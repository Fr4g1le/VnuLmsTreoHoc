// Cầu nối: nhận lệnh từ biểu tượng extension (background.js) và chuyển vào trang cho content.js.
chrome.runtime.onMessage.addListener(msg => {
  if (msg === 'toggle-panel') window.postMessage({ vnuTreo: 'toggle-panel' }, location.origin);
});
