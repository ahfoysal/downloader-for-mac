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

// Popup messages
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'send' && msg.url) {
    sendToApp(msg.url);
    sendResponse({ ok: true });
  }
  if (msg && msg.type === 'send-active') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) sendToApp(tabs[0].url);
      sendResponse({ ok: true });
    });
    return true;
  }
});
