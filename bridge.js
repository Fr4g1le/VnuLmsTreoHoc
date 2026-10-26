// Cầu nối giữa trang (content.js, world MAIN) và background của extension.
chrome.runtime.onMessage.addListener(msg => {
  if (msg === 'toggle-panel') window.postMessage({ vnuTreo: 'toggle-panel' }, location.origin);
});

window.addEventListener('message', e => {
  if (e.source !== window || !e.data) return;
  const { vnuTreo, id, questions, task } = e.data;
  if (vnuTreo === 'ai-suggest' || vnuTreo === 'ai-fill') {
    chrome.runtime.sendMessage(vnuTreo === 'ai-fill' ? { type: 'ai-fill', task } : { type: 'ai-suggest', questions })
      .then(res => window.postMessage({ vnuTreo: 'ai-result', id, ...res }, location.origin))
      .catch(err => window.postMessage({ vnuTreo: 'ai-result', id, ok: false, error: String(err.message || err) }, location.origin));
  }
  if (vnuTreo === 'open-options') chrome.runtime.sendMessage({ type: 'open-options' });
});

// Mỗi lần mở trang LMS: hỏi background có bản mới không (background chỉ hỏi GitHub tối đa 6 tiếng một lần)
chrome.runtime.sendMessage({ type: 'check-update' })
  .then(res => res && window.postMessage({ vnuTreo: 'update', ...res }, location.origin))
  .catch(() => {});

// Sau khi chạy CapNhat.bat: background tự khởi động lại khi thấy file mới trên đĩa. Khi đó script này mất kết nối
// với extension (chrome.runtime.id thành undefined) -> báo trang tải lại để dùng bản mới.
const reloadTimer = setInterval(() => {
  if (!chrome.runtime || !chrome.runtime.id) {
    clearInterval(reloadTimer);
    window.postMessage({ vnuTreo: 'ext-reloaded' }, location.origin);
    return;
  }
  chrome.runtime.sendMessage({ type: 'check-reload' }).catch(() => {});
}, 30000);
