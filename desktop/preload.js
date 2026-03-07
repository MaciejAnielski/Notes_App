// Preload script for Electron
// Exposes safe APIs to the renderer process via contextBridge if needed

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform
});
