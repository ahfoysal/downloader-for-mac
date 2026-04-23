const tabTitleEl = document.getElementById('tabTitle');
const sendCurrent = document.getElementById('sendCurrent');
const mediaContainer = document.getElementById('mediaContainer');
const mediaCount = document.getElementById('mediaCount');
const sendSelected = document.getElementById('sendSelected');
const manualUrl = document.getElementById('manualUrl');
const sendManual = document.getElementById('sendManual');
const autoSendToggle = document.getElementById('autoSendToggle');
const status = document.getElementById('status');

function showStatus(msg) {
  status.textContent = msg;
  setTimeout(() => (status.textContent = ''), 2000);
}

function short(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname + u.search).slice(0, 40);
    return u.hostname.replace(/^www\./, '') + p;
  } catch (_) { return url.slice(0, 48); }
}

function renderMedia(urls) {
  if (!urls || urls.length === 0) {
    mediaContainer.innerHTML = '<div class="empty">No media detected on this page.</div>';
    mediaCount.style.display = 'none';
    sendSelected.style.display = 'none';
    return;
  }
  mediaCount.textContent = urls.length;
  mediaCount.style.display = 'inline-block';
  sendSelected.style.display = 'block';
  mediaContainer.innerHTML = '<div class="media-list">' + urls.map((u, i) => `
    <label class="media-item">
      <input type="checkbox" data-idx="${i}" ${i === 0 ? 'checked' : ''} />
      <span class="url" title="${u.replace(/"/g, '&quot;')}">${short(u)}</span>
    </label>
  `).join('') + '</div>';
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;
  tabTitleEl.textContent = tab.title || tab.url || '';
  tabTitleEl.title = tab.url || '';
  chrome.runtime.sendMessage({ type: 'get-tab-media', tabId: tab.id }, (data) => {
    if (chrome.runtime.lastError) return;
    renderMedia(data && data.urls);
  });
});

chrome.storage.local.get(['autoSendOnSupported'], (obj) => {
  autoSendToggle.checked = !!obj.autoSendOnSupported;
});
autoSendToggle.addEventListener('change', () => {
  chrome.storage.local.set({ autoSendOnSupported: autoSendToggle.checked });
  showStatus(autoSendToggle.checked ? 'Auto-send enabled' : 'Auto-send disabled');
});

sendCurrent.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'send-active' }, () => {
    showStatus('✓ Sent');
    setTimeout(() => window.close(), 700);
  });
});

sendSelected.addEventListener('click', () => {
  const checks = [...mediaContainer.querySelectorAll('input[type="checkbox"]:checked')];
  const urls = checks.map((c) => c.closest('.media-item').querySelector('.url').title);
  if (urls.length === 0) return showStatus('Pick at least one');
  chrome.runtime.sendMessage({ type: 'send-many', urls }, (res) => {
    showStatus(`✓ Sent ${res ? res.count : urls.length}`);
    setTimeout(() => window.close(), 900);
  });
});

sendManual.addEventListener('click', () => {
  const u = manualUrl.value.trim();
  if (!/^https?:\/\//i.test(u)) return showStatus('Enter a valid URL');
  chrome.runtime.sendMessage({ type: 'send', url: u }, () => {
    showStatus('✓ Sent');
    setTimeout(() => window.close(), 700);
  });
});
manualUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendManual.click(); });
