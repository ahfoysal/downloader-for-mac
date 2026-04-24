// renderer.js — v2.0 mode-state UI
'use strict';

const api = window.electronAPI;
const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

// ============ State ============
const state = {
  mode: 'idle',
  view: 'download',
  urlInput: '',
  analyzedUrl: null,
  meta: null,
  selectedFormatId: null,
  selectedTile: 'audio',
  lastDownloadedFile: null,
  lastError: null,
  queueState: { active: [], queued: [] },
  playlistState: [],
  settings: {},
  history: [],
  sessionStarted: false,
};

// ============ Mode controller ============
function setView(name) {
  state.view = name;
  qsa('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  qsa('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  document.body.classList.toggle('view-browse', name === 'browse');
  document.body.classList.toggle('view-library', name === 'library');
  document.body.classList.toggle('view-download', name === 'download');
  if (name === 'library') renderLibrary();
  if (name === 'download') {
    renderRecentLanding();
    renderMostPlayedLanding();
    renderBrowseHistoryLanding();
  }
  if (name === 'browse') {
    initBrowse();
    reportBrowseBounds();
    api.browseSetVisible(true);
  } else {
    // Hide BrowserView when not on Browse tab
    api.browseSetVisible(false);
  }
}

function forceSizeWebviews() {
  const body = $('browseBody');
  if (!body) return;
  const bodyH = body.clientHeight;
  const bodyW = body.clientWidth;
  body.querySelectorAll('webview').forEach((wv) => {
    wv.style.width = bodyW + 'px';
    wv.style.height = bodyH + 'px';
    // Force Chromium to recompute viewport: toggle width by 1px then restore.
    // This is the canonical workaround for the <webview> static-viewport bug
    // where internal render size gets stuck at element's initial dimensions.
    setTimeout(() => {
      try {
        wv.style.width = (bodyW - 1) + 'px';
        requestAnimationFrame(() => { wv.style.width = bodyW + 'px'; });
      } catch (_) {}
    }, 0);
  });
}
// Run on window resize AND any mutation within the view hierarchy
window.addEventListener('resize', () => {
  if (state.view === 'browse') forceSizeWebviews();
});
// Ensure initial size is set once DOM paints
requestAnimationFrame(() => setTimeout(() => { if (state.view === 'browse' || !state.view) forceSizeWebviews(); }, 200));

function setMode(name) {
  state.mode = name;
  // If queue has >1 active+queued, force queue mode (but allow user to switch)
  const totalQueue = state.queueState.active.length + state.queueState.queued.length;
  const effective = totalQueue > 1 && (name === 'downloading' || name === 'idle') ? 'queue' : name;
  qsa('.mode').forEach((m) => m.classList.toggle('active', m.dataset.mode === effective));
}

// ============ Landing page: quick sites + recent library ============
const QUICK_SITES = [
  { name: 'Google',    url: 'https://www.google.com',    color: '#4285F4', letter: 'G' },
  { name: 'YouTube',   url: 'https://www.youtube.com',   color: '#FF0033', letter: 'Y' },
  { name: 'Vimeo',     url: 'https://vimeo.com',         color: '#19B7EA', letter: 'V' },
  { name: 'Twitter',   url: 'https://twitter.com',       color: '#1DA1F2', letter: '𝕏' },
  { name: 'TikTok',    url: 'https://www.tiktok.com',    color: '#000000', letter: 'T' },
  { name: 'Facebook',  url: 'https://www.facebook.com',  color: '#1877F2', letter: 'f' },
  { name: 'Instagram', url: 'https://www.instagram.com', color: '#E4405F', letter: 'I' },
  { name: 'Twitch',    url: 'https://www.twitch.tv',     color: '#9146FF', letter: 't' },
  { name: 'Reddit',    url: 'https://www.reddit.com',    color: '#FF4500', letter: 'r' },
  { name: 'SoundCloud',url: 'https://soundcloud.com',    color: '#FF5500', letter: 'S' },
];

function renderQuickSites() {
  const el = $('quickSites');
  if (!el) return;
  el.innerHTML = QUICK_SITES.map((s) =>
    `<div class="quick-site" data-url="${s.url}">
      <div class="qs-icon" style="background:${s.color}">${s.letter}</div>
      <div class="qs-name">${s.name}</div>
    </div>`
  ).join('');
  el.querySelectorAll('[data-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      setView('browse');
      setTimeout(() => {
        // Navigate the active BrowserView tab instead of creating a new one
        if (browseTabsState.length) api.browseNavigate(null, url);
        else api.browseCreateTab(url);
      }, 60);
    });
  });
}

function mediaCard(e) {
  const audio = ['mp3', 'm4a', 'webm', 'flac', 'ogg', 'wav', 'opus', 'aac'].includes((e.format || '').toLowerCase());
  const icon = audio
    ? `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
    : `<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><polygon points="8 5 19 12 8 19 8 5"/></svg>`;
  const thumb = e.thumbnail
    ? `<img src="${e.thumbnail}" />`
    : `<div class="rc-thumb-placeholder">${icon}</div>`;
  return `<div class="recent-card" data-path="${(e.filepath || '').replace(/"/g, '&quot;')}" data-title="${(e.title || '').replace(/"/g, '&quot;')}">
    <div class="rc-thumb">${thumb}</div>
    <div class="rc-title">${(e.title || 'Untitled').replace(/</g, '&lt;')}</div>
  </div>`;
}

async function renderRecentLanding() {
  const section = $('recentSection');
  const el = $('recentRow');
  if (!el || !section) return;
  const entries = (await api.getHistory() || []).filter((e) => e.filepath).slice(0, 10);
  if (entries.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  el.innerHTML = entries.map(mediaCard).join('');
  el.querySelectorAll('.recent-card').forEach((card) => {
    card.addEventListener('click', () => {
      const path = card.dataset.path;
      if (path) playFile(path, card.dataset.title);
    });
  });
}

async function renderMostPlayedLanding() {
  const section = $('mostPlayedSection');
  const el = $('mostPlayedRow');
  if (!el || !section) return;
  const counts = await api.getPlayCounts();
  const history = await api.getHistory();
  const byPath = new Map(history.map((h) => [h.filepath, h]));
  const entries = Object.entries(counts)
    .map(([fp, c]) => ({ ...(byPath.get(fp) || {}), filepath: fp, plays: c }))
    .filter((e) => e.filepath)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 10);
  if (entries.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  el.innerHTML = entries.map((e) => `${mediaCard(e).replace('<div class="rc-title">', `<div class="rc-title" title="${e.plays} plays">${e.plays}× · `)}`).join('');
  el.querySelectorAll('.recent-card').forEach((card) => {
    card.addEventListener('click', () => {
      const path = card.dataset.path;
      if (path) playFile(path, card.dataset.title);
    });
  });
}

async function renderBrowseHistoryLanding() {
  const section = $('browseHistorySection');
  const el = $('browseHistoryRow');
  if (!el || !section) return;
  const list = await api.getBrowseHistory();
  if (!list || list.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  el.innerHTML = list.slice(0, 12).map((h) => {
    let host = '?'; try { host = new URL(h.url).hostname.replace(/^www\./, ''); } catch (_) {}
    const letter = (host[0] || '?').toUpperCase();
    return `<div class="recent-card" data-browse-url="${h.url.replace(/"/g, '&quot;')}">
      <div class="rc-thumb" style="display:flex;align-items:center;justify-content:center;">
        <div class="rc-thumb-placeholder" style="font-size:28px;font-weight:800;color:var(--accent);">${letter}</div>
      </div>
      <div class="rc-title">${(h.title || host).replace(/</g, '&lt;')}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.recent-card').forEach((card) => {
    card.addEventListener('click', () => {
      const url = card.dataset.browseUrl;
      if (!url) return;
      setView('browse');
      setTimeout(() => {
        if (browseTabsState.length) api.browseNavigate(null, url);
        else api.browseCreateTab(url);
      }, 60);
    });
  });
}

// Hook clear button
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'clearBrowseHistoryBtn') {
    await api.clearBrowseHistory();
    renderBrowseHistoryLanding();
  }
});

document.querySelectorAll('[data-goto]').forEach((el) => {
  el.addEventListener('click', () => setView(el.dataset.goto));
});

// ============ URL input + auto-analyze ============
const urlInput = $('urlInput');
const urlWrap = $('urlWrap');
const btnDownload = $('btnDownload');
const tileVideo = $('tileVideo');
const tileAudio = $('tileAudio');
const videoQuality = $('videoQuality');
const audioFormat = $('audioFormat');

urlInput.addEventListener('input', () => {
  state.urlInput = urlInput.value.trim();
  btnDownload.disabled = !/^https?:\/\//i.test(state.urlInput);
  detectPlaylistUrl();
});
urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    const u = urlInput.value.trim();
    if (/^https?:\/\//i.test(u)) {
      state.urlInput = u;
      detectPlaylistUrl();
      analyzeUrl(u);
    }
  }, 10);
});
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.urlInput) {
    if (state.mode === 'idle') {
      if (state.analyzedUrl === state.urlInput) openReady();
      else analyzeUrl(state.urlInput);
    }
  }
});

// Track URLs we've already asked about to avoid repeating the prompt on every keystroke
const playlistAsked = new Map(); // url -> 'single' | 'playlist'

function isPlaylistUrl(u) {
  return /[?&]list=[^&]+/i.test(u) || /\/playlist\?/.test(u) || /\/channel\//.test(u) || /\/@[\w.-]+\/?$/.test(u);
}

function detectPlaylistUrl() {
  const u = state.urlInput;
  if (!/^https?:\/\//i.test(u)) return;
  if (!isPlaylistUrl(u)) {
    $('optPlaylist').checked = false;
    return;
  }
  if (playlistAsked.has(u)) {
    $('optPlaylist').checked = playlistAsked.get(u) === 'playlist';
    return;
  }
  askPlaylistChoice(u).then((choice) => {
    playlistAsked.set(u, choice);
    $('optPlaylist').checked = choice === 'playlist';
  });
}

// Returns Promise<'single' | 'playlist'>
function askPlaylistChoice(url) {
  return new Promise((resolve) => {
    const existing = document.getElementById('playlistConfirm');
    if (existing) existing.remove();
    const dlg = document.createElement('div');
    dlg.id = 'playlistConfirm';
    dlg.className = 'modal show';
    dlg.innerHTML = `
      <div class="modal-body" style="width:420px;">
        <div class="modal-head">
          <h2>Playlist detected</h2>
          <p>This URL is part of a playlist or channel. What would you like to download?</p>
        </div>
        <div class="modal-content">
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn btn-primary btn-lg" data-choice="single" style="justify-content:flex-start;padding:14px 16px;">
              <svg class="ico" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <div style="text-align:left;margin-left:8px;">
                <div>Only this video</div>
                <div style="font-size:11px;font-weight:400;opacity:0.7;margin-top:2px;">Download the single video (default)</div>
              </div>
            </button>
            <button class="btn btn-secondary btn-lg" data-choice="playlist" style="justify-content:flex-start;padding:14px 16px;">
              <svg class="ico" viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              <div style="text-align:left;margin-left:8px;">
                <div>Whole playlist</div>
                <div style="font-size:11px;font-weight:400;opacity:0.7;margin-top:2px;">Download every video into its own folder</div>
              </div>
            </button>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:14px;line-height:1.5;word-break:break-all;">${url.replace(/</g, '&lt;').slice(0, 120)}${url.length > 120 ? '…' : ''}</div>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    function done(choice) {
      dlg.remove();
      resolve(choice);
    }
    dlg.querySelectorAll('[data-choice]').forEach((btn) => {
      btn.addEventListener('click', () => done(btn.dataset.choice));
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done('single'); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done('single'); }
    }, { once: true });
  });
}

async function analyzeUrl(url) {
  if (!url) return;
  urlWrap.classList.add('loading');
  const res = await api.probeFormats(url);
  urlWrap.classList.remove('loading');
  if (!res.ok) {
    toast(res.error || 'Could not analyze URL', 'error');
    return;
  }
  state.analyzedUrl = url;
  state.meta = res;
  prepReady(res);
}

// ============ Tiles (video/audio) ============
[tileVideo, tileAudio].forEach((tile) => {
  tile.addEventListener('click', (e) => {
    if (e.target.tagName === 'SELECT') return;
    state.selectedTile = tile.dataset.tile;
    tileVideo.classList.toggle('selected', state.selectedTile === 'video');
    tileAudio.classList.toggle('selected', state.selectedTile === 'audio');
    api.updateSettings({ selectedTile: state.selectedTile });
  });
});
videoQuality.addEventListener('change', () => api.updateSettings({ videoQuality: videoQuality.value }));
audioFormat.addEventListener('change', () => api.updateSettings({ audioFormat: audioFormat.value }));

function currentFormat() {
  if (state.selectedTile === 'video') return videoQuality.value; // best/1080/720/480
  return audioFormat.value; // mp3/m4a/webm
}

// ============ More-options drawer ============
const moreToggle = $('moreToggle');
const optionsDrawer = $('optionsDrawer');
moreToggle.addEventListener('click', () => {
  const isOpen = optionsDrawer.classList.toggle('open');
  moreToggle.classList.toggle('open', isOpen);
});
const optClip = $('optClip');
const clipInputs = $('clipInputs');
optClip.addEventListener('change', () => clipInputs.classList.toggle('hidden', !optClip.checked));

// ============ Ready mode ============
function prepReady(meta) {
  $('readyThumb').src = meta.thumbnail || '';
  $('readyTitle').textContent = meta.title || 'Untitled';
  const parts = [];
  if (meta.uploader) parts.push(meta.uploader);
  if (meta.duration) parts.push(fmtDur(meta.duration));
  $('readyMeta').textContent = parts.join(' · ');
  // Build quality chips
  const grid = $('qualityGrid');
  const videos = (meta.formats || []).filter((f) => f.vcodec).sort((a, b) => (b.height || 0) - (a.height || 0));
  const audios = (meta.formats || []).filter((f) => !f.vcodec && f.acodec).sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const dedup = [];
  const seen = new Set();
  [...videos.slice(0, 6), ...audios.slice(0, 3)].forEach((f) => {
    const key = f.height ? `v${f.height}${f.ext}` : `a${Math.round(f.abr || 0)}${f.ext}`;
    if (!seen.has(key)) { seen.add(key); dedup.push(f); }
  });
  // Always prepend quick-presets: Best / 1080 / 720 / MP3
  grid.innerHTML = `
    <span class="quality-chip selected" data-preset="auto">Auto (${state.selectedTile})</span>
    <span class="quality-chip" data-preset="best">Best MP4</span>
    <span class="quality-chip" data-preset="1080">1080p</span>
    <span class="quality-chip" data-preset="720">720p</span>
    <span class="quality-chip" data-preset="mp3">MP3</span>
  ` + dedup.map((f) =>
    `<span class="quality-chip" data-format-id="${f.format_id}">${describeFormat(f)}</span>`
  ).join('');
  state.selectedFormatId = null;
  grid.querySelectorAll('.quality-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      grid.querySelectorAll('.quality-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      state.selectedFormatId = chip.dataset.formatId || null;
      if (chip.dataset.preset === 'mp3') { state.selectedTile = 'audio'; audioFormat.value = 'mp3'; }
      else if (chip.dataset.preset === 'best') { state.selectedTile = 'video'; videoQuality.value = 'best'; }
      else if (chip.dataset.preset === '1080') { state.selectedTile = 'video'; videoQuality.value = '1080'; }
      else if (chip.dataset.preset === '720') { state.selectedTile = 'video'; videoQuality.value = '720'; }
    });
  });
  openReady();
}

function openReady() { setMode('ready'); }
$('btnReadyCancel').addEventListener('click', () => setMode('idle'));

$('btnReadyDownload').addEventListener('click', startDownload);
btnDownload.addEventListener('click', () => {
  if (!state.urlInput) return;
  // Kick off analyze in background so thumbnail shows up in the dl card
  if (state.analyzedUrl !== state.urlInput) analyzeUrl(state.urlInput);
  startDownload();
});

async function startDownload() {
  const url = state.urlInput;
  if (!/^https?:\/\//i.test(url)) { toast('Paste a URL first', 'error'); return; }
  // Dedup check
  const dup = await api.checkDuplicate(url);
  if (dup.duplicate) {
    if (!confirm(`Already downloaded:\n${dup.filepath}\n\nDownload again?`)) return;
  }

  // Fast probe reuse: ONLY use what's already cached — never block the user
  // waiting for a new probe. Backend will handle the probe if needed.
  let prefetched = state.meta || probeCache.get(url);
  if (!prefetched && !$('optPlaylist').checked) {
    prefetched = await api.probeCacheGet(url); // disk read is fast (<10ms)
  }

  const format = currentFormat();
  const opts = {
    playlist: $('optPlaylist').checked,
    subtitles: $('optSubs').checked,
    cookiesBrowser: $('optCookies').value,
    formatId: state.selectedFormatId,
    startTime: optClip.checked ? $('clipStart').value.trim() || null : null,
    endTime: optClip.checked ? $('clipEnd').value.trim() || null : null,
    resume: $('optResume').checked,
    prefetchedMeta: prefetched ? {
      title: prefetched.title || null,
      uploader: prefetched.uploader || null,
      thumbnail: prefetched.thumbnail || null,
      duration: prefetched.duration || null,
      skipProbe: !$('optPlaylist').checked,
    } : null,
  };
  // Reset UI to downloading state
  state.playlistState = [];
  $('playlistListWrap').innerHTML = '';
  $('playlistListWrap').classList.add('hidden');
  $('dlTitle').textContent = state.meta && state.meta.title ? state.meta.title : 'Starting…';
  $('dlSub').textContent = 'Fetching video info…';
  $('dlPercent').textContent = '0%';
  $('dlSpeed').textContent = '—';
  $('dlEta').textContent = '—';
  $('dlBarWrap').classList.add('indeterminate');
  $('dlBar').style.width = '0%';
  const thumb = state.meta && state.meta.thumbnail;
  if (thumb) {
    $('dlThumb').src = thumb;
    $('dlThumb').classList.remove('hidden');
    $('dlThumbPlaceholder').classList.add('hidden');
  } else {
    $('dlThumb').classList.add('hidden');
    $('dlThumbPlaceholder').classList.remove('hidden');
  }
  setMode('downloading');
  api.downloadAudio(url, format, opts);
}

$('btnCancel').addEventListener('click', () => api.cancelDownload());

// ============ Download events ============
api.onMeta((meta) => {
  if (state.mode === 'downloading') {
    if (meta.title) $('dlTitle').textContent = meta.title;
    if (meta.uploader) $('dlSub').textContent = meta.uploader;
    if (meta.thumbnail) {
      $('dlThumb').src = meta.thumbnail;
      $('dlThumb').classList.remove('hidden');
      $('dlThumbPlaceholder').classList.add('hidden');
    }
  }
});
api.onStatus((msg) => { if (state.mode === 'downloading') $('dlSub').textContent = msg; });
api.onProgress((data) => {
  if (state.mode !== 'downloading' && state.mode !== 'queue') return;
  const pct = parseFloat(data.percent) || 0;
  $('dlBarWrap').classList.remove('indeterminate');
  $('dlBar').style.width = pct + '%';
  $('dlPercent').textContent = pct.toFixed(1) + '%';
  $('dlSpeed').textContent = data.speed || '—';
  $('dlEta').textContent = data.eta ? 'ETA ' + data.eta : '—';
  // Per-item mini-bar for playlists
  if (data.item && data.item.index && data.item.index !== 'NA') {
    const idx = parseInt(data.item.index, 10);
    const it = state.playlistState.find((x) => x.index === idx);
    if (it) { it.percent = pct; renderPlaylist(); }
  }
});
api.onPlaylistItems((items) => {
  state.playlistState = items.map((it) => ({ ...it, state: 'pending', percent: 0 }));
  renderPlaylist();
});
api.onItemState((data) => {
  const it = state.playlistState.find((x) => x.index === data.index);
  if (!it) return;
  it.state = data.state;
  if (data.title) it.title = data.title;
  if (data.filepath) it.filepath = data.filepath;
  if (data.error) it.error = data.error;
  if (data.state === 'downloading') { it.percent = 0; it.error = null; }
  if (data.state === 'done') it.percent = 100;
  renderPlaylist();
});
function renderPlaylist() {
  const wrap = $('playlistListWrap');
  if (state.playlistState.length === 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const done = state.playlistState.filter((i) => i.state === 'done').length;
  wrap.innerHTML = `
    <div class="pl-list">
      <div class="pl-head"><strong>Playlist</strong><span>${done}/${state.playlistState.length} done</span></div>
      ${state.playlistState.map((it) => `
        <div class="pl-item ${it.state}">
          <span class="pl-idx">${String(it.index).padStart(3, '0')}</span>
          <span class="pl-title" title="${(it.title||'').replace(/"/g,'&quot;')}">${(it.title||'').replace(/</g,'&lt;')}</span>
          ${it.state === 'error' && it.url ? `<button class="pl-retry" data-retry="${it.index}">Retry</button>` : ''}
          <span class="pl-state">${it.state}</span>
        </div>
      `).join('')}
    </div>
  `;
  wrap.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.retry);
      const it = state.playlistState.find((x) => x.index === idx);
      if (!it || !it.url) return;
      api.retryItem({
        url: it.url,
        format: currentFormat(),
        index: idx,
        playlistFolder: state.meta && state.meta.title ? state.meta.title.replace(/[\\/:*?"<>|]/g, '_') : null,
        subtitles: $('optSubs').checked,
        cookiesBrowser: $('optCookies').value,
      });
    });
  });
}

api.onComplete(async (payload) => {
  state.lastDownloadedFile = payload && payload.filepath;
  if (state.queueState.active.length + state.queueState.queued.length <= 1) {
    setMode('done');
    $('doneTitle').textContent = payload && payload.count > 1 ? `${payload.count} files downloaded` : 'Download complete';
    $('doneSub').textContent = state.lastDownloadedFile || '';
    const actions = $('doneActions');
    actions.innerHTML = `
      ${state.lastDownloadedFile ? `
        <button class="btn btn-secondary btn-sm" data-done="show">Show</button>
        <button class="btn btn-secondary btn-sm" data-done="copy">Copy path</button>
      ` : ''}
      <button class="btn btn-primary btn-sm" data-done="new">New download</button>
    `;
    actions.querySelectorAll('[data-done]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = b.dataset.done;
        if (a === 'show' && state.lastDownloadedFile) api.revealFile(state.lastDownloadedFile);
        else if (a === 'copy' && state.lastDownloadedFile) { navigator.clipboard.writeText(state.lastDownloadedFile); toast('Path copied', 'success'); }
        else if (a === 'new') { urlInput.value = ''; state.urlInput = ''; state.analyzedUrl = null; state.meta = null; setMode('idle'); urlInput.focus(); }
      });
    });
  }
  if (payload && payload.history) state.history = payload.history;
  if (state.view === 'library') renderLibrary();
});
api.onError((msg) => {
  state.lastError = msg;
  $('errorMsg').textContent = msg || 'Unknown error';
  if (state.queueState.active.length + state.queueState.queued.length <= 1) setMode('error');
});
$('btnErrorDismiss').addEventListener('click', () => setMode('idle'));
$('btnErrorRetry').addEventListener('click', () => { setMode('idle'); btnDownload.click(); });

// ============ Queue panel ============
let queueRenderTimer = null;
function scheduleQueueRender() {
  if (queueRenderTimer) return;
  queueRenderTimer = requestAnimationFrame(() => {
    queueRenderTimer = null;
    renderQueue();
  });
}

api.onQueueState((data) => {
  const prevTotal = state.queueState.active.length + state.queueState.queued.length;
  state.queueState = data;
  // Throttle DOM re-renders to once per animation frame
  scheduleQueueRender();
  const total = data.active.length + data.queued.length;
  // >1 parallel → queue view
  if (total > 1) {
    setMode('queue');
    return;
  }
  // Exactly 1 active and we're currently idle/done/error → show the downloading card
  if (data.active.length === 1 && (state.mode === 'idle' || state.mode === 'done' || state.mode === 'error' || state.mode === 'queue')) {
    const d = data.active[0];
    $('dlTitle').textContent = d.title || d.url || 'Downloading…';
    $('dlSub').textContent = d.state === 'starting' ? 'Fetching video info…' : (d.speed ? d.speed : 'Starting…');
    const pct = d.percent || 0;
    $('dlPercent').textContent = pct.toFixed(1) + '%';
    $('dlBar').style.width = pct + '%';
    $('dlBarWrap').classList.toggle('indeterminate', pct === 0);
    $('dlSpeed').textContent = d.speed || '—';
    $('dlEta').textContent = d.eta ? 'ETA ' + d.eta : '—';
    $('dlThumb').classList.add('hidden');
    $('dlThumbPlaceholder').classList.remove('hidden');
    setMode('downloading');
    return;
  }
  // Nothing happening any more; if we were in queue mode, drop back to idle
  if (total === 0 && state.mode === 'queue') setMode('idle');
});
function renderQueue() {
  $('queueCount').textContent = `${state.queueState.active.length} active · ${state.queueState.queued.length} waiting`;
  const rows = $('queueRows');
  rows.innerHTML = [
    ...state.queueState.active.map((d) => {
      const pct = Math.round(d.percent || 0);
      return `
        <div class="q-row active" data-id="${d.id}">
          <div class="q-row-body">
            <div class="q-row-title">${(d.title || d.url || '').replace(/</g, '&lt;')}</div>
            <div class="q-row-meta">
              <span>${(d.format || '').toUpperCase()}</span>
              <span>· ${pct}%</span>
              ${d.speed ? `<span>· ${d.speed}</span>` : ''}
              ${d.eta ? `<span>· ETA ${d.eta}</span>` : ''}
            </div>
            <div class="q-mini-bar"><div class="q-mini-bar-fill" style="width:${pct}%"></div></div>
          </div>
          <button class="q-cancel" data-cancel="${d.id}">×</button>
        </div>`;
    }),
    ...state.queueState.queued.map((d) => `
      <div class="q-row pending" data-id="${d.id}" draggable="true">
        <span class="q-handle">⋮⋮</span>
        <div class="q-row-body">
          <div class="q-row-title">${(d.url || '').replace(/</g, '&lt;')}</div>
          <div class="q-row-meta"><span>${(d.format || '').toUpperCase()}</span><span>· waiting</span></div>
        </div>
        <button class="q-cancel" data-cancel="${d.id}">×</button>
      </div>`),
  ].join('');
  rows.querySelectorAll('[data-cancel]').forEach((b) => {
    b.addEventListener('click', () => api.cancelDownloadById(b.dataset.cancel));
  });
  // Drag reorder
  let dragSrc = null;
  rows.querySelectorAll('.q-row.pending').forEach((el) => {
    el.addEventListener('dragstart', () => { dragSrc = el; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      const ids = [...rows.querySelectorAll('.q-row.pending')].map((r) => r.dataset.id);
      api.reorderQueue(ids);
      dragSrc = null;
    });
  });
  rows.addEventListener('dragover', (e) => {
    const t = e.target.closest('.q-row.pending');
    if (!t || !dragSrc || t === dragSrc) return;
    e.preventDefault();
    const r = t.getBoundingClientRect();
    t.parentNode.insertBefore(dragSrc, e.clientY > r.top + r.height / 2 ? t.nextSibling : t);
  });
}

// ============ Tabs ============
qsa('.nav-tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.tab)));

// ============ Library ============
const librarySearch = $('librarySearch');
librarySearch.addEventListener('input', renderLibrary);

async function renderLibrary() {
  // First, auto-heal: scan download folder for orphan files and add them to history
  try { await api.reconcileLibrary(); } catch (_) {}
  let entries = await api.getHistory();
  // Sort: recently added first. Fall back to file mtime when timestamp missing.
  entries = [...entries].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  state.history = entries;
  const q = librarySearch.value.trim().toLowerCase();
  const enriched = await Promise.all(entries.map(async (e) => {
    const [exists, pos] = await Promise.all([api.fileExists(e.filepath), api.getPlayPosition(e.filepath)]);
    return { ...e, _exists: !!exists, _pos: pos };
  }));
  const filtered = q ? enriched.filter((e) =>
    (e.title || '').toLowerCase().includes(q) ||
    (e.uploader || '').toLowerCase().includes(q) ||
    (e.format || '').toLowerCase().includes(q)
  ) : enriched;
  const onDisk = enriched.filter((e) => e._exists).length;
  $('libraryStats').textContent = `${onDisk} of ${enriched.length} on disk${q ? ` · showing ${filtered.length}` : ''}`;
  const container = $('libraryContainer');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="lib-empty">
      <svg class="ico ico-lg" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      <div>${entries.length === 0 ? 'No downloads yet.' : 'No matches.'}</div>
    </div>`;
    return;
  }

  const AUDIO_FORMATS = ['mp3', 'm4a', 'webm', 'flac', 'ogg', 'wav', 'opus', 'aac'];
  const isAudio = (e) => AUDIO_FORMATS.includes((e.format || '').toLowerCase());

  function renderCard(e) {
    const resume = e._pos && e._pos.duration ? Math.round((e._pos.pos / e._pos.duration) * 100) : 0;
    const audio = isAudio(e);
    const icon = audio
      ? `<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
      : `<svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><polygon points="8 5 19 12 8 19 8 5"/></svg>`;
    const thumb = e.thumbnail
      ? `<img class="lib-card-thumb" src="${e.thumbnail}" onerror="this.outerHTML='<div class=\\'lib-card-thumb-placeholder\\'>${icon.replace(/'/g, '&apos;').replace(/"/g, '&quot;')}</div>'" />`
      : `<div class="lib-card-thumb-placeholder">${icon}</div>`;
    return `
      <div class="lib-card ${audio ? 'audio' : 'video'} ${e._exists ? '' : 'missing'}" data-path="${(e.filepath || '').replace(/"/g, '&quot;')}" data-title="${(e.title || '').replace(/"/g, '&quot;')}">
        <div class="lib-card-thumb-wrap">
          ${thumb}
          ${e._exists ? `<button class="lib-card-play" data-play title="Play">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          </button>` : ''}
          ${resume > 0 && resume < 95 ? `<div class="lib-card-resume"><div class="lib-card-resume-fill" style="width:${resume}%"></div></div>` : ''}
        </div>
        <div class="lib-card-title">${(e.title || 'Untitled').replace(/</g, '&lt;')}</div>
        <div class="lib-card-meta">${(e.format || '').toUpperCase()}${e.uploader ? ' · ' + e.uploader : ''}</div>
      </div>
    `;
  }

  // Sections: Recently added (horizontal row), Audio, Video
  const recent = filtered.slice(0, 10);
  const audios = filtered.filter(isAudio);
  const videos = filtered.filter((e) => !isAudio(e));
  let html = '';
  if (!q && recent.length) {
    html += `<div class="lib-section">
      <div class="lib-section-head">
        <h3>Recently added</h3>
        <span class="lib-section-count">${recent.length}</span>
      </div>
      <div class="lib-row">${recent.map(renderCard).join('')}</div>
    </div>`;
  }
  if (audios.length) {
    html += `<div class="lib-section">
      <div class="lib-section-head"><h3>${q ? 'Audio matches' : 'Audio'}</h3><span class="lib-section-count">${audios.length}</span></div>
      <div class="lib-grid">${audios.map(renderCard).join('')}</div>
    </div>`;
  }
  if (videos.length) {
    html += `<div class="lib-section">
      <div class="lib-section-head"><h3>${q ? 'Video matches' : 'Video'}</h3><span class="lib-section-count">${videos.length}</span></div>
      <div class="lib-grid">${videos.map(renderCard).join('')}</div>
    </div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.lib-card').forEach((card) => {
    const go = () => {
      const path = card.dataset.path;
      if (!path || card.classList.contains('missing')) return;
      playFile(path, card.dataset.title);
    };
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-play]')) return; // play btn has its own handler below
      go();
    });
    const playBtn = card.querySelector('[data-play]');
    if (playBtn) playBtn.addEventListener('click', (ev) => { ev.stopPropagation(); go(); });
    card.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (!card.dataset.path) return;
      showLibContextMenu(e.clientX, e.clientY, card.dataset.path);
    });
  });
}

// ============ Library context menu (right-click on card) ============
function showLibContextMenu(x, y, filepath) {
  const existing = document.getElementById('libCtxMenu');
  if (existing) existing.remove();
  const m = document.createElement('div');
  m.id = 'libCtxMenu';
  m.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;z-index:900;box-shadow:var(--shadow-md);min-width:180px;`;
  const items = [
    { label: 'Play', fn: () => playFile(filepath) },
    { label: 'Show in Finder', fn: () => api.revealFile(filepath) },
    { label: 'Copy path', fn: () => navigator.clipboard.writeText(filepath) },
    { type: 'sep' },
    { label: 'Edit metadata…', fn: () => openMetadataEditor(filepath) },
    { type: 'sep' },
    { label: 'Delete from history', fn: async () => {
      const match = state.history.find((h) => h.filepath === filepath);
      if (match) { await api.deleteHistoryEntry(match.id); renderLibrary(); }
    }},
  ];
  m.innerHTML = items.map((it, i) => it.type === 'sep'
    ? '<div style="height:1px;background:var(--border);margin:4px 0;"></div>'
    : `<div data-i="${i}" style="padding:7px 12px;border-radius:5px;font-size:12.5px;cursor:pointer;color:var(--text);">${it.label}</div>`
  ).join('');
  document.body.appendChild(m);
  m.querySelectorAll('[data-i]').forEach((el) => {
    el.addEventListener('mouseenter', () => el.style.background = 'var(--surface-2)');
    el.addEventListener('mouseleave', () => el.style.background = '');
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.i);
      const it = items[i];
      if (it && it.fn) it.fn();
      m.remove();
    });
  });
  const close = (e) => {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ============ Metadata editor ============
const metaModal = $('metaModal');
let metaEditingPath = null;
async function openMetadataEditor(filepath) {
  metaEditingPath = filepath;
  $('metaFilepath').textContent = filepath;
  const meta = await api.readMetadata(filepath);
  $('metaTitle').value = (meta && meta.title) || '';
  $('metaArtist').value = (meta && meta.artist) || '';
  $('metaAlbum').value = (meta && meta.album) || '';
  $('metaYear').value = (meta && meta.year) || '';
  $('metaGenre').value = (meta && meta.genre) || '';
  $('metaTrack').value = (meta && meta.track) || '';
  metaModal.classList.add('show');
}
$('metaCancel') && $('metaCancel').addEventListener('click', () => metaModal.classList.remove('show'));
metaModal && metaModal.addEventListener('click', (e) => { if (e.target === metaModal) metaModal.classList.remove('show'); });
$('metaSave') && $('metaSave').addEventListener('click', async () => {
  if (!metaEditingPath) return;
  const tags = {
    title: $('metaTitle').value.trim(),
    artist: $('metaArtist').value.trim(),
    album: $('metaAlbum').value.trim(),
    year: $('metaYear').value.trim(),
    genre: $('metaGenre').value.trim(),
    track: $('metaTrack').value.trim(),
  };
  const res = await api.writeMetadata(metaEditingPath, tags);
  if (res && res.ok) {
    toast('Metadata saved', 'success');
    metaModal.classList.remove('show');
    renderLibrary();
  } else {
    toast((res && res.error) || 'Save failed', 'error');
  }
});

// ============ Player ============
const player = $('player');
const playerVideo = $('playerVideo');
const playerAudio = playerVideo; // unified: video element handles both audio & video
const musicView = $('musicView');
const musicArtWrap = $('musicArtWrap');
const playerTitle = $('playerTitle');

const musicArt = $('musicArt');
const musicArtPlaceholder = $('musicArtPlaceholder');
const musicTitle = $('musicTitle');
const musicArtist = $('musicArtist');
const musicPlayBtn = $('musicPlayBtn');
const musicPlayIcon = $('musicPlayIcon');
const musicBar = $('musicBar');
const musicBarFill = $('musicBarFill');
const musicBarHandle = $('musicBarHandle');
const musicCurTime = $('musicCurTime');
const musicTotalTime = $('musicTotalTime');
const musicBack15 = $('musicBack15');
const musicFwd15 = $('musicFwd15');
const musicPrev = $('musicPrev');
const musicNext = $('musicNext');
const musicVolume = $('musicVolume');
const musicSpeedBtn = $('musicSpeedBtn');

let currentPlaying = null;
let currentIsAudio = false;
let playlistForPlayer = [];
let playerIdx = -1;

const AUDIO_EXTS = ['mp3', 'm4a', 'webm', 'flac', 'ogg', 'wav', 'opus', 'aac'];

function isAudioFile(filepath) {
  const ext = (filepath.split('.').pop() || '').toLowerCase();
  return AUDIO_EXTS.includes(ext);
}

// Unified: video element plays both audio and video files.
// Previously split into audio/video elements; keep alias for safety.
function getActiveMediaEl() { return playerVideo; }  // kept as helper; always video element

function fmtTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function playFile(filepath, title, entry) {
  currentPlaying = filepath;
  currentIsAudio = isAudioFile(filepath);

  // Build playback queue from currently-visible library items
  playlistForPlayer = (state.history || []).filter((e) => e.filepath && e._exists !== false);
  playerIdx = playlistForPlayer.findIndex((e) => e.filepath === filepath);
  updateNavButtons();

  playerVideo.pause();
  playerTitle.textContent = title || filepath.split('/').pop();

  // Toggle art wrapper between square (audio) and 16:9 (video)
  musicArtWrap.classList.toggle('video-mode', !currentIsAudio);

  const match = state.history.find((e) => e.filepath === filepath);
  const thumbUrl = (entry && entry.thumbnail) || (match && match.thumbnail) || null;

  if (currentIsAudio) {
    // Show thumbnail + hide video element (audio-only has no visual track)
    playerVideo.classList.remove('show');
    if (thumbUrl) {
      musicArt.src = thumbUrl;
      musicArt.classList.add('show');
      musicArtPlaceholder.style.display = 'none';
    } else {
      musicArt.classList.remove('show');
      musicArt.removeAttribute('src');
      musicArtPlaceholder.style.display = 'flex';
    }
  } else {
    // Video file: show video, hide thumbnail/placeholder
    musicArt.classList.remove('show');
    musicArtPlaceholder.style.display = 'none';
    playerVideo.classList.add('show');
  }

  playerVideo.src = 'file://' + encodeURI(filepath);
  musicTitle.textContent = title || filepath.split('/').pop().replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  musicArtist.textContent = (match && match.uploader) || (match && match.playlist) || '';
  await loadResumePosition(playerVideo, filepath);
  try { await playerVideo.play(); api.incrementPlayCount(filepath); } catch (_) {}

  // Dynamic backdrop color from album art
  if (thumbUrl) applyBackdropColor(thumbUrl);

  // Reset lyrics for the new track. If the pane is open, reload after we have duration.
  lyricsData = null;
  if (lyricsShown) {
    lyricsPane.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Loading lyrics…</div>';
    const reload = () => {
      playerVideo.removeEventListener('loadedmetadata', reload);
      loadLyrics(musicTitle.textContent, musicArtist.textContent);
    };
    if (playerVideo.readyState >= 1 && isFinite(playerVideo.duration)) reload();
    else playerVideo.addEventListener('loadedmetadata', reload);
  }
  // Always show the mini-player. Only open expanded view on first play of a session.
  syncMini();
  renderQueueList();
  if (!state.sessionStarted) {
    state.sessionStarted = true;
    player.classList.add('show');
  }
}

async function loadResumePosition(el, filepath) {
  const saved = await api.getPlayPosition(filepath);
  if (saved && saved.pos && saved.duration && (saved.pos / saved.duration) < 0.95) {
    el.currentTime = saved.pos;
  } else {
    el.currentTime = 0;
  }
}

function updateNavButtons() {
  musicPrev.disabled = playerIdx <= 0;
  musicNext.disabled = playerIdx < 0 || playerIdx >= playlistForPlayer.length - 1;
}

// Scrub / play / time / volume / speed
musicPlayBtn.addEventListener('click', () => {
  const el = getActiveMediaEl();
  if (el.paused) el.play(); else el.pause();
});
musicBack15.addEventListener('click', () => {
  const el = getActiveMediaEl();
  el.currentTime = Math.max(0, el.currentTime - 15);
});
musicFwd15.addEventListener('click', () => {
  const el = getActiveMediaEl();
  el.currentTime = Math.min(el.duration || 0, el.currentTime + 15);
});
musicPrev.addEventListener('click', () => {
  if (playerIdx > 0) {
    const prev = playlistForPlayer[--playerIdx];
    playFile(prev.filepath, prev.title, prev);
  }
});
musicNext.addEventListener('click', () => {
  if (playerIdx >= 0 && playerIdx < playlistForPlayer.length - 1) {
    const next = playlistForPlayer[++playerIdx];
    playFile(next.filepath, next.title, next);
  }
});
playerVideo.addEventListener('ended', () => {
  if (playerIdx >= 0 && playerIdx < playlistForPlayer.length - 1) musicNext.click();
});
playerVideo.addEventListener('play', () => {
  musicPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  musicView.classList.add('playing');
});
playerVideo.addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (playerVideo.requestFullscreen) playerVideo.requestFullscreen().catch(() => {});
});
playerVideo.addEventListener('pause', () => {
  musicPlayIcon.innerHTML = '<polygon points="6 4 20 12 6 20 6 4"/>';
  musicView.classList.remove('playing');
});
playerVideo.addEventListener('loadedmetadata', () => {
  musicTotalTime.textContent = fmtTime(playerVideo.duration);
});
playerVideo.addEventListener('timeupdate', () => {
  if (!playerVideo.duration) return;
  const pct = (playerVideo.currentTime / playerVideo.duration) * 100;
  musicBarFill.style.width = pct + '%';
  musicBarHandle.style.left = pct + '%';
  musicCurTime.textContent = fmtTime(playerVideo.currentTime);
  scheduleSavePos(playerVideo);
});

let saveTimer = null;
function scheduleSavePos(el) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (currentPlaying && el.duration) api.savePlayPosition(currentPlaying, el.currentTime, el.duration);
  }, 1500);
}

musicBar.addEventListener('click', (e) => {
  const el = getActiveMediaEl();
  if (!el.duration) return;
  const r = musicBar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  el.currentTime = ratio * el.duration;
});
musicVolume.addEventListener('input', () => {
  playerVideo.volume = musicVolume.value / 100;
});
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
let speedIdx = 0;
musicSpeedBtn.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  playerVideo.playbackRate = SPEEDS[speedIdx];
  musicSpeedBtn.textContent = SPEEDS[speedIdx] + '×';
});

function closePlayer() {
  if (currentPlaying && playerVideo.duration) api.savePlayPosition(currentPlaying, playerVideo.currentTime, playerVideo.duration);
  playerVideo.pause();
  playerVideo.removeAttribute('src');
  playerVideo.load();
  player.classList.remove('show');
  $('miniPlayer').classList.remove('show');
  document.body.classList.remove('mini-active');
  currentPlaying = null;
}
// Expanded player → collapse to mini
function collapsePlayer() {
  player.classList.remove('show');
  // Lyrics pane is tied to the expanded player — hide it when collapsing
  if (lyricsPane) lyricsPane.classList.remove('show');
  renderQueueList();
}
function expandPlayer() {
  player.classList.add('show');
  // Restore lyrics visibility if user had it on
  if (lyricsShown && lyricsPane) lyricsPane.classList.add('show');
  renderQueueList();
}
$('playerCollapse').addEventListener('click', collapsePlayer);

document.addEventListener('keydown', (e) => {
  const playing = currentPlaying != null;
  const expanded = player.classList.contains('show');
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    if (expanded) collapsePlayer();
    return;
  }
  if (!playing) return;
  if (e.key === ' ') { e.preventDefault(); musicPlayBtn.click(); }
  else if (e.key === 'ArrowLeft' && !(e.metaKey || e.ctrlKey)) musicBack15.click();
  else if (e.key === 'ArrowRight' && !(e.metaKey || e.ctrlKey)) musicFwd15.click();
  else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowLeft') musicPrev.click();
  else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowRight') musicNext.click();
  else if (e.key.toLowerCase() === 'f') { expanded ? collapsePlayer() : expandPlayer(); }
});

// ===== Mini player wiring =====
const miniPlayer = $('miniPlayer');
const miniThumb = $('miniThumb');
const miniThumbPlaceholder = $('miniThumbPlaceholder');
const miniTitle = $('miniTitle');
const miniArtist = $('miniArtist');
const miniPlay = $('miniPlay');
const miniPlayIcon = $('miniPlayIcon');
const miniPrev = $('miniPrev');
const miniNext = $('miniNext');
const miniTime = $('miniTime');
const miniExpand = $('miniExpand');
const miniClose = $('miniClose');
const miniProg = document.querySelector('.mini-prog');
const miniProgFill = $('miniProgFill');

function syncMini() {
  if (!currentPlaying) return;
  const match = state.history.find((e) => e.filepath === currentPlaying);
  const title = (match && match.title) || currentPlaying.split('/').pop().replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const artist = (match && (match.uploader || match.playlist)) || '';
  const thumb = (match && match.thumbnail) || null;
  miniTitle.textContent = title;
  miniArtist.textContent = artist;
  if (thumb) {
    miniThumb.src = thumb;
    miniThumb.classList.add('show');
  } else {
    miniThumb.classList.remove('show');
    miniThumb.removeAttribute('src');
  }
  miniPlayer.classList.add('show');
  document.body.classList.add('mini-active');
  updateNavButtons();
}

miniPlay.addEventListener('click', () => musicPlayBtn.click());
miniPrev.addEventListener('click', () => musicPrev.click());
miniNext.addEventListener('click', () => musicNext.click());
miniExpand.addEventListener('click', expandPlayer);
miniInfoClick();
function miniInfoClick() {
  // Clicking the thumb or info area also expands
  $('miniInfo').addEventListener('click', expandPlayer);
  $('miniThumb').addEventListener('click', expandPlayer);
  $('miniThumbPlaceholder').addEventListener('click', expandPlayer);
}
miniClose.addEventListener('click', closePlayer);

// Scrub by clicking mini-bar progress strip
miniProg.addEventListener('click', (e) => {
  if (!playerVideo.duration) return;
  const r = miniProg.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  playerVideo.currentTime = ratio * playerVideo.duration;
});

playerVideo.addEventListener('timeupdate', () => {
  if (!playerVideo.duration) return;
  const pct = (playerVideo.currentTime / playerVideo.duration) * 100;
  miniProgFill.style.width = pct + '%';
  miniTime.textContent = fmtTime(playerVideo.currentTime) + ' / ' + fmtTime(playerVideo.duration);
});
playerVideo.addEventListener('play', () => {
  miniPlayIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
});
playerVideo.addEventListener('pause', () => {
  miniPlayIcon.innerHTML = '<polygon points="6 4 20 12 6 20 6 4"/>';
});

// Queue list in expanded player
const PLACEHOLDER_SVG = `<svg viewBox="0 0 24 24" width="40%" height="40%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-dim);"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
const PLACEHOLDER_VIDEO_SVG = `<svg viewBox="0 0 24 24" width="40%" height="40%" fill="currentColor" style="color:var(--text-dim);"><polygon points="8 5 19 12 8 19 8 5"/></svg>`;

function thumbHtml(entry, cls = 'pq-thumb') {
  const isAudio = entry && ['mp3', 'm4a', 'webm', 'flac', 'ogg', 'wav', 'opus', 'aac'].includes((entry.format || '').toLowerCase());
  const icon = isAudio ? PLACEHOLDER_SVG : PLACEHOLDER_VIDEO_SVG;
  if (entry && entry.thumbnail) {
    return `<div class="${cls} thumb-wrap"><img src="${entry.thumbnail}" class="${cls}-img" onerror="this.parentNode.innerHTML='${icon.replace(/'/g, '&apos;').replace(/"/g, '&quot;')}'" /></div>`;
  }
  return `<div class="${cls} thumb-wrap thumb-empty">${icon}</div>`;
}

function renderQueueList() {
  const list = $('playerQueue');
  if (!list) return;
  // If we don't have an explicit playback queue, show the library as default
  // up-next so the panel is never empty.
  if (playlistForPlayer.length === 0 && state.history && state.history.length) {
    playlistForPlayer = state.history.filter((e) => e.filepath);
    playerIdx = -1;
  }
  if (playlistForPlayer.length === 0) {
    list.innerHTML = '<div class="player-queue-head">Up next</div><div style="color:var(--text-muted);font-size:12px;padding:20px 0;">Nothing in library yet.</div>';
    return;
  }
  const rows = playlistForPlayer.map((e, i) => {
    const title = e.title || 'Untitled';
    const artist = e.uploader || '';
    const thumb = thumbHtml(e, 'pq-thumb');
    return `<div class="pq-item ${i === playerIdx ? 'playing' : ''}" data-idx="${i}">
      ${thumb}
      <div class="pq-title">${(i === playerIdx ? '▶ ' : (i + 1) + '. ') + title.replace(/</g, '&lt;')}</div>
      <div class="pq-artist">${artist.replace(/</g, '&lt;')}</div>
    </div>`;
  }).join('');
  list.innerHTML = `<div class="player-queue-head">Up next · ${playlistForPlayer.length} items — drag to reorder</div>` + rows;
  list.querySelectorAll('.pq-item').forEach((el) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('click', (ev) => {
      if (el.dataset.dragging === '1') return;
      const i = parseInt(el.dataset.idx);
      const entry = playlistForPlayer[i];
      if (!entry) return;
      playerIdx = i;
      playFile(entry.filepath, entry.title, entry);
    });
    el.addEventListener('dragstart', (ev) => {
      el.dataset.dragging = '1';
      el.style.opacity = '0.4';
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', el.dataset.idx); } catch (_) {}
    });
    el.addEventListener('dragend', () => {
      el.style.opacity = '';
      setTimeout(() => { el.dataset.dragging = '0'; }, 50);
    });
    el.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const fromIdx = parseInt(ev.dataTransfer.getData('text/plain'));
      const toIdx = parseInt(el.dataset.idx);
      if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
      const currentlyPlayingEntry = playlistForPlayer[playerIdx];
      const [moved] = playlistForPlayer.splice(fromIdx, 1);
      playlistForPlayer.splice(toIdx, 0, moved);
      // Recompute playerIdx to still point at the same playing track
      playerIdx = playlistForPlayer.findIndex((p) => p === currentlyPlayingEntry);
      renderQueueList();
    });
  });
}


// ============ Settings modal ============
const settingsModal = $('settingsModal');
$('btnSettings').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => settingsModal.classList.remove('show'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('show'); });

async function refreshChannels() {
  const list = await api.listChannels();
  const el = $('channelList');
  if (!el) return;
  if (list.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:6px 2px;">No channel subscriptions.</div>'; return; }
  el.innerHTML = list.map((c) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;font-size:12px;">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(c.url || '').replace(/</g, '&lt;')}</span>
      <span style="color:var(--text-muted);font-size:10px;">${c.cron} · ${(c.format || 'mp3').toUpperCase()}</span>
      <button data-chan-del="${c.id}" class="btn btn-ghost btn-sm" style="padding:2px 8px;color:var(--danger);">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-chan-del]').forEach((b) => b.addEventListener('click', async () => {
    await api.removeChannel(b.dataset.chanDel);
    refreshChannels();
  }));
}

// App info + auto-update checker
async function loadAboutInfo() {
  try {
    const info = await api.getAppInfo();
    if (!info) return;
    $('aboutVersion') && ($('aboutVersion').textContent = 'v' + (info.version || '—'));
    $('aboutCommit') && ($('aboutCommit').textContent = info.commit || '—');
    $('aboutBranch') && ($('aboutBranch').textContent = info.branch || '—');
    $('aboutElectron') && ($('aboutElectron').textContent = info.electron || '—');
    $('aboutPlatform') && ($('aboutPlatform').textContent = `${info.platform}-${info.arch}`);
    const repoA = $('aboutRepo');
    const relA = $('aboutReleases');
    const authA = $('aboutAuthor');
    if (repoA) repoA.href = info.repo;
    if (relA) relA.href = info.repo + '/releases';
    if (authA) authA.href = 'https://github.com/ahfoysal';
    [repoA, relA, authA].forEach((a) => {
      if (!a) return;
      a.addEventListener('click', (e) => { e.preventDefault(); window.open(a.href); });
    });
    checkLatestVersion(info);
  } catch (_) {}
}

async function checkLatestVersion(info) {
  try {
    const res = await fetch('https://api.github.com/repos/ahfoysal/downloader-for-mac/releases/latest');
    if (!res.ok) return;
    const json = await res.json();
    const latest = (json.tag_name || '').replace(/^v/, '');
    const current = (info.version || '').replace(/^v/, '');
    if (latest && semverGt(latest, current)) {
      const banner = document.createElement('div');
      banner.className = 'about-update-banner show';
      banner.innerHTML = `🎉 New version <strong>v${latest}</strong> available. <a href="${json.html_url}" target="_blank">Download</a>`;
      banner.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); window.open(json.html_url); });
      const block = $('aboutBlock');
      if (block) {
        const existing = block.querySelector('.about-update-banner');
        if (existing) existing.remove();
        block.appendChild(banner);
      }
    }
  } catch (_) {}
}

function semverGt(a, b) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

async function openSettings() {
  loadAboutInfo();
  const s = await api.getSettings();
  state.settings = s;
  const setTheme = $('setTheme');
  const grid = $('setAccentGrid');
  if (setTheme) setTheme.value = s.theme || 'dark';
  if (grid) {
    grid.innerHTML = ACCENTS.map((a) => `<span class="accent-swatch accent-${a} ${(s.accent || 'teal') === a ? 'active' : ''}" data-a="${a}" style="background:var(--a-${a},#999)"></span>`).join('');
    // Need inline backgrounds since CSS vars for each accent aren't defined yet; hard-code hexes
    const SW = { teal:'#5eead4', purple:'#c084fc', pink:'#f472b6', blue:'#60a5fa', orange:'#fb923c', green:'#4ade80', red:'#f87171', yellow:'#fbbf24' };
    grid.querySelectorAll('.accent-swatch').forEach((el) => {
      el.style.background = SW[el.dataset.a];
      el.addEventListener('click', () => {
        grid.querySelectorAll('.accent-swatch').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
        const theme = setTheme ? setTheme.value : 'dark';
        applyTheme(theme, el.dataset.a);
        api.updateSettings({ accent: el.dataset.a });
      });
    });
  }
  // Bind once at first open; flag on element so we don't double-bind.
  if (setTheme && !setTheme.dataset.bound) {
    setTheme.dataset.bound = '1';
    setTheme.addEventListener('change', () => {
      applyTheme(setTheme.value, (state.settings && state.settings.accent) || 'teal');
      api.updateSettings({ theme: setTheme.value });
    });
  }
  $('setFolderDisplay').textContent = s.downloadFolder || '— not set —';
  $('setConcurrency').value = s.concurrency || 1;
  $('setSpeedLimit').value = s.speedLimit || '';
  $('setOutputTemplate').value = s.outputTemplate || '';
  $('setOrganize').checked = !!s.organizeByUploader;
  $('setKeepAwake').checked = s.keepAwake !== false;
  $('setAutoRetry').checked = s.autoRetryYtDlp !== false;
  if ($('setSponsorBlock')) $('setSponsorBlock').checked = !!s.sponsorBlock;
  if ($('setLoudness')) $('setLoudness').checked = !!s.loudnessNormalize;
  $('setWatchFolder').value = s.watchFolder || '';
  refreshChannels();
  settingsModal.classList.add('show');
}
[
  ['setConcurrency', 'concurrency', (v) => parseInt(v) || 1],
  ['setSpeedLimit', 'speedLimit', (v) => v.trim()],
  ['setOutputTemplate', 'outputTemplate', (v) => v.trim()],
  ['setOrganize', 'organizeByUploader', (e) => e.target.checked, true],
  ['setKeepAwake', 'keepAwake', (e) => e.target.checked, true],
  ['setAutoRetry', 'autoRetryYtDlp', (e) => e.target.checked, true],
  ['setSponsorBlock', 'sponsorBlock', (e) => e.target.checked, true],
  ['setLoudness', 'loudnessNormalize', (e) => e.target.checked, true],
  ['setWatchFolder', 'watchFolder', (v) => v.trim()],
].filter(([id]) => $(id)).forEach(([id, key, conv, isCheckbox]) => {
  $(id).addEventListener('change', async (e) => {
    const v = isCheckbox ? conv(e) : conv(e.target.value);
    await api.updateSettings({ [key]: v });
  });
});
$('setFolderPick').addEventListener('click', async () => {
  const dir = await api.selectDownloadFolder();
  if (dir) $('setFolderDisplay').textContent = dir;
});
$('setWatchFolderPick').addEventListener('click', async () => {
  const dir = await api.pickFolder('Watch folder');
  if (dir) { $('setWatchFolder').value = dir; await api.updateSettings({ watchFolder: dir }); }
});

const chanAddBtn = $('chanAdd');
if (chanAddBtn) chanAddBtn.addEventListener('click', async () => {
  const url = $('chanUrl').value.trim();
  const cron = $('chanCron').value;
  if (!/^https?:\/\//i.test(url)) { toast('Enter a valid channel URL', 'error'); return; }
  await api.addChannel({ url, cron, format: 'mp3' });
  $('chanUrl').value = '';
  refreshChannels();
  toast('Channel added', 'success');
});
$('btnFolder').addEventListener('click', () => api.openFolder());

// ============ Extension installer ============
const installerModal = $('installerModal');
$('btnExtension').addEventListener('click', openInstaller);
$('installerClose').addEventListener('click', () => installerModal.classList.remove('show'));
installerModal.addEventListener('click', (e) => { if (e.target === installerModal) installerModal.classList.remove('show'); });

const BROWSER_META = {
  chrome:  { name: 'Google Chrome',  auto: true },
  brave:   { name: 'Brave',          auto: true },
  edge:    { name: 'Microsoft Edge', auto: true },
  arc:     { name: 'Arc',            auto: true },
  vivaldi: { name: 'Vivaldi',        auto: true },
  firefox: { name: 'Firefox',        auto: false },
  safari:  { name: 'Safari',         auto: false, note: 'needs Xcode' },
};
async function openInstaller() {
  const installed = await api.detectBrowsers();
  const s = await api.getSettings();
  const connected = s.extensionInstalled;
  $('installerStatus').innerHTML = connected
    ? `<span style="color:var(--success);">✓ Extension connected</span><br><span style="color:var(--text-muted);font-size:11px;">Last seen: ${s.extensionLastSeen ? new Date(s.extensionLastSeen).toLocaleString() : 'just now'}</span>`
    : `<span style="color:var(--text-muted);">Extension not detected yet — install for any browser below.</span>`;
  const list = $('installerList');
  const all = ['chrome', 'brave', 'edge', 'arc', 'vivaldi', 'firefox', 'safari'];
  list.innerHTML = all.map((b) => {
    const meta = BROWSER_META[b];
    const present = installed.includes(b);
    return `
      <div class="browser-row ${present ? '' : 'disabled'}">
        <span class="b-name">${meta.name}</span>
        <span class="b-sub">${present ? (meta.note || 'installed') : 'not found'}</span>
        ${meta.auto && present ? `<button class="btn btn-primary btn-sm" data-auto="${b}">Auto</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-install="${b}" ${present ? '' : 'disabled'}>Open</button>
      </div>
    `;
  }).join('');
  list.addEventListener('click', async (ev) => {
    const autoBtn = ev.target.closest('[data-auto]');
    const openBtn = ev.target.closest('[data-install]');
    if (autoBtn) {
      const res = await api.launchWithExtension(autoBtn.dataset.auto);
      if (res.ok) toast(`Launched ${BROWSER_META[autoBtn.dataset.auto].name} with extension`, 'success');
      else toast(res.error || 'Failed', 'error');
    } else if (openBtn) {
      const res = await api.openExtensionInstaller(openBtn.dataset.install);
      if (res.ok) toast(`Opened ${BROWSER_META[openBtn.dataset.install].name}`, 'success');
      else toast(res.error || 'Failed', 'error');
    }
  });
  installerModal.classList.add('show');
}
api.onExtensionPing(() => {
  api.getSettings().then((s) => {
    $('extDot').classList.toggle('connected', !!s.extensionInstalled);
  });
  toast('Browser extension connected', 'success');
});

// ============ Deep link + clipboard + watch folder ============
api.onDeepLink((url) => {
  urlInput.value = url;
  state.urlInput = url;
  detectPlaylistUrl();
  setView('download');
  analyzeUrl(url);
  toast('URL received', 'info');
});

// Context-menu / target=_blank → open in a new browser tab
api.onOpenUrlNewTab((url) => {
  setView('browse');
  setTimeout(() => openNewTab(url), 30);
});
api.onWatchFolderUrls((urls) => {
  toast(`${urls.length} URLs queued from watch folder`, 'success');
  setView('download');
  urls.forEach((u, i) => setTimeout(() => {
    urlInput.value = u;
    state.urlInput = u;
    startDownload();
  }, i * 200));
});
api.onScheduledTrigger((task) => {
  toast(`Running scheduled: ${task.url.slice(0, 40)}…`, 'info');
  api.downloadAudio(task.url, task.format, task.opts || {});
});

// Channel subscriptions: auto-download new content (uses yt-dlp's
// --download-archive to only grab newly-uploaded items)
api.onChannelTrigger((c) => {
  toast(`Channel sync: ${c.url.slice(0, 40)}…`, 'info');
  api.downloadAudio(c.url, c.format || 'mp3', { playlist: true, ...(c.opts || {}) });
});

let lastClip = '';
window.addEventListener('focus', () => {
  const clip = (api.readClipboard() || '').trim();
  if (!clip || clip === lastClip) return;
  if (!/^https?:\/\//i.test(clip)) return;
  if (!/youtube|youtu\.be|vimeo|twitter|x\.com|tiktok|soundcloud|twitch|instagram/i.test(clip)) return;
  if (clip === state.urlInput) return;
  lastClip = clip;
  const t = toast('URL in clipboard — click to use', 'info', () => {
    urlInput.value = clip;
    state.urlInput = clip;
    analyzeUrl(clip);
  });
});

// ============ Toasts ============
function toast(msg, kind = 'info', onClick) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (onClick) { el.style.cursor = 'pointer'; el.addEventListener('click', () => { onClick(); el.remove(); }); }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
  return el;
}

// ============ Keyboard shortcuts ============
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === '1') { e.preventDefault(); setView('download'); }
  else if (e.key === '2') { e.preventDefault(); setView('library'); }
  else if (e.key === '3') { e.preventDefault(); setView('browse'); }
  else if (e.key === 'k' && !e.shiftKey) { e.preventDefault(); urlInput.value = ''; state.urlInput = ''; urlInput.focus(); }
});

// ============ Helpers ============
function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function describeFormat(f) {
  const parts = [];
  if (f.height) parts.push(`${f.height}p${f.fps && f.fps > 30 ? f.fps : ''}`);
  else if (f.acodec) parts.push(`audio ${Math.round(f.abr || f.tbr || 0)}k`);
  parts.push(f.ext);
  if (f.filesize) parts.push(fmtBytes(f.filesize));
  return parts.join(' · ');
}

// ============ Browser tabs — BrowserView-based ============
// All webview logic removed. Tabs live in main process as BrowserViews,
// sized via IPC browseSetBounds. We only manage the tab bar UI + URL bar.
let browseTabsState = [];   // [{ id, url, title, active }]

function tabsBar() { return $('browseTabs'); }
function newTabBtn() { return $('browseNewTab'); }
function browseBody() { return $('browseBody'); }

// Report content-area bounds to main so it can size BrowserViews.
function reportBrowseBounds() {
  const body = $('browseBody');
  if (!body) return;
  const r = body.getBoundingClientRect();
  // BrowserView renders above the DOM, so we must leave bottom space for
  // anything the user needs to click on (FAB, mini-player).
  let reserveBottom = 0;
  const sendBtn = $('browseSend');
  if (sendBtn && sendBtn.classList.contains('show')) reserveBottom += 80;
  if (document.body.classList.contains('mini-active')) reserveBottom += 64;
  api.browseSetBounds({ x: r.left, y: r.top, width: r.width, height: Math.max(0, r.height - reserveBottom) });
}
window.addEventListener('resize', reportBrowseBounds);
// Poll every 500ms in case layout shifts due to mini-player / sidebar toggles
setInterval(() => { if (state.view === 'browse') reportBrowseBounds(); }, 500);

function renderTabs() {
  const bar = tabsBar();
  if (!bar) return;
  const plus = newTabBtn();
  [...bar.querySelectorAll('.browse-tab')].forEach((t) => t.remove());
  browseTabsState.forEach((t) => {
    const el = document.createElement('button');
    el.className = 'browse-tab' + (t.active ? ' active' : '');
    el.dataset.id = t.id;
    const fav = (() => {
      try { const h = new URL(t.url || '').hostname; return h.replace(/^www\./, '').charAt(0).toUpperCase(); }
      catch (_) { return '•'; }
    })();
    el.innerHTML = `<span class="b-tab-favicon">${fav}</span>
      <span class="b-tab-title">${(t.title || t.url || 'Loading…').replace(/</g, '&lt;')}</span>
      <span class="b-tab-close" data-close="${t.id}">×</span>`;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]')) return;
      api.browseSwitchTab(t.id);
    });
    const closeBtn = el.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); api.browseCloseTab(t.id); });
    bar.insertBefore(el, plus);
  });
  // Reflect active tab url in URL bar
  const active = browseTabsState.find((t) => t.active);
  if (active) { const u = $('browseUrl'); if (u && document.activeElement !== u) u.value = active.url || ''; }
}

api.onBrowseTabs((tabs) => {
  browseTabsState = tabs || [];
  renderTabs();
  // Update FAB based on active tab's URL
  const active = tabs.find((t) => t.active);
  const sendBtn = $('browseSend');
  const fabBadge = $('fabBadge');
  if (sendBtn) {
    const wasShown = sendBtn.classList.contains('show');
    if (active && SUPPORTED_SITES_RE.test(active.url || '')) {
      sendBtn.classList.add('show');
      sendBtn.dataset.url = active.url;
      if (fabBadge) {
        try { const h = new URL(active.url).hostname.replace(/^www\./, '').split('.')[0]; fabBadge.textContent = h.charAt(0).toUpperCase() + h.slice(1); } catch (_) {}
      }
      if (typeof schedulePrefetchGlobal === 'function') schedulePrefetchGlobal(active.url);
    } else {
      sendBtn.classList.remove('show');
    }
    // Re-report bounds if FAB visibility changed — shrink/grow BrowserView accordingly
    if (wasShown !== sendBtn.classList.contains('show')) reportBrowseBounds();
  }
});

// Global prefetch helper used by onBrowseTabs (no access to initBrowse-scoped state)
let _globalPrefetchTimer = null;
let _globalLastPrefetchUrl = null;
function schedulePrefetchGlobal(url) {
  if (!url || !isVideoWatchUrl(url)) return;
  if (probeCache.has(url) || url === _globalLastPrefetchUrl) return;
  clearTimeout(_globalPrefetchTimer);
  _globalPrefetchTimer = setTimeout(async () => {
    const disk = await api.probeCacheGet(url);
    if (disk) { probeCache.set(url, disk); return; }
    _globalLastPrefetchUrl = url;
    const res = await api.probeFast(url);
    if (res && res.ok) {
      probeCache.set(url, res);
      api.probeCacheSet(url, res);
      setTimeout(() => { probeCache.delete(url); if (_globalLastPrefetchUrl === url) _globalLastPrefetchUrl = null; }, 120 * 1000);
    }
  }, 400);
}

function openNewTab(url) { api.browseCreateTab(url || 'https://www.google.com'); }
function closeActiveTab() {
  const active = browseTabsState.find((t) => t.active);
  if (active) api.browseCloseTab(active.id);
}

const BROWSE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSE_HOME = 'https://www.google.com';

// The rest of this block (createWebview/updateTabFromWebview/switchToTab/
// openNewTab/closeTab/persistTabs/restoreTabs) is DEAD CODE from the old
// <webview> era. Kept inert — unreachable because browser UI now calls
// api.browseCreateTab / api.browseSwitchTab / api.browseCloseTab directly.
function _deadCode_createWebview(url) {
  const wv = document.createElement('webview');
  wv.setAttribute('src', url || BROWSE_HOME);
  wv.setAttribute('partition', 'persist:browse');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('useragent', BROWSE_UA);
  wv.dataset.tab = String(tabSeq);
  // Wire events on the new webview
  wv.addEventListener('did-navigate', (e) => { updateTabFromWebview(wv, e.url); });
  wv.addEventListener('did-navigate-in-page', (e) => { updateTabFromWebview(wv, e.url); });
  wv.addEventListener('page-title-updated', (e) => {
    const t = browseTabs.find((bt) => bt.webview === wv);
    if (t) { t.title = e.title || t.title; renderTabs(); }
  });
  wv.addEventListener('dom-ready', () => {
    try { updateTabFromWebview(wv, wv.getURL()); } catch (_) {}
  });
  wv.addEventListener('did-finish-load', () => {
    try { updateTabFromWebview(wv, wv.getURL()); } catch (_) {}
  });
  browseBody().appendChild(wv);
  return wv;
}

function updateTabFromWebview(wv, url) {
  const t = browseTabs.find((bt) => bt.webview === wv);
  if (!t) return;
  t.url = url || t.url;
  // Record in browser history (debounced via the fact that every nav overwrites)
  if (url && /^https?:/.test(url) && !/^about:blank/.test(url)) {
    api.recordBrowseVisit({ url, title: t.title || null });
  }
  // Refresh FAB only for the ACTIVE tab
  if (browseTabs[activeTabIdx] && browseTabs[activeTabIdx].webview === wv) {
    $('browseUrl').value = t.url;
    if (typeof updateSendBtn === 'function') updateSendBtn(t.url);
  }
  renderTabs();
  persistTabs();
}

function switchToTab(idx) {
  if (idx < 0 || idx >= browseTabs.length) return;
  activeTabIdx = idx;
  browseTabs.forEach((t, i) => {
    if (t.webview) t.webview.classList.toggle('active', i === idx);
  });
  const t = browseTabs[idx];
  if (t) {
    try { $('browseUrl').value = t.webview.getURL() || t.url; } catch (_) { $('browseUrl').value = t.url; }
    if (typeof updateSendBtn === 'function') updateSendBtn($('browseUrl').value);
  }
  renderTabs();
  persistTabs();
}

function openNewTab(url) {
  const wv = createWebview(url || BROWSE_HOME);
  browseTabs.push({ id: ++tabSeq, url: url || BROWSE_HOME, title: 'New tab', webview: wv });
  switchToTab(browseTabs.length - 1);
}

function closeTab(idx) {
  const t = browseTabs[idx];
  if (!t) return;
  if (t.webview && t.webview.parentNode) t.webview.parentNode.removeChild(t.webview);
  browseTabs.splice(idx, 1);
  if (browseTabs.length === 0) { openNewTab(); return; }
  if (activeTabIdx >= browseTabs.length) activeTabIdx = browseTabs.length - 1;
  switchToTab(activeTabIdx);
}

function persistTabs() {
  const urls = browseTabs.map((t) => t.url).filter(Boolean);
  api.updateSettings({ browseTabs: urls, browseActiveTab: activeTabIdx });
}

async function restoreTabs() {
  const s = await api.getSettings();
  const saved = (s && s.browseTabs) || [];
  // Claim the initial #browseView as the first tab
  const firstWv = document.querySelector('webview#browseView');
  if (!firstWv) return;
  if (saved.length === 0) {
    browseTabs.push({ id: ++tabSeq, url: BROWSE_HOME, title: 'YouTube', webview: firstWv });
    firstWv.classList.add('active');
  } else {
    firstWv.setAttribute('src', saved[0]);
    browseTabs.push({ id: ++tabSeq, url: saved[0], title: 'Tab', webview: firstWv });
    firstWv.classList.add('active');
    // Wire the initial webview's events (same as createWebview)
    firstWv.addEventListener('did-navigate', (e) => updateTabFromWebview(firstWv, e.url));
    firstWv.addEventListener('did-navigate-in-page', (e) => updateTabFromWebview(firstWv, e.url));
    firstWv.addEventListener('page-title-updated', (e) => {
      const t = browseTabs.find((bt) => bt.webview === firstWv);
      if (t) { t.title = e.title || t.title; renderTabs(); }
    });
    for (let i = 1; i < saved.length; i++) {
      const wv = createWebview(saved[i]);
      browseTabs.push({ id: ++tabSeq, url: saved[i], title: 'Tab', webview: wv });
    }
    activeTabIdx = Math.min((s.browseActiveTab || 0), browseTabs.length - 1);
    browseTabs.forEach((t, i) => t.webview.classList.toggle('active', i === activeTabIdx));
  }
  renderTabs();
}

// Wire new-tab button once (DOMContentLoaded may or may not have fired yet)
function wireNewTabButton() {
  const btn = newTabBtn();
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => openNewTab());
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireNewTabButton);
} else {
  wireNewTabButton();
}

// ============ Browse tab (built-in browser with webview) ============
const SUPPORTED_SITES_RE = /(youtube\.com|youtu\.be|vimeo\.com|twitter\.com|x\.com|tiktok\.com|soundcloud\.com|twitch\.tv|dailymotion\.com|bilibili\.com|facebook\.com|instagram\.com)/i;

// Only probe URLs that clearly point at a single watchable item.
// Skips homepages, search results, channel listings, shorts/reels feeds.
function isVideoWatchUrl(u) {
  try {
    if (!SUPPORTED_SITES_RE.test(u)) return false;
    const p = new URL(u);
    const h = p.hostname.replace(/^www\./, '');
    const path = p.pathname;
    if (h.endsWith('youtube.com')) return /[?&]v=[a-zA-Z0-9_-]{11}/.test(u) || /\/shorts\/[a-zA-Z0-9_-]{11}/.test(path);
    if (h === 'youtu.be') return /\/[a-zA-Z0-9_-]{11}/.test(path);
    if (h.endsWith('vimeo.com')) return /\/\d+/.test(path);
    if (h.endsWith('tiktok.com')) return /\/video\/\d+/.test(path);
    if (h.endsWith('twitter.com') || h === 'x.com') return /\/status\/\d+/.test(path);
    if (h.endsWith('soundcloud.com')) return path.split('/').filter(Boolean).length >= 2;
    if (h.endsWith('twitch.tv')) return /\/videos?\/\d+|\/clip\//.test(path);
    if (h.endsWith('dailymotion.com')) return /\/video\//.test(path);
    if (h.endsWith('bilibili.com')) return /\/video\//.test(path);
    return true;
  } catch (_) { return false; }
}
async function initBrowse() {
  const urlBar = $('browseUrl');
  const sendBtn = $('browseSend');
  // Tell main to render the active BrowserView in the correct bounds
  reportBrowseBounds();
  await api.browseSetVisible(true);
  // Load existing tabs state
  const tabs = await api.browseGetTabs();
  if (tabs) { browseTabsState = tabs; renderTabs(); }
  if ($('browseBody').dataset.init) return;
  $('browseBody').dataset.init = '1';

  const fabBadge = $('fabBadge');
  function hostLabel(u) {
    try {
      const h = new URL(u).hostname.replace(/^www\./, '').split('.')[0];
      return h.charAt(0).toUpperCase() + h.slice(1);
    } catch (_) { return 'Video'; }
  }

  // Debounced prefetch — probe the formats in the background as soon as the
  // user lands on a supported video page, so the FAB sheet opens instantly
  // with real formats (no "Picking formats" spinner).
  let prefetchTimer = null;
  let lastPrefetchUrl = null;
  async function schedulePrefetch(url) {
    if (!url || !isVideoWatchUrl(url)) return;
    if (probeCache.has(url) || url === lastPrefetchUrl) return;
    // Disk cache hit? load it in-memory too, skip network.
    const disk = await api.probeCacheGet(url);
    if (disk) { probeCache.set(url, disk); return; }
    clearTimeout(prefetchTimer);
    // Shorter debounce — fast probe is cheap, fire early
    prefetchTimer = setTimeout(async () => {
      lastPrefetchUrl = url;
      // Fast probe: title/thumb/duration only, ~1-3s
      const res = await api.probeFast(url);
      if (res && res.ok) {
        probeCache.set(url, res);
        api.probeCacheSet(url, res);
        setTimeout(() => { probeCache.delete(url); if (lastPrefetchUrl === url) lastPrefetchUrl = null; }, 120 * 1000);
      }
    }, 400);
  }

  function updateSendBtn(url) {
    const match = SUPPORTED_SITES_RE.test(url || '');
    if (match) {
      sendBtn.classList.add('show');
      sendBtn.dataset.url = url;
      if (fabBadge) fabBadge.textContent = hostLabel(url);
      schedulePrefetch(url);
    } else {
      sendBtn.classList.remove('show');
    }
  }
  webview.addEventListener('did-navigate', (e) => { urlBar.value = e.url; updateSendBtn(e.url); });
  webview.addEventListener('did-navigate-in-page', (e) => { urlBar.value = e.url; updateSendBtn(e.url); });
  // Fire once on initial load
  webview.addEventListener('dom-ready', () => {
    const u = webview.getURL();
    urlBar.value = u;
    updateSendBtn(u);
  });
  webview.addEventListener('did-finish-load', () => {
    const u = webview.getURL();
    urlBar.value = u;
    updateSendBtn(u);
  });
  webview.addEventListener('page-title-updated', () => { /* optional: show in status */ });
  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode && e.errorCode !== -3) toast(`Load failed: ${e.errorDescription}`, 'error');
  });

  $('browseBack').addEventListener('click', () => api.browseBack());
  $('browseForward').addEventListener('click', () => api.browseForward());
  $('browseReload').addEventListener('click', () => api.browseReload());
  function navigate() {
    const u = urlBar.value.trim();
    if (!u) return;
    api.browseNavigate(null, u);
  }
  $('browseGo').addEventListener('click', navigate);
  const browseImport = $('browseImport');
  if (browseImport) {
    browseImport.addEventListener('click', async () => {
      browseImport.disabled = true;
      browseImport.textContent = 'Importing…';
      const currentHost = (() => { try { return new URL(webview.getURL()).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
      const res = await api.importChromeCookies({ domainFilter: currentHost || null });
      browseImport.disabled = false;
      browseImport.innerHTML = `<svg class="ico ico-sm" viewBox="0 0 24 24"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg> Import Chrome`;
      if (res.ok) {
        toast(`Imported ${res.imported}/${res.total} cookies — reloading`, 'success');
        webview.reload();
      } else {
        toast(res.error || 'Import failed', 'error');
      }
    });
  }
  urlBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(); });
  sendBtn.addEventListener('click', async () => {
    let u = sendBtn.dataset.url;
    if (!u) { try { u = await api.browseCurrentUrl(); } catch (_) {} }
    if (!u) return;
    openFabSheet(u);
  });
}

// ===== FAB quick-pick sheet =====
const probeCache = new Map();  // url -> probe result (hot cache)

const VIDEO_PRESETS = [
  { label: 'Best', sub: 'mp4', tile: 'video', fmt: 'best' },
  { label: '1080p', sub: 'mp4', tile: 'video', fmt: '1080' },
  { label: '720p',  sub: 'mp4', tile: 'video', fmt: '720' },
  { label: '480p',  sub: 'mp4', tile: 'video', fmt: '480' },
];
const AUDIO_PRESETS = [
  { label: 'MP3', sub: 'converted', tile: 'audio', fmt: 'mp3' },
  { label: 'M4A', sub: 'native AAC', tile: 'audio', fmt: 'm4a' },
  { label: 'WebM', sub: 'original', tile: 'audio', fmt: 'webm' },
];

function chipsHtml(presets) {
  return presets.map((p) =>
    `<button class="fab-sheet-chip" data-tile="${p.tile}" data-fmt="${p.fmt}"><span class="chip-label">${p.label}</span><span class="chip-size">${p.sub}</span></button>`
  ).join('');
}

async function getLiveWebviewInfo() {
  // Old webview API is gone — use BrowserView current tab info instead.
  try {
    const active = (browseTabsState || []).find((t) => t.active);
    if (!active) return { title: null, thumbnail: null };
    const url = active.url || '';
    // Derive YouTube thumbnail from video ID in the URL
    let thumb = null;
    const yt = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (yt) thumb = 'https://i.ytimg.com/vi/' + yt[1] + '/maxresdefault.jpg';
    return { title: active.title || url, thumbnail: thumb, uploader: null };
  } catch (_) { return { title: null, thumbnail: null }; }
}

async function _deadCode_getLiveWebviewInfo() {
  const webview = $('browseView');
  if (!webview) return { title: null, thumbnail: null };
  try {
    const info = await webview.executeJavaScript(`(function(){
      // For YouTube watch pages, ALWAYS prefer the video-ID-derived thumbnail
      // over og:image (which is often just the YouTube brand logo for radio/
      // auto-generated playlists).
      const ytMatch = location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || location.href.match(/youtu\\.be\\/([a-zA-Z0-9_-]{11})/);
      let thumb = ytMatch ? 'https://i.ytimg.com/vi/' + ytMatch[1] + '/maxresdefault.jpg' : null;
      if (!thumb) {
        const og = document.querySelector('meta[property="og:image"]');
        const tw = document.querySelector('meta[name="twitter:image"]');
        const poster = document.querySelector('video[poster]');
        thumb = (og && og.content) || (tw && tw.content) || (poster && poster.poster) || null;
      }
      // Prefer the actual YouTube video title element over og:title (which
      // changes slowly during SPA navigation). Try multiple selectors.
      const ytTitle = document.querySelector('h1.ytd-watch-metadata, h1.title, #title h1, ytd-video-primary-info-renderer h1');
      const ogTitle = document.querySelector('meta[property="og:title"]');
      let title = (ytTitle && ytTitle.textContent.trim()) || (ogTitle && ogTitle.content) || document.title || '';
      // Strip site suffix ' - YouTube'
      title = title.replace(/\\s*[-–—]\\s*YouTube\\s*$/i, '');
      const uploaderEl = document.querySelector('ytd-video-owner-renderer #text a, ytd-channel-name a, #owner-name a, #channel-name a');
      const uploader = (uploaderEl && uploaderEl.textContent.trim()) || null;
      return { title, thumbnail: thumb, uploader };
    })();`);
    return info || { title: null, thumbnail: null };
  } catch (_) { return { title: null, thumbnail: null }; }
}

async function openFabSheet(url) {
  const backdrop = $('fabSheetBackdrop');
  const thumb = $('fabSheetThumb');
  const titleEl = $('fabSheetTitle');
  const subEl = $('fabSheetSub');
  const videoGrid = $('fabSheetVideo');
  const audioGrid = $('fabSheetAudio');

  // 1) Paint the sheet instantly with presets — user can click before we even hit yt-dlp
  videoGrid.innerHTML = chipsHtml(VIDEO_PRESETS);
  audioGrid.innerHTML = chipsHtml(AUDIO_PRESETS);
  // Highlight last-picked format as the "default" selection
  const lastPick = state.settings && state.settings.lastFabChoice;
  if (lastPick && lastPick.fmt) {
    const targetGrid = lastPick.tile === 'video' ? videoGrid : audioGrid;
    const chip = targetGrid.querySelector(`[data-fmt="${lastPick.fmt}"]`);
    if (chip) chip.classList.add('selected');
  }

  // If we've already pre-fetched this URL (via background probe on page load),
  // show the real data immediately — no spinner, no wait.
  const warm = probeCache.get(url);
  if (warm) {
    titleEl.textContent = warm.title || '—';
    const parts = [];
    if (warm.uploader) parts.push(warm.uploader);
    if (warm.duration) parts.push(fmtDur(warm.duration));
    subEl.textContent = parts.join(' · ') || '—';
    thumb.src = warm.thumbnail || '';
  } else {
    titleEl.textContent = 'Loading…';
    subEl.innerHTML = '<span class="fab-sheet-spinner"></span>Picking formats';
    thumb.src = '';
  }
  backdrop.classList.add('show');
  document.body.classList.add('sheet-open');

  let picked = false;
  async function pick(ev) {
    const chip = ev.target.closest('.fab-sheet-chip');
    if (!chip || picked) return;
    picked = true;
    const format = chip.dataset.fmt;
    state.analyzedUrl = url;
    state.urlInput = url;
    state.selectedTile = chip.dataset.tile;
    state.selectedFormatId = null;
    if (chip.dataset.tile === 'video') { $('videoQuality').value = format; $('tileVideo').classList.add('selected'); $('tileAudio').classList.remove('selected'); }
    else { $('audioFormat').value = format; $('tileAudio').classList.add('selected'); $('tileVideo').classList.remove('selected'); }
    // Persist as "last pick" so it's highlighted on next sheet open
    api.updateSettings({ lastFabChoice: { tile: chip.dataset.tile, fmt: format } });
    closeFabSheet();

    // Playlist confirm for URLs that look like one
    let playlist = false;
    if (isPlaylistUrl(url)) {
      const choice = playlistAsked.has(url) ? playlistAsked.get(url) : await askPlaylistChoice(url);
      playlistAsked.set(url, choice);
      playlist = choice === 'playlist';
    }

    // REUSE the probe result (or the live webview title/thumb) to skip the
    // second yt-dlp --dump-single-json call that main.js would otherwise make.
    // Playlist mode still needs a --flat-playlist probe for entries, BUT we
    // can still pass title/thumbnail early so the download card shows them.
    const cached = probeCache.get(url);
    // Freshly scrape the webview DOM — don't rely on the sheet's labels which
    // may still say "Loading…" for fast clicks.
    const live = await getLiveWebviewInfo();
    const prefetchedMeta = {
      title: (cached && cached.title) || (live && live.title) || null,
      thumbnail: (cached && cached.thumbnail) || (live && live.thumbnail) || null,
      uploader: (cached && cached.uploader) || (live && live.uploader) || null,
      duration: cached && cached.duration ? cached.duration : null,
      skipProbe: !playlist && !!cached,
    };

    const opts = {
      playlist,
      subtitles: $('optSubs').checked,
      cookiesBrowser: $('optCookies').value,
      formatId: null,
      resume: $('optResume').checked,
      prefetchedMeta,
    };
    api.downloadAudio(url, format, opts);
    toast(`Downloading ${playlist ? 'playlist' : format.toUpperCase()} — track in Download tab`, 'success');
  }
  videoGrid.addEventListener('click', pick);
  audioGrid.addEventListener('click', pick);

  // 2) In parallel: pull title + thumbnail from the live webview DOM (instant — no network)
  getLiveWebviewInfo().then((live) => {
    if (live.title) titleEl.textContent = live.title;
    if (live.thumbnail) thumb.src = live.thumbnail;
    if (!live.title) titleEl.textContent = '—';
  });

  // 3) Disk cache first
  const diskHit = await api.probeCacheGet(url);
  if (diskHit) {
    probeCache.set(url, diskHit);
    applyProbeResult(diskHit);
  } else if (probeCache.has(url)) {
    applyProbeResult(probeCache.get(url));
  }

  // 4) Always fire a real (format-inclusive) probe if we don't have formats yet
  const haveFormats = (diskHit && diskHit.formats && diskHit.formats.length > 0) ||
                      (probeCache.get(url) && probeCache.get(url).formats && probeCache.get(url).formats.length > 0);
  if (!haveFormats) {
    api.probeFormats(url).then((res) => {
      if (!res.ok) { subEl.textContent = '—'; return; }
      probeCache.set(url, res);
      api.probeCacheSet(url, res);
      setTimeout(() => probeCache.delete(url), 60 * 1000);
      applyProbeResult(res);
    });
  }

  function applyProbeResult(res) {
    state.meta = res;
    if (res.title) titleEl.textContent = res.title;
    if (res.thumbnail && !thumb.src) thumb.src = res.thumbnail;
    const parts = [];
    if (res.uploader) parts.push(res.uploader);
    if (res.duration) parts.push(fmtDur(res.duration));
    subEl.textContent = parts.join(' · ') || '—';
    // Append real-format chips with file sizes
    const videos = (res.formats || []).filter((f) => f.vcodec).sort((a, b) => (b.height || 0) - (a.height || 0));
    const audios = (res.formats || []).filter((f) => !f.vcodec && f.acodec).sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const realVideos = videos.slice(0, 4).map((f) =>
      `<button class="fab-sheet-chip" data-fmt-id="${f.format_id}" data-tile="video"><span class="chip-label">${f.height ? f.height + 'p' : 'video'}</span><span class="chip-size">${f.ext}${f.filesize ? ' · ' + fmtBytes(f.filesize) : ''}</span></button>`
    ).join('');
    const realAudios = audios.slice(0, 3).map((f) =>
      `<button class="fab-sheet-chip" data-fmt-id="${f.format_id}" data-tile="audio"><span class="chip-label">${Math.round(f.abr || f.tbr || 0)}k</span><span class="chip-size">${f.ext}${f.filesize ? ' · ' + fmtBytes(f.filesize) : ''}</span></button>`
    ).join('');
    if (realVideos) videoGrid.insertAdjacentHTML('beforeend', realVideos);
    if (realAudios) audioGrid.insertAdjacentHTML('beforeend', realAudios);
    // Wire up direct format-id picks (these bypass presets)
    videoGrid.querySelectorAll('[data-fmt-id]').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (picked) return;
        picked = true;
        const fmtId = chip.dataset.fmtId;
        closeFabSheet();
        api.downloadAudio(url, 'best', {
          playlist: /[?&]list=|\/playlist\?|\/channel\//i.test(url),
          subtitles: $('optSubs').checked,
          cookiesBrowser: $('optCookies').value,
          formatId: fmtId,
          resume: $('optResume').checked,
        });
        toast(`Downloading — track in Download tab`, 'success');
      });
    });
    audioGrid.querySelectorAll('[data-fmt-id]').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (picked) return;
        picked = true;
        const fmtId = chip.dataset.fmtId;
        closeFabSheet();
        api.downloadAudio(url, 'mp3', {
          playlist: /[?&]list=|\/playlist\?|\/channel\//i.test(url),
          subtitles: false,
          cookiesBrowser: $('optCookies').value,
          formatId: fmtId,
          resume: $('optResume').checked,
        });
        toast(`Downloading — track in Download tab`, 'success');
      });
    });
  }
}
function closeFabSheet() {
  $('fabSheetBackdrop').classList.remove('show');
  document.body.classList.remove('sheet-open');
}
document.addEventListener('click', (e) => {
  if (e.target.id === 'fabSheetBackdrop' || e.target.closest('#fabSheetClose')) closeFabSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('fabSheetBackdrop').classList.contains('show')) closeFabSheet();
});

// ============ Album-art color extraction for dynamic player backdrop ============
function extractDominantColor(imgUrl) {
  return new Promise((resolve) => {
    if (!imgUrl) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 24;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          // Skip very dark or very bright pixels (edges / blacks / whites)
          const br = (data[i] + data[i+1] + data[i+2]) / 3;
          if (br < 40 || br > 220) continue;
          r += data[i]; g += data[i+1]; b += data[i+2]; n++;
        }
        if (!n) return resolve(null);
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        resolve({ r, g, b });
      } catch (_) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imgUrl;
  });
}
async function applyBackdropColor(thumbUrl) {
  const col = await extractDominantColor(thumbUrl);
  const playerEl = $('player');
  if (!playerEl) return;
  if (col) {
    const { r, g, b } = col;
    playerEl.style.background = `
      radial-gradient(circle at 20% 20%, rgba(${r},${g},${b},0.22), transparent 60%),
      radial-gradient(circle at 85% 80%, rgba(0,0,0,0.5), transparent 60%),
      rgba(10,10,12,0.98)
    `;
  } else {
    playerEl.style.background = '';
  }
}

// ============ Sleep timer ============
let sleepTimerMs = 0;
let sleepTimerStart = 0;
let sleepFadeRaf = 0;
function startSleepTimer(minutes) {
  stopSleepTimer();
  if (!minutes) return;
  sleepTimerMs = minutes * 60 * 1000;
  sleepTimerStart = Date.now();
  toast(`Sleep timer: ${minutes} min`, 'success');
  // Schedule the fade + pause
  const fadeStartMs = sleepTimerMs - 10000; // last 10s fade
  setTimeout(beginSleepFade, fadeStartMs);
}
function beginSleepFade() {
  const start = Date.now();
  const startVol = playerVideo.volume;
  function tick() {
    const t = (Date.now() - start) / 10000;
    if (t >= 1) { playerVideo.pause(); playerVideo.volume = startVol; toast('Sleep timer done', 'info'); return; }
    playerVideo.volume = startVol * (1 - t);
    sleepFadeRaf = requestAnimationFrame(tick);
  }
  tick();
}
function stopSleepTimer() {
  sleepTimerMs = 0;
  cancelAnimationFrame(sleepFadeRaf);
}

// ============ Audio equalizer (WebAudio biquad bank) ============
let eqBands = null;
const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 12000, 16000];
const EQ_PRESETS = {
  'Flat':      [0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost':[6, 4, 2, 0, 0, 0, 0, 0],
  'Vocal':     [-2, 0, 2, 4, 4, 2, 0, 0],
  'Rock':      [3, 2, -1, -2, 0, 2, 3, 3],
  'Classical': [2, 2, 0, -1, -1, 0, 2, 3],
  'Jazz':      [2, 1, 0, 1, 1, 2, 1, 1],
};
function ensureEQ() {
  if (eqBands || !audioCtx || !sourceNode || !analyser) return;
  try {
    // Rewire: source → bands → analyser → destination
    sourceNode.disconnect();
    analyser.disconnect();
    const bands = EQ_FREQS.map((f, i) => {
      const b = audioCtx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1;
      b.gain.value = 0;
      return b;
    });
    sourceNode.connect(bands[0]);
    for (let i = 0; i < bands.length - 1; i++) bands[i].connect(bands[i + 1]);
    bands[bands.length - 1].connect(analyser);
    analyser.connect(audioCtx.destination);
    eqBands = bands;
  } catch (_) {}
}
function applyEQPreset(name) {
  if (!eqBands) ensureEQ();
  if (!eqBands) return;
  const values = EQ_PRESETS[name] || EQ_PRESETS.Flat;
  eqBands.forEach((b, i) => { b.gain.value = values[i] || 0; });
  api.updateSettings({ eqPreset: name });
}

// ============ Audio visualizer (WebAudio analyzer) ============
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let vizRaf = 0;
function ensureVisualizer() {
  const canvas = $('visualizer');
  if (!canvas) return;
  // Only animate for audio files (when the video element is hidden)
  const isAudio = !playerVideo.classList.contains('show');
  if (!isAudio) {
    canvas.style.display = 'none';
    cancelAnimationFrame(vizRaf);
    return;
  }
  canvas.style.display = 'block';

  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioCtx.createMediaElementSource(playerVideo);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      console.warn('visualizer init failed', err);
      canvas.style.display = 'none';
      return;
    }
  }
  try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {}

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 300 * dpr;
  canvas.height = 300 * dpr;
  ctx.scale(dpr, dpr);
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#5eead4';

  function draw() {
    vizRaf = requestAnimationFrame(draw);
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);
    ctx.clearRect(0, 0, 300, 300);
    const cx = 150, cy = 150, radius = 88;
    const bars = 64;
    for (let i = 0; i < bars; i++) {
      const dataIdx = Math.floor(i / bars * bufferLength * 0.6);
      const v = dataArray[dataIdx] / 255;
      const barLen = 12 + v * 52;
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(angle) * radius;
      const y1 = cy + Math.sin(angle) * radius;
      const x2 = cx + Math.cos(angle) * (radius + barLen);
      const y2 = cy + Math.sin(angle) * (radius + barLen);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.25 + v * 0.55;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  cancelAnimationFrame(vizRaf);
  draw();
}

// ============ Shuffle + repeat ============
let shuffleOn = false;
let repeatMode = 'off'; // 'off' | 'all' | 'one'
const musicShuffleBtn = $('musicShuffleBtn');
const musicRepeatBtn = $('musicRepeatBtn');
if (musicShuffleBtn) musicShuffleBtn.addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  musicShuffleBtn.style.color = shuffleOn ? 'var(--accent)' : '';
  musicShuffleBtn.style.borderColor = shuffleOn ? 'var(--accent)' : '';
  toast(`Shuffle ${shuffleOn ? 'on' : 'off'}`, 'info');
  api.updateSettings({ shuffle: shuffleOn });
});
if (musicRepeatBtn) musicRepeatBtn.addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  musicRepeatBtn.style.color = repeatMode === 'off' ? '' : 'var(--accent)';
  musicRepeatBtn.style.borderColor = repeatMode === 'off' ? '' : 'var(--accent)';
  musicRepeatBtn.textContent = repeatMode === 'one' ? '↻1' : '';
  if (repeatMode !== 'one') musicRepeatBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  toast(`Repeat ${repeatMode}`, 'info');
  api.updateSettings({ repeat: repeatMode });
});

// Override default "ended → next" to handle shuffle/repeat
playerVideo.addEventListener('ended', () => {
  if (repeatMode === 'one') { playerVideo.currentTime = 0; playerVideo.play(); return; }
  if (playlistForPlayer.length <= 1) return;
  let nextIdx;
  if (shuffleOn) {
    do { nextIdx = Math.floor(Math.random() * playlistForPlayer.length); }
    while (nextIdx === playerIdx && playlistForPlayer.length > 1);
  } else {
    nextIdx = playerIdx + 1;
    if (nextIdx >= playlistForPlayer.length) {
      if (repeatMode === 'all') nextIdx = 0;
      else return;
    }
  }
  const next = playlistForPlayer[nextIdx];
  playerIdx = nextIdx;
  playFile(next.filepath, next.title, next);
}, { capture: true });

// ============ Lyrics pane ============
const lyricsPane = $('lyricsPane');
const musicLyricsBtn = $('musicLyricsBtn');
let lyricsData = null;
let lyricsShown = false;

function parseSyncedLyrics(synced) {
  if (!synced) return null;
  const lines = synced.split('\n').map((line) => {
    const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!m) return null;
    return { t: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() };
  }).filter(Boolean);
  return lines.length ? lines : null;
}

function cleanTrackTitle(title) {
  return (title || '')
    .replace(/\(Official.*?\)|\[Official.*?\]/gi, '')
    .replace(/\(Audio\)|\(Lyrics?\s*Video\)|\(Lyrics\)|\(HD\)|\(4K\)|\(Remaster.*?\)|\(Music Video\)|\(Official Music Video\)/gi, '')
    .replace(/\s+-\s+YouTube\s*$/i, '')
    .replace(/\s*\|\s*.*$/g, '')  // strip "| Vevo | channel" suffix
    .replace(/\s+/g, ' ')
    .trim();
}

function splitArtistTitle(title, fallbackArtist) {
  const clean = cleanTrackTitle(title);
  let artist = (fallbackArtist || '').trim();
  let track = clean;
  // Strip "- Topic" suffix that YouTube uses for auto-uploaded music
  artist = artist.replace(/\s*-\s*Topic\s*$/i, '').trim();
  // If no artist or artist looks generic, try to split "Artist - Title" from the title itself
  if ((!artist || artist.toLowerCase() === 'unknown') && /\s+-\s+/.test(clean)) {
    const parts = clean.split(/\s+-\s+/);
    if (parts.length === 2) { artist = parts[0].trim(); track = parts[1].trim(); }
  } else if (artist && clean.toLowerCase().startsWith(artist.toLowerCase() + ' - ')) {
    // "Artist - Track" when the title already has the artist prefix
    track = clean.slice(artist.length + 3).trim();
  } else if (/\s+-\s+/.test(clean)) {
    // Artist is known but title has "... - ..." — take part after first ' - '
    const dashIdx = clean.indexOf(' - ');
    if (dashIdx > 0) track = clean.slice(dashIdx + 3).trim();
  }
  return { artist, track };
}

async function loadLyrics(title, artist) {
  if (!title) { lyricsPane.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No track.</div>'; return; }
  lyricsPane.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Searching lyrics…</div>';
  const parsed = splitArtistTitle(title, artist);
  const duration = playerVideo && playerVideo.duration && isFinite(playerVideo.duration) ? Math.round(playerVideo.duration) : null;
  const res = await api.fetchLyrics(parsed.artist, parsed.track, duration);
  if (!res.ok || (!res.synced && !res.plain)) {
    lyricsPane.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:20px;">
      No lyrics found<br><span style="font-size:11px;">Searched: "${parsed.artist}" · "${parsed.track}"</span>
    </div>`;
    lyricsData = null;
    return;
  }
  const synced = parseSyncedLyrics(res.synced);
  lyricsData = synced ? { type: 'synced', lines: synced } : { type: 'plain', text: res.plain };
  renderLyrics();
}

function renderLyrics() {
  if (!lyricsData) { return; }
  if (lyricsData.type === 'synced') {
    lyricsPane.innerHTML = lyricsData.lines.map((l, i) =>
      `<div class="lyrics-line" data-t="${l.t}" data-i="${i}">${(l.text || ' ').replace(/</g, '&lt;')}</div>`
    ).join('');
    lyricsPane.querySelectorAll('.lyrics-line').forEach((el) => {
      el.addEventListener('click', () => {
        if (playerVideo.duration) playerVideo.currentTime = parseFloat(el.dataset.t);
      });
    });
  } else {
    lyricsPane.innerHTML = `<pre style="white-space:pre-wrap;color:var(--text);font-size:13px;line-height:1.7;font-family:inherit;">${(lyricsData.text || '').replace(/</g, '&lt;')}</pre>`;
  }
}

playerVideo.addEventListener('timeupdate', () => {
  if (!lyricsShown || !lyricsData || lyricsData.type !== 'synced') return;
  const t = playerVideo.currentTime;
  const lines = lyricsPane.querySelectorAll('.lyrics-line');
  let currentIdx = -1;
  for (let i = 0; i < lyricsData.lines.length; i++) {
    if (t >= lyricsData.lines[i].t) currentIdx = i;
    else break;
  }
  lines.forEach((el, i) => el.classList.toggle('current', i === currentIdx));
  const active = lines[currentIdx];
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

if (musicLyricsBtn) musicLyricsBtn.addEventListener('click', async () => {
  lyricsShown = !lyricsShown;
  lyricsPane.classList.toggle('show', lyricsShown);
  musicLyricsBtn.style.color = lyricsShown ? 'var(--accent)' : '';
  if (lyricsShown && !lyricsData) {
    await loadLyrics(musicTitle.textContent, musicArtist.textContent);
  }
});

// ============ Theme + accent picker ============
const THEMES = ['dark', 'light'];
const ACCENTS = ['teal', 'purple', 'pink', 'blue', 'orange', 'green', 'red', 'yellow'];
function applyTheme(theme, accent) {
  document.body.classList.remove('theme-light', 'theme-dark');
  document.body.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
  ACCENTS.forEach((a) => document.body.classList.remove('accent-' + a));
  document.body.classList.add('accent-' + (accent || 'teal'));
}

// ============ Command palette (⌘K) ============
const cmdk = $('cmdk');
const cmdkInput = $('cmdkInput');
const cmdkList = $('cmdkList');
let cmdkItems = [];
let cmdkActive = 0;

function buildCommands() {
  return [
    { label: 'New download', sub: 'Paste a URL', icon: '⬇', run: () => { setView('download'); setMode('idle'); urlInput.focus(); } },
    { label: 'Open Library', sub: '⌘2', icon: '▦', run: () => setView('library') },
    { label: 'Open Browser', sub: '⌘3', icon: '🌐', run: () => setView('browse') },
    { label: 'Settings', sub: '⌘,', icon: '⚙︎', run: () => openSettings() },
    { label: 'Activity log', sub: 'See recent events', icon: '≡', run: () => openActivity() },
    { label: 'Listening stats', sub: 'Top tracks / artists', icon: '📊', run: () => openStats() },
    { label: 'Debug console', sub: 'Live yt-dlp log', icon: '⚡', run: () => openDebug() },
    { label: 'Keyboard shortcuts', sub: '?', icon: '⌨', run: () => openHelp() },
    { label: 'Install browser extension', sub: 'Chrome / Firefox / Safari', icon: '🧩', run: () => openInstaller() },
    { label: 'Update yt-dlp', sub: 'Fetch latest binary', icon: '⟳', run: async () => { toast('Updating yt-dlp…'); const r = await api.updateYtdlp(); toast(r.ok ? 'Updated' : 'Failed', r.ok ? 'success' : 'error'); } },
    { label: 'Clear history', sub: 'Danger', icon: '✕', run: async () => { if (confirm('Clear all history?')) await api.clearHistory(); renderLibrary(); } },
    { label: 'Toggle theme (dark / light)', icon: '◐', run: () => {
      const cur = document.body.classList.contains('theme-light') ? 'light' : 'dark';
      const next = cur === 'light' ? 'dark' : 'light';
      applyTheme(next, (state.settings && state.settings.accent) || 'teal');
      api.updateSettings({ theme: next });
    } },
    ...ACCENTS.map((a) => ({
      label: 'Accent: ' + a.charAt(0).toUpperCase() + a.slice(1),
      icon: '●', iconColor: `var(--accent)`,
      run: () => { applyTheme(document.body.classList.contains('theme-light') ? 'light' : 'dark', a); api.updateSettings({ accent: a }); },
    })),
    { label: 'Play / Pause', sub: 'Space', icon: '▶', run: () => { if (currentPlaying) musicPlayBtn.click(); } },
    { label: 'Toggle shuffle', icon: '⇄', run: () => musicShuffleBtn && musicShuffleBtn.click() },
    { label: 'Toggle lyrics', icon: '♪', run: () => musicLyricsBtn && musicLyricsBtn.click() },
    { label: 'Fullscreen video', icon: '⛶', run: () => {
      if (playerVideo && playerVideo.requestFullscreen) playerVideo.requestFullscreen().catch(() => {});
    }},
    { label: 'Picture-in-Picture', icon: '▭', run: async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (playerVideo && playerVideo.requestPictureInPicture) await playerVideo.requestPictureInPicture();
      } catch (e) { toast('PiP unavailable: ' + e.message, 'error'); }
    }},
    { label: 'Sleep timer: 15 min', icon: '☾', run: () => startSleepTimer(15) },
    { label: 'Sleep timer: 30 min', icon: '☾', run: () => startSleepTimer(30) },
    { label: 'Sleep timer: 60 min', icon: '☾', run: () => startSleepTimer(60) },
    { label: 'Sleep timer: 90 min', icon: '☾', run: () => startSleepTimer(90) },
    { label: 'Sleep timer off', icon: '☾', run: () => { stopSleepTimer(); toast('Sleep timer off', 'info'); } },
    ...Object.keys(EQ_PRESETS).map((name) => ({
      label: 'EQ: ' + name,
      icon: '≡',
      run: () => { applyEQPreset(name); toast('EQ: ' + name, 'info'); },
    })),
  ];
}

function fuzzyMatch(query, text) {
  if (!query) return 1;
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (text.includes(query)) return 2;
  // Simple subsequence match
  let qi = 0;
  for (const ch of text) {
    if (ch === query[qi]) qi++;
    if (qi === query.length) return 1;
  }
  return 0;
}

function renderCmdk() {
  const q = cmdkInput.value.trim();
  const all = buildCommands();
  cmdkItems = all
    .map((c) => ({ ...c, score: fuzzyMatch(q, c.label + ' ' + (c.sub || '')) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (cmdkActive >= cmdkItems.length) cmdkActive = 0;
  cmdkList.innerHTML = cmdkItems.map((c, i) =>
    `<div class="cmdk-item ${i === cmdkActive ? 'active' : ''}" data-i="${i}">
      <span class="cmdk-icon">${c.icon || '·'}</span>
      <span class="cmdk-label">${c.label.replace(/</g, '&lt;')}</span>
      ${c.sub ? `<span class="cmdk-sub">${c.sub}</span>` : ''}
    </div>`
  ).join('');
  cmdkList.querySelectorAll('.cmdk-item').forEach((el) => {
    el.addEventListener('mouseenter', () => { cmdkActive = parseInt(el.dataset.i); renderCmdk(); });
    el.addEventListener('click', () => runCmdkItem(parseInt(el.dataset.i)));
  });
}

function runCmdkItem(i) {
  const c = cmdkItems[i];
  if (!c) return;
  closeCmdk();
  try { c.run(); } catch (e) { toast(e.message, 'error'); }
}
function openCmdk() { cmdk.classList.add('show'); cmdkInput.value = ''; cmdkActive = 0; renderCmdk(); setTimeout(() => cmdkInput.focus(), 10); }
function closeCmdk() { cmdk.classList.remove('show'); }
cmdkInput && cmdkInput.addEventListener('input', () => { cmdkActive = 0; renderCmdk(); });
cmdkInput && cmdkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCmdk(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); cmdkActive = Math.min(cmdkItems.length - 1, cmdkActive + 1); renderCmdk(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkActive = Math.max(0, cmdkActive - 1); renderCmdk(); }
  else if (e.key === 'Enter') { e.preventDefault(); runCmdkItem(cmdkActive); }
});
cmdk && cmdk.addEventListener('click', (e) => { if (e.target === cmdk) closeCmdk(); });

// ============ Keyboard help ============
const KEY_HELP = [
  { key: '⌘K', label: 'Command palette' },
  { key: '⌘1', label: 'Download tab' },
  { key: '⌘2', label: 'Library tab' },
  { key: '⌘3', label: 'Browser tab' },
  { key: '⌘,', label: 'Settings' },
  { key: '⌘F', label: 'Focus search' },
  { key: '⌘K', label: 'Clear URL input' },
  { key: '⌘⏎', label: 'Start download' },
  { key: 'Space', label: 'Play / Pause' },
  { key: '←/→', label: 'Seek 15s' },
  { key: '⌘←/→', label: 'Previous / Next track' },
  { key: 'F', label: 'Expand / collapse player' },
  { key: 'Esc', label: 'Close dialog / collapse player' },
  { key: '?', label: 'This help' },
];

function openHelp() {
  const grid = $('helpGrid');
  grid.innerHTML = KEY_HELP.map((r) =>
    `<div class="help-row"><span class="help-label">${r.label}</span><span class="kbd">${r.key}</span></div>`
  ).join('');
  $('helpModal').classList.add('show');
}
$('helpClose') && $('helpClose').addEventListener('click', () => $('helpModal').classList.remove('show'));

// ============ Activity log ============
async function openActivity() {
  const log = await api.getActivityLog();
  $('activityList').innerHTML = log.length
    ? log.map((e) => {
        const t = new Date(e.ts);
        const tt = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
        return `<div class="activity-row">
          <span class="a-time">${tt}</span>
          <span class="a-type ${e.type}">${e.type}</span>
          <span class="a-msg" title="${(e.msg || '').replace(/"/g, '&quot;')}">${(e.msg || '').replace(/</g, '&lt;')}</span>
        </div>`;
      }).join('')
    : '<div style="text-align:center;padding:40px;color:var(--text-muted);">No activity yet.</div>';
  $('activityModal').classList.add('show');
}
$('activityClose') && $('activityClose').addEventListener('click', () => $('activityModal').classList.remove('show'));

// ============ Listening stats dashboard ============
async function openStats() {
  const counts = await api.getPlayCounts();
  const history = await api.getHistory();
  const byPath = new Map(history.map((h) => [h.filepath, h]));
  const tracks = Object.entries(counts)
    .map(([fp, c]) => ({ ...byPath.get(fp), filepath: fp, plays: c }))
    .sort((a, b) => b.plays - a.plays);
  const totalPlays = tracks.reduce((s, t) => s + t.plays, 0);
  const uploaders = {};
  tracks.forEach((t) => { if (t.uploader) uploaders[t.uploader] = (uploaders[t.uploader] || 0) + t.plays; });
  const topArtists = Object.entries(uploaders).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const totalDownloads = history.length;
  const formats = {};
  history.forEach((h) => { if (h.format) formats[h.format] = (formats[h.format] || 0) + 1; });

  const row = (label, value) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12.5px;"><span style="color:var(--text-muted);">${label}</span><span style="font-weight:600;">${value}</span></div>`;
  let html = `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:0 0 10px;">Overview</h3>`;
  html += row('Total downloads', totalDownloads);
  html += row('Total plays', totalPlays);
  html += row('Unique tracks played', tracks.length);
  html += `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:18px 0 10px;">Top tracks</h3>`;
  if (tracks.length === 0) {
    html += `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">No plays yet.</div>`;
  } else {
    tracks.slice(0, 8).forEach((t, i) => {
      html += `<div style="display:flex;gap:10px;padding:6px 0;font-size:12px;border-bottom:1px solid var(--border);">
        <span style="color:var(--text-dim);min-width:20px;">${i + 1}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(t.title || t.filepath.split('/').pop()).replace(/</g,'&lt;')}</span>
        <span style="color:var(--accent);font-variant-numeric:tabular-nums;">${t.plays}×</span>
      </div>`;
    });
  }
  html += `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:18px 0 10px;">Top artists</h3>`;
  if (topArtists.length === 0) html += `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">—</div>`;
  else topArtists.forEach(([name, cnt]) => {
    html += row(name, cnt + ' plays');
  });
  html += `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin:18px 0 10px;">Formats</h3>`;
  Object.entries(formats).sort((a,b) => b[1]-a[1]).forEach(([f, c]) => html += row(f.toUpperCase(), c));
  $('statsContent').innerHTML = html;
  $('statsModal').classList.add('show');
}
$('statsClose') && $('statsClose').addEventListener('click', () => $('statsModal').classList.remove('show'));

// ============ Debug console ============
async function openDebug() {
  const log = await api.getActivityLog();
  const lines = log.map((e) => `[${e.ts}] ${e.type.toUpperCase()}  ${e.msg || ''}`).join('\n');
  $('debugContent').textContent = lines || '(no activity yet)';
  $('debugModal').classList.add('show');
}
$('debugClose') && $('debugClose').addEventListener('click', () => $('debugModal').classList.remove('show'));
$('debugCopy') && $('debugCopy').addEventListener('click', () => {
  navigator.clipboard.writeText($('debugContent').textContent);
  toast('Log copied to clipboard', 'success');
});
$('activityClear') && $('activityClear').addEventListener('click', async () => { await api.clearActivityLog(); openActivity(); });

// ============ Global keyboard shortcuts ============
document.addEventListener('keydown', (e) => {
  const inField = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !inField) {
    e.preventDefault(); openCmdk();
  } else if (e.key === '?' && !inField) {
    e.preventDefault(); openHelp();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't' && state.view === 'browse') {
    e.preventDefault(); openNewTab();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w' && state.view === 'browse') {
    e.preventDefault(); closeActiveTab();
  }
});

// ============ Boot ============
(async () => {
  const s = await api.getSettings();
  state.settings = s;
  applyTheme(s.theme || 'dark', s.accent || 'teal');
  if (s.shuffle) { shuffleOn = true; if (musicShuffleBtn) { musicShuffleBtn.style.color = 'var(--accent)'; musicShuffleBtn.style.borderColor = 'var(--accent)'; } }
  if (s.repeat && s.repeat !== 'off') { repeatMode = s.repeat; if (musicRepeatBtn) { musicRepeatBtn.style.color = 'var(--accent)'; musicRepeatBtn.style.borderColor = 'var(--accent)'; } }
  if (s.audioFormat) audioFormat.value = s.audioFormat;
  if (s.videoQuality) videoQuality.value = s.videoQuality;
  if (s.selectedTile) {
    state.selectedTile = s.selectedTile;
    tileVideo.classList.toggle('selected', state.selectedTile === 'video');
    tileAudio.classList.toggle('selected', state.selectedTile === 'audio');
  }
  $('extDot').classList.toggle('connected', !!s.extensionInstalled);
  renderQuickSites();
  renderRecentLanding();
  renderMostPlayedLanding();
  renderBrowseHistoryLanding();
  // Initial queue state
  const q = await api.getQueueState();
  state.queueState = q;
  if (q.active.length + q.queued.length > 1) setMode('queue');
  renderQueue();
  urlInput.focus();
})();
