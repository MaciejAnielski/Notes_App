// Preload script for Electron
// Exposes safe APIs to the renderer process via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('notes:openExternal', url),

  // Returns the local auth-callback URL (http://127.0.0.1:<port>/auth-callback).
  // powersync-storage.js passes this as emailRedirectTo so magic links open
  // the local server page, which extracts the tokens and sends them back here.
  getAuthCallbackUrl: () => ipcRenderer.invoke('notes:getAuthCallbackUrl'),

  // Magic link auth callback: main process forwards either
  //   • the raw token param-string from the local HTTP server POST, or
  //   • a notesapp:// deep-link URL (protocol handler fallback).
  // powersync-storage.js calls this to register its handler.
  onAuthCallback: (callback) => {
    ipcRenderer.on('auth:callback', (_event, payload) => callback(payload));
  },

  // Write attachment bytes to a temp file and open with the OS default app.
  openAttachmentFile: (filename, base64data) =>
    ipcRenderer.invoke('notes:openAttachmentFile', filename, base64data),

  // Open a new application window.
  newWindow: () => ipcRenderer.invoke('notes:newWindow'),

  // Forward a NoteStorage call to the primary window (secondary windows only).
  proxyNoteStorage: (method, args) => ipcRenderer.invoke('notes:proxy', method, args)
});
