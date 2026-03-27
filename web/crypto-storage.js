// CryptoStorage — transparent encryption wrapper for NoteStorage.
//
// Intercepts NoteStorage.getNote / setNote / getAllNotes calls to
// encrypt on write and decrypt on read. The rest of the app (editor,
// search, export, file-list) works with plaintext in memory — only
// the storage layer ever sees ciphertext.
//
// Activation:
//   const wrapped = CryptoStorage.wrap(window.NoteStorage, masterKey);
//   window.NoteStorage = wrapped;
//
// Special notes (Settings, Projects, Note Graph) are never encrypted.

'use strict';

const _SPECIAL_NOTES = new Set(['Settings', 'Projects', 'Note Graph']);

window.CryptoStorage = {

  /**
   * Wrap a NoteStorage implementation with encryption.
   * Returns a new object with the same interface that encrypts/decrypts
   * transparently using the provided masterKey.
   */
  wrap(storage, masterKey) {
    // Create a shallow copy that delegates all methods to the original,
    // then override the methods that touch content.
    const wrapped = {};
    for (const key of Object.keys(storage)) {
      if (typeof storage[key] === 'function') {
        wrapped[key] = storage[key].bind(storage);
      }
    }

    // Also copy any properties that are accessed by name
    // (e.g. noteExistsInSync used by migration code)
    if (storage.noteExistsInSync) {
      wrapped.noteExistsInSync = storage.noteExistsInSync.bind(storage);
    }
    if (storage.refreshCache) {
      wrapped.refreshCache = storage.refreshCache.bind(storage);
    }
    if (storage.triggerSync) {
      wrapped.triggerSync = storage.triggerSync.bind(storage);
    }

    // ── getNote: decrypt after read ──────────────────────────────────────

    wrapped.getNote = async function (name) {
      const raw = await storage.getNote(name);
      if (raw === null) return null;
      if (_SPECIAL_NOTES.has(name)) return raw;
      if (CryptoEngine.isEncrypted(raw)) {
        try {
          return await CryptoEngine.decrypt(raw, masterKey);
        } catch (e) {
          console.error('[crypto-storage] Decryption failed for note:', name, e);
          return raw; // return ciphertext as-is rather than losing data
        }
      }
      return raw; // plaintext (not yet migrated)
    };

    // ── setNote: encrypt before write ────────────────────────────────────

    wrapped.setNote = async function (name, content) {
      if (_SPECIAL_NOTES.has(name)) {
        return storage.setNote(name, content);
      }
      const encrypted = await CryptoEngine.encrypt(content, masterKey);
      return storage.setNote(name, encrypted);
    };

    // ── renameNote: encrypt content during rename ────────────────────────

    wrapped.renameNote = async function (oldName, newName, content) {
      if (_SPECIAL_NOTES.has(newName)) {
        return storage.renameNote(oldName, newName, content);
      }
      const encrypted = await CryptoEngine.encrypt(content, masterKey);
      return storage.renameNote(oldName, newName, encrypted);
    };

    // ── getAllNotes: decrypt all content ──────────────────────────────────

    wrapped.getAllNotes = async function () {
      const notes = await storage.getAllNotes();
      const results = [];
      for (const n of notes) {
        if (_SPECIAL_NOTES.has(n.name) || !CryptoEngine.isEncrypted(n.content)) {
          results.push(n);
        } else {
          try {
            const plaintext = await CryptoEngine.decrypt(n.content, masterKey);
            results.push({ name: n.name, content: plaintext });
          } catch (e) {
            console.error('[crypto-storage] Decrypt failed for note:', n.name, e);
            results.push(n); // pass through ciphertext
          }
        }
      }
      return results;
    };

    // ── Attachment encryption ────────────────────────────────────────────

    wrapped.writeAttachment = async function (noteName, filename, base64data) {
      try {
        const raw = Uint8Array.from(atob(base64data), c => c.charCodeAt(0));
        const enc = await CryptoEngine.encryptBytes(raw, masterKey);
        const encB64 = btoa(String.fromCharCode.apply(null, enc.length <= 8192
          ? enc
          : _chunkedToString(enc)));
        return storage.writeAttachment(noteName, filename, encB64);
      } catch (e) {
        console.error('[crypto-storage] Attachment encrypt failed:', e);
        // Fall back to unencrypted write
        return storage.writeAttachment(noteName, filename, base64data);
      }
    };

    wrapped.readAttachment = async function (noteName, filename) {
      const b64 = await storage.readAttachment(noteName, filename);
      if (!b64) return b64;
      try {
        const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        // Check if this looks like encrypted data (at least IV + 1 byte + tag)
        if (raw.length > 28) {
          const dec = await CryptoEngine.decryptBytes(raw, masterKey);
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < dec.length; i += chunk) {
            binary += String.fromCharCode.apply(null, dec.subarray(i, i + chunk));
          }
          return btoa(binary);
        }
        return b64; // too short to be encrypted, return as-is
      } catch {
        // Not encrypted or wrong key — return raw
        return b64;
      }
    };

    // ── Expose unwrapped storage for migration ───────────────────────────
    wrapped._unwrapped = storage;
    wrapped._masterKey = masterKey;

    return wrapped;
  },

  /**
   * Bulk-encrypt all existing plaintext notes.
   * Called when encryption is first enabled.
   * @param {object} storage - the UNWRAPPED NoteStorage (writes ciphertext directly)
   * @param {CryptoKey} masterKey
   * @param {function} onProgress - callback(current, total)
   * @returns {number} count of migrated notes
   */
  async migrateToEncrypted(storage, masterKey, onProgress) {
    const allNotes = await storage.getAllNotes();
    const toMigrate = allNotes.filter(
      n => !_SPECIAL_NOTES.has(n.name) &&
           n.content &&
           !CryptoEngine.isEncrypted(n.content)
    );

    let done = 0;
    for (const { name, content } of toMigrate) {
      const encrypted = await CryptoEngine.encrypt(content, masterKey);
      await storage.setNote(name, encrypted);
      done++;
      if (onProgress) onProgress(done, toMigrate.length);
    }

    return done;
  }
};

// Helper for large Uint8Array → string conversion
function _chunkedToString(arr) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return binary;
}
