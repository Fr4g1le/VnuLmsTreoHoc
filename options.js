const $ = id => document.getElementById(id);
const FIELDS = ['provider', 'apiKey', 'model', 'geminiKey', 'geminiModel'];

function showBox() {
  $('geminiBox').hidden = $('provider').value !== 'gemini';
  $('claudeBox').hidden = $('provider').value !== 'claude';
}

chrome.storage.local.get(FIELDS).then(saved => {
  // Đã có khoá Claude từ bản trước thì giữ Claude làm mặc định
  if (!saved.provider) saved.provider = saved.apiKey ? 'claude' : 'gemini';
  for (const k of FIELDS) if (saved[k]) $(k).value = saved[k];
  showBox();
});

$('provider').addEventListener('change', showBox);

$('save').addEventListener('click', async () => {
  const data = {};
  for (const k of FIELDS) data[k] = $(k).value.trim();
  await chrome.storage.local.set(data);
  $('status').textContent = 'Đã lưu ✓';
  setTimeout(() => ($('status').textContent = ''), 2000);
});
