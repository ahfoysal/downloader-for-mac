const urlEl = document.getElementById('currentUrl');
const sendCurrent = document.getElementById('sendCurrent');
const manualUrl = document.getElementById('manualUrl');
const sendManual = document.getElementById('sendManual');
const status = document.getElementById('status');

function showStatus(msg) {
  status.textContent = msg;
  setTimeout(() => (status.textContent = ''), 2000);
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && tabs[0].url) {
    urlEl.textContent = tabs[0].url;
    urlEl.title = tabs[0].url;
  }
});

sendCurrent.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'send-active' }, () => {
    showStatus('✓ Sent');
    setTimeout(() => window.close(), 700);
  });
});

sendManual.addEventListener('click', () => {
  const u = manualUrl.value.trim();
  if (!/^https?:\/\//i.test(u)) {
    showStatus('Enter a valid URL');
    return;
  }
  chrome.runtime.sendMessage({ type: 'send', url: u }, () => {
    showStatus('✓ Sent');
    setTimeout(() => window.close(), 700);
  });
});

manualUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendManual.click();
});
