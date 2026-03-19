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

  async trashNote(name) {
    // Web (localStorage) has no iCloud trash — just remove the note.
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

// ── PowerSync override (Desktop + iOS) ──
// When running on Desktop (Electron) or iOS (Capacitor), powersync-storage.js
// sets window.PowerSyncNoteStorage with a PowerSync-backed implementation
// that syncs via Supabase. Falls back to the localStorage default above
// if PowerSync initialization failed (e.g. config not set).
//
// Because powersync-storage.js is an async IIFE, it may not have finished
// initializing by the time this script runs. Listen for the 'powersync:ready'
// event as a fallback.
if (window.PowerSyncNoteStorage) {
  window.NoteStorage = window.PowerSyncNoteStorage;
} else {
  window.addEventListener('powersync:ready', () => {
    if (window.PowerSyncNoteStorage) {
      window.NoteStorage = window.PowerSyncNoteStorage;
    }
  }, { once: true });
}
