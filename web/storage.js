// NoteStorage — abstraction layer for note CRUD operations.
//
// Default (web) implementation: delegates to localStorage with 'md_' key prefix.
// Desktop (Electron) and iOS (Capacitor) override this at load time to use
// file-system-backed iCloud storage via IPC or Capacitor Filesystem.
//
// All methods are async so platform implementations can use file I/O without
// blocking. The web implementation returns resolved promises immediately.

window.NoteStorage = {
  async getNote(name) {
    return localStorage.getItem('md_' + name);
  },

  async setNote(name, content) {
    localStorage.setItem('md_' + name, content);
  },

  async removeNote(name) {
    localStorage.removeItem('md_' + name);
  },

  async getAllNoteNames() {
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('md_')) {
        names.push(key.slice(3));
      }
    }
    return names;
  },

  async getAllNotes() {
    const notes = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('md_')) {
        notes.push({ name: key.slice(3), content: localStorage.getItem(key) });
      }
    }
    return notes;
  },

  async clear() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('md_')) keys.push(key);
    }
    keys.forEach(k => localStorage.removeItem(k));
    return keys.length;
  },

  // Backup/export to iCloud stubs — overridden by desktop/iOS implementations
  async writeBackup(filename, data) {},
  async writeExport(filename, data) {},

  // Attachment stubs — no-ops on web (localStorage has no binary file support)
  async writeAttachment(noteName, filename, base64data) { return false; },
  async readAttachment(noteName, filename) { return null; },
  async renameAttachment(noteName, oldFilename, newFilename) { return false; },
  async removeAttachmentDir(noteName) {},
  async renameAttachmentDir(oldNoteName, newNoteName) {},
  async listAttachments(noteName) { return []; }
};

// ── Desktop (Electron) override ──
// When running inside the Electron shell, the preload script exposes
// window.electronAPI.notes which proxies to ipcMain handlers that
// read/write .md files in the iCloud Drive folder.
if (window.electronAPI?.notes) {
  const api = window.electronAPI.notes;
  window.NoteStorage = {
    async getNote(name)            { return api.get(name); },
    async setNote(name, content)   { return api.set(name, content); },
    async removeNote(name)         { return api.remove(name); },
    async getAllNoteNames()         { return api.list(); },
    async getAllNotes() {
      const names = await api.list();
      const notes = [];
      for (const name of names) {
        const content = await api.get(name);
        if (content !== null) notes.push({ name, content });
      }
      return notes;
    },
    async clear()                  { return api.clear(); },
    async writeBackup(filename, data) { return api.writeBackup(filename, data); },
    async writeExport(filename, data) { return api.writeExport(filename, data); },
    async writeAttachment(noteName, filename, data) { return api.writeAttachment(noteName, filename, data); },
    async readAttachment(noteName, filename) { return api.readAttachment(noteName, filename); },
    async renameAttachment(noteName, oldF, newF) { return api.renameAttachment(noteName, oldF, newF); },
    async removeAttachmentDir(noteName) { return api.removeAttachmentDir(noteName); },
    async renameAttachmentDir(oldN, newN) { return api.renameAttachmentDir(oldN, newN); },
    async listAttachments(noteName) { return api.listAttachments(noteName); }
  };
}

// ── iOS (Capacitor) override ──
// When running as a native iOS app, Capacitor's isNativePlatform() returns
// true. The icloud-bridge.js script (loaded before this file on iOS) sets
// window.CapacitorNoteStorage with a Filesystem-backed implementation.
if (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage) {
  window.NoteStorage = window.CapacitorNoteStorage;
}
