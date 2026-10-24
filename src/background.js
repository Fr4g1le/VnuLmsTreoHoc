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
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  if (!apiKey) throw new Error('Chưa có khoá API. Bấm "Cài khoá API" để nhập.');

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify({ questions }) }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude từ chối trả lời các câu hỏi này.');
  if (response.stop_reason === 'max_tokens') throw new Error('Câu trả lời bị cắt ngắn, hãy thử lại với ít câu hơn.');
  const text = response.content.find(b => b.type === 'text');
  if (!text) throw new Error('Claude không trả về kết quả.');
  return JSON.parse(text.text).answers;
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Khoá API không hợp lệ.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Khoá API không có quyền dùng model này.';
  if (e instanceof Anthropic.RateLimitError) return 'Đang bị giới hạn tốc độ, thử lại sau ít phút.';
  if (e instanceof Anthropic.BadRequestError) return 'Yêu cầu không hợp lệ: ' + e.message;
  if (e instanceof Anthropic.APIConnectionError) return 'Không kết nối được tới Claude.';
  if (e instanceof Anthropic.APIError) return `Lỗi từ Claude (${e.status}): ${e.message}`;
  return e.message || String(e);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ai-suggest') {
    suggest(msg.questions)
      .then(answers => sendResponse({ ok: true, answers }))
      .catch(e => sendResponse({ ok: false, error: describeError(e) }));
    return true; // trả lời bất đồng bộ
  }
  if (msg && msg.type === 'open-options') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, 'toggle-panel').catch(() => {});
});
