const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

// ── IPC handlers ────────────────────────────────────────────────────────────
// Storage is now handled by PowerSync in the renderer process.
// Only keep utility IPC handlers that need Node.js capabilities.
function registerHandlers() {
  ipcMain.handle('notes:openExternal', async (_event, url) => {
    await shell.openExternal(url);
  });

  // Legacy migration: read notes from the old iCloud CloudDocs folder
  // so the renderer can import them into PowerSync on first launch.
  ipcMain.handle('notes:readLegacyNotes', async () => {
    if (process.platform !== 'darwin') return [];
    const ICLOUD_ROOT = path.join(os.homedir(), 'Library', 'Mobile Documents');
    const dirs = [
      path.join(ICLOUD_ROOT, 'com~apple~CloudDocs', 'Notes App', '000_Notes'),
      path.join(ICLOUD_ROOT, 'iCloud~com~notesapp~ios', 'Documents', '000_Notes'),
    ];
    const notes = new Map();
    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const name = file.slice(0, -3);
          if (notes.has(name)) continue;
          try {
            const content = await fs.readFile(path.join(dir, file), 'utf-8');
            notes.set(name, content);
          } catch { /* skip unreadable */ }
        }
      } catch { /* dir doesn't exist */ }
    }
    return Array.from(notes, ([name, content]) => ({ name, content }));
  });
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

  // Fallback: show the window if ready-to-show hasn't fired within 3 s.
  const showFallback = setTimeout(() => win.show(), 3000);

  win.once('ready-to-show', () => {
    clearTimeout(showFallback);
    win.show();
    if (!app.isPackaged) {
      win.webContents.openDevTools();
    }
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] Failed to load ${validatedURL || getWebPath()}: ${errorDescription} (${errorCode})`);
    clearTimeout(showFallback);
    win.show();
  });

  win.loadFile(getWebPath());
}

registerHandlers();

app.whenReady().then(async () => {
  // Set Content-Security-Policy — allow connections to Supabase and PowerSync
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "font-src 'self' data:; " +
          "connect-src 'self' https://*.supabase.co https://*.powersync.journeyapps.com wss://*.powersync.journeyapps.com"
        ]
      }
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
