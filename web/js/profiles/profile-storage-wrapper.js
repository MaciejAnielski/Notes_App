// profile-storage-wrapper.js — Namespaces NoteStorage by active profile.
//
// Wraps window.NoteStorage so every note name read/written is transparently
// prefixed with `__p<activeProfileId>__`. Filters getAllNotes/getAllNoteNames
// to entries belonging to the active profile and strips the prefix on return.
//
// The PowerSync (Desktop/iOS) fallback for legacy unprefixed rows: rows whose
// names do not start with __p are surfaced as belonging to the default profile
// only — we do NOT mass-rename synced rows to avoid generating hundreds of
// CRUD operations that would propagate to every paired device.
//
// Hidden notes (.app_preferences, .calendar_metadata) are also prefixed,
// which automatically scopes theme + calendar selections per profile.

(function () {
  'use strict';

  const PREFIX_TAG = '__p';
  const PREFIX_END = '__';

  function prefix() {
    const id = window.ProfileStore?.getActiveId();
    return id ? PREFIX_TAG + id + PREFIX_END : '';
  }

  function _isPrefixed(name) {
    return typeof name === 'string' && name.startsWith(PREFIX_TAG);
  }

  function _stripPrefix(name) {
    if (!_isPrefixed(name)) return name;
    const end = name.indexOf(PREFIX_END, PREFIX_TAG.length);
    if (end === -1) return name;
    return name.slice(end + PREFIX_END.length);
  }

  function _belongsToActive(name) {
    const p = prefix();
    if (!p) return true;
    return typeof name === 'string' && name.startsWith(p);
  }

  // True when the active profile is the first/default one. Legacy unprefixed
  // rows (created before the multi-profile feature) are surfaced as belonging
  // to the default profile so existing users see their notes after upgrade.
  // Only applies on PowerSync paths where the IDB rename migration is skipped.
  function _isDefaultActive() {
    const list = window.ProfileStore?.list() || [];
    if (list.length === 0) return false;
    // Default is the first profile by createdAt.
    const sorted = list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return sorted[0]?.id === window.ProfileStore?.getActiveId();
  }

  // Build the wrapper object around an underlying NoteStorage implementation.
  // Each method translates names on the way in and out, while delegating
  // implementation to the wrapped object.
  function _buildWrapper(inner) {
    const wrap = (name) => prefix() + (name ?? '');

    // Read-fallback for legacy unprefixed rows: when the active profile is
    // the default and a read for the prefixed name returns nothing, try the
    // raw name as a fallback. This lets existing users on PowerSync paths
    // continue reading their pre-migration notes.
    async function readWithFallback(name) {
      const direct = await inner.getNote(wrap(name));
      if (direct !== null && direct !== undefined) return direct;
      if (_isDefaultActive() && !_isPrefixed(name)) {
        return inner.getNote(name);
      }
      return direct;
    }

    const wrapped = {
      _unprefixed: inner,
      _isProfileWrapped: true,

      async getNote(name) {
        return readWithFallback(name);
      },
      async setNote(name, content) {
        return inner.setNote(wrap(name), content);
      },
      async removeNote(name) {
        return inner.removeNote(wrap(name));
      },
      async trashNote(name) {
        return inner.trashNote(wrap(name));
      },
      async renameNote(oldName, newName, content) {
        return inner.renameNote(wrap(oldName), wrap(newName), content);
      },
      async getAllNoteNames() {
        const names = await inner.getAllNoteNames();
        const p = prefix();
        if (!p) return names;
        const includeLegacy = _isDefaultActive();
        const out = [];
        const seen = new Set();
        for (const n of names) {
          if (typeof n !== 'string') continue;
          if (n.startsWith(p)) {
            const stripped = n.slice(p.length);
            if (!seen.has(stripped)) { seen.add(stripped); out.push(stripped); }
          } else if (includeLegacy && !n.startsWith(PREFIX_TAG)) {
            if (!seen.has(n)) { seen.add(n); out.push(n); }
          }
        }
        return out;
      },
      async getAllNotes() {
        const all = await inner.getAllNotes();
        const p = prefix();
        if (!p) return all;
        const includeLegacy = _isDefaultActive();
        const out = [];
        const seen = new Set();
        for (const r of all) {
          if (typeof r.name !== 'string') continue;
          if (r.name.startsWith(p)) {
            const stripped = r.name.slice(p.length);
            if (!seen.has(stripped)) {
              seen.add(stripped);
              out.push({ name: stripped, content: r.content });
            }
          } else if (includeLegacy && !r.name.startsWith(PREFIX_TAG)) {
            if (!seen.has(r.name)) {
              seen.add(r.name);
              out.push({ name: r.name, content: r.content });
            }
          }
        }
        return out;
      },
      async clear() {
        // Only clear notes belonging to the active profile.
        const p = prefix();
        if (!p && typeof inner.clear === 'function') return inner.clear();
        const all = await inner.getAllNoteNames();
        let count = 0;
        for (const n of all) {
          if (typeof n === 'string' && n.startsWith(p)) {
            await inner.removeNote(n);
            count++;
          }
        }
        return count;
      },

      // Attachments — namespace via the noteName argument.
      async writeAttachment(noteName, filename, base64data) {
        return inner.writeAttachment(wrap(noteName), filename, base64data);
      },
      async readAttachment(noteName, filename) {
        return inner.readAttachment(wrap(noteName), filename);
      },
      async renameAttachment(noteName, oldFilename, newFilename) {
        return inner.renameAttachment(wrap(noteName), oldFilename, newFilename);
      },
      async removeAttachmentDir(noteName) {
        return inner.removeAttachmentDir(wrap(noteName));
      },
      async renameAttachmentDir(oldNoteName, newNoteName) {
        return inner.renameAttachmentDir(wrap(oldNoteName), wrap(newNoteName));
      },
      async deleteAttachment(noteName, filename) {
        return inner.deleteAttachment(wrap(noteName), filename);
      },
      async listAttachments(noteName) {
        return inner.listAttachments(wrap(noteName));
      }
    };

    // Pass through optional methods that callers feature-detect (they don't
    // need name translation — they manipulate caches/connections, not names).
    for (const method of ['refreshCache', 'triggerSync', 'noteExistsInSync']) {
      if (typeof inner[method] === 'function') {
        if (method === 'noteExistsInSync') {
          wrapped[method] = (name) => inner[method](wrap(name));
        } else {
          wrapped[method] = (...args) => inner[method](...args);
        }
      }
    }

    if ('isSyncEnabled' in inner) wrapped.isSyncEnabled = inner.isSyncEnabled;
    if (typeof inner._getRawDB === 'function') wrapped._getRawDB = inner._getRawDB;

    return wrapped;
  }

  // Migrate existing IDB notes (web only) into the active profile's namespace.
  // Idempotent: rows already starting with __p are skipped.
  // Runs in a single readwrite transaction over notes + attachments.
  async function _migrateIDBToProfile(profileId) {
    if (!window.NoteStorage?._getRawDB) return false;
    const p = PREFIX_TAG + profileId + PREFIX_END;
    try {
      const db = await window.NoteStorage._getRawDB();
      const tx = db.transaction(['notes', 'attachments'], 'readwrite');
      const notesStore = tx.objectStore('notes');
      const attachStore = tx.objectStore('attachments');

      // Notes: rename by put-new + delete-old.
      const noteRecs = await new Promise((resolve, reject) => {
        const req = notesStore.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const rec of noteRecs) {
        if (typeof rec.name !== 'string') continue;
        if (rec.name.startsWith(PREFIX_TAG)) continue;
        notesStore.put({ name: p + rec.name, content: rec.content });
        notesStore.delete(rec.name);
      }

      // Attachments: rewrite the noteName field.
      const attachRecs = await new Promise((resolve, reject) => {
        const req = attachStore.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const rec of attachRecs) {
        if (typeof rec.noteName !== 'string') continue;
        if (rec.noteName.startsWith(PREFIX_TAG)) continue;
        attachStore.delete([rec.noteName, rec.filename]);
        attachStore.put({ noteName: p + rec.noteName, filename: rec.filename, data: rec.data });
      }

      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) {
      console.error('[profile-storage-wrapper] IDB migration failed:', e);
      return false;
    }
  }

  // Replace window.NoteStorage with the wrapped version. Idempotent: if the
  // current NoteStorage is already a profile wrapper, rebuild it around the
  // same inner object so the prefix function picks up the new active profile.
  function install() {
    if (!window.NoteStorage) return false;
    const inner = window.NoteStorage._isProfileWrapped
      ? window.NoteStorage._unprefixed
      : window.NoteStorage;
    window.NoteStorage = _buildWrapper(inner);
    return true;
  }

  window.ProfileStorageWrapper = {
    PREFIX_TAG,
    install,
    prefix,
    _migrateIDBToProfile,
    _stripPrefix,
    _isPrefixed
  };
})();
