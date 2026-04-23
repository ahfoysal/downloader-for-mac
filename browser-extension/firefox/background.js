// background.js — service worker
// Sends URLs to the Downloader for Mac app via the "downloader://" deep-link protocol.

const DEEP_LINK_PREFIX = 'downloader://url/';

function sendToApp(url) {
  if (!url) return;
  const deep = DEEP_LINK_PREFIX + encodeURIComponent(url);
  // Opening the deep link triggers the OS to hand off to Downloader for Mac.
  // We open it in the CURRENT tab via chrome.tabs.update so no new tab pops up
  // (and when the app takes over, the tab stays on the original page).
  // But update() would replace the page — safer: create a brief hidden tab.
  chrome.tabs.create({ url: deep, active: false }, (tab) => {
    // Close the helper tab after a second — the OS has already grabbed the link.
    setTimeout(() => {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
    }, 1200);
  });
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'Sent to Downloader for Mac',
      message: url.length > 80 ? url.slice(0, 77) + '…' : url,
    });
  } catch (_) {}
}

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
