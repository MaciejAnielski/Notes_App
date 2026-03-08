const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

// ── iCloud Drive notes folder ──────────────────────────────────────────────
// On macOS, iCloud Drive is at ~/Library/Mobile Documents/com~apple~CloudDocs/.
// We store notes in a "Notes App" subfolder. If the iOS app uses its own
// iCloud container (iCloud~com~notesapp~ios), the desktop app reads/writes
// from that container's Documents folder so both platforms share the same
// iCloud-synced files.
const ICLOUD_ROOT = path.join(os.homedir(), 'Library', 'Mobile Documents');
const ICLOUD_IOS_CONTAINER = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', '000_Notes');
const ICLOUD_IOS_BACKUPS = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', '001_Backups');
const ICLOUD_IOS_EXPORTS = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', '002_Exports');
const ICLOUD_GENERIC = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', '000_Notes');
const ICLOUD_GENERIC_BACKUPS = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', '001_Backups');
const ICLOUD_GENERIC_EXPORTS = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', '002_Exports');

let notesDir = null;
let backupsDir = null;
let exportsDir = null;
let iCloudAvailable = false;
let fileWatcher = null;

// Determine the notes directory at startup
function resolveNotesDir() {
  if (process.platform !== 'darwin') return;

  // Prefer the iOS iCloud container (shared with iOS app).
  // Check for the container's Documents folder (parent of "000_Notes") rather
  // than the 000_Notes subfolder itself, which may not exist yet on first launch.
  const iosContainerDocuments = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents');
  if (fsSync.existsSync(iosContainerDocuments)) {
    notesDir = ICLOUD_IOS_CONTAINER; // …/Documents/000_Notes
    backupsDir = ICLOUD_IOS_BACKUPS;
    exportsDir = ICLOUD_IOS_EXPORTS;
    // Create subfolders synchronously so subsequent reads/writes work
    for (const dir of [notesDir, backupsDir, exportsDir]) {
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    }
    iCloudAvailable = true;
    return;
  }

  // Fall back to generic iCloud Drive folder
  const iCloudDrive = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs');
  if (fsSync.existsSync(iCloudDrive)) {
    notesDir = ICLOUD_GENERIC;
    backupsDir = ICLOUD_GENERIC_BACKUPS;
    exportsDir = ICLOUD_GENERIC_EXPORTS;
    // Create folders if they don't exist
    for (const dir of [notesDir, backupsDir, exportsDir]) {
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    }
    iCloudAvailable = true;
  }
}

// ── File name sanitization ─────────────────────────────────────────────────
// Note names may contain characters that are invalid in filenames. We replace
// them with underscores and append .md.
const UNSAFE_CHARS = /[/\\:*?"<>|]/g;

function noteNameToFileName(name) {
  return name.replace(UNSAFE_CHARS, '_') + '.md';
}

function fileNameToNoteName(fileName) {
  if (!fileName.endsWith('.md')) return null;
  return fileName.slice(0, -3);
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
    const filePath = path.join(notesDir, noteNameToFileName(name));
    await fs.writeFile(filePath, content, 'utf-8');
  });

  ipcMain.handle('notes:remove', async (_event, name) => {
    if (!notesDir) return;
    const filePath = path.join(notesDir, noteNameToFileName(name));
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist — ignore
    }
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
        await fs.unlink(path.join(notesDir, file));
      }
      return mdFiles.length;
    } catch {
      return 0;
    }
  });

  ipcMain.handle('notes:getDir', () => {
    return { path: notesDir, iCloudAvailable };
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
    const lockPath = path.join(notesDir, lockFileName);
    const data = JSON.stringify({ deviceId, timestamp: Date.now() });
    await fs.writeFile(lockPath, data, 'utf-8');
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
    const lockPath = path.join(notesDir, lockFileName);
    try { await fs.unlink(lockPath); } catch {}
  });

  // ── Backup/export to iCloud folders ──
  ipcMain.handle('notes:writeBackup', async (_event, filename, data) => {
    if (!backupsDir) return;
    await fs.mkdir(backupsDir, { recursive: true });
    // Backup data arrives as base64-encoded zip — write as binary
    const buf = Buffer.from(data, 'base64');
    await fs.writeFile(path.join(backupsDir, filename), buf);
  });

  ipcMain.handle('notes:writeExport', async (_event, filename, data) => {
    if (!exportsDir) return;
    await fs.mkdir(exportsDir, { recursive: true });
    await fs.writeFile(path.join(exportsDir, filename), data, 'utf-8');
  });
}

// ── One-time migration from old notes locations ────────────────────────────
// Migrate .md files from old locations (Documents/ root and Documents/Notes App/)
// into the new 000_Notes subfolder.
async function migrateOldNotes() {
  if (!notesDir) return;
  const oldLocations = [
    path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents'),
    path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', 'Notes App')
  ];
  for (const oldDir of oldLocations) {
    if (oldDir === notesDir) continue; // guard: already the same path
    try {
      const files = await fs.readdir(oldDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      if (mdFiles.length === 0) continue;
      await fs.mkdir(notesDir, { recursive: true });
      for (const file of mdFiles) {
        const src = path.join(oldDir, file);
        const dst = path.join(notesDir, file);
        // Skip if a file with the same name already exists at the destination
        try { await fs.access(dst); continue; } catch {}
        await fs.rename(src, dst);
      }
    } catch {
      // Old directory doesn't exist or can't be read — nothing to migrate
    }
  }
}

// ── File watcher ───────────────────────────────────────────────────────────
// Watch the iCloud notes folder for external changes (e.g. from iOS or
// another Mac) and notify the renderer so it can refresh.
// Debounce file watcher events to avoid flooding the renderer when multiple
// changes arrive in quick succession (e.g. iCloud syncing several files).
let _watcherDebounce = null;
let _watcherPending = new Map(); // filename -> eventType

function startFileWatcher(win) {
  if (!notesDir || fileWatcher) return;
  try {
    fileWatcher = fsSync.watch(notesDir, { persistent: false }, (eventType, filename) => {
      if (!filename || !win || win.isDestroyed()) return;
      if (!filename.endsWith('.md') && filename !== '.edit_lock') return;
      _watcherPending.set(filename, eventType);
      clearTimeout(_watcherDebounce);
      _watcherDebounce = setTimeout(() => {
        for (const [file, evt] of _watcherPending) {
          win.webContents.send('notes:changed', { eventType: evt, filename: file });
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

// ── iCloud polling ─────────────────────────────────────────────────────────
// fsSync.watch() does not reliably detect files synced down by the iCloud
// daemon (it uses kqueue internally, but iCloud may write files through a
// different code path that doesn't trigger kqueue events).  To compensate,
// we poll the notes directory periodically and compare file mtimes to detect
// changes that the watcher missed.
const POLL_INTERVAL_MS = 15000; // 15 seconds
let pollTimer = null;
let lastPollSnapshot = new Map(); // filename -> mtimeMs

async function buildSnapshot() {
  const snapshot = new Map();
  try {
    const files = await fs.readdir(notesDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const stat = await fs.stat(path.join(notesDir, file));
        snapshot.set(file, stat.mtimeMs);
      } catch {
        // File may have been deleted between readdir and stat
      }
    }
  } catch {
    // Directory may not exist yet
  }
  return snapshot;
}

function startICloudPolling(win) {
  if (!notesDir || pollTimer) return;

  // Build initial snapshot so the first poll has a baseline
  buildSnapshot().then(snap => { lastPollSnapshot = snap; });

  pollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    const current = await buildSnapshot();

    // Detect new or modified files
    for (const [file, mtime] of current) {
      const prev = lastPollSnapshot.get(file);
      if (prev === undefined || prev !== mtime) {
        win.webContents.send('notes:changed', { eventType: 'change', filename: file });
      }
    }
    // Detect deleted files
    for (const [file] of lastPollSnapshot) {
      if (!current.has(file)) {
        win.webContents.send('notes:changed', { eventType: 'rename', filename: file });
      }
    }

    lastPollSnapshot = current;
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

  // Show window once content is ready to avoid white flash on startup
  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile(getWebPath());

  // Start watching iCloud folder for external changes
  startFileWatcher(win);
  // Start polling as fallback for iCloud-synced changes that fsSync.watch misses
  startICloudPolling(win);
}

resolveNotesDir();
registerNoteHandlers();

app.whenReady().then(async () => {
  await migrateOldNotes();

  // If iCloud wasn't available at startup, retry periodically in case the
  // user signs in later or the daemon finishes initialising.
  if (!iCloudAvailable) {
    const retryInterval = setInterval(() => {
      resolveNotesDir();
      if (iCloudAvailable) {
        clearInterval(retryInterval);
        migrateOldNotes();
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
