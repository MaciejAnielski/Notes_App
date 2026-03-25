# IndexedDB Migration Plan for Web Storage

## Context

The Notes App web version uses `localStorage` (5-10MB limit) for note storage, with attachment methods stubbed as no-ops. Desktop (Electron) and iOS (Capacitor) use PowerSync+Supabase with SQLite and have full attachment support. The user wants to:
1. **Security**: Ensure web notes are browser-sandboxed (no external access without explicit export/import)
2. **Storage capacity**: Support much larger storage, especially for attachments (images/files)

Both localStorage and IndexedDB share the same-origin security model, so sandboxing is already satisfied. The real gain is IndexedDB's capacity (GBs vs 5-10MB) and native binary storage, which unlocks attachment support for the web version.

---

## Pros and Cons

### Pros
- **Storage**: 5-10MB -> effectively unlimited (50-80% of disk)
- **Attachments**: Native Blob storage enables image paste/drag-drop in web version (currently impossible)
- **Binary efficiency**: No 33% base64 overhead for stored attachments
- **Atomic transactions**: Rename = write+delete in single transaction (crash-safe)
- **Non-blocking**: Truly async I/O (localStorage blocks main thread on large iterations)
- **Schema versioning**: Built-in via `onupgradeneeded`
- **Feature parity**: Web gains same attachment interface as desktop/iOS

### Cons
- **Complexity**: ~250 lines vs current 82-line storage.js
- **Debugging**: DevTools for IndexedDB less intuitive than localStorage key-value view
- **Eviction risk**: Without `navigator.storage.persist()`, browser may evict data under pressure (localStorage is never evicted)
- **Private browsing**: Firefox private mode = session-scoped; Safari private mode may throw quota errors
- **Migration risk**: Existing users need one-time localStorage->IndexedDB data transfer

### Security (unchanged)
Both localStorage and IndexedDB are: same-origin sandboxed, equally exposed to XSS, visible in DevTools, unencrypted at rest. **No security difference.** The user's sandboxing requirement is already met by the browser's same-origin policy.

---

## Implementation Plan

### Step 1: Rewrite `web/storage.js` (~250 lines)

Replace localStorage implementation with IndexedDB. Structure:

```
// DB connection singleton (lazy-init on first method call)
let _dbPromise = null;
function _getDB() { ... }  // indexedDB.open('NotesAppDB', 1)

// Schema: onupgradeneeded handler
//   - 'notes' store: keyPath 'name', records { name, content }
//   - 'attachments' store: keyPath ['noteName','filename'],
//       index 'by_note' on 'noteName', records { noteName, filename, data: Blob, mimeType }

// base64 <-> Blob helpers
function _base64ToBlob(b64, mime) { ... }
function _blobToBase64(blob) { ... }

// One-time migration from localStorage
async function _migrateFromLocalStorage(db) { ... }

// NoteStorage interface (same 14 methods, same signatures)
window.NoteStorage = { getNote, setNote, removeNote, trashNote,
  getAllNoteNames, getAllNotes, clear, renameNote,
  writeAttachment, readAttachment, renameAttachment,
  removeAttachmentDir, renameAttachmentDir, listAttachments };

// PowerSync override (unchanged)
```

Key design decisions:
- **Raw IndexedDB API** (no library) -- matches project's no-build-step, no-framework pattern
- **Lazy DB open**: `_getDB()` returns cached promise; first call triggers `indexedDB.open()`. Since all methods are already async, `await _getDB()` is transparent
- **In-memory `_noteNamesCache`** preserved for performance
- **Attachments stored as Blob** internally, converted to/from base64 at API boundary (saves 33% space)
- **Compound key `[noteName, filename]`** for attachments enables efficient per-note range queries

### Step 2: localStorage -> IndexedDB migration

Within `_getDB()`, after DB opens:
1. Check `localStorage.getItem('idb_migration_done')`
2. If not set: iterate all `md_` keys, write to `notes` store in single transaction
3. Set `localStorage.setItem('idb_migration_done', '1')`
4. Keep old `md_` keys as fallback (clean up in a future release)

Pattern mirrors existing `migrateLocalNotesToSync()` at `web/app-init.js:1065-1097`.

### Step 3: Update Projects note routing in `web/note-manager.js`

Lines 182-184 and 457 write Projects note directly to `localStorage.setItem('md_' + PROJECTS_NOTE, ...)`. Change to:
```javascript
if (window.PowerSyncNoteStorage) {
  localStorage.setItem(localKey, newContent);  // Desktop: keep out of sync
} else {
  await NoteStorage.setNote(PROJECTS_NOTE, newContent);  // Web: use IndexedDB
}
```

### Step 4: Request persistent storage

At end of `_getDB()` in `web/storage.js`:
```javascript
if (navigator.storage?.persist) {
  navigator.storage.persist();  // fire-and-forget
}
```
Prevents browser from evicting IndexedDB data under storage pressure.

### Step 5: Multi-tab safety

Handle `versionchange` event on the DB connection:
```javascript
db.onversionchange = () => { db.close(); _dbPromise = null; };
```

---

## Files to Modify

| File | Change | Scope |
|---|---|---|
| `web/storage.js` | Complete rewrite: localStorage -> IndexedDB + attachment support + migration | Major |
| `web/note-manager.js` | Update Projects note storage (lines 182-184, 457) with platform guard | Minor (3 lines) |

**No changes needed to:** `index.html`, `powersync-storage.js`, `export-import.js`, `markdown-renderer.js`, `app-state.js`, `app-init.js`, or any other file. The `NoteStorage` interface abstraction means all consumers work without modification.

## Reference Files
- `web/powersync-storage.js:741-930` -- attachment method signatures and behavior to match
- `web/app-init.js:1065-1097` -- migration pattern reference
- `web/export-import.js:421-424,578-592` -- attachment export/import (already uses NoteStorage)
- `web/note-manager.js:261-262,287,316,365` -- quota error handling (works as-is)

## Verification

1. **Note CRUD**: Create, edit, rename, delete notes in web version; verify data persists across refresh
2. **Migration**: Pre-populate localStorage with `md_` notes, load new code, verify all notes appear in IndexedDB
3. **Attachments**: Paste/drop an image into a note, verify it renders; export as ZIP, verify image included; import ZIP with attachments, verify they render
4. **Export/Import**: Full backup export and restore cycle with notes + attachments
5. **Multi-tab**: Open two tabs, edit in one, verify no crashes or data loss
6. **Desktop/iOS**: Verify PowerSync override still works (IndexedDB code is never active on Electron/Capacitor)
7. **Private browsing**: Test in Firefox/Safari private mode; verify graceful behavior
8. **Storage quota**: Verify error message still appears when storage is exhausted
