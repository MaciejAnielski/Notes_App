// Preload script for Electron
// Exposes safe APIs to the renderer process via contextBridge.
// Storage is now handled by PowerSync in the renderer — only utility IPC remains.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('notes:openExternal', url),
  // Legacy migration: read notes from old iCloud folder (one-time, first launch only)
  readLegacyNotes: () => ipcRenderer.invoke('notes:readLegacyNotes')
});
