// Preload script for Electron
// Exposes safe APIs to the renderer process via contextBridge

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  notes: {
    get: (name) => ipcRenderer.invoke('notes:get', name),
    set: (name, content) => ipcRenderer.invoke('notes:set', name, content),
    remove: (name) => ipcRenderer.invoke('notes:remove', name),
    list: () => ipcRenderer.invoke('notes:list'),
    clear: () => ipcRenderer.invoke('notes:clear'),
    onExternalChange: (callback) => {
      ipcRenderer.on('notes:changed', (_event, data) => callback(data));
    },
    getDir: () => ipcRenderer.invoke('notes:getDir'),
    openFolder: () => ipcRenderer.invoke('notes:openFolder'),
    writeLock: (deviceId) => ipcRenderer.invoke('notes:writeLock', deviceId),
    readLock: () => ipcRenderer.invoke('notes:readLock'),
    removeLock: () => ipcRenderer.invoke('notes:removeLock'),
    writeBackup: (filename, data) => ipcRenderer.invoke('notes:writeBackup', filename, data),
    writeExport: (filename, data) => ipcRenderer.invoke('notes:writeExport', filename, data)
  }
});
