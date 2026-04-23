// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // actions
  downloadAudio: (url, format, opts = {}) =>
    ipcRenderer.send('download-audio', {
      url,
      format,
      playlist: !!opts.playlist,
      subtitles: !!opts.subtitles,
      cookiesBrowser: opts.cookiesBrowser || 'none',
      formatId: opts.formatId || null,
      startTime: opts.startTime || null,
      endTime: opts.endTime || null,
      resume: opts.resume !== false,
    }),
  probeFormats: (url) => ipcRenderer.invoke('probe-formats', url),
  readClipboard: () => require('electron').clipboard.readText(),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  retryItem: (payload) => ipcRenderer.send('retry-item', payload),
  selectDownloadFolder: () => ipcRenderer.invoke('select-download-folder'),
  getSavedFolder: () => ipcRenderer.invoke('get-saved-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  revealFile: (filepath) => ipcRenderer.invoke('reveal-file', filepath),

  // settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),

  // yt-dlp updater
  updateYtdlp: () => ipcRenderer.invoke('update-ytdlp'),
  onYtdlpUpdateStatus: (cb) => ipcRenderer.on('ytdlp-update-status', (_e, data) => cb(data)),
  onTriggerUpdateYtdlp: (cb) => ipcRenderer.on('trigger-update-ytdlp', () => cb()),
  onNotify: (cb) => ipcRenderer.on('notify', (_e, msg) => cb(msg)),

  // history
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  deleteHistoryEntry: (id) => ipcRenderer.invoke('delete-history-entry', id),

  // events
  onMeta: (cb) => ipcRenderer.on('download-meta', (_e, meta) => cb(meta)),
  onPlaylistItems: (cb) => ipcRenderer.on('playlist-items', (_e, items) => cb(items)),
  onItemState: (cb) => ipcRenderer.on('item-state', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('download-status', (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('download-progress', (_e, data) => cb(data)),
  onComplete: (cb) => ipcRenderer.on('download-complete', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('download-error', (_e, msg) => cb(msg)),
  onHistoryUpdated: (cb) => ipcRenderer.on('history-updated', (_e, data) => cb(data)),
});
