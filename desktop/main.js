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
        if (isMdDir && !file.endsWith('.md')) continue;
        await syncFile(file, cloudDir, iosDir);
      }
    } catch { /* dir may not exist */ }

    // iOS container → CloudDocs
    try {
      const files = await fs.readdir(iosDir);
      for (const file of files) {
        if (isMdDir && !file.endsWith('.md')) continue;
        await syncFile(file, iosDir, cloudDir);
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
      await fs.writeFile(path.join(notesDir, filename), content, 'utf-8');
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

  // ── Edit lock handlers ──
  const lockFileName = '.edit_lock';

  ipcMain.handle('notes:writeLock', async (_event, deviceId) => {
    if (!notesDir) return;
    const data = JSON.stringify({ deviceId, timestamp: Date.now() });
    await fs.writeFile(path.join(notesDir, lockFileName), data, 'utf-8');
    // Write lock to iOS container too so iOS sees it
    if (iosNotesDir) {
      try {
        await fs.writeFile(path.join(iosNotesDir, lockFileName), data, 'utf-8');
      } catch { /* non-fatal */ }
    }
  });

  ipcMain.handle('notes:readLock', async () => {
    if (!notesDir) return null;
    const lockPath = path.join(notesDir, lockFileName);
    try {
      const data = await fs.readFile(lockPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  });

  ipcMain.handle('notes:removeLock', async () => {
    if (!notesDir) return;
    try { await fs.unlink(path.join(notesDir, lockFileName)); } catch {}
    if (iosNotesDir) {
      try { await fs.unlink(path.join(iosNotesDir, lockFileName)); } catch {}
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
      if (!filename.endsWith('.md') && filename !== '.edit_lock') return;
      // Ignore writes we initiated ourselves
      if (_ourWrites.has(filename)) return;
      _watcherPending.set(filename, eventType);
      clearTimeout(_watcherDebounce);
      _watcherDebounce = setTimeout(async () => {
        for (const [file, evt] of _watcherPending) {
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

function stopFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

// ── iCloud polling (iOS container → CloudDocs) ─────────────────────────────
// Poll the iOS container for changes made on iOS devices and copy them to
// CloudDocs so the desktop app sees them. Also detect changes in CloudDocs
// that the file watcher may have missed.
const POLL_INTERVAL_MS = 15000;
let pollTimer = null;
let lastPollSnapshot = new Map();       // CloudDocs: filename -> mtimeMs
let lastIosPollSnapshot = new Map();    // iOS container: filename -> mtimeMs

async function buildSnapshot(dir) {
  const snapshot = new Map();
  if (!dir) return snapshot;
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const stat = await fs.stat(path.join(dir, file));
        snapshot.set(file, stat.mtimeMs);
      } catch { /* deleted between readdir and stat */ }
    }
  } catch { /* dir may not exist */ }
  return snapshot;
}

function startICloudPolling(win) {
  if (!notesDir || pollTimer) return;

  // Build initial snapshots
  Promise.all([
    buildSnapshot(notesDir),
    buildSnapshot(iosNotesDir),
  ]).then(([cloudSnap, iosSnap]) => {
    lastPollSnapshot = cloudSnap;
    lastIosPollSnapshot = iosSnap;
  });

  pollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;

    // 1. Check CloudDocs for changes (fallback for missed file watcher events)
    const currentCloud = await buildSnapshot(notesDir);
    for (const [file, mtime] of currentCloud) {
      const prev = lastPollSnapshot.get(file);
      if (prev === undefined || prev !== mtime) {
        win.webContents.send('notes:changed', { eventType: 'change', filename: file });
      }
    }
    for (const [file] of lastPollSnapshot) {
      if (!currentCloud.has(file)) {
        win.webContents.send('notes:changed', { eventType: 'rename', filename: file });
      }
    }
    lastPollSnapshot = currentCloud;

    // 2. Check iOS container for changes from iOS devices
    if (iosNotesDir) {
      const currentIos = await buildSnapshot(iosNotesDir);
      let iosChanged = false;

      // Detect new or modified files in iOS container
      for (const [file, mtime] of currentIos) {
        const prev = lastIosPollSnapshot.get(file);
        if (prev === undefined || prev !== mtime) {
          // Copy newer iOS file to CloudDocs
          await syncFile(file, iosNotesDir, notesDir);
          iosChanged = true;
        }
      }

      // Detect files deleted on iOS
      for (const [file] of lastIosPollSnapshot) {
        if (!currentIos.has(file)) {
          // Only delete from CloudDocs if the file was also deleted there
          // (avoid deleting files that were just added on desktop)
          try {
            await fs.access(path.join(notesDir, file));
            // File exists in CloudDocs but was deleted on iOS — delete it
            _ourWrites.add(file);
            await fs.unlink(path.join(notesDir, file));
            setTimeout(() => _ourWrites.delete(file), 500);
            iosChanged = true;
          } catch { /* already gone from CloudDocs */ }
        }
      }

      lastIosPollSnapshot = currentIos;

      // If iOS changes were synced, notify renderer
      if (iosChanged) {
        // Rebuild CloudDocs snapshot so the next poll doesn't re-detect
        lastPollSnapshot = await buildSnapshot(notesDir);
        win.webContents.send('notes:changed', { eventType: 'change', filename: '*' });
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
