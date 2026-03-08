const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

// ── iCloud Drive paths ─────────────────────────────────────────────────────
// The desktop app uses com~apple~CloudDocs as its PRIMARY storage so notes
// appear in Finder's iCloud Drive sidebar and can be edited by other apps.
// It also syncs bidirectionally with the iOS container so both platforms
// share the same notes.
const ICLOUD_ROOT = path.join(os.homedir(), 'Library', 'Mobile Documents');

// Primary (Finder-visible)
const CLOUD_DOCS        = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', 'Notes App');
const CLOUD_DOCS_NOTES  = path.join(CLOUD_DOCS, '000_Notes');
const CLOUD_DOCS_BACKUPS = path.join(CLOUD_DOCS, '001_Backups');
const CLOUD_DOCS_EXPORTS = path.join(CLOUD_DOCS, '002_Exports');

// iOS container (for syncing with iOS devices)
const IOS_CONTAINER_DOCS = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents');
const IOS_CONTAINER_NOTES  = path.join(IOS_CONTAINER_DOCS, '000_Notes');
const IOS_CONTAINER_BACKUPS = path.join(IOS_CONTAINER_DOCS, '001_Backups');
const IOS_CONTAINER_EXPORTS = path.join(IOS_CONTAINER_DOCS, '002_Exports');

let notesDir = null;
let backupsDir = null;
let exportsDir = null;
let iosNotesDir = null;   // null if iOS container doesn't exist
let iosBackupsDir = null;
let iosExportsDir = null;
let iCloudAvailable = false;
let fileWatcher = null;

// Track writes we initiated so the file watcher doesn't echo them back
const _ourWrites = new Set(); // filenames currently being written by us

// Content hash cache for change detection — avoids unnecessary IPC events
// when mtimes change but content is identical (common with iCloud metadata sync)
const _contentHashes = new Map(); // filename -> content hash string

async function getFileHash(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    // Simple fast hash: use content length + first/last chars + sample
    // This is not cryptographic but sufficient for change detection
    const len = content.length;
    if (len === 0) return 'empty';
    const mid = Math.floor(len / 2);
    return `${len}:${content.charCodeAt(0)}:${content.charCodeAt(mid)}:${content.charCodeAt(len - 1)}:${content.slice(0, 100)}:${content.slice(-100)}`;
  } catch {
    return null; // file doesn't exist or can't be read
  }
}

// Track files we recently wrote through to iOS to avoid re-syncing them back
const _iosWriteThroughs = new Map(); // filename -> timestamp of write-through

// ── Resolve storage directories ────────────────────────────────────────────
function resolveNotesDir() {
  if (process.platform !== 'darwin') return;

  const cloudDocsRoot = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs');
  if (!fsSync.existsSync(cloudDocsRoot)) return; // iCloud not signed in

  // Primary: CloudDocs (visible in Finder)
  notesDir = CLOUD_DOCS_NOTES;
  backupsDir = CLOUD_DOCS_BACKUPS;
  exportsDir = CLOUD_DOCS_EXPORTS;
  for (const dir of [notesDir, backupsDir, exportsDir]) {
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
  }
  iCloudAvailable = true;

  // Secondary: iOS container (for syncing with iOS devices)
  if (fsSync.existsSync(IOS_CONTAINER_DOCS)) {
    iosNotesDir = IOS_CONTAINER_NOTES;
    iosBackupsDir = IOS_CONTAINER_BACKUPS;
    iosExportsDir = IOS_CONTAINER_EXPORTS;
    for (const dir of [iosNotesDir, iosBackupsDir, iosExportsDir]) {
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    }
  }
}

// ── File name sanitization ─────────────────────────────────────────────────
const UNSAFE_CHARS = /[/\\:*?"<>|]/g;

function noteNameToFileName(name) {
  return name.replace(UNSAFE_CHARS, '_') + '.md';
}

function noteNameToAttachmentDir(name) {
  return name.replace(UNSAFE_CHARS, '_') + '.attachments';
}

// Remove a directory tree silently (no-op if missing)
async function rmdir(dirPath) {
  try { await fs.rm(dirPath, { recursive: true, force: true }); } catch {}
}

function fileNameToNoteName(fileName) {
  if (!fileName.endsWith('.md')) return null;
  return fileName.slice(0, -3);
}

// ── Bidirectional sync with iOS container ──────────────────────────────────
// Copy a single file from src dir to dst dir if it is newer or missing.
async function syncFile(filename, srcDir, dstDir) {
  const srcPath = path.join(srcDir, filename);
  const dstPath = path.join(dstDir, filename);
  try {
    const srcStat = await fs.stat(srcPath);
    let needsCopy = false;
    try {
      const dstStat = await fs.stat(dstPath);
      needsCopy = srcStat.mtimeMs > dstStat.mtimeMs + 1000; // 1s tolerance
    } catch {
      needsCopy = true; // dst doesn't exist
    }
    if (needsCopy) {
      await fs.mkdir(dstDir, { recursive: true });
      await fs.copyFile(srcPath, dstPath);
    }
  } catch {
    // Source doesn't exist or read error — skip
  }
}

// Recursively sync an attachment directory from src to dst.
// Copies individual files that are newer or missing.
async function syncAttachmentDir(dirName, srcParent, dstParent) {
  const srcDir = path.join(srcParent, dirName);
  const dstDir = path.join(dstParent, dirName);
  try {
    const srcStat = await fs.stat(srcDir);
    if (!srcStat.isDirectory()) return;
  } catch { return; }

  try {
    await fs.mkdir(dstDir, { recursive: true });
    const files = await fs.readdir(srcDir);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      await syncFile(file, srcDir, dstDir);
    }
  } catch { /* non-fatal */ }
}

// Full sync between CloudDocs and iOS container (newer file wins).
async function fullSync() {
  if (!iosNotesDir) return;

  // Sync notes in both directions
  const pairs = [
    [notesDir, iosNotesDir],
    [backupsDir, iosBackupsDir],
    [exportsDir, iosExportsDir],
  ];

  for (const [cloudDir, iosDir] of pairs) {
    const isMdDir = cloudDir === notesDir;
    // CloudDocs → iOS container
    try {
      const files = await fs.readdir(cloudDir);
      for (const file of files) {
        if (isMdDir && file.endsWith('.attachments')) {
          await syncAttachmentDir(file, cloudDir, iosDir);
        } else {
          if (isMdDir && !file.endsWith('.md')) continue;
          await syncFile(file, cloudDir, iosDir);
        }
      }
    } catch { /* dir may not exist */ }

    // iOS container → CloudDocs
    try {
      const files = await fs.readdir(iosDir);
      for (const file of files) {
        if (isMdDir && file.endsWith('.attachments')) {
          await syncAttachmentDir(file, iosDir, cloudDir);
        } else {
          if (isMdDir && !file.endsWith('.md')) continue;
          await syncFile(file, iosDir, cloudDir);
        }
      }
    } catch { /* dir may not exist */ }
  }
}

// Sync a specific file after a desktop write (write-through to iOS container)
async function writeThrough(filename, dir, iosDir) {
  if (!iosDir) return;
  try {
    await fs.mkdir(iosDir, { recursive: true });
    const src = path.join(dir, filename);
    const dst = path.join(iosDir, filename);
    await fs.copyFile(src, dst);
    // Track this write-through so polling doesn't re-sync it back
    _iosWriteThroughs.set(filename, Date.now());
  } catch {
    // Non-fatal — iOS sync will catch up later
  }
}

// Delete a file from the iOS container mirror
async function deleteMirror(filename, iosDir) {
  if (!iosDir) return;
  try {
    await fs.unlink(path.join(iosDir, filename));
  } catch { /* may not exist */ }
}

// ── IPC handlers for note CRUD ─────────────────────────────────────────────
function registerNoteHandlers() {
  ipcMain.handle('notes:get', async (_event, name) => {
    if (!notesDir) return null;
    const filePath = path.join(notesDir, noteNameToFileName(name));
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('notes:set', async (_event, name, content) => {
    if (!notesDir) return;
    await fs.mkdir(notesDir, { recursive: true });
    const filename = noteNameToFileName(name);
    _ourWrites.add(filename);
    try {
      const filePath = path.join(notesDir, filename);
      await fs.writeFile(filePath, content, 'utf-8');
      // Update content hash so polling doesn't re-detect this write as a change
      const hash = await getFileHash(filePath);
      if (hash) _contentHashes.set(filename, hash);
      await writeThrough(filename, notesDir, iosNotesDir);
    } finally {
      // Delay clearing so the file watcher event can be filtered
      setTimeout(() => _ourWrites.delete(filename), 500);
    }
  });

  ipcMain.handle('notes:remove', async (_event, name) => {
    if (!notesDir) return;
    const filename = noteNameToFileName(name);
    _ourWrites.add(filename);
    try {
      await fs.unlink(path.join(notesDir, filename));
    } catch { /* may not exist */ }
    await deleteMirror(filename, iosNotesDir);
    // Remove the attachments folder for this note
    const attDir = noteNameToAttachmentDir(name);
    await rmdir(path.join(notesDir, attDir));
    if (iosNotesDir) await rmdir(path.join(iosNotesDir, attDir));
    setTimeout(() => _ourWrites.delete(filename), 500);
  });

  ipcMain.handle('notes:list', async () => {
    if (!notesDir) return [];
    try {
      const files = await fs.readdir(notesDir);
      return files
        .filter(f => f.endsWith('.md'))
        .map(f => fileNameToNoteName(f))
        .filter(Boolean);
    } catch {
      return [];
    }
  });

  ipcMain.handle('notes:clear', async () => {
    if (!notesDir) return 0;
    try {
      const files = await fs.readdir(notesDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      for (const file of mdFiles) {
        _ourWrites.add(file);
        await fs.unlink(path.join(notesDir, file));
        await deleteMirror(file, iosNotesDir);
        // Also remove the attachment directory for this note
        const noteName = fileNameToNoteName(file);
        if (noteName) {
          const attDir = noteNameToAttachmentDir(noteName);
          await rmdir(path.join(notesDir, attDir));
          if (iosNotesDir) await rmdir(path.join(iosNotesDir, attDir));
        }
        setTimeout(() => _ourWrites.delete(file), 500);
      }
      return mdFiles.length;
    } catch {
      return 0;
    }
  });

  ipcMain.handle('notes:getDir', () => {
    return { path: notesDir, iCloudAvailable, iosContainerAvailable: !!iosNotesDir };
  });

  ipcMain.handle('notes:openFolder', async () => {
    if (notesDir) {
      await shell.openPath(notesDir);
    }
  });

  ipcMain.handle('notes:forceSync', async () => {
    await fullSync();
    // Notify the renderer that notes may have changed after the sync.
    if (win && !win.isDestroyed()) {
      win.webContents.send('notes:changed', { eventType: 'change', filename: '*' });
    }
  });

  // ── Attachment CRUD ──
  ipcMain.handle('notes:writeAttachment', async (_event, noteName, filename, base64data) => {
    if (!notesDir) return false;
    const attDir = path.join(notesDir, noteNameToAttachmentDir(noteName));
    await fs.mkdir(attDir, { recursive: true });
    const buf = Buffer.from(base64data, 'base64');
    await fs.writeFile(path.join(attDir, filename), buf);
    if (iosNotesDir) {
      const iosAttDir = path.join(iosNotesDir, noteNameToAttachmentDir(noteName));
      try {
        await fs.mkdir(iosAttDir, { recursive: true });
        await fs.copyFile(path.join(attDir, filename), path.join(iosAttDir, filename));
      } catch {}
    }
    return true;
  });

  ipcMain.handle('notes:readAttachment', async (_event, noteName, filename) => {
    if (!notesDir) return null;
    try {
      const buf = await fs.readFile(path.join(notesDir, noteNameToAttachmentDir(noteName), filename));
      return buf.toString('base64');
    } catch { return null; }
  });

  ipcMain.handle('notes:renameAttachment', async (_event, noteName, oldFilename, newFilename) => {
    if (!notesDir) return false;
    const attDir = path.join(notesDir, noteNameToAttachmentDir(noteName));
    try {
      await fs.rename(path.join(attDir, oldFilename), path.join(attDir, newFilename));
      if (iosNotesDir) {
        const iosAttDir = path.join(iosNotesDir, noteNameToAttachmentDir(noteName));
        try { await fs.rename(path.join(iosAttDir, oldFilename), path.join(iosAttDir, newFilename)); } catch {}
      }
      return true;
    } catch { return false; }
  });

  ipcMain.handle('notes:removeAttachmentDir', async (_event, noteName) => {
    if (!notesDir) return;
    const attDir = noteNameToAttachmentDir(noteName);
    await rmdir(path.join(notesDir, attDir));
    if (iosNotesDir) await rmdir(path.join(iosNotesDir, attDir));
  });

  ipcMain.handle('notes:openAttachment', async (_event, noteName, filename) => {
    if (!notesDir) return;
    const filePath = path.join(notesDir, noteNameToAttachmentDir(noteName), filename);
    await shell.openPath(filePath);
  });

  ipcMain.handle('notes:listAttachments', async (_event, noteName) => {
    if (!notesDir) return [];
    const attDir = path.join(notesDir, noteNameToAttachmentDir(noteName));
    try {
      const files = await fs.readdir(attDir);
      return files.filter(f => !f.startsWith('.'));
    } catch { return []; }
  });

  ipcMain.handle('notes:renameAttachmentDir', async (_event, oldNoteName, newNoteName) => {
    if (!notesDir) return;
    const oldDir = path.join(notesDir, noteNameToAttachmentDir(oldNoteName));
    const newDir = path.join(notesDir, noteNameToAttachmentDir(newNoteName));
    try { await fs.rename(oldDir, newDir); } catch {}
    if (iosNotesDir) {
      const iosOld = path.join(iosNotesDir, noteNameToAttachmentDir(oldNoteName));
      const iosNew = path.join(iosNotesDir, noteNameToAttachmentDir(newNoteName));
      try { await fs.rename(iosOld, iosNew); } catch {}
    }
  });

  // ── Backup/export to iCloud folders ──
  ipcMain.handle('notes:writeBackup', async (_event, filename, data) => {
    if (!backupsDir) return;
    await fs.mkdir(backupsDir, { recursive: true });
    const buf = Buffer.from(data, 'base64');
    await fs.writeFile(path.join(backupsDir, filename), buf);
    await writeThrough(filename, backupsDir, iosBackupsDir);
  });

  ipcMain.handle('notes:writeExport', async (_event, filename, data) => {
    if (!exportsDir) return;
    await fs.mkdir(exportsDir, { recursive: true });
    await fs.writeFile(path.join(exportsDir, filename), data, 'utf-8');
    await writeThrough(filename, exportsDir, iosExportsDir);
  });
}

// ── One-time migration from old notes locations ────────────────────────────
async function migrateOldNotes() {
  if (!notesDir) return;
  // Locations that can be moved from (not needed after migration)
  const moveFrom = [
    path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', 'Notes App'),
    path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', '000_Notes'),
  ];
  // Locations that should be copied from (still needed for iOS sync)
  const copyFrom = [
    IOS_CONTAINER_NOTES,
    path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents'),
  ];

  for (const oldDir of moveFrom) {
    if (oldDir === notesDir) continue;
    try {
      const files = await fs.readdir(oldDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      if (mdFiles.length === 0) continue;
      await fs.mkdir(notesDir, { recursive: true });
      for (const file of mdFiles) {
        const src = path.join(oldDir, file);
        const dst = path.join(notesDir, file);
        try { await fs.access(dst); continue; } catch {}
        await fs.rename(src, dst);
      }
    } catch { /* doesn't exist */ }
  }

  for (const oldDir of copyFrom) {
    if (oldDir === notesDir) continue;
    try {
      const files = await fs.readdir(oldDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      if (mdFiles.length === 0) continue;
      await fs.mkdir(notesDir, { recursive: true });
      for (const file of mdFiles) {
        const src = path.join(oldDir, file);
        const dst = path.join(notesDir, file);
        try { await fs.access(dst); continue; } catch {}
        await fs.copyFile(src, dst);
      }
    } catch { /* doesn't exist */ }
  }
}

// ── File watcher ───────────────────────────────────────────────────────────
// Watch the CloudDocs notes folder for external changes (e.g. from another
// app editing in Finder) and notify the renderer so it can refresh.
// Also syncs external changes to the iOS container.
let _watcherDebounce = null;
let _watcherPending = new Map();

function startFileWatcher(win) {
  if (!notesDir || fileWatcher) return;
  try {
    fileWatcher = fsSync.watch(notesDir, { persistent: false }, (eventType, filename) => {
      if (!filename || !win || win.isDestroyed()) return;
      if (!filename.endsWith('.md')) return;
      // Ignore writes we initiated ourselves
      if (_ourWrites.has(filename)) return;
      _watcherPending.set(filename, eventType);
      clearTimeout(_watcherDebounce);
      _watcherDebounce = setTimeout(async () => {
        for (const [file, evt] of _watcherPending) {
          // For .md files, verify content actually changed before notifying
          if (file.endsWith('.md') && evt !== 'rename') {
            const newHash = await getFileHash(path.join(notesDir, file));
            const oldHash = _contentHashes.get(file);
            if (newHash && newHash === oldHash) continue; // content unchanged
            if (newHash) _contentHashes.set(file, newHash);
          }
          win.webContents.send('notes:changed', { eventType: evt, filename: file });
          // Sync external edits to the iOS container
          if (file.endsWith('.md') && iosNotesDir) {
            if (evt === 'rename') {
              // File may have been deleted — check if it still exists
              try {
                await fs.access(path.join(notesDir, file));
                await writeThrough(file, notesDir, iosNotesDir);
              } catch {
                await deleteMirror(file, iosNotesDir);
              }
            } else {
              await writeThrough(file, notesDir, iosNotesDir);
            }
          }
        }
        _watcherPending.clear();
      }, 300);
    });
  } catch {
    // Folder may not exist yet or watching may not be supported
  }
}

// ── File watchers for Backups and Exports directories ──
// Mirror deletions and additions to the iOS container so both stay in sync.
let backupsWatcher = null;
let exportsWatcher = null;

function startDirWatcher(dir, iosDir, watcherRef) {
  if (!dir || !iosDir) return null;
  try {
    return fsSync.watch(dir, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      setTimeout(async () => {
        if (eventType === 'rename') {
          try {
            await fs.access(path.join(dir, filename));
            await writeThrough(filename, dir, iosDir);
          } catch {
            await deleteMirror(filename, iosDir);
          }
        } else {
          await writeThrough(filename, dir, iosDir);
        }
      }, 300);
    });
  } catch { return null; }
}

function startBackupsExportsWatchers() {
  if (!backupsWatcher) backupsWatcher = startDirWatcher(backupsDir, iosBackupsDir);
  if (!exportsWatcher) exportsWatcher = startDirWatcher(exportsDir, iosExportsDir);
}

function stopFileWatcher() {
  if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
  if (backupsWatcher) { backupsWatcher.close(); backupsWatcher = null; }
  if (exportsWatcher) { exportsWatcher.close(); exportsWatcher = null; }
}

// ── iCloud polling (iOS container → CloudDocs) ─────────────────────────────
// Poll the iOS container for changes made on iOS devices and copy them to
// CloudDocs so the desktop app sees them. Also detect changes in CloudDocs
// that the file watcher may have missed.
const POLL_INTERVAL_MS = 15000;
let pollTimer = null;
let lastPollSnapshot = new Map();       // CloudDocs notes: filename -> mtimeMs
let lastIosPollSnapshot = new Map();    // iOS container notes: filename -> mtimeMs
let lastBackupsPollSnapshot = new Map();     // CloudDocs backups
let lastIosBackupsPollSnapshot = new Map();  // iOS container backups
let lastExportsPollSnapshot = new Map();     // CloudDocs exports
let lastIosExportsPollSnapshot = new Map();  // iOS container exports

async function buildSnapshot(dir, filterExt) {
  const snapshot = new Map();
  if (!dir) return snapshot;
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (filterExt && !file.endsWith(filterExt) && !file.endsWith('.attachments')) continue;
      try {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);
        if (file.endsWith('.attachments') && stat.isDirectory()) {
          // For attachment dirs, use the latest mtime of any file inside
          const subFiles = await fs.readdir(filePath).catch(() => []);
          let latestMtime = stat.mtimeMs;
          for (const sf of subFiles) {
            try {
              const ss = await fs.stat(path.join(filePath, sf));
              if (ss.mtimeMs > latestMtime) latestMtime = ss.mtimeMs;
            } catch {}
          }
          snapshot.set(file, latestMtime);
        } else {
          snapshot.set(file, stat.mtimeMs);
        }
      } catch { /* deleted between readdir and stat */ }
    }
  } catch { /* dir may not exist */ }
  return snapshot;
}

// Grace period (ms) after a write-through before we consider iOS changes
// as genuine external edits (prevents re-syncing our own write-throughs)
const WRITE_THROUGH_GRACE_MS = 10000;

function startICloudPolling(win) {
  if (!notesDir || pollTimer) return;

  // Build initial snapshots and content hashes
  Promise.all([
    buildSnapshot(notesDir, '.md'),
    buildSnapshot(iosNotesDir, '.md'),
    buildSnapshot(backupsDir),
    buildSnapshot(iosBackupsDir),
    buildSnapshot(exportsDir),
    buildSnapshot(iosExportsDir),
  ]).then(async ([cloudSnap, iosSnap, bkSnap, iosBkSnap, exSnap, iosExSnap]) => {
    lastPollSnapshot = cloudSnap;
    lastIosPollSnapshot = iosSnap;
    lastBackupsPollSnapshot = bkSnap;
    lastIosBackupsPollSnapshot = iosBkSnap;
    lastExportsPollSnapshot = exSnap;
    lastIosExportsPollSnapshot = iosExSnap;
    // Seed content hashes so we can detect real content changes
    for (const [file] of cloudSnap) {
      const hash = await getFileHash(path.join(notesDir, file));
      if (hash) _contentHashes.set(file, hash);
    }
  });

  pollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;

    // 1. Check CloudDocs for changes (fallback for missed file watcher events)
    //    Only notify the renderer if the file CONTENT actually changed, not
    //    just the mtime (iCloud can update mtimes during metadata sync).
    const currentCloud = await buildSnapshot(notesDir, '.md');
    for (const [file, mtime] of currentCloud) {
      if (file.endsWith('.attachments')) continue; // handled via iOS polling
      const prev = lastPollSnapshot.get(file);
      if (prev === undefined || prev !== mtime) {
        // mtime changed — check if content actually differs
        const newHash = await getFileHash(path.join(notesDir, file));
        const oldHash = _contentHashes.get(file);
        if (newHash && newHash !== oldHash) {
          _contentHashes.set(file, newHash);
          win.webContents.send('notes:changed', { eventType: 'change', filename: file });
        }
        // If hash is the same, skip the notification — content didn't change
      }
    }
    for (const [file] of lastPollSnapshot) {
      if (file.endsWith('.attachments')) continue;
      if (!currentCloud.has(file)) {
        _contentHashes.delete(file);
        win.webContents.send('notes:changed', { eventType: 'rename', filename: file });
      }
    }
    lastPollSnapshot = currentCloud;

    // 2. Check iOS container for changes from iOS devices
    if (iosNotesDir) {
      const currentIos = await buildSnapshot(iosNotesDir, '.md');
      let iosChanged = false;
      const now = Date.now();

      // Detect new or modified files in iOS container
      for (const [file, mtime] of currentIos) {
        const prev = lastIosPollSnapshot.get(file);
        if (prev === undefined || prev !== mtime) {
          // Skip if we recently wrote this file through to iOS — it's our
          // own write echoing back, not a genuine iOS edit.
          const wtTime = _iosWriteThroughs.get(file);
          if (wtTime && now - wtTime < WRITE_THROUGH_GRACE_MS) {
            continue;
          }
          _iosWriteThroughs.delete(file);

          if (file.endsWith('.attachments')) {
            // Sync entire attachment directory from iOS → CloudDocs
            await syncAttachmentDir(file, iosNotesDir, notesDir);
            iosChanged = true;
          } else {
            // Verify the iOS file actually has different content before copying
            const iosHash = await getFileHash(path.join(iosNotesDir, file));
            const cloudHash = _contentHashes.get(file);
            if (iosHash && iosHash !== cloudHash) {
              await syncFile(file, iosNotesDir, notesDir);
              // Update our content hash to the new content
              const newHash = await getFileHash(path.join(notesDir, file));
              if (newHash) _contentHashes.set(file, newHash);
              iosChanged = true;
            }
          }
        }
      }

      // Detect files deleted on iOS and propagate to CloudDocs.
      // Skip files we recently wrote through — the iOS container may
      // just not have received them yet.
      for (const [file] of lastIosPollSnapshot) {
        if (!currentIos.has(file)) {
          const wtTime = _iosWriteThroughs.get(file);
          if (wtTime && now - wtTime < WRITE_THROUGH_GRACE_MS) {
            console.log(`[iCloud poll] "${file}" missing from iOS — skipping (recent write-through).`);
            continue;
          }
          console.log(`[iCloud poll] "${file}" deleted on iOS — removing from CloudDocs.`);
          try {
            await fs.unlink(path.join(notesDir, file));
          } catch { /* may already be gone */ }
          _contentHashes.delete(file);
          iosChanged = true;
        }
      }

      lastIosPollSnapshot = currentIos;

      // If iOS changes were synced, notify renderer
      if (iosChanged) {
        // Rebuild CloudDocs snapshot so the next poll doesn't re-detect
        lastPollSnapshot = await buildSnapshot(notesDir, '.md');
        win.webContents.send('notes:changed', { eventType: 'change', filename: '*' });
      }
    }

    // 3. Sync Backups and Exports directories bidirectionally and mirror deletions
    const dirPairs = [
      { cloud: backupsDir, ios: iosBackupsDir, lastCloud: lastBackupsPollSnapshot, lastIos: lastIosBackupsPollSnapshot, keyCloud: 'lastBackupsPollSnapshot', keyIos: 'lastIosBackupsPollSnapshot' },
      { cloud: exportsDir, ios: iosExportsDir, lastCloud: lastExportsPollSnapshot, lastIos: lastIosExportsPollSnapshot, keyCloud: 'lastExportsPollSnapshot', keyIos: 'lastIosExportsPollSnapshot' },
    ];
    for (const pair of dirPairs) {
      if (!pair.cloud || !pair.ios) continue;
      const currentCloudDir = await buildSnapshot(pair.cloud);
      const currentIosDir = await buildSnapshot(pair.ios);

      // CloudDocs → iOS: sync new/changed files
      for (const [file, mtime] of currentCloudDir) {
        const prev = pair.lastCloud.get(file);
        if (prev === undefined || prev !== mtime) {
          await syncFile(file, pair.cloud, pair.ios);
        }
      }
      // CloudDocs deletions → mirror to iOS
      for (const [file] of pair.lastCloud) {
        if (!currentCloudDir.has(file)) {
          await deleteMirror(file, pair.ios);
        }
      }

      // iOS → CloudDocs: sync new/changed files
      for (const [file, mtime] of currentIosDir) {
        const prev = pair.lastIos.get(file);
        if (prev === undefined || prev !== mtime) {
          await syncFile(file, pair.ios, pair.cloud);
        }
      }
      // iOS deletions → mirror to CloudDocs
      for (const [file] of pair.lastIos) {
        if (!currentIosDir.has(file)) {
          await deleteMirror(file, pair.cloud);
        }
      }

      // Update snapshots
      if (pair.keyCloud === 'lastBackupsPollSnapshot') {
        lastBackupsPollSnapshot = currentCloudDir;
        lastIosBackupsPollSnapshot = currentIosDir;
      } else {
        lastExportsPollSnapshot = currentCloudDir;
        lastIosExportsPollSnapshot = currentIosDir;
      }
    }
  }, POLL_INTERVAL_MS);
}

function stopICloudPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Electron app lifecycle ─────────────────────────────────────────────────
function getWebPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web', 'index.html');
  }
  return path.join(__dirname, '..', 'web', 'index.html');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    title: 'Notes App',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile(getWebPath());

  startFileWatcher(win);
  startBackupsExportsWatchers();
  startICloudPolling(win);
}

resolveNotesDir();
registerNoteHandlers();

app.whenReady().then(async () => {
  await migrateOldNotes();

  // Bidirectional sync between CloudDocs and iOS container on startup
  await fullSync();

  // If iCloud wasn't available at startup, retry periodically
  if (!iCloudAvailable) {
    const retryInterval = setInterval(async () => {
      resolveNotesDir();
      if (iCloudAvailable) {
        clearInterval(retryInterval);
        await migrateOldNotes();
        await fullSync();
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          startFileWatcher(win);
          startBackupsExportsWatchers();
          startICloudPolling(win);
        }
      }
    }, 30000);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopFileWatcher();
  stopICloudPolling();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
