// Preload script for Electron
// Exposes safe APIs to the renderer process via contextBridge

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  notes: {
    get: (name) => ipcRenderer.invoke('notes:get', name),
    set: (name, content) => ipcRenderer.invoke('notes:set', name, content),
    remove: (name) => ipcRenderer.invoke('notes:remove', name),
    trash: (name) => ipcRenderer.invoke('notes:trash', name),
    list: () => ipcRenderer.invoke('notes:list'),
    clear: () => ipcRenderer.invoke('notes:clear'),
    onExternalChange: (callback) => {
      ipcRenderer.on('notes:changed', (_event, data) => callback(data));
    },
    getDir: () => ipcRenderer.invoke('notes:getDir'),
    openFolder: () => ipcRenderer.invoke('notes:openFolder'),
    forceSync: () => ipcRenderer.invoke('notes:forceSync'),
    writeBackup: (filename, data) => ipcRenderer.invoke('notes:writeBackup', filename, data),
    writeExport: (filename, data) => ipcRenderer.invoke('notes:writeExport', filename, data),
    writeAttachment: (noteName, filename, data) => ipcRenderer.invoke('notes:writeAttachment', noteName, filename, data),
    readAttachment: (noteName, filename) => ipcRenderer.invoke('notes:readAttachment', noteName, filename),
    renameAttachment: (noteName, oldF, newF) => ipcRenderer.invoke('notes:renameAttachment', noteName, oldF, newF),
    removeAttachmentDir: (noteName) => ipcRenderer.invoke('notes:removeAttachmentDir', noteName),
    renameAttachmentDir: (oldName, newName) => ipcRenderer.invoke('notes:renameAttachmentDir', oldName, newName),
    openAttachment: (noteName, filename) => ipcRenderer.invoke('notes:openAttachment', noteName, filename),
    listAttachments: (noteName) => ipcRenderer.invoke('notes:listAttachments', noteName),
    openExternal: (url) => ipcRenderer.invoke('notes:openExternal', url)
  }
});
