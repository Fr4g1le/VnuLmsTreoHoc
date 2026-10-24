// Cầu nối giữa trang (content.js, world MAIN) và background của extension.
chrome.runtime.onMessage.addListener(msg => {
  if (msg === 'toggle-panel') window.postMessage({ vnuTreo: 'toggle-panel' }, location.origin);
});

window.addEventListener('message', e => {
  if (e.source !== window || !e.data) return;
  const { vnuTreo, id, questions } = e.data;
  if (vnuTreo === 'ai-suggest') {
    chrome.runtime.sendMessage({ type: 'ai-suggest', questions })
      .then(res => window.postMessage({ vnuTreo: 'ai-result', id, ...res }, location.origin))
      .catch(err => window.postMessage({ vnuTreo: 'ai-result', id, ok: false, error: String(err.message || err) }, location.origin));
  }
  if (vnuTreo === 'open-options') chrome.runtime.sendMessage({ type: 'open-options' });
});
