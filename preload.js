// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // actions
  downloadAudio: (url, format, playlist) => ipcRenderer.send('download-audio', { url, format, playlist: !!playlist }),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  selectDownloadFolder: () => ipcRenderer.invoke('select-download-folder'),
  getSavedFolder: () => ipcRenderer.invoke('get-saved-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  revealFile: (filepath) => ipcRenderer.invoke('reveal-file', filepath),

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
});
