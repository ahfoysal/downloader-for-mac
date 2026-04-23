// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const YtDlpWrap = require('yt-dlp-wrap').default;

const ytDlpWrap = new YtDlpWrap();
let selectedDownloadFolder = null;
let currentDownload = null;

const userData = app.getPath('userData');
const settingsPath = path.join(userData, 'settings.json');
const historyPath = path.join(userData, 'history.json');

const EXE = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = app.isPackaged
  ? path.join(process.resourcesPath, `ffmpeg${EXE}`)
  : path.join(__dirname, 'bin', `ffmpeg${EXE}`);

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');
}

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

function loadSettings() {
  const s = loadJSON(settingsPath, {});
  selectedDownloadFolder = s.downloadFolder || null;
}

function saveSettings() {
  saveJSON(settingsPath, { downloadFolder: selectedDownloadFolder });
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

app.whenReady().then(() => {
  loadSettings();
  try {
    const binaryPath = app.isPackaged
      ? path.join(process.resourcesPath, `yt-dlp${EXE}`)
      : path.join(__dirname, 'bin', `yt-dlp${EXE}`);
    ytDlpWrap.setBinaryPath(binaryPath);
  } catch (err) {
    console.error('Failed to set yt-dlp binary path:', err);
  }
  createWindow();
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

ipcMain.on('cancel-download', () => {
  if (currentDownload && !currentDownload.killed) {
    try {
      currentDownload.ytDlpProcess && currentDownload.ytDlpProcess.kill('SIGTERM');
    } catch (e) {
      /* ignore */
    }
  }
});

ipcMain.on('download-audio', async (event, { url, format, playlist }) => {
  if (!selectedDownloadFolder) {
    return event.sender.send('download-error', 'No folder selected. Please select a download folder first.');
  }

  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };

  send('download-status', playlist ? 'Fetching playlist info…' : 'Fetching video info…');

  let meta = { title: null, uploader: null, duration: null, thumbnail: null, playlistCount: null };
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
  } catch (err) {
    console.error('info fetch failed:', err);
  }

  const extension = format === 'mp3' ? 'mp3' : 'webm';
  const outputTemplate = path
    .join(
      selectedDownloadFolder,
      playlist ? '%(playlist_title|Playlist)s/%(playlist_index)03d - %(title)s.' + extension : `%(title)s.${extension}`
    )
    .replace(/\\/g, '/');

  const args = [
    url,
    '-f', 'bestaudio',
    '-o', outputTemplate,
    '--newline',
    '--progress',
    '--restrict-filenames',
    '--print', 'after_move:filepath=%(filepath)s',
    '--print', 'before_dl:item=%(playlist_index)s/%(playlist_count)s|%(title)s',
    '--ffmpeg-location', ffmpegPath,
  ];

  if (!playlist) args.push('--no-playlist');
  if (format === 'mp3') args.push('-x', '--audio-format', 'mp3');

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

  currentDownload.on('ytDlpEvent', (type, data) => {
    const text = String(data).trim();
    if (text.startsWith('filepath=')) {
      completed.push(text.slice('filepath='.length));
      return;
    }
    if (text.startsWith('item=')) {
      const raw = text.slice('item='.length);
      const [idx, title] = raw.split('|');
      const [cur, total] = (idx || '').split('/');
      currentItem = { index: cur, total, title: title || '' };
      send('download-item', currentItem);
      return;
    }
    if (type === 'download') {
      send('download-status', text.slice(0, 160));
    }
  });

  currentDownload.on('error', (err) => {
    console.error('yt-dlp error:', err);
    send('download-error', err && err.message ? err.message : String(err));
    currentDownload = null;
  });

  currentDownload.on('close', (code) => {
    const durationMs = Date.now() - startedAt;
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
