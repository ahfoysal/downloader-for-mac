// background.js — service worker
// Primary transport: Native Messaging Host (silent, instant).
// Fallback: downloader:// deep-link via a brief helper tab.

const NATIVE_HOST = 'com.ahfoysal.downloader_for_mac';
const DEEP_LINK_PREFIX = 'downloader://url/';
let nativePort = null;

function connectNative() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener(handleAppMessage);
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      setTimeout(connectNative, 5000);
    });
  } catch (_) {
    nativePort = null;
    setTimeout(connectNative, 10000);
  }
}

function handleAppMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'progress') {
    const pct = Math.round(msg.percent || 0);
    chrome.action.setBadgeText({ text: pct > 0 ? `${pct}%` : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#03dac6' });
    chrome.action.setTitle({ title: `Downloading ${pct}% · ETA ${msg.eta || '?'}` });
  } else if (msg.type === 'complete') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
    chrome.action.setTitle({ title: 'Download complete' });
    setTimeout(() => { chrome.action.setBadgeText({ text: '' }); chrome.action.setTitle({ title: 'Send to Downloader for Mac' }); }, 5000);
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Download complete',
        message: msg.count > 1 ? `${msg.count} files saved` : 'File saved',
      });
    } catch (_) {}
  }
}

function fallbackOpenDeepLink(url) {
  const deep = DEEP_LINK_PREFIX + encodeURIComponent(url);
  chrome.tabs.create({ url: deep, active: false }, (tab) => {
    setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (_) {} }, 1200);
  });
}

function sendToApp(url) {
  if (!url) return;
  if (nativePort) {
    try {
      nativePort.postMessage({ type: 'send', url });
    } catch (_) {
      nativePort = null;
      fallbackOpenDeepLink(url);
      connectNative();
    }
  } else {
    fallbackOpenDeepLink(url);
  }
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'Sent to Downloader for Mac',
      message: url.length > 80 ? url.slice(0, 77) + '…' : url,
    });
  } catch (_) {}
}

// Open persistent connection at startup
connectNative();

// Context menu on page / link / video
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'send-page',
    title: 'Send page to Downloader for Mac',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'send-link',
    title: 'Send link to Downloader for Mac',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: 'send-video',
    title: 'Send video to Downloader for Mac',
    contexts: ['video', 'audio'],
  });
  // One-time handshake ping to register this extension with the app
  const manifest = chrome.runtime.getManifest();
  const browserName = navigator.userAgent.match(/(Firefox|Edg|OPR|Arc|Brave|Vivaldi)/i)?.[1] || 'chrome';
  const ping = `downloader://ping?browser=${encodeURIComponent(browserName)}&version=${encodeURIComponent(manifest.version)}`;
  chrome.tabs.create({ url: ping, active: false }, (tab) => {
    setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (_) {} }, 1200);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url = null;
  if (info.menuItemId === 'send-page') url = info.pageUrl || (tab && tab.url);
  else if (info.menuItemId === 'send-link') url = info.linkUrl;
  else if (info.menuItemId === 'send-video') url = info.srcUrl || info.pageUrl;
  sendToApp(url);
});

// Keyboard command
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'send_current_tab') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) sendToApp(tabs[0].url);
  });
});

// Per-tab media cache for the popup.
const tabMedia = {};           // { [tabId]: { urls: [...], pageUrl, pageTitle, supported } }
const autoSent = new Set();    // tabIds where we've already auto-sent on this page

async function getSetting(key, def) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (obj) => resolve(obj[key] === undefined ? def : obj[key]));
  });
}

function setBadge(tabId, count, supported) {
  const text = count > 0 ? (count > 9 ? '9+' : String(count)) : (supported ? '●' : '');
  const color = supported ? '#03dac6' : '#666';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'send' && msg.url) {
    sendToApp(msg.url);
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === 'send-active') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) sendToApp(tabs[0].url);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg && msg.type === 'page-media' && sender.tab) {
    const tabId = sender.tab.id;
    tabMedia[tabId] = {
      urls: msg.urls || [],
      pageUrl: msg.pageUrl,
      pageTitle: msg.pageTitle,
      supported: !!msg.supportedVideoPage,
    };
    setBadge(tabId, msg.urls.length, msg.supportedVideoPage);

    // Auto-send toggle
    getSetting('autoSendOnSupported', false).then((on) => {
      if (on && msg.supportedVideoPage && !autoSent.has(tabId)) {
        autoSent.add(tabId);
        sendToApp(msg.pageUrl);
      }
    });
    return;
  }
  if (msg && msg.type === 'get-tab-media' && msg.tabId) {
    sendResponse(tabMedia[msg.tabId] || { urls: [], supported: false });
    return;
  }
  if (msg && msg.type === 'send-many' && Array.isArray(msg.urls)) {
    msg.urls.forEach((u, i) => setTimeout(() => sendToApp(u), i * 400));
    sendResponse({ ok: true, count: msg.urls.length });
    return;
  }
});

// Clear per-tab state on navigation
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) {
    autoSent.delete(d.tabId);
    delete tabMedia[d.tabId];
    setBadge(d.tabId, 0, false);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabMedia[tabId];
  autoSent.delete(tabId);
});
