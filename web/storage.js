// NoteStorage — abstraction layer for note CRUD operations.
//
// Default (web) implementation: delegates to IndexedDB for note and attachment
// storage. Desktop (Electron) and iOS (Capacitor) override this at load time
// to use PowerSync + Supabase via powersync-storage.js.
//
// All methods are async — IndexedDB is natively asynchronous.

// ── IndexedDB connection singleton ────────────────────────────────────────

const _DB_NAME = 'NotesAppDB';
const _DB_VERSION = 1;
let _dbPromise = null;

function _getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_DB_NAME, _DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('attachments')) {
        const store = db.createObjectStore('attachments', { keyPath: ['noteName', 'filename'] });
        store.createIndex('by_note', 'noteName', { unique: false });
      }
    };

    req.onsuccess = (e) => {
      const db = e.target.result;
      // Handle version changes from other tabs
      db.onversionchange = () => {
        db.close();
        _dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  }).then(async (db) => {
    await _migrateFromLocalStorage(db);
    // Request persistent storage to prevent eviction
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    return db;
  });
  return _dbPromise;
}

// ── localStorage → IndexedDB migration ────────────────────────────────────

async function _migrateFromLocalStorage(db) {
  if (localStorage.getItem('idb_migration_done')) return;

  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('md_')) keys.push(key);
  }
  if (keys.length === 0) {
    localStorage.setItem('idb_migration_done', '1');
    return;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    for (const key of keys) {
      const name = key.slice(3);
      const content = localStorage.getItem(key);
      // Only write if not already present (idempotent for crash recovery)
      const getReq = store.get(name);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          store.put({ name, content });
        }
      };
    }
    tx.oncomplete = () => {
      localStorage.setItem('idb_migration_done', '1');
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ── Base64 ↔ Blob helpers ─────────────────────────────────────────────────

function _base64ToBlob(b64, mimeType) {
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // reader.result is "data:<mime>;base64,<data>" — extract the base64 part
      const idx = reader.result.indexOf(',');
      resolve(idx >= 0 ? reader.result.slice(idx + 1) : reader.result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── IDB transaction helpers ───────────────────────────────────────────────

function _txStore(db, storeName, mode) {
  const tx = db.transaction(storeName, mode);
  return { tx, store: tx.objectStore(storeName) };
}

function _req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function _txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── In-memory cache for note names ────────────────────────────────────────

let _noteNamesCache = null;

// ── NoteStorage interface ─────────────────────────────────────────────────

window.NoteStorage = {
  async getNote(name) {
    const db = await _getDB();
    const { store } = _txStore(db, 'notes', 'readonly');
    const rec = await _req(store.get(name));
    return rec ? rec.content : null;
  },

  async setNote(name, content) {
    _noteNamesCache = null;
    const db = await _getDB();
    const { tx, store } = _txStore(db, 'notes', 'readwrite');
    store.put({ name, content });
    await _txDone(tx);
  },

  async removeNote(name) {
    _noteNamesCache = null;
    const db = await _getDB();
    const { tx, store } = _txStore(db, 'notes', 'readwrite');
    store.delete(name);
    await _txDone(tx);
  },

  async trashNote(name) {
    // Web (IndexedDB) has no trash — just remove the note.
    _noteNamesCache = null;
    const db = await _getDB();
    const { tx, store } = _txStore(db, 'notes', 'readwrite');
    store.delete(name);
    await _txDone(tx);
    await this.removeAttachmentDir(name);
  },

  async getAllNoteNames() {
    if (_noteNamesCache !== null) return _noteNamesCache.slice();
    const db = await _getDB();
    const { store } = _txStore(db, 'notes', 'readonly');
    const names = await _req(store.getAllKeys());
    _noteNamesCache = names;
    return names.slice();
  },

  async getAllNotes() {
    const db = await _getDB();
    const { store } = _txStore(db, 'notes', 'readonly');
    const records = await _req(store.getAll());
    return records.map(r => ({ name: r.name, content: r.content }));
  },

  async clear() {
    _noteNamesCache = null;
    const db = await _getDB();
    const { tx, store } = _txStore(db, 'notes', 'readwrite');
    const count = await _req(store.count());
    store.clear();
    await _txDone(tx);
    return count;
  },

  async renameNote(oldName, newName, content) {
    _noteNamesCache = null;
    const db = await _getDB();
    const { tx, store } = _txStore(db, 'notes', 'readwrite');
    store.put({ name: newName, content });
    store.delete(oldName);
    await _txDone(tx);
  },

  // ── Attachment methods ────────────────────────────────────────────────

  async writeAttachment(noteName, filename, base64data) {
    try {
      const db = await _getDB();
      const blob = _base64ToBlob(base64data);
      const { tx, store } = _txStore(db, 'attachments', 'readwrite');
      store.put({ noteName, filename, data: blob });
      await _txDone(tx);
      return true;
    } catch (e) {
      console.error('[storage] writeAttachment failed:', e);
      return false;
    }
  },

  async readAttachment(noteName, filename) {
    try {
      const db = await _getDB();
      const { store } = _txStore(db, 'attachments', 'readonly');
      const rec = await _req(store.get([noteName, filename]));
      if (!rec || !rec.data) return null;
      return await _blobToBase64(rec.data);
    } catch (e) {
      console.error('[storage] readAttachment failed:', e);
      return null;
    }
  },

  async renameAttachment(noteName, oldFilename, newFilename) {
    try {
      const db = await _getDB();
      const { tx, store } = _txStore(db, 'attachments', 'readwrite');
      const rec = await _req(store.get([noteName, oldFilename]));
      if (!rec) return false;
      store.delete([noteName, oldFilename]);
      store.put({ noteName, filename: newFilename, data: rec.data });
      await _txDone(tx);
      return true;
    } catch (e) {
      console.error('[storage] renameAttachment failed:', e);
      return false;
    }
  },

  async removeAttachmentDir(noteName) {
    try {
      const db = await _getDB();
      const { tx, store } = _txStore(db, 'attachments', 'readwrite');
      const index = store.index('by_note');
      const keys = await _req(index.getAllKeys(noteName));
      for (const key of keys) {
        store.delete(key);
      }
      await _txDone(tx);
    } catch (e) {
      console.error('[storage] removeAttachmentDir failed:', e);
    }
  },

  async deleteAttachment(noteName, filename) {
    try {
      const db = await _getDB();
      const { tx, store } = _txStore(db, 'attachments', 'readwrite');
      store.delete([noteName, filename]);
      await _txDone(tx);
    } catch (e) {
      console.error('[storage] deleteAttachment failed:', e);
    }
  },

  async renameAttachmentDir(oldNoteName, newNoteName) {
    try {
      const db = await _getDB();
      const { tx, store } = _txStore(db, 'attachments', 'readwrite');
      const index = store.index('by_note');
      const recs = await _req(index.getAll(oldNoteName));
      for (const rec of recs) {
        store.delete([oldNoteName, rec.filename]);
        store.put({ noteName: newNoteName, filename: rec.filename, data: rec.data });
      }
      await _txDone(tx);
    } catch (e) {
      console.error('[storage] renameAttachmentDir failed:', e);
    }
  },

  async listAttachments(noteName) {
    try {
      const db = await _getDB();
      const { store } = _txStore(db, 'attachments', 'readonly');
      const index = store.index('by_note');
      const recs = await _req(index.getAll(noteName));
      return recs.map(r => r.filename);
    } catch (e) {
      console.error('[storage] listAttachments failed:', e);
      return [];
    }
  }
};

// ── PowerSync override (Desktop + iOS) ──
// When running on Desktop (Electron) or iOS (Capacitor), powersync-storage.js
// sets window.PowerSyncNoteStorage with a PowerSync-backed implementation
// that syncs via Supabase. Falls back to the IndexedDB default above
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
