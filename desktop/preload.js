// Preload script for Electron
// Exposes safe APIs to the renderer process via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('notes:openExternal', url),

  // Magic link auth callback: main process forwards the notesapp:// URL here.
  // powersync-storage.js calls this to register its handler.
  onAuthCallback: (callback) => {
    ipcRenderer.on('auth:callback', (_event, url) => callback(url));
  }
});
