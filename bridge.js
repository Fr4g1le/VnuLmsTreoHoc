// Cầu nối giữa trang (content.js, world MAIN) và background của extension.
chrome.runtime.onMessage.addListener(msg => {
  if (msg === 'toggle-panel') window.postMessage({ vnuTreo: 'toggle-panel' }, location.origin);
});

window.addEventListener('message', e => {
  if (e.source !== window || !e.data) return;
  const { vnuTreo, id, questions, task } = e.data;
  if (vnuTreo === 'ai-suggest' || vnuTreo === 'ai-task') {
    // Mỗi yêu cầu một cổng kết nối: background gửi tiến độ trong lúc chờ AI, rồi kết quả.
    // Cổng đóng mà chưa có kết quả nghĩa là background bị dừng giữa chừng.
    const reply = res => window.postMessage({ vnuTreo: 'ai-result', id, ...res }, location.origin);
    let done = false;
    try {
      const port = chrome.runtime.connect({ name: 'ai' });
      port.onMessage.addListener(m => {
        if (m.progress) window.postMessage({ vnuTreo: 'ai-progress', id, text: m.progress }, location.origin);
        if (m.done) { done = true; reply(m); port.disconnect(); }
      });
      port.onDisconnect.addListener(() => {
        if (!done) reply({ ok: false, error: 'Extension bị ngắt giữa chừng (có thể vừa cập nhật hoặc bị trình duyệt dừng). Tải lại trang (F5) rồi bấm lại.' });
      });
      port.postMessage(vnuTreo === 'ai-task' ? { type: 'ai-task', task } : { type: 'ai-suggest', questions });
    } catch (err) {
      reply({ ok: false, error: 'Mất kết nối với extension (có thể vừa cập nhật). Tải lại trang (F5) rồi bấm lại.' });
    }
  }
  if (vnuTreo === 'open-options') chrome.runtime.sendMessage({ type: 'open-options' });
  // Bấm "Kiểm tra bản mới" trong bảng: hỏi GitHub ngay
  if (vnuTreo === 'check-update-now') {
    chrome.runtime.sendMessage({ type: 'check-update', force: true })
      .then(res => window.postMessage({ vnuTreo: 'update', manual: true, ...res }, location.origin))
      .catch(() => window.postMessage({ vnuTreo: 'update', manual: true, failed: true }, location.origin));
  }
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
