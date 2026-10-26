// Background (service worker) của extension. Được đóng gói bằng `npm run build` thành ../background.js.
// - Bấm biểu tượng extension -> mở/đóng bảng điều khiển trong tab LMS.
// - Nhận câu hỏi trắc nghiệm từ trang (qua bridge.js), hỏi Claude, trả về gợi ý đáp án.
// Khoá API chỉ nằm trong chrome.storage của extension, trang LMS không đọc được.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `Bạn là trợ lý ôn tập cho sinh viên Đại học Quốc gia Hà Nội, môn học trên hệ thống LMS (pháp luật, chính trị, khoa học xã hội của Việt Nam, hoặc tiếng Anh).
Với mỗi câu hỏi trắc nghiệm được gửi đến, chọn đáp án đúng nhất theo kiến thức giáo trình đại học Việt Nam hiện hành.
- Câu đọc hiểu: đề ("question") có kèm đoạn văn; trả lời dựa vào nội dung đoạn văn đó.
- "answers" là danh sách đáp án, đánh số từ 0. Trả về số thứ tự đáp án bạn chọn trong "choices".
- Câu có "multi": false chỉ chọn đúng 1 đáp án. Câu có "multi": true chọn tất cả đáp án đúng.
- Đọc kỹ đề: nhiều câu hỏi đáp án SAI / KHÔNG đúng.
- "why": giải thích bằng tiếng Việt, tối đa 15 từ, nêu căn cứ nếu có (điều luật, khái niệm).
- "confidence": "cao", "trung bình" hoặc "thấp".`;

const SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'string' },
          choices: { type: 'array', items: { type: 'integer' } },
          why: { type: 'string' },
          confidence: { type: 'string', enum: ['cao', 'trung bình', 'thấp'] },
        },
        required: ['n', 'choices', 'why', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

async function suggest(questions, progress) {
  const { provider } = await chrome.storage.local.get(['provider']);
  return provider === 'gemini' ? suggestGemini(questions, progress) : suggestClaude(questions, progress);
}

// ---------- Gemini (Google AI Studio, có gói miễn phí) ----------
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// responseSchema của Gemini dùng kiểu OpenAPI rút gọn: kiểu viết hoa, không có additionalProperties.
function geminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = geminiSchema(s.items);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]));
  if (s.required) out.required = s.required;
  return out;
}

// Model dự phòng khi model đang chọn quá tải (503), hết lượt miễn phí (429) hoặc không còn (404)
const GEMINI_FALLBACKS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

class GeminiError extends Error {
  constructor(message, { status = 0, retry = false, nextModel = false } = {}) {
    super(message);
    Object.assign(this, { status, retry, nextModel });
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Gemini im lặng quá 150 giây (chưa trả lời, hoặc dừng giữa luồng) thì coi như model bận và chuyển model khác.
const GEMINI_IDLE = 150000;

// req = { system, parts, schema }: parts là nội dung gửi lên (chữ, có thể kèm audio).
// Dùng bản trả về dạng luồng (SSE): biết ngay model đã bắt đầu trả lời, và báo tiến độ trong lúc chờ.
// Suy nghĩ ít để đỡ tốn token và trả lời nhanh: Gemini 3.x dùng mức "low", Gemini 2.5 tắt hẳn.
// Model nào báo không nhận tuỳ chọn này thì nhớ lại (noThinking) và gửi lại không kèm.
const noThinking = new Set();
function thinkingFor(model) {
  if (noThinking.has(model)) return {};
  if (/^gemini-[3-9]/.test(model)) return { thinkingConfig: { thinkingLevel: 'low' } };
  if (/^gemini-2\.5/.test(model)) return { thinkingConfig: { thinkingBudget: /pro/.test(model) ? 128 : 0 } };
  return {};
}

// signal: huỷ từ bên ngoài (đã có model khác trả lời xong). onStream: gọi khi nhận được chữ đầu tiên của câu trả lời.
async function callGemini(model, key, req, progress, signal, onStream = () => {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const abort = new AbortController();
  if (signal) signal.addEventListener('abort', () => abort.abort());
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), GEMINI_IDLE); };
  arm();
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: req.parts }],
          generationConfig: Object.assign({ responseMimeType: 'application/json', responseSchema: req.schema }, thinkingFor(model)),
        }),
      });
    } catch (e) {
      if (abort.signal.aborted) throw new GeminiError(`Gemini "${model}" không phản hồi quá ${GEMINI_IDLE / 1000} giây.`, { nextModel: true });
      throw new GeminiError('Không kết nối được tới Gemini.', { retry: true });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = Array.isArray(body) ? body[0] && body[0].error : body.error;
      const msg = (err && err.message) || res.statusText;
      if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError('Khoá Gemini không hợp lệ.', { status: 400 });
      if (res.status === 400 && /thinking/i.test(msg) && !noThinking.has(model)) {
        noThinking.add(model);
        throw new GeminiError(`Gemini "${model}" không nhận tuỳ chọn suy nghĩ, gửi lại.`, { status: 400, retry: true });
      }
      if (res.status === 503 || res.status === 500) throw new GeminiError(`Gemini "${model}" đang quá tải.`, { status: res.status, retry: true, nextModel: true });
      if (res.status === 429) throw new GeminiError(`Gemini "${model}" hết lượt miễn phí tạm thời.`, { status: 429, nextModel: true });
      if (res.status === 404) throw new GeminiError(`Gemini không có model "${model}".`, { status: 404, nextModel: true });
      throw new GeminiError(`Lỗi từ Gemini (${res.status}): ${msg}`, { status: res.status });
    }
    arm();
    progress(`${model} đang xử lý…`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', text = '', started = false;
    const handle = line => {
      if (!line.startsWith('data:')) return;
      const ev = JSON.parse(line.slice(5));
      if (ev.promptFeedback && ev.promptFeedback.blockReason) throw new GeminiError('Gemini chặn câu hỏi này.');
      const parts = (ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts) || [];
      for (const p of parts) if (p.text && !p.thought) text += p.text;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(handle);
        if (text && !started) { started = true; onStream(model); }
        if (text) progress(`${model} đang trả lời… (${text.length} ký tự)`);
      }
      handle(buf);
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      if (abort.signal.aborted) throw new GeminiError(`Gemini "${model}" ngừng trả lời giữa chừng.`, { nextModel: true });
      throw new GeminiError(`Mất kết nối với Gemini "${model}" giữa chừng.`, { retry: true, nextModel: true });
    }
    if (!text) throw new GeminiError('Gemini không trả về kết quả.', { retry: true });
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const suggestGemini = (questions, progress) =>
  askGemini({ system: SYSTEM, parts: [{ text: JSON.stringify({ questions }) }], schema: geminiSchema(SCHEMA) }, progress);

// Một model: quá tải thì thử lại một lần sau 3 giây.
async function callGeminiRetry(model, key, req, progress, signal, onStream) {
  for (let attempt = 0; ; attempt++) {
    try {
      progress(`Đang gửi cho ${model}${attempt ? ' (thử lại)' : ''}…`);
      return await callGemini(model, key, req, progress, signal, onStream);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (attempt === 0 && e instanceof GeminiError && e.retry) { progress(e.message); await wait(3000); continue; }
      throw e;
    }
  }
}

// Model vừa trả lời xong được gọi trước trong 30 phút sau đó (chế độ Nhanh): đỡ chờ model đang quá tải.
const LAST_GOOD_FOR = 30 * 60000;

// Bao lâu chưa có model nào bắt đầu trả lời thì gọi thêm model kế tiếp (chế độ Nhanh). Bài có audio cần nghe lâu hơn.
const HEDGE_TEXT = 10000, HEDGE_AUDIO = 30000;

// Chế độ Nhanh (mặc định): gọi model đang chọn; quá HEDGE mà chưa có chữ nào thì gọi thêm model dự phòng kế tiếp,
// model nào báo lỗi thì gọi ngay model khác; lấy kết quả của model trả lời xong đầu tiên và huỷ các model còn lại.
// Chế độ Chính xác: lần lượt từng model, chỉ chuyển khi model trước lỗi.
async function askGemini(req, progress = () => {}) {
  const { geminiKey, geminiModel, geminiSpeed } = await chrome.storage.local.get(['geminiKey', 'geminiModel', 'geminiSpeed']);
  if (!geminiKey) throw new GeminiError('Chưa có khoá Gemini. Bấm "⚙ Khoá API" để nhập.');
  const chosen = (geminiModel || DEFAULT_GEMINI_MODEL).trim();
  let models = [chosen, ...GEMINI_FALLBACKS.filter(m => m !== chosen)];
  const fast = geminiSpeed !== 'accurate';
  const { geminiLastGood: good } = await chrome.storage.local.get('geminiLastGood');
  if (fast && good && Date.now() - good.at < LAST_GOOD_FOR && models.includes(good.model)) {
    models = [good.model, ...models.filter(m => m !== good.model)];
  }
  const hedge = req.parts.some(p => p.inlineData && /^audio\//.test(p.inlineData.mimeType)) ? HEDGE_AUDIO : HEDGE_TEXT;
  const usable = e => e instanceof GeminiError && (e.retry || e.nextModel);

  return new Promise((resolve, reject) => {
    const running = new Map();
    const tried = [];
    let next = 0, settled = false, streaming = false, timer;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const ac of running.values()) ac.abort();
      if (err) reject(err); else resolve(result);
    };
    const armHedge = () => {
      clearTimeout(timer);
      if (fast && next < models.length) timer = setTimeout(() => { if (!streaming) launch(); }, hedge);
    };
    const launch = () => {
      if (settled || next >= models.length) return;
      const model = models[next++];
      const ac = new AbortController();
      running.set(model, ac);
      if (running.size > 1) progress(`Model trước chậm, gọi thêm ${model}…`);
      armHedge();
      callGeminiRetry(model, geminiKey, req, progress, ac.signal, () => { streaming = true; clearTimeout(timer); })
        .then(result => {
          chrome.storage.local.set({ geminiLastGood: { model, at: Date.now() } });
          finish(null, { ...result, model });
        }, e => {
          running.delete(model);
          if (settled) return;
          if (!usable(e)) return finish(e);
          tried.push(e.message);
          progress(e.message);
          if (next < models.length) launch();
          else if (!running.size) finish(new GeminiError('Tất cả model Gemini đều đang bận hoặc hết lượt, thử lại sau ít phút. (' + tried.join(' ') + ')'));
        });
    };
    launch();
  });
}

// ---------- Claude ----------
const suggestClaude = (questions, progress) => askClaude(SYSTEM, SCHEMA, JSON.stringify({ questions }), progress);

async function askClaude(system, schema, content, progress = () => {}, effort = 'low') {
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  if (!apiKey) throw new Error('Chưa có khoá API. Bấm "Cài khoá API" để nhập.');
  progress(`Đang hỏi ${model || DEFAULT_MODEL}…`);

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude từ chối trả lời các câu hỏi này.');
  if (response.stop_reason === 'max_tokens') throw new Error('Câu trả lời bị cắt ngắn, hãy thử lại với ít câu hơn.');
  const text = response.content.find(b => b.type === 'text');
  if (!text) throw new Error('Claude không trả về kết quả.');
  return { ...JSON.parse(text.text), model: response.model };
}

// ---------- Bài điền chỗ trống, nối cặp, bài viết ----------
const CONFIDENCE = { type: 'string', enum: ['cao', 'trung bình', 'thấp'] };
const answersOf = props => ({
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false },
    },
  },
  required: ['answers'],
  additionalProperties: false,
});

const TASKS = {
  // Trắc nghiệm có đề chung (đoạn văn, audio) hoặc có ảnh trong đề: chọn đáp án như trắc nghiệm thường
  choose: {
    system: SYSTEM + `
- "context" là đề chung của các câu (có thể trống). Nếu có file audio thì đó là bài nghe của đề chung: nghe hết rồi trả lời theo nội dung nghe được.
- Câu có "images" (ví dụ ["img1"]) thì xem các ảnh có nhãn tương ứng được gửi kèm; đề có thể chỉ là ảnh.`,
    schema: SCHEMA,
  },
  // Bài điền chỗ trống, thường là bài nghe: đề có (1) ____, mỗi ô có n ("1.1") và label ("1-" hoặc câu cần viết lại)
  fill: {
    system: `Bạn giúp sinh viên ôn tập dạng bài điền vào ô trống trên LMS, thường là bài tiếng Anh.
- "context" là đề chung, có thể có các chỗ trống được đánh số như (1) ____, (2) ____.
- Mỗi ô trong "blanks" có "n" (ví dụ "1.1") và "label". Label có thể chỉ là số ("1-", ứng với chỗ trống cùng số trong đề) hoặc là câu riêng của ô đó (ví dụ câu cần viết lại theo yêu cầu của đề).
- Nếu có file audio: nghe hết, điền đúng từ hoặc cụm từ nghe được, khớp ngữ pháp với câu trong đề và giới hạn số từ nếu đề có nêu.
- Làm đúng mọi quy định trong đề (dấu chấm cuối câu, viết hoa chữ đầu câu...).
- "text": chỉ ghi nội dung cần điền vào ô, không ghi số thứ tự. Nếu "caps" là true thì viết IN HOA.
- "why": giải thích bằng tiếng Việt, tối đa 12 từ (trích ý nghe được nếu có audio).
- "confidence": "cao", "trung bình" hoặc "thấp".`,
    schema: answersOf({ n: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, confidence: CONFIDENCE }),
  },
  // Kéo thả nối cặp: mỗi câu có danh sách mục để kéo và các ô đích
  match: {
    system: `Bạn giúp sinh viên ôn tập dạng bài nối cặp (kéo thả) trên LMS, thường là bài tiếng Anh.
- "context" là đề chung (có thể có đoạn văn cần đọc). Mỗi câu trong "questions" có "n", "title" (đề riêng nếu có), "items" (các mục để kéo, đánh số từ 0) và "targets" (các ô đích, đánh số từ 0).
- Ghép mỗi mục với ô đích đúng của nó. Ví dụ: câu hỏi -> câu trả lời trong đoạn văn; hoặc bài sắp xếp câu, khi items là số thứ tự vị trí (1, 2, 3...) và targets là các từ: đặt số vị trí vào từ đứng ở vị trí đó trong câu đúng.
- "pairs": mỗi phần tử là { "item": số của mục, "target": số của ô đích }. Mỗi mục dùng đúng một lần.
- "why": tối đa 15 từ bằng tiếng Việt; với bài sắp xếp thì chỉ ghi câu hoàn chỉnh.
- "confidence": "cao", "trung bình" hoặc "thấp".`,
    schema: answersOf({
      n: { type: 'string' },
      pairs: {
        type: 'array',
        items: {
          type: 'object', properties: { item: { type: 'integer' }, target: { type: 'integer' } },
          required: ['item', 'target'], additionalProperties: false,
        },
      },
      why: { type: 'string' },
      confidence: CONFIDENCE,
    }),
  },
  // Bài tập nộp bằng bài viết, hoặc viết thảo luận / cảm nghĩ dưới bài học
  write: {
    system: `Bạn giúp sinh viên Đại học Quốc gia Hà Nội viết bản nháp cho bài tập viết hoặc bài thảo luận trên LMS.
- "kind" là "assignment" (bài tập giảng viên giao, "prompt" là đề bài) hoặc "discussion" (viết thảo luận / cảm nghĩ về bài học, "prompt" là nội dung bài học).
- "idea" là ý sinh viên muốn viết (có thể trống). Nếu có, bám theo ý đó.
- Viết bằng ngôn ngữ của đề bài / bài học (bài tiếng Anh thì viết tiếng Anh), giọng một sinh viên năm nhất, tự nhiên, không sáo rỗng.
- Làm đúng mọi yêu cầu của đề (số câu, số từ, dạng bài). Đề yêu cầu làm từng câu thì đánh số từng câu như đề.
- Bài thảo luận: 80-150 từ, nêu cảm nghĩ và một điều rút ra cụ thể; "title" là tiêu đề ngắn (dưới 12 từ). Bài tập: "title" để trống.
- "body": nội dung, mỗi đoạn hoặc mỗi câu trả lời cách nhau bằng một dòng trống, không dùng markdown.
- "note": nhắc sinh viên bằng tiếng Việt (1 câu) điều nên tự kiểm tra hoặc sửa thêm.`,
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' }, note: { type: 'string' } },
      required: ['title', 'body', 'note'],
      additionalProperties: false,
    },
  },
};

// Claude không nghe được audio, nên việc có audio luôn dùng Gemini (nếu đã nhập khoá Gemini).
async function runTask({ kind, audio, images = [], ...data }, progress) {
  const task = TASKS[kind];
  if (!task) throw new Error('Không rõ loại yêu cầu: ' + kind);
  const { provider, geminiKey } = await chrome.storage.local.get(['provider', 'geminiKey']);
  const text = JSON.stringify(data);
  if (audio || provider === 'gemini') {
    if (audio && !geminiKey) {
      throw new GeminiError('Bài nghe cần khoá Gemini (Claude không nghe được audio). Bấm "⚙ Khoá API", chọn Google Gemini và nhập khoá miễn phí.');
    }
    const parts = [{ text }];
    if (audio) parts.push({ inlineData: { mimeType: audio.mime, data: audio.data } });
    for (const im of images) parts.push({ text: `Ảnh ${im.id}:` }, { inlineData: { mimeType: im.mime, data: im.data } });
    return askGemini({ system: task.system, parts, schema: geminiSchema(task.schema) }, progress);
  }
  const content = images.length ? [{ type: 'text', text }, ...images.flatMap(im => [
    { type: 'text', text: `Ảnh ${im.id}:` },
    { type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } },
  ])] : text;
  return askClaude(task.system, task.schema, content, progress, kind === 'write' ? 'medium' : 'low');
}

function describeError(e) {
  if (e instanceof GeminiError) return e.message;
  if (e instanceof SyntaxError) return 'Kết quả AI trả về không đúng định dạng, hãy thử lại.';
  if (e instanceof Anthropic.AuthenticationError) return 'Khoá API không hợp lệ.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Khoá API không có quyền dùng model này.';
  if (e instanceof Anthropic.RateLimitError) return 'Đang bị giới hạn tốc độ, thử lại sau ít phút.';
  if (e instanceof Anthropic.BadRequestError) return 'Yêu cầu không hợp lệ: ' + e.message;
  if (e instanceof Anthropic.APIConnectionError) return 'Không kết nối được tới Claude.';
  if (e instanceof Anthropic.APIError) return `Lỗi từ Claude (${e.status}): ${e.message}`;
  return e.message || String(e);
}

// ---------- Kiểm tra bản mới trên GitHub Releases (tối đa 6 tiếng một lần) ----------
const REPO = 'Fr4g1le/VnuLmsTreoHoc';
const CHECK_EVERY = 6 * 3600 * 1000;

function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// force: bạn bấm "Kiểm tra bản mới" -> hỏi GitHub ngay, không dùng kết quả cũ; hỏi không được thì báo failed.
async function latestRelease(force) {
  const { upd } = await chrome.storage.local.get('upd');
  if (!force && upd && Date.now() - upd.checkedAt < CHECK_EVERY) return upd;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) return force ? Object.assign({}, upd, { failed: true }) : upd || null;
    const j = await r.json();
    const zip = (j.assets || []).find(a => /\.zip$/i.test(a.name));
    const info = { checkedAt: Date.now(), latest: String(j.tag_name || '').replace(/^v/i, ''), url: j.html_url, zip: zip && zip.browser_download_url };
    await chrome.storage.local.set({ upd: info });
    return info;
  } catch (e) {
    return force ? Object.assign({}, upd, { failed: true }) : upd || null; // mất mạng: dùng kết quả lần trước
  }
}

async function updateStatus(force) {
  const current = chrome.runtime.getManifest().version;
  const info = await latestRelease(force);
  const hasUpdate = !!(info && info.latest && isNewer(info.latest, current));
  chrome.action.setBadgeText({ text: hasUpdate ? 'NEW' : '' });
  if (hasUpdate) chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
  return { hasUpdate, current, latest: info && info.latest, url: info && info.url, zip: info && info.zip, failed: !!(info && info.failed) };
}

// CapNhat.bat ghi đè file trong thư mục extension. Extension cài từ thư mục đọc file trực tiếp từ đĩa,
// nên manifest.json trên đĩa mới hơn bản đang chạy nghĩa là vừa cập nhật xong -> tự khởi động lại.
async function reloadIfUpdatedOnDisk() {
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (isNewer(disk.version, chrome.runtime.getManifest().version)) {
      chrome.runtime.reload();
      return true;
    }
  } catch (e) {}
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'check-reload') {
    reloadIfUpdatedOnDisk().then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'check-update') {
    updateStatus(msg.force).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'open-options') chrome.runtime.openOptionsPage();
});

// Việc AI chạy qua một cổng kết nối (bridge.js mở) thay vì sendMessage: bài nghe có thể mất vài phút.
// Cổng còn mở và nhịp báo tiến độ mỗi 15 giây giữ service worker không bị trình duyệt cho ngủ giữa chừng,
// còn trang thì biết việc vẫn đang chạy.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ai') return;
  port.onMessage.addListener(async msg => {
    let last = 'Đang xử lý…';
    const progress = text => { last = text; try { port.postMessage({ progress: text }); } catch (e) {} };
    const beat = setInterval(() => progress(last), 15000);
    try {
      const result = msg.type === 'ai-task' ? await runTask(msg.task, progress) : await suggest(msg.questions, progress);
      port.postMessage({ done: true, ok: true, ...result });
    } catch (e) {
      try { port.postMessage({ done: true, ok: false, error: describeError(e) }); } catch (_) {}
    } finally {
      clearInterval(beat);
    }
  });
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, 'toggle-panel').catch(() => {});
});
