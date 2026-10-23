// Bấm biểu tượng extension trên thanh công cụ -> mở/đóng bảng điều khiển trong tab LMS.
chrome.action.onClicked.addListener(tab => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, 'toggle-panel').catch(() => {});
});
