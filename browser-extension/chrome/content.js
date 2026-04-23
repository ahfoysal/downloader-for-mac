// content.js — scan the current page for downloadable media.
// Runs on every page load. Reports counts + URLs to the background worker.

(function () {
  const SUPPORTED_HOSTS = [
    'youtube.com', 'youtu.be', 'music.youtube.com',
    'vimeo.com', 'dailymotion.com',
    'twitter.com', 'x.com',
    'tiktok.com',
    'soundcloud.com',
    'twitch.tv',
    'facebook.com', 'instagram.com',
    'bilibili.com',
    'reddit.com',
  ];

  function isSupportedVideoPage() {
    const h = location.hostname.replace(/^www\./, '');
    return SUPPORTED_HOSTS.some((s) => h === s || h.endsWith('.' + s));
  }

  function hostOf(url) {
    try { return new URL(url, location.href).hostname.replace(/^www\./, ''); }
    catch (_) { return ''; }
  }

  function scanMedia() {
    const found = new Set();

    // <video> and <audio> elements with src or child <source>
    document.querySelectorAll('video, audio').forEach((el) => {
      if (el.src && /^https?:/.test(el.src)) found.add(el.src);
      el.querySelectorAll('source[src]').forEach((s) => {
        if (/^https?:/.test(s.src)) found.add(s.src);
      });
    });

    // Links pointing at known video sites
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      if (!/^https?:/.test(href)) return;
      const host = hostOf(href);
      if (SUPPORTED_HOSTS.some((s) => host === s || host.endsWith('.' + s))) {
        // Limit to likely watch URLs, not homepage links
        if (/watch\?v=|\/video\/|\/shorts\/|\/embed\/|youtu\.be\/|vimeo\.com\/\d+|\/status\/\d+|\/tracks\/|twitch\.tv\/videos\//.test(href)) {
          found.add(href);
        }
      }
    });

    return Array.from(found);
  }

  function pageThumbnail() {
    // Try og:image first, then twitter:image, then <video poster>, then YouTube thumbnail
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) return og.content;
    const tw = document.querySelector('meta[name="twitter:image"]');
    if (tw && tw.content) return tw.content;
    const poster = document.querySelector('video[poster]');
    if (poster && poster.poster) return poster.poster;
    // YouTube: extract video ID from URL
    const ytMatch = location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (ytMatch) return `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
    const ytShort = location.href.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (ytShort) return `https://i.ytimg.com/vi/${ytShort[1]}/hqdefault.jpg`;
    return null;
  }

  let lastReport = 0;
  function reportNow() {
    const urls = scanMedia();
    chrome.runtime.sendMessage({
      type: 'page-media',
      pageUrl: location.href,
      pageTitle: document.title,
      thumbnail: pageThumbnail(),
      supportedVideoPage: isSupportedVideoPage(),
      urls,
    });
    lastReport = Date.now();
  }

  // Initial scan
  setTimeout(reportNow, 800);

  // Re-scan when DOM changes significantly (SPAs like YouTube)
  const obs = new MutationObserver(() => {
    if (Date.now() - lastReport < 1500) return;
    reportNow();
  });
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Re-scan on navigation (history API)
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(reportNow, 600);
    }
  }, 1000);
})();
