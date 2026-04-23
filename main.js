// main.js
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const YtDlpWrap = require('yt-dlp-wrap').default;

const ytDlpWrap = new YtDlpWrap();
let selectedDownloadFolder = null;
let currentDownload = null;

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
const ffmpegPath = app.isPackaged
  ? path.join(process.resourcesPath, `ffmpeg${EXE}`)
  : path.join(__dirname, 'bin', `ffmpeg${EXE}`);

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

let appSettings = { downloadFolder: null, subtitles: false, cookiesBrowser: 'none' };

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

app.whenReady().then(() => {
  loadSettings();
  try {
    ytDlpWrap.setBinaryPath(activeYtDlpPath());
  } catch (err) {
    console.error('Failed to set yt-dlp binary path:', err);
  }
  const win = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  buildMenu(win);
});

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
  appSettings = { ...appSettings, ...patch };
  saveSettings();
  return { ...appSettings };
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
    .join(outDir, playlistFolder ? `${String(index).padStart(3, '0')} - %(title)s.${extension}` : `%(title)s.${extension}`)
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
  if (cookiesBrowser && cookiesBrowser !== 'none') {
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

ipcMain.on('cancel-download', () => {
  if (currentDownload && !currentDownload.killed) {
    try {
      currentDownload.ytDlpProcess && currentDownload.ytDlpProcess.kill('SIGTERM');
    } catch (e) {
      /* ignore */
    }
  }
});

ipcMain.on('download-audio', async (event, { url, format, playlist, subtitles, cookiesBrowser }) => {
  if (!selectedDownloadFolder) {
    return event.sender.send('download-error', 'No folder selected. Please select a download folder first.');
  }
  const preset = FORMAT_PRESETS[format] || FORMAT_PRESETS.mp3;

  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };

  send('download-status', playlist ? 'Fetching playlist info…' : 'Fetching video info…');

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
      playlist ? `%(playlist_title|Playlist)s/%(playlist_index)03d - %(title)s.${extension}` : `%(title)s.${extension}`
    )
    .replace(/\\/g, '/');

  const args = [
    url,
    ...preset.args,
    '-o', outputTemplate,
    '--newline',
    '--progress',
    '--restrict-filenames',
    '--print', 'after_move:filepath=%(filepath)s',
    '--print', 'before_dl:item=%(playlist_index)s/%(playlist_count)s|%(title)s',
    '--ffmpeg-location', ffmpegPath,
    '--embed-metadata',
    '--embed-thumbnail',
  ];

  if (subtitles && preset.kind === 'video') {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--embed-subs', '--convert-subs', 'srt');
  }
  if (cookiesBrowser && cookiesBrowser !== 'none') {
    args.push('--cookies-from-browser', cookiesBrowser);
  }
  if (!playlist) args.push('--no-playlist');
  if (playlist) args.push('--ignore-errors');

  currentDownload = ytDlpWrap.exec(args);
  const completed = [];
  let currentItem = null;
  const startedAt = Date.now();

  currentDownload.on('progress', (progress) => {
    const pct = typeof progress.percent === 'number' ? progress.percent.toFixed(1) : progress.percent;
    send('download-progress', {
      percent: pct,
      speed: progress.currentSpeed || '',
      eta: progress.eta || '',
      size: progress.totalSize || '',
      item: currentItem,
    });
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
  });

  currentDownload.on('close', (code) => {
    const durationMs = Date.now() - startedAt;
    if (lastStartedIndex != null && lastStartedIndex !== lastCompletedIndex) {
      send('item-state', { index: lastStartedIndex, state: 'error', error: 'Item failed or unavailable' });
    }
    if (code && code !== 0 && completed.length === 0) {
      send('download-error', `yt-dlp exited with code ${code}`);
      currentDownload = null;
      return;
    }
    const now = new Date().toISOString();
    const paths = completed.length ? completed : [null];
    let entries;
    for (const fp of paths) {
      const isPl = playlist && paths.length > 1;
      entries = addHistoryEntry({
        url,
        format,
        title: isPl && fp ? path.basename(fp) : meta.title,
        uploader: meta.uploader,
        thumbnail: meta.thumbnail,
        filepath: fp,
        folder: selectedDownloadFolder,
        timestamp: now,
        durationMs,
        playlist: isPl ? meta.title : null,
      });
    }
    send('download-complete', {
      filepath: completed[0] || null,
      count: completed.length,
      history: entries,
    });
    currentDownload = null;
  });
});
