const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');

// ── Custom protocol — handles magic link auth callbacks ──────────────────────
// Supabase redirects the magic link to notesapp://auth/callback#access_token=...
// We register the protocol here so the OS knows to open this app for notesapp:// URLs.
const PROTOCOL = 'notesapp';

// Must be called before app.whenReady()
if (!app.isDefaultProtocolClient(PROTOCOL)) {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

let mainWindow = null;

// ── IPC handlers ────────────────────────────────────────────────────────────
function registerHandlers() {
  ipcMain.handle('notes:openExternal', async (_event, url) => {
    await shell.openExternal(url);
  });
}

// ── Forward a deep-link URL to the renderer ──────────────────────────────────
function handleDeepLink(url) {
  if (!url || !url.startsWith(PROTOCOL + '://')) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('auth:callback', url);
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
  mainWindow = new BrowserWindow({
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
  const showFallback = setTimeout(() => mainWindow.show(), 3000);

  mainWindow.once('ready-to-show', () => {
    clearTimeout(showFallback);
    mainWindow.show();
    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] Failed to load ${validatedURL || getWebPath()}: ${errorDescription} (${errorCode})`);
    clearTimeout(showFallback);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(getWebPath());
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

  // macOS / Linux: handle protocol URL passed at launch
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
});

// Windows: a second instance is launched with the URL as argv — forward to the
// existing window and quit the new instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(arg => arg.startsWith(PROTOCOL + '://'));
    if (url) handleDeepLink(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
