// Background (service worker) của extension. Được đóng gói bằng `npm run build` thành ../background.js.
// - Bấm biểu tượng extension -> mở/đóng bảng điều khiển trong tab LMS.
// - Nhận câu hỏi trắc nghiệm từ trang (qua bridge.js), hỏi Claude, trả về gợi ý đáp án.
// Khoá API chỉ nằm trong chrome.storage của extension, trang LMS không đọc được.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `Bạn là trợ lý ôn tập cho sinh viên Đại học Quốc gia Hà Nội, môn học trên hệ thống LMS (thường là pháp luật, chính trị, khoa học xã hội của Việt Nam).
Với mỗi câu hỏi trắc nghiệm được gửi đến, chọn đáp án đúng nhất theo kiến thức giáo trình đại học Việt Nam hiện hành.
- "answers" là danh sách đáp án, đánh số từ 0. Trả về số thứ tự đáp án bạn chọn trong "choices".
- Câu có "multi": false chỉ chọn đúng 1 đáp án. Câu có "multi": true chọn tất cả đáp án đúng.
- Đọc kỹ đề: nhiều câu hỏi đáp án SAI / KHÔNG đúng.
- "why": giải thích ngắn gọn bằng tiếng Việt (1-2 câu), nêu căn cứ nếu có (điều luật, khái niệm).
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

async function suggest(questions) {
  const { provider } = await chrome.storage.local.get(['provider']);
  return provider === 'gemini' ? suggestGemini(questions) : suggestClaude(questions);
}

// ---------- Gemini (Google AI Studio, có gói miễn phí) ----------
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// responseSchema của Gemini dùng kiểu OpenAPI rút gọn: không có additionalProperties.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          n: { type: 'STRING' },
          choices: { type: 'ARRAY', items: { type: 'INTEGER' } },
          why: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['cao', 'trung bình', 'thấp'] },
        },
        required: ['n', 'choices', 'why', 'confidence'],
      },
    },
  },
  required: ['answers'],
};

// Model dự phòng khi model đang chọn quá tải (503), hết lượt miễn phí (429) hoặc không còn (404)
const GEMINI_FALLBACKS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

class GeminiError extends Error {
  constructor(message, { status = 0, retry = false, nextModel = false } = {}) {
    super(message);
    Object.assign(this, { status, retry, nextModel });
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// req = { system, parts, schema }: parts là nội dung gửi lên (chữ, có thể kèm audio).
async function callGemini(model, key, req) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: req.parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: req.schema },
      }),
    });
  } catch (e) {
    throw new GeminiError('Không kết nối được tới Gemini.', { retry: true });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || res.statusText;
    if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError('Khoá Gemini không hợp lệ.', { status: 400 });
    if (res.status === 503 || res.status === 500) throw new GeminiError(`Gemini "${model}" đang quá tải.`, { status: res.status, retry: true, nextModel: true });
    if (res.status === 429) throw new GeminiError(`Gemini "${model}" hết lượt miễn phí tạm thời.`, { status: 429, nextModel: true });
    if (res.status === 404) throw new GeminiError(`Gemini không có model "${model}".`, { status: 404, nextModel: true });
    throw new GeminiError(`Lỗi từ Gemini (${res.status}): ${msg}`, { status: res.status });
  }
  if (body.promptFeedback && body.promptFeedback.blockReason) throw new GeminiError('Gemini chặn câu hỏi này.');
  const parts = (body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text) throw new GeminiError('Gemini không trả về kết quả.', { retry: true });
  return JSON.parse(text).answers;
}

const suggestGemini = questions =>
  askGemini({ system: SYSTEM, parts: [{ text: JSON.stringify({ questions }) }], schema: GEMINI_SCHEMA });

// Thử model đang chọn trước (quá tải thì thử lại sau 3 giây), không được thì lần lượt chuyển sang model dự phòng.
async function askGemini(req) {
  const { geminiKey, geminiModel } = await chrome.storage.local.get(['geminiKey', 'geminiModel']);
  if (!geminiKey) throw new GeminiError('Chưa có khoá Gemini. Bấm "⚙ Khoá API" để nhập.');
  const chosen = (geminiModel || DEFAULT_GEMINI_MODEL).trim();
  const models = [chosen, ...GEMINI_FALLBACKS.filter(m => m !== chosen)];
  const tried = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { answers: await callGemini(model, geminiKey, req), model };
      } catch (e) {
        if (!(e instanceof GeminiError) || (!e.retry && !e.nextModel)) throw e;
        if (attempt === 0 && e.retry) { await wait(3000); continue; }
        tried.push(e.message);
        break;
      }
    }
  }
  throw new GeminiError('Tất cả model Gemini đều đang bận hoặc hết lượt, thử lại sau ít phút. (' + tried.join(' ') + ')');
}

// ---------- Claude ----------
const suggestClaude = questions => askClaude(SYSTEM, SCHEMA, JSON.stringify({ questions }));

async function askClaude(system, schema, content) {
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  if (!apiKey) throw new Error('Chưa có khoá API. Bấm "Cài khoá API" để nhập.');

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude từ chối trả lời các câu hỏi này.');
  if (response.stop_reason === 'max_tokens') throw new Error('Câu trả lời bị cắt ngắn, hãy thử lại với ít câu hơn.');
  const text = response.content.find(b => b.type === 'text');
  if (!text) throw new Error('Claude không trả về kết quả.');
  return { answers: JSON.parse(text.text).answers, model: response.model };
}

// ---------- Bài điền chỗ trống / bài nghe ----------
const FILL_SYSTEM = `Bạn giúp sinh viên ôn tập dạng bài điền vào chỗ trống trên LMS, thường là bài nghe tiếng Anh.
- "context" là đề bài, trong đó các chỗ trống được đánh số như (1) ____, (2) ____.
- Mỗi ô trong "blanks" có "n" (ví dụ "1.1") và "label" (ví dụ "1-"); số trong label ứng với chỗ trống cùng số trong đề.
- Nếu có file audio: nghe hết, điền đúng từ hoặc cụm từ nghe được, khớp ngữ pháp với câu trong đề và giới hạn số từ nếu đề có nêu.
- "text": chỉ ghi đáp án cần điền, không ghi số thứ tự. Nếu "caps" là true thì viết IN HOA.
- "why": giải thích ngắn bằng tiếng Việt (1 câu), trích ý nghe được trong audio nếu có.
- "confidence": "cao", "trung bình" hoặc "thấp".`;

const FILL_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
          confidence: { type: 'string', enum: ['cao', 'trung bình', 'thấp'] },
        },
        required: ['n', 'text', 'why', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

const GEMINI_FILL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          n: { type: 'STRING' },
          text: { type: 'STRING' },
          why: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['cao', 'trung bình', 'thấp'] },
        },
        required: ['n', 'text', 'why', 'confidence'],
      },
    },
  },
  required: ['answers'],
};

// Claude không nghe được audio, nên bài có audio luôn dùng Gemini (nếu đã nhập khoá Gemini).
async function fillBlanks({ context, caps, audio, blanks }) {
  const { provider, geminiKey } = await chrome.storage.local.get(['provider', 'geminiKey']);
  const text = JSON.stringify({ context, caps, blanks });
  if (audio || provider === 'gemini') {
    if (audio && !geminiKey) {
      throw new GeminiError('Bài nghe cần khoá Gemini (Claude không nghe được audio). Bấm "⚙ Khoá API", chọn Google Gemini và nhập khoá miễn phí.');
    }
    const parts = [{ text }];
    if (audio) parts.push({ inlineData: { mimeType: audio.mime, data: audio.data } });
    return askGemini({ system: FILL_SYSTEM, parts, schema: GEMINI_FILL_SCHEMA });
  }
  return askClaude(FILL_SYSTEM, FILL_SCHEMA, text);
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

async function latestRelease() {
  const { upd } = await chrome.storage.local.get('upd');
  if (upd && Date.now() - upd.checkedAt < CHECK_EVERY) return upd;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return upd || null;
    const j = await r.json();
    const zip = (j.assets || []).find(a => /\.zip$/i.test(a.name));
    const info = { checkedAt: Date.now(), latest: String(j.tag_name || '').replace(/^v/i, ''), url: j.html_url, zip: zip && zip.browser_download_url };
    await chrome.storage.local.set({ upd: info });
    return info;
  } catch (e) {
    return upd || null; // mất mạng: dùng kết quả lần trước
  }
}

async function updateStatus() {
  const current = chrome.runtime.getManifest().version;
  const info = await latestRelease();
  const hasUpdate = !!(info && info.latest && isNewer(info.latest, current));
  chrome.action.setBadgeText({ text: hasUpdate ? 'NEW' : '' });
  if (hasUpdate) chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
  return { hasUpdate, current, latest: info && info.latest, url: info && info.url, zip: info && info.zip };
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
    updateStatus().then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'ai-suggest') {
    suggest(msg.questions)
      .then(({ answers, model }) => sendResponse({ ok: true, answers, model }))
      .catch(e => sendResponse({ ok: false, error: describeError(e) }));
    return true; // trả lời bất đồng bộ
  }
  if (msg && msg.type === 'ai-fill') {
    fillBlanks(msg.task)
      .then(({ answers, model }) => sendResponse({ ok: true, answers, model }))
      .catch(e => sendResponse({ ok: false, error: describeError(e) }));
    return true;
  }
  if (msg && msg.type === 'open-options') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, 'toggle-panel').catch(() => {});
});
