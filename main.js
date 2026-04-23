// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const YtDlpWrap = require('yt-dlp-wrap').default;

const ytDlpWrap = new YtDlpWrap();
let selectedDownloadFolder = null;
let currentDownload = null;         // kept for backwards compatibility — refers to most recent active download
const activeDownloads = new Map();  // id -> { ytDlpWrap, url, format, opts, startedAt }
const downloadQueue = [];           // { id, url, format, opts }
let downloadSeq = 0;

const userData = app.getPath('userData');
const settingsPath = path.join(userData, 'settings.json');
const historyPath = path.join(userData, 'history.json');

const EXE = process.platform === 'win32' ? '.exe' : '';
// User-writable yt-dlp override (so we can auto-update inside a signed bundle)
const ytDlpOverridePath = path.join(userData, `yt-dlp${EXE}`);
const ytDlpBundledPath = app.isPackaged
  ? path.join(process.resourcesPath, `yt-dlp${EXE}`)
  : path.join(__dirname, 'bin', `yt-dlp${EXE}`);
function activeYtDlpPath() {
  return fs.existsSync(ytDlpOverridePath) ? ytDlpOverridePath : ytDlpBundledPath;
}
function resolveFfmpegPath() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, `ffmpeg${EXE}`),
        path.join(process.resourcesPath, `ffmpeg-${process.arch}${EXE}`),
      ]
    : [
        path.join(__dirname, 'bin', `ffmpeg-${process.arch}${EXE}`),
        path.join(__dirname, 'bin', `ffmpeg${EXE}`),
      ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}
const ffmpegPath = resolveFfmpegPath();

// Format presets — keep main.js as source of truth, expose to renderer.
const FORMAT_PRESETS = {
  mp3:   { kind: 'audio', ext: 'mp3',  args: ['-f', 'bestaudio', '-x', '--audio-format', 'mp3'] },
  m4a:   { kind: 'audio', ext: 'm4a',  args: ['-f', 'bestaudio', '-x', '--audio-format', 'm4a'] },
  webm:  { kind: 'audio', ext: 'webm', args: ['-f', 'bestaudio'] },
  best:  { kind: 'video', ext: 'mp4',  args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'] },
  '1080':{ kind: 'video', ext: 'mp4',  args: ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4'] },
  '720': { kind: 'video', ext: 'mp4',  args: ['-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4'] },
  '480': { kind: 'video', ext: 'mp4',  args: ['-f', 'bv*[height<=480]+ba/b[height<=480]', '--merge-output-format', 'mp4'] },
};

function loadJSON(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Error reading ${p}:`, err);
  }
  return fallback;
}

function saveJSON(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing ${p}:`, err);
  }
}

let appSettings = {
  downloadFolder: null,
  subtitles: false,
  cookiesBrowser: 'none',
  resume: true,
  format: 'mp3',
  concurrency: 1,
  speedLimit: '',
  outputTemplate: '',
  organizeByUploader: false,
  keepAwake: true,
  watchFolder: '',
  scheduled: [],
  extensionInstalled: false,
  extensionLastSeen: null,
  extensionBanner: 'show',
  siteDefaults: {},               // { 'youtube.com': 'mp3', 'twitter.com': 'best', ... }
  autoRetryYtDlp: true,           // auto-update yt-dlp and retry on signature failure
  playPositions: {},              // { [filepath]: { pos: seconds, duration: seconds } }
};
let powerBlockerId = null;

function loadSettings() {
  const s = loadJSON(settingsPath, {});
  appSettings = { ...appSettings, ...s };
  selectedDownloadFolder = appSettings.downloadFolder || null;
}

function saveSettings() {
  appSettings.downloadFolder = selectedDownloadFolder;
  saveJSON(settingsPath, appSettings);
}

function loadHistory() {
  return loadJSON(historyPath, []);
}

function saveHistory(entries) {
  saveJSON(historyPath, entries.slice(0, 200));
}

function addHistoryEntry(entry) {
  const entries = loadHistory();
  entries.unshift({ ...entry, id: Date.now() + Math.random().toString(36).slice(2, 8) });
  saveHistory(entries);
  return entries;
}

function buildMenu(win) {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Update yt-dlp…',
          click: () => win.webContents.send('trigger-update-ytdlp'),
        },
        {
          label: 'Reveal yt-dlp binary',
          click: () => shell.showItemInFolder(activeYtDlpPath()),
        },
        { type: 'separator' },
        {
          label: 'Install Native Messaging Host…',
          click: async () => {
            try {
              const results = writeNativeHostManifest();
              const oks = Object.values(results).filter((r) => r.ok).length;
              win.webContents.send('notify', `Native host installed for ${oks} browsers. Reload extension to take effect.`);
            } catch (err) {
              win.webContents.send('notify', `Install failed: ${err.message}`);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Reset to bundled yt-dlp',
          click: () => {
            try { if (fs.existsSync(ytDlpOverridePath)) fs.unlinkSync(ytDlpOverridePath); } catch (_) {}
            ytDlpWrap.setBinaryPath(activeYtDlpPath());
            win.webContents.send('notify', 'Reverted to bundled yt-dlp.');
          },
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GitHub Repo',
          click: () => shell.openExternal('https://github.com/ahfoysal/downloader-for-mac'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Deep-link protocol: downloader://url/<encoded-url>
if (!app.isDefaultProtocolClient('downloader')) {
  app.setAsDefaultProtocolClient('downloader');
}

let mainWindow = null;
function handleDeepLink(rawUrl) {
  if (!rawUrl || !rawUrl.startsWith('downloader://')) return;

  // Extension handshake: `downloader://ping?browser=chrome&version=1.0.0`
  if (rawUrl.startsWith('downloader://ping')) {
    const now = new Date().toISOString();
    const wasInstalled = appSettings.extensionInstalled;
    appSettings.extensionInstalled = true;
    appSettings.extensionLastSeen = now;
    saveSettings();
    const qs = rawUrl.split('?')[1] || '';
    const params = Object.fromEntries(qs.split('&').map((p) => p.split('=').map(decodeURIComponent)));
    if (mainWindow) {
      mainWindow.webContents.send('extension-ping', { ...params, firstTime: !wasInstalled });
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    return;
  }

  const payload = rawUrl.replace(/^downloader:\/\/(url\/)?/, '');
  let target = '';
  try { target = decodeURIComponent(payload); } catch (_) { target = payload; }
  // Any deep-link counts as 'extension used'
  appSettings.extensionInstalled = true;
  appSettings.extensionLastSeen = new Date().toISOString();
  saveSettings();
  if (mainWindow) {
    mainWindow.webContents.send('deep-link-url', target);
    mainWindow.webContents.send('extension-ping', { firstTime: false });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// Single-instance lock so subsequent `open downloader://...` invocations route to our window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv) => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  const link = argv.find((a) => a && a.startsWith('downloader://'));
  if (link) handleDeepLink(link);
});
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });

// Watch-folder for .txt URL lists.
let watchInterval = null;
function startWatchFolder() {
  if (watchInterval) clearInterval(watchInterval);
  const dir = appSettings.watchFolder;
  if (!dir || !fs.existsSync(dir)) return;
  const seen = new Set();
  watchInterval = setInterval(() => {
    try {
      const files = fs.readdirSync(dir).filter((f) => /\.(txt|urls)$/i.test(f));
      for (const f of files) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        const key = `${full}:${stat.mtimeMs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const urls = fs.readFileSync(full, 'utf8')
          .split(/\r?\n/).map((s) => s.trim())
          .filter((s) => /^https?:\/\//i.test(s));
        if (urls.length && mainWindow) {
          mainWindow.webContents.send('watch-folder-urls', urls);
        }
      }
    } catch (err) { console.error('watch folder error', err); }
  }, 5000);
}

// Scheduled tasks — simple interval check every minute.
let schedulerInterval = null;
function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(() => {
    const now = new Date();
    const tasks = appSettings.scheduled || [];
    let changed = false;
    for (const t of tasks) {
      if (!t.url || !t.cron) continue;
      const last = t.last ? new Date(t.last) : null;
      const shouldRun = matchCron(t, now, last);
      if (shouldRun) {
        t.last = now.toISOString();
        changed = true;
        if (mainWindow) mainWindow.webContents.send('scheduled-trigger', t);
      }
    }
    if (changed) { saveSettings(); }
  }, 60 * 1000);
}
function matchCron(t, now, last) {
  if (last && (now - last) < 30 * 60 * 1000) return false; // min 30 min gap
  const h = now.getHours(), m = now.getMinutes();
  if (t.hour != null && t.hour !== h) return false;
  if (t.minute != null && Math.abs(t.minute - m) > 2) return false;
  if (t.cron === 'daily') return true;
  if (t.cron === 'weekly') return t.day === now.getDay();
  return false;
}

app.whenReady().then(() => {
  loadSettings();
  try {
    ytDlpWrap.setBinaryPath(activeYtDlpPath());
  } catch (err) {
    console.error('Failed to set yt-dlp binary path:', err);
  }
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  buildMenu(mainWindow);

  // Wire context menu for webview (Browse tab)
  mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
    wc.on('context-menu', (e, params) => {
      const { linkURL, pageURL, srcURL, selectionText } = params;
      const template = [];
      if (linkURL) template.push({
        label: 'Send link to Downloader',
        click: () => mainWindow.webContents.send('deep-link-url', linkURL),
      });
      if (srcURL) template.push({
        label: 'Send media to Downloader',
        click: () => mainWindow.webContents.send('deep-link-url', srcURL),
      });
      if (pageURL) template.push({
        label: 'Send page to Downloader',
        click: () => mainWindow.webContents.send('deep-link-url', pageURL),
      });
      if (linkURL || pageURL) template.push({ type: 'separator' });
      template.push(
        { role: 'back' },
        { role: 'forward' },
        { role: 'reload' },
        { type: 'separator' },
        { role: 'copy' },
        { role: 'paste' },
      );
      if (linkURL) template.push({
        label: 'Copy link',
        click: () => require('electron').clipboard.writeText(linkURL),
      });
      if (selectionText) template.push({
        label: 'Search Google for "' + selectionText.slice(0, 30) + '"',
        click: () => wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent(selectionText)),
      });
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    });
    // Handle new-window requests (target=_blank links) by loading in same view
    wc.setWindowOpenHandler(({ url }) => {
      wc.loadURL(url);
      return { action: 'deny' };
    });
  });

  // Handle deep link passed at launch (macOS sometimes passes via argv).
  const link = process.argv.find((a) => a && a.startsWith('downloader://'));
  if (link) mainWindow.webContents.once('did-finish-load', () => handleDeepLink(link));

  startWatchFolder();
  startScheduler();
  startControlSocket();

  // Auto-install native host on first launch (idempotent, silent).
  if (!appSettings.nativeHostInstalled) {
    try {
      writeNativeHostManifest();
      appSettings.nativeHostInstalled = true;
      saveSettings();
    } catch (err) {
      console.error('native host auto-install failed:', err);
    }
  }
});

// ===== Control socket: lets native-host proxies talk to us =====
const controlClients = new Set();
function startControlSocket() {
  const sockDir = app.getPath('userData');
  const sockPath = path.join(sockDir, 'control.sock');
  try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch (_) {}

  const server = net.createServer((conn) => {
    controlClients.add(conn);
    conn.setEncoding('utf8');
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { handleControlMessage(conn, JSON.parse(line)); } catch (_) {}
      }
    });
    conn.on('close', () => controlClients.delete(conn));
    conn.on('error', () => controlClients.delete(conn));
    // Greet
    try { conn.write(JSON.stringify({ type: 'welcome', app: 'downloader-for-mac' }) + '\n'); } catch (_) {}
  });

  server.on('error', (err) => console.error('control socket error:', err));
  server.listen(sockPath, () => console.log('control socket listening at', sockPath));
}

function handleControlMessage(conn, msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'send' && msg.url) {
    if (mainWindow) {
      mainWindow.webContents.send('deep-link-url', msg.url);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    try { conn.write(JSON.stringify({ type: 'ack', url: msg.url }) + '\n'); } catch (_) {}
  }
}

// Broadcast to every connected native-host
function broadcastToExtensions(obj) {
  const line = JSON.stringify(obj) + '\n';
  for (const c of controlClients) {
    try { c.write(line); } catch (_) {}
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('select-download-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Default Download Folder',
    properties: ['openDirectory'],
  });
  if (!canceled && filePaths.length > 0) {
    selectedDownloadFolder = filePaths[0];
    saveSettings();
    return selectedDownloadFolder;
  }
  return null;
});

ipcMain.handle('get-saved-folder', () => selectedDownloadFolder);
ipcMain.handle('get-history', () => loadHistory());
ipcMain.handle('get-settings', () => ({ ...appSettings }));
ipcMain.handle('update-settings', (_e, patch) => {
  const prevWatch = appSettings.watchFolder;
  appSettings = { ...appSettings, ...patch };
  saveSettings();
  if (patch.watchFolder !== undefined && patch.watchFolder !== prevWatch) startWatchFolder();
  return { ...appSettings };
});

ipcMain.handle('pick-folder', async (_e, title = 'Select Folder') => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
  return canceled || !filePaths[0] ? null : filePaths[0];
});

// Detect installed browsers for cookie auto-mode.
function detectInstalledBrowsers() {
  const apps = {
    safari: '/Applications/Safari.app',
    chrome: '/Applications/Google Chrome.app',
    firefox: '/Applications/Firefox.app',
    brave: '/Applications/Brave Browser.app',
    edge: '/Applications/Microsoft Edge.app',
    arc: '/Applications/Arc.app',
    vivaldi: '/Applications/Vivaldi.app',
  };
  return Object.keys(apps).filter((k) => fs.existsSync(apps[k]));
}
ipcMain.handle('detect-browsers', () => detectInstalledBrowsers());

// ===== Chrome cookie import for built-in browser =====
// Reads ~/Library/Application Support/Google/Chrome/Default/Cookies (SQLite),
// decrypts values using the AES key stored in macOS Keychain,
// and injects into the webview's persist:browse session.
const { session } = require('electron');
ipcMain.handle('import-chrome-cookies', async (_e, { domainFilter } = {}) => {
  try {
    const { execFileSync } = require('child_process');
    const cryptoM = require('crypto');
    const home = app.getPath('home');
    const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4'];
    const cookiesDbs = profiles
      .map((p) => path.join(home, 'Library/Application Support/Google/Chrome', p, 'Cookies'))
      .filter(fs.existsSync);
    if (cookiesDbs.length === 0) return { ok: false, error: 'Chrome cookies DB not found' };

    // Get Chrome master password from Keychain
    let passwd;
    try {
      passwd = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { encoding: 'utf8' }).trim();
    } catch (err) {
      return { ok: false, error: 'Keychain access denied — try again and approve the prompt' };
    }
    const key = cryptoM.pbkdf2Sync(passwd, 'saltysalt', 1003, 16, 'sha1');

    const ses = session.fromPartition('persist:browse');
    let total = 0;
    let imported = 0;
    for (const db of cookiesDbs) {
      // Copy to a temp file so sqlite3 can read without locking issues
      const tmp = path.join(app.getPath('temp'), `cookies-${Date.now()}.db`);
      fs.copyFileSync(db, tmp);
      let rows;
      try {
        // Use hex() so binary is ASCII — otherwise embedded newlines/0x1f bytes
        // in the encrypted blob break the row split.
        const sql = `SELECT host_key, name, hex(encrypted_value), path, expires_utc, is_secure, is_httponly, samesite FROM cookies${domainFilter ? ` WHERE host_key LIKE '%${domainFilter.replace(/'/g,"''")}%'` : ''};`;
        const raw = execFileSync('sqlite3', ['-separator', '\x1f', tmp, sql], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
        rows = raw.split('\n').filter(Boolean).map((line) => {
          const parts = line.split('\x1f');
          return {
            host: parts[0], name: parts[1],
            encryptedHex: parts[2] || '',
            path: parts[3],
            expires: parseInt(parts[4]) || 0,
            secure: parts[5] === '1', httpOnly: parts[6] === '1', sameSite: parts[7],
          };
        });
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        continue;
      }
      try { fs.unlinkSync(tmp); } catch (_) {}

      for (const row of rows) {
        total++;
        try {
          if (!row.encryptedHex) continue;
          const encBuf = Buffer.from(row.encryptedHex, 'hex');
          if (encBuf.length < 3) continue;
          const prefix = encBuf.slice(0, 3).toString();
          if (prefix !== 'v10' && prefix !== 'v11') continue;
          const iv = Buffer.alloc(16, 0x20); // 16 spaces
          const decipher = cryptoM.createDecipheriv('aes-128-cbc', key, iv);
          const body = encBuf.slice(3);
          let decrypted;
          try {
            decrypted = Buffer.concat([decipher.update(body), decipher.final()]);
          } catch (_) { continue; }
          // Strip PKCS7 padding (createDecipheriv already does); then SHA256 prefix (32 bytes) on some Chrome versions
          let value;
          if (decrypted.length > 32 && row.name && row.name.length > 0) {
            // Some newer Chrome versions prefix 32 bytes of SHA256(host||name) — detect by non-printable
            const maybeStripped = decrypted.slice(32).toString('utf8');
            const direct = decrypted.toString('utf8');
            value = /[\x00-\x08\x0E-\x1F]/.test(direct) && !/[\x00-\x08\x0E-\x1F]/.test(maybeStripped)
              ? maybeStripped
              : direct;
          } else {
            value = decrypted.toString('utf8');
          }
          const host = row.host.startsWith('.') ? row.host.slice(1) : row.host;
          await ses.cookies.set({
            url: `${row.secure ? 'https' : 'http'}://${host}${row.path || '/'}`,
            name: row.name,
            value,
            domain: row.host,
            path: row.path || '/',
            secure: row.secure,
            httpOnly: row.httpOnly,
            expirationDate: row.expires ? Math.floor(row.expires / 1000000 - 11644473600) : undefined,
          });
          imported++;
        } catch (_) { /* skip bad row */ }
      }
    }
    return { ok: true, total, imported };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ===== Native Messaging Host registration =====
const NATIVE_HOST_NAME = 'com.ahfoysal.downloader_for_mac';
const EXTENSION_ID = 'jncpnkmhbhhgjcdhgkhdgfoghnkbdnam';

// Directories where Chrome/Chromium-based browsers look for native host manifests.
function nativeHostDirs() {
  const home = app.getPath('home');
  return {
    chrome:   `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`,
    chromium: `${home}/Library/Application Support/Chromium/NativeMessagingHosts`,
    brave:    `${home}/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts`,
    edge:     `${home}/Library/Application Support/Microsoft Edge/NativeMessagingHosts`,
    arc:      `${home}/Library/Application Support/Arc/User Data/NativeMessagingHosts`,
    vivaldi:  `${home}/Library/Application Support/Vivaldi/NativeMessagingHosts`,
    firefox:  `${home}/Library/Application Support/Mozilla/NativeMessagingHosts`,
  };
}

function hostScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'native-host.js')
    : path.join(__dirname, 'scripts', 'native-host.js');
}

function writeNativeHostManifest() {
  const nodeBin = process.execPath.includes('Electron')
    ? '/usr/bin/env'  // fall back to env node; packaged Electron binary won't run a plain .js
    : process.execPath;
  const hostScript = hostScriptPath();
  // Use a small wrapper that runs node with our script, since Electron's binary is not node.
  // We write a tiny shell stub next to the script to handle invocation.
  const wrapperDir = app.getPath('userData');
  const wrapperPath = path.join(wrapperDir, 'native-host-wrapper.sh');
  const wrapperBody = `#!/bin/bash\nexec /usr/bin/env node "${hostScript}" "$@"\n`;
  fs.writeFileSync(wrapperPath, wrapperBody);
  fs.chmodSync(wrapperPath, 0o755);

  const chromeManifest = {
    name: NATIVE_HOST_NAME,
    description: 'Downloader for Mac native host',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  const firefoxManifest = {
    name: NATIVE_HOST_NAME,
    description: 'Downloader for Mac native host',
    path: wrapperPath,
    type: 'stdio',
    allowed_extensions: ['downloader-for-mac@ahfoysal.dev'],
  };

  const results = {};
  const dirs = nativeHostDirs();
  for (const [browser, dir] of Object.entries(dirs)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${NATIVE_HOST_NAME}.json`);
      const manifest = browser === 'firefox' ? firefoxManifest : chromeManifest;
      fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
      results[browser] = { ok: true, path: target };
    } catch (err) {
      results[browser] = { ok: false, error: err.message };
    }
  }
  return results;
}

ipcMain.handle('install-native-host', () => {
  try {
    const results = writeNativeHostManifest();
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


// Return absolute path to an extension folder shipped with the app.
ipcMain.handle('extension-folder', (_e, browser) => {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(__dirname, 'browser-extension');
  const sub = browser || 'chrome';
  return path.join(base, sub);
});

// Launch a browser's extensions page + reveal the unpacked folder.
ipcMain.handle('open-extension-installer', async (_e, browser) => {
  const folderBase = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(__dirname, 'browser-extension');
  const { execFile } = require('child_process');

  const targets = {
    chrome:   { app: 'Google Chrome',        url: 'chrome://extensions/',       folder: 'chrome' },
    brave:    { app: 'Brave Browser',        url: 'brave://extensions/',        folder: 'chrome' },
    edge:     { app: 'Microsoft Edge',       url: 'edge://extensions/',         folder: 'chrome' },
    arc:      { app: 'Arc',                  url: 'chrome://extensions/',       folder: 'chrome' },
    vivaldi:  { app: 'Vivaldi',              url: 'vivaldi://extensions/',      folder: 'chrome' },
    firefox:  { app: 'Firefox',              url: 'about:debugging#/runtime/this-firefox', folder: 'firefox' },
    safari:   { app: 'Safari',               url: 'https://support.apple.com/guide/safari/use-extensions-sfri32508/mac', folder: 'safari' },
  };
  const t = targets[browser];
  if (!t) return { ok: false, error: 'Unknown browser' };
  const folderPath = path.join(folderBase, t.folder);

  // Reveal the unpacked extension folder in Finder
  shell.showItemInFolder(folderPath);

  // Open the browser at its extensions page
  return new Promise((resolve) => {
    execFile('open', ['-a', t.app, t.url], (err) => {
      if (err) resolve({ ok: false, error: err.message, folderPath });
      else resolve({ ok: true, folderPath });
    });
  });
});

// Attempt truly auto-loading via --load-extension (Chromium only, session-only).
ipcMain.handle('launch-with-extension', async (_e, browser) => {
  const folderBase = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(__dirname, 'browser-extension');
  const { execFile } = require('child_process');
  const paths = {
    chrome:  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    brave:   '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    edge:    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    arc:     '/Applications/Arc.app/Contents/MacOS/Arc',
    vivaldi: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  };
  const bin = paths[browser];
  if (!bin || !fs.existsSync(bin)) return { ok: false, error: 'Browser not found' };
  const folder = path.join(folderBase, 'chrome');
  execFile(bin, [`--load-extension=${folder}`], { detached: true }, () => {});
  return { ok: true, note: 'Launched browser with extension loaded (session only).' };
});

// Disk space check (returns GB free, or null if unknown).
function diskFreeGB(dir) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`df -k "${dir}" | tail -1`).toString();
    const parts = out.trim().split(/\s+/);
    // format: Filesystem 1K-blocks Used Available Capacity Mounted
    return Math.floor(parseInt(parts[3], 10) / (1024 * 1024));
  } catch (_) {
    return null;
  }
}
ipcMain.handle('disk-free', (_e, dir) => diskFreeGB(dir || selectedDownloadFolder));

// Check if a URL was already downloaded (by URL match in history).
ipcMain.handle('check-duplicate', (_e, url) => {
  const h = loadHistory();
  const match = h.find((e) => e.url === url && e.filepath && fs.existsSync(e.filepath));
  return match ? { duplicate: true, filepath: match.filepath, timestamp: match.timestamp } : { duplicate: false };
});

// Per-site defaults — { host: format }
function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}
ipcMain.handle('get-site-default', (_e, url) => {
  const host = hostFromUrl(url);
  return appSettings.siteDefaults[host] || null;
});
ipcMain.handle('set-site-default', (_e, { url, format }) => {
  const host = hostFromUrl(url);
  if (!host) return { ok: false };
  appSettings.siteDefaults[host] = format;
  saveSettings();
  return { ok: true, host, format };
});

// Play position tracker for continue-watching
ipcMain.handle('save-play-position', (_e, { filepath, pos, duration }) => {
  if (!filepath) return { ok: false };
  appSettings.playPositions[filepath] = { pos, duration, ts: Date.now() };
  // Keep only last 200 entries
  const entries = Object.entries(appSettings.playPositions).sort((a,b) => b[1].ts - a[1].ts);
  appSettings.playPositions = Object.fromEntries(entries.slice(0, 200));
  saveSettings();
  return { ok: true };
});
ipcMain.handle('get-play-position', (_e, filepath) => {
  return appSettings.playPositions[filepath] || null;
});

// Check that a history-item file still exists on disk
ipcMain.handle('file-exists', (_e, filepath) => {
  try { return !!filepath && fs.existsSync(filepath); } catch (_) { return false; }
});

// Scan the download folder and add any untracked media files to history.
// Called when the Library view opens — catches files yt-dlp wrote but
// didn't surface via `--print after_move`.
ipcMain.handle('reconcile-library', () => {
  if (!selectedDownloadFolder || !fs.existsSync(selectedDownloadFolder)) return { added: 0 };
  const existing = new Set(loadHistory().map((e) => e.filepath).filter(Boolean));
  function walk(dir, depth = 3) {
    if (depth < 0) return [];
    let list = [];
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) list.push(...walk(full, depth - 1));
        else if (/\.(mp3|m4a|webm|mp4|mkv|mov|flac|ogg|wav|opus|aac)$/i.test(ent.name)) list.push(full);
      }
    } catch (_) {}
    return list;
  }
  const files = walk(selectedDownloadFolder);
  const toAdd = files.filter((f) => !existing.has(f));
  if (toAdd.length === 0) return { added: 0 };
  const history = loadHistory();
  for (const fp of toAdd) {
    const rel = path.relative(selectedDownloadFolder, fp);
    const parts = rel.split(path.sep);
    const playlist = parts.length > 1 ? parts[0].replace(/_/g, ' ') : null;
    const basename = path.basename(fp, path.extname(fp));
    const title = basename.replace(/_/g, ' ').replace(/^\d{3}\s*[-_]\s*/, '').trim();
    const ext = path.extname(fp).slice(1).toLowerCase();
    let stat = null; try { stat = fs.statSync(fp); } catch (_) {}
    history.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      url: null,
      format: ext,
      title,
      uploader: null,
      thumbnail: null,
      filepath: fp,
      folder: selectedDownloadFolder,
      timestamp: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString(),
      playlist,
      reconciled: true,
    });
  }
  saveHistory(history);
  return { added: toAdd.length };
});

// Compute SHA256 of a completed file for duplicate-content detection.
const crypto = require('crypto');
ipcMain.handle('file-hash', async (_e, filepath) => {
  return new Promise((resolve) => {
    if (!filepath || !fs.existsSync(filepath)) return resolve(null);
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', (c) => h.update(c));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', () => resolve(null));
  });
});

ipcMain.handle('probe-formats', async (_e, url) => {
  if (!url) return { ok: false, error: 'no url' };
  try {
    const args = ['--dump-single-json', '--no-playlist', '--no-warnings', url];
    const raw = await ytDlpWrap.execPromise(args);
    const info = JSON.parse(raw);
    const formats = (info.formats || [])
      .filter((f) => f.url && f.protocol && f.protocol !== 'mhtml')
      .map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        height: f.height || null,
        width: f.width || null,
        fps: f.fps || null,
        vcodec: f.vcodec === 'none' ? null : f.vcodec,
        acodec: f.acodec === 'none' ? null : f.acodec,
        abr: f.abr || null,
        vbr: f.vbr || null,
        tbr: f.tbr || null,
        filesize: f.filesize || f.filesize_approx || null,
        format_note: f.format_note || '',
        container: f.container || f.ext || '',
      }));
    return {
      ok: true,
      title: info.title,
      uploader: info.uploader || info.channel || null,
      duration: info.duration || null,
      thumbnail: info.thumbnail || null,
      formats,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update-ytdlp', async (event) => {
  const send = (ch, p) => {
    if (!event.sender.isDestroyed()) event.sender.send(ch, p);
  };
  const url = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  send('ytdlp-update-status', { state: 'downloading', message: 'Downloading latest yt-dlp…' });
  try {
    await downloadFile(url, ytDlpOverridePath);
    fs.chmodSync(ytDlpOverridePath, 0o755);
    ytDlpWrap.setBinaryPath(ytDlpOverridePath);
    const version = await ytDlpWrap.execPromise(['--version']).catch(() => 'unknown');
    send('ytdlp-update-status', { state: 'done', message: `Updated — version ${String(version).trim()}` });
    return { ok: true, version: String(version).trim() };
  } catch (err) {
    send('ytdlp-update-status', { state: 'error', message: err.message });
    return { ok: false, error: err.message };
  }
});

function downloadFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

ipcMain.handle('clear-history', () => {
  saveHistory([]);
  return [];
});

ipcMain.handle('delete-history-entry', (_e, id) => {
  const entries = loadHistory().filter((e) => e.id !== id);
  saveHistory(entries);
  return entries;
});

ipcMain.handle('reveal-file', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  if (selectedDownloadFolder) {
    shell.openPath(selectedDownloadFolder);
    return true;
  }
  return false;
});

ipcMain.handle('open-folder', () => {
  if (selectedDownloadFolder) {
    shell.openPath(selectedDownloadFolder);
    return true;
  }
  return false;
});

ipcMain.on('retry-item', async (event, { url, format, index, playlistFolder, subtitles, cookiesBrowser }) => {
  if (!selectedDownloadFolder || !url) return;
  const preset = FORMAT_PRESETS[format] || FORMAT_PRESETS.mp3;
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };
  send('item-state', { index, state: 'downloading' });

  const extension = preset.ext;
  const outDir = playlistFolder
    ? path.join(selectedDownloadFolder, playlistFolder)
    : selectedDownloadFolder;
  const outputTemplate = path
    .join(outDir, `%(title)s.${extension}`)
    .replace(/\\/g, '/');

  const args = [
    url,
    ...preset.args,
    '-o', outputTemplate,
    '--no-playlist',
    '--newline',
    '--progress',
    '--restrict-filenames',
    '--print', 'after_move:filepath=%(filepath)s',
    '--ffmpeg-location', ffmpegPath,
    '--embed-metadata',
    '--embed-thumbnail',
  ];
  if (subtitles && preset.kind === 'video') {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--embed-subs', '--convert-subs', 'srt');
  }
  if (cookiesBrowser === 'auto') {
    const installed = detectInstalledBrowsers();
    if (installed.length) args.push('--cookies-from-browser', installed[0]);
  } else if (cookiesBrowser && cookiesBrowser !== 'none') {
    args.push('--cookies-from-browser', cookiesBrowser);
  }

  const dl = ytDlpWrap.exec(args);
  let filepath = null;
  dl.on('ytDlpEvent', (type, data) => {
    const text = String(data).trim();
    if (text.startsWith('filepath=')) filepath = text.slice('filepath='.length);
  });
  dl.on('error', (err) => {
    send('item-state', { index, state: 'error', error: err && err.message ? err.message : String(err) });
  });
  dl.on('close', (code) => {
    if (code === 0 && filepath) {
      send('item-state', { index, state: 'done', filepath });
      const entries = addHistoryEntry({
        url,
        format,
        title: path.basename(filepath),
        filepath,
        folder: outDir,
        timestamp: new Date().toISOString(),
        playlist: playlistFolder || null,
      });
      send('history-updated', entries);
    } else {
      send('item-state', { index, state: 'error', error: `Retry failed (code ${code})` });
    }
  });
});

ipcMain.on('cancel-download', (_e, downloadId) => {
  if (downloadId) {
    const d = activeDownloads.get(downloadId);
    if (d && d.proc && d.proc.ytDlpProcess) {
      try { d.proc.ytDlpProcess.kill('SIGTERM'); } catch (_) {}
    }
    // Also remove from queue if pending
    const idx = downloadQueue.findIndex((q) => q.id === downloadId);
    if (idx >= 0) downloadQueue.splice(idx, 1);
    return;
  }
  // Fallback: cancel most recent if no id given
  if (currentDownload && !currentDownload.killed) {
    try { currentDownload.ytDlpProcess && currentDownload.ytDlpProcess.kill('SIGTERM'); } catch (_) {}
  }
});

ipcMain.handle('get-queue-state', () => ({
  active: Array.from(activeDownloads.entries()).map(([id, d]) => ({ id, url: d.url, format: d.format, title: d.title, percent: d.percent || 0, speed: d.speed || '', eta: d.eta || '' })),
  queued: downloadQueue.map((q) => ({ id: q.id, url: q.url, format: q.format })),
  concurrency: appSettings.concurrency || 1,
}));

ipcMain.on('reorder-queue', (_e, orderedIds) => {
  // Reorder pending queue items based on provided id list (ignores unknown ids)
  const map = new Map(downloadQueue.map((q) => [q.id, q]));
  const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
  downloadQueue.splice(0, downloadQueue.length, ...reordered);
});

// Broadcaster: push per-download events with id, and aggregate into whole-queue refresh.
function broadcastQueue() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('queue-state', {
    active: Array.from(activeDownloads.entries()).map(([id, d]) => ({
      id, url: d.url, format: d.format,
      title: d.title || null,
      thumbnail: d.thumbnail || null,
      uploader: d.uploader || null,
      percent: d.percent || 0, speed: d.speed || '', eta: d.eta || '',
      item: d.currentItem || null, state: d.state || 'running',
    })),
    queued: downloadQueue.map((q) => ({ id: q.id, url: q.url, format: q.format })),
  });
}

ipcMain.on('download-audio', async (event, params) => {
  const id = 'd' + (++downloadSeq);
  downloadQueue.push({ id, url: params.url, format: params.format, opts: params, event });
  broadcastQueue();
  pumpDownloads();
});

function pumpDownloads() {
  const max = Math.max(1, Math.min(5, appSettings.concurrency || 1));
  while (activeDownloads.size < max && downloadQueue.length > 0) {
    const job = downloadQueue.shift();
    startOneDownload(job.event, job.id, job.opts);
  }
  broadcastQueue();
}

async function startOneDownload(event, downloadId, { url, format, playlist, subtitles, cookiesBrowser, formatId, startTime, endTime, resume, prefetchedMeta }) {
  if (!selectedDownloadFolder) {
    return event.sender.send('download-error', 'No folder selected. Please select a download folder first.');
  }
  const preset = FORMAT_PRESETS[format] || FORMAT_PRESETS.mp3;

  const send = (channel, payload) => {
    if (event.sender.isDestroyed()) return;
    // Only attach downloadId to plain objects; leave strings, arrays, primitives alone.
    const isPlainObj = payload && typeof payload === 'object' && !Array.isArray(payload);
    const out = isPlainObj ? { ...payload, downloadId } : payload;
    event.sender.send(channel, out);
  };

  activeDownloads.set(downloadId, {
    proc: null, url, format,
    title: prefetchedMeta && prefetchedMeta.title ? prefetchedMeta.title : null,
    thumbnail: prefetchedMeta && prefetchedMeta.thumbnail ? prefetchedMeta.thumbnail : null,
    uploader: prefetchedMeta && prefetchedMeta.uploader ? prefetchedMeta.uploader : null,
    percent: 0, state: 'starting',
  });
  broadcastQueue();
  // Push an early meta event so the Download tab shows the title/thumb now
  // instead of waiting for yt-dlp's slow --dump-single-json probe.
  if (prefetchedMeta && (prefetchedMeta.title || prefetchedMeta.thumbnail)) {
    send('download-meta', {
      title: prefetchedMeta.title || null,
      uploader: prefetchedMeta.uploader || null,
      thumbnail: prefetchedMeta.thumbnail || null,
    });
  }

  send('download-status', playlist ? 'Fetching playlist info…' : 'Fetching video info…');

  // Disk space warning (< 500 MB free)
  const freeGB = diskFreeGB(selectedDownloadFolder);
  if (freeGB != null && freeGB < 0.5) {
    send('download-error', `Only ${freeGB.toFixed(1)} GB free in download folder`);
    return;
  }

  // Keep-awake
  if (appSettings.keepAwake && powerBlockerId == null) {
    try { powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) {}
  }

  let meta = { title: null, uploader: null, duration: null, thumbnail: null, playlistCount: null };
  let playlistItems = [];
  try {
    const infoArgs = playlist
      ? [url, '--flat-playlist', '--dump-single-json', '--no-warnings']
      : [url, '--dump-single-json', '--no-playlist', '--no-warnings'];
    const infoRaw = await ytDlpWrap.execPromise(infoArgs);
    const info = JSON.parse(infoRaw);
    const isPl = info._type === 'playlist' || Array.isArray(info.entries);
    meta = {
      title: info.title || null,
      uploader: info.uploader || info.channel || info.uploader_id || null,
      duration: info.duration || null,
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[info.thumbnails.length - 1]?.url) || null,
      playlistCount: isPl ? (info.playlist_count || (info.entries && info.entries.length) || null) : null,
    };
    send('download-meta', meta);
    if (isPl && playlist && Array.isArray(info.entries)) {
      playlistItems = info.entries.map((e, i) => ({
        index: i + 1,
        title: e.title || e.url || `Item ${i + 1}`,
        url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
        state: 'pending',
      }));
      send('playlist-items', playlistItems);
    }
  } catch (err) {
    console.error('info fetch failed:', err);
  }

  const extension = preset.ext;
  const outputTemplate = path
    .join(
      selectedDownloadFolder,
      playlist ? `%(playlist_title|Playlist)s/%(title)s.${extension}` : `%(title)s.${extension}`
    )
    .replace(/\\/g, '/');
  const archivePath = path.join(userData, 'download-archive.txt');

  // If a specific format_id was picked, override the preset's -f flag.
  const presetArgs = formatId
    ? preset.args.filter((a, i, arr) => a !== '-f' && arr[i - 1] !== '-f').concat(['-f', `${formatId}+ba/${formatId}/b`])
    : preset.args;

  const args = [
    url,
    ...presetArgs,
    '-o', outputTemplate,
    '--newline',
    '--progress',
    '--restrict-filenames',
    '--print', 'after_move:filepath=%(filepath)s',
    '--print', 'before_dl:item=%(playlist_index)s/%(playlist_count)s|%(title)s',
    '--ffmpeg-location', ffmpegPath,
    '--embed-metadata',
    '--embed-thumbnail',
    '--download-archive', archivePath,
  ];

  if (resume !== false) args.push('--continue');
  if (subtitles && preset.kind === 'video') {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--embed-subs', '--convert-subs', 'srt');
  }
  if (cookiesBrowser === 'auto') {
    const installed = detectInstalledBrowsers();
    if (installed.length) args.push('--cookies-from-browser', installed[0]);
  } else if (cookiesBrowser && cookiesBrowser !== 'none') {
    args.push('--cookies-from-browser', cookiesBrowser);
  }
  if (startTime || endTime) {
    const s = startTime || '0:00';
    const e = endTime || 'inf';
    args.push('--download-sections', `*${s}-${e}`);
  }
  if (!playlist) args.push('--no-playlist');
  if (playlist) args.push('--ignore-errors');

  currentDownload = ytDlpWrap.exec(args);
  const myDownload = activeDownloads.get(downloadId);
  if (myDownload) {
    myDownload.proc = currentDownload;
    myDownload.state = 'running';
    myDownload.title = meta.title;
  }
  broadcastQueue();

  // Direct stdout parser — more reliable than yt-dlp-wrap's progress events
  // Catches [download] lines + post-processing phases (ExtractAudio, Merger)
  // and interpolates percent when yt-dlp is silent (e.g. during ffmpeg).
  if (currentDownload.ytDlpProcess && currentDownload.ytDlpProcess.stdout) {
    let lineBuf = '';
    let lastPct = 0;
    let lastProgressTs = Date.now();
    currentDownload.ytDlpProcess.stdout.on('data', (buf) => {
      lineBuf += buf.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        // [download]  33.2% of  2.48MiB at 1.20MiB/s ETA 00:02
        const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMG]?i?B)?(?:\s+at\s+([\d.]+\s*[KMG]?i?B\/s))?(?:\s+ETA\s+([\d:]+))?/);
        if (m) {
          const pct = parseFloat(m[1]) || 0;
          const size = m[2] || '';
          const speed = m[3] || '';
          const eta = m[4] || '';
          lastPct = pct;
          lastProgressTs = Date.now();
          send('download-progress', { percent: pct.toFixed(1), speed, eta, size, item: currentItem });
          const d = activeDownloads.get(downloadId);
          if (d) { d.percent = pct; d.speed = speed; d.eta = eta; d.currentItem = currentItem; broadcastQueue(); }
          broadcastToExtensions({ type: 'progress', percent: pct, eta });
          continue;
        }
        // Post-processing phase — send a status nudge so user sees something is happening
        if (/\[ExtractAudio\]|\[ffmpeg\]|\[Merger\]/i.test(line)) {
          lastProgressTs = Date.now();
          send('download-status', line.trim().slice(0, 160));
          const d = activeDownloads.get(downloadId);
          if (d) { d.speed = 'Converting…'; d.eta = ''; broadcastQueue(); }
        }
        if (line.startsWith('after_move:filepath=')) {
          // Handled already via ytDlpEvent; ignore duplicate here.
          continue;
        }
      }
    });
    // Heartbeat: if no progress line in 800ms, nudge an interim percent so the
    // bar animates instead of appearing stuck.
    const heartbeat = setInterval(() => {
      if (Date.now() - lastProgressTs > 800 && lastPct < 99) {
        const d = activeDownloads.get(downloadId);
        if (d && d.state === 'running') {
          // Creep the bar forward slowly to show activity during ffmpeg
          const bump = Math.min(99, lastPct + 0.5);
          if (bump > lastPct) {
            lastPct = bump;
            d.percent = bump;
            broadcastQueue();
          }
        }
      }
    }, 400);
    currentDownload.ytDlpProcess.on('close', () => clearInterval(heartbeat));
  }
  const completed = [];
  let currentItem = null;
  const startedAt = Date.now();
  let capturedStderr = '';
  let retrying = false;
  if (currentDownload.ytDlpProcess && currentDownload.ytDlpProcess.stderr) {
    currentDownload.ytDlpProcess.stderr.on('data', (b) => { capturedStderr += b.toString(); });
  }

  currentDownload.on('progress', (progress) => {
    const pct = typeof progress.percent === 'number' ? progress.percent.toFixed(1) : progress.percent;
    send('download-progress', {
      percent: pct,
      speed: progress.currentSpeed || '',
      eta: progress.eta || '',
      size: progress.totalSize || '',
      item: currentItem,
    });
    broadcastToExtensions({ type: 'progress', percent: parseFloat(pct) || 0, eta: progress.eta || '' });
    const m = activeDownloads.get(downloadId);
    if (m) {
      m.percent = parseFloat(pct) || 0;
      m.speed = progress.currentSpeed || '';
      m.eta = progress.eta || '';
      m.currentItem = currentItem;
      broadcastQueue();
    }
  });

  let lastStartedIndex = null;
  let lastCompletedIndex = null;

  currentDownload.on('ytDlpEvent', (type, data) => {
    const text = String(data).trim();
    if (text.startsWith('filepath=')) {
      const fp = text.slice('filepath='.length);
      completed.push(fp);
      if (currentItem && currentItem.index) {
        const idx = parseInt(currentItem.index, 10);
        lastCompletedIndex = idx;
        send('item-state', { index: idx, state: 'done', filepath: fp });
      }
      return;
    }
    if (text.startsWith('item=')) {
      const raw = text.slice('item='.length);
      const [idx, title] = raw.split('|');
      const [cur, total] = (idx || '').split('/');
      if (lastStartedIndex != null && lastStartedIndex !== lastCompletedIndex) {
        send('item-state', { index: lastStartedIndex, state: 'error', error: 'Item failed or unavailable' });
      }
      currentItem = { index: cur, total, title: title || '' };
      send('download-item', currentItem);
      if (cur && cur !== 'NA') {
        const n = parseInt(cur, 10);
        lastStartedIndex = n;
        send('item-state', { index: n, state: 'downloading', title });
      }
      return;
    }
    if (type === 'download') {
      send('download-status', text.slice(0, 160));
    }
  });

  currentDownload.on('ytDlpEvent', (type, data) => {
    if (type !== 'error') return;
    const text = String(data).trim();
    const m = text.match(/\[youtube\]\s+([\w-]+):/);
    if (m && currentItem && currentItem.index) {
      send('item-state', {
        index: parseInt(currentItem.index, 10),
        state: 'error',
        error: text.slice(0, 200),
      });
    }
  });

  currentDownload.on('error', (err) => {
    console.error('yt-dlp error:', err);
    send('download-error', err && err.message ? err.message : String(err));
    currentDownload = null;
    activeDownloads.delete(downloadId);
    broadcastQueue();
    pumpDownloads();
  });

  // Scan a directory tree for media files newer than sinceMs
  function scanRecentMedia(dir, sinceMs, maxDepth = 3) {
    const out = [];
    if (!dir || !fs.existsSync(dir) || maxDepth < 0) return out;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) {
        out.push(...scanRecentMedia(full, sinceMs, maxDepth - 1));
      } else {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= sinceMs && /\.(mp3|m4a|webm|mp4|mkv|mov|flac|ogg|wav|opus|aac)$/i.test(ent.name)) {
            out.push(full);
          }
        } catch (_) {}
      }
    }
    return out;
  }

  currentDownload.on('close', (code) => {
    const durationMs = Date.now() - startedAt;
    // Fallback: scan for any media files created since this download started
    // that weren't captured via `--print after_move`. Covers archive-skipped
    // items, format-conversion quirks, and missing print hooks.
    try {
      const scanDir = playlist && meta.title
        ? path.join(selectedDownloadFolder, meta.title.replace(/[\\/:*?"<>|]/g, '_'))
        : selectedDownloadFolder;
      const fallback = scanRecentMedia(scanDir, startedAt - 2000);
      const set = new Set(completed.map((p) => p));
      for (const fp of fallback) if (!set.has(fp)) completed.push(fp);
    } catch (_) {}
    if (lastStartedIndex != null && lastStartedIndex !== lastCompletedIndex) {
      send('item-state', { index: lastStartedIndex, state: 'error', error: 'Item failed or unavailable' });
    }
    // Stop keep-awake when queue is idle (best effort)
    if (powerBlockerId != null) {
      try { powerSaveBlocker.stop(powerBlockerId); } catch (_) {}
      powerBlockerId = null;
    }
    if (code && code !== 0 && completed.length === 0) {
      // Detect yt-dlp signature breakage heuristically — retry once after auto-update
      const errText = (capturedStderr || '').toString();
      const signatureBreak = /signature|nsig|player|extract|cipher/i.test(errText);
      if (signatureBreak && appSettings.autoRetryYtDlp && !retrying) {
        send('download-status', 'yt-dlp extractor failed — updating and retrying…');
        const url2 = process.platform === 'win32'
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
        (async () => {
          try {
            await downloadFile(url2, ytDlpOverridePath);
            fs.chmodSync(ytDlpOverridePath, 0o755);
            ytDlpWrap.setBinaryPath(ytDlpOverridePath);
            retrying = true;
            // Kick off same download again (reuse the closure args)
            ipcMain.emit('download-audio', { sender: event.sender, _retry: true }, { url, format, playlist, subtitles, cookiesBrowser, formatId, startTime, endTime, resume });
          } catch (_) {
            send('download-error', `yt-dlp exited with code ${code}. Auto-update failed; try Tools → Update yt-dlp manually.`);
          }
        })();
        currentDownload = null;
        activeDownloads.delete(downloadId);
        broadcastQueue();
        pumpDownloads();
        return;
      }
      send('download-error', `yt-dlp exited with code ${code}. Tip: Tools → Update yt-dlp if this keeps happening.`);
      currentDownload = null;
      activeDownloads.delete(downloadId);
      broadcastQueue();
      pumpDownloads();
      return;
    }
    const now = new Date().toISOString();
    const paths = completed.length ? completed : [null];
    let entries;
    const existingByPath = new Set(loadHistory().map((e) => e.filepath).filter(Boolean));
    for (const fp of paths) {
      // Skip duplicates — important after scanRecentMedia picks up files
      // that may already be in history from a previous run.
      if (fp && existingByPath.has(fp)) continue;
      const isPl = playlist && paths.length > 1;
      const prettyTitle = fp
        ? path.basename(fp, path.extname(fp)).replace(/_/g, ' ').replace(/^\d{3}\s*[-_]\s*/, '').trim()
        : null;
      entries = addHistoryEntry({
        url,
        format,
        title: prettyTitle || (meta.title || null),
        uploader: meta.uploader,
        thumbnail: meta.thumbnail,
        filepath: fp,
        folder: selectedDownloadFolder,
        timestamp: now,
        durationMs,
        playlist: isPl ? meta.title : null,
      });
    }
    if (!entries) entries = loadHistory();
    send('download-complete', {
      filepath: completed[0] || null,
      count: completed.length,
      history: entries,
    });
    broadcastToExtensions({ type: 'complete', count: completed.length });
    currentDownload = null;
    activeDownloads.delete(downloadId);
    broadcastQueue();
    pumpDownloads();
  });
}
