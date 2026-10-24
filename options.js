const $ = id => document.getElementById(id);

chrome.storage.local.get(['apiKey', 'model']).then(({ apiKey, model }) => {
  if (apiKey) $('apiKey').value = apiKey;
  if (model) $('model').value = model;
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim(), model: $('model').value });
  $('status').textContent = 'Đã lưu ✓';
  setTimeout(() => ($('status').textContent = ''), 2000);
});
