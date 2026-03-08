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
const ICLOUD_IOS_CONTAINER = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', 'Notes App');
const ICLOUD_GENERIC = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', 'Notes App');

let notesDir = null;
let iCloudAvailable = false;
let fileWatcher = null;

// Determine the notes directory at startup
function resolveNotesDir() {
  if (process.platform !== 'darwin') return;

  // Prefer the iOS iCloud container (shared with iOS app).
  // Check for the container's Documents folder (parent of "Notes App") rather
  // than the Notes App subfolder itself, which may not exist yet on first launch.
  const iosContainerDocuments = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents');
  if (fsSync.existsSync(iosContainerDocuments)) {
    notesDir = ICLOUD_IOS_CONTAINER; // …/Documents/Notes App
    // Create the Notes App subfolder synchronously so subsequent reads/writes work
    if (!fsSync.existsSync(notesDir)) {
      fsSync.mkdirSync(notesDir, { recursive: true });
    }
    iCloudAvailable = true;
    return;
  }

  // Fall back to generic iCloud Drive folder
  const iCloudDrive = path.join(ICLOUD_ROOT, 'com~apple~CloudDocs');
  if (fsSync.existsSync(iCloudDrive)) {
    notesDir = ICLOUD_GENERIC;
    // Create the folder if it doesn't exist
    if (!fsSync.existsSync(notesDir)) {
      fsSync.mkdirSync(notesDir, { recursive: true });
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
}

// ── One-time migration from old notes location ─────────────────────────────
// Prior to this fix, the desktop app saved .md files directly into the iOS
// container's Documents/ root. iOS saves into Documents/Notes App/ so the two
// never actually synced. On first launch after this update we move any .md
// files found in the old root location into the new Notes App subfolder.
async function migrateOldNotes() {
  if (!notesDir) return;
  const oldDir = path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents');
  if (oldDir === notesDir) return; // guard: already the same path
  try {
    const files = await fs.readdir(oldDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    if (mdFiles.length === 0) return;
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

// ── File watcher ───────────────────────────────────────────────────────────
// Watch the iCloud notes folder for external changes (e.g. from iOS or
// another Mac) and notify the renderer so it can refresh.
function startFileWatcher(win) {
  if (!notesDir || fileWatcher) return;
  try {
    fileWatcher = fsSync.watch(notesDir, { persistent: false }, (eventType, filename) => {
      if (filename && filename.endsWith('.md') && win && !win.isDestroyed()) {
        win.webContents.send('notes:changed', { eventType, filename });
      }
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
}

resolveNotesDir();
registerNoteHandlers();

app.whenReady().then(async () => {
  await migrateOldNotes();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopFileWatcher();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
