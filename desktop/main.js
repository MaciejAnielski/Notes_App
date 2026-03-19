const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');

// ── IPC handlers ────────────────────────────────────────────────────────────
// Storage is handled by PowerSync in the renderer process.
// Only keep utility IPC handlers that need Node.js capabilities.
function registerHandlers() {
  ipcMain.handle('notes:openExternal', async (_event, url) => {
    await shell.openExternal(url);
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
