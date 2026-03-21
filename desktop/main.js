const { app, BrowserWindow, ipcMain, shell, session, screen } = require('electron');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Custom protocol — handles magic link auth callbacks ──────────────────────
// Supabase redirects the magic link to notesapp://auth/callback#access_token=...
// We register the protocol here so the OS knows to open this app for notesapp:// URLs.
const PROTOCOL = 'notesapp';

// Must be called before app.whenReady()
if (!app.isDefaultProtocolClient(PROTOCOL)) {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// primaryWindow is the first window ever created. It owns the PowerSync/auth
// connection and is the target for auth callbacks and deep-links.
// Additional windows (opened with Ctrl+Shift+N) are tracked by Electron
// automatically via BrowserWindow.getAllWindows() and do NOT duplicate the
// PowerSync/Supabase connection — they receive ?secondary=true and fall back
// to localStorage + cross-window storage events.
let primaryWindow = null;

// ── Local auth-callback server ───────────────────────────────────────────────
// When the user clicks a magic link the system browser opens the redirect URL.
// To bridge the gap between the system browser and the Electron renderer we run
// a tiny local HTTP server. The redirect URL is set to
// http://127.0.0.1:<port>/auth-callback. The server returns a tiny HTML page
// that extracts the tokens from the URL hash and posts them back to the server,
// which then forwards them to the renderer via IPC.
//
// This approach works out of the box because Supabase allows localhost redirect
// URLs by default, requiring no extra dashboard configuration.

let authServer = null;
let authServerPort = null;

function startAuthServer() {
  return new Promise((resolve) => {
    authServer = http.createServer((req, res) => {
      // ── GET /auth-callback ──────────────────────────────────────────────
      // Browser lands here after magic link verification. Supabase appends
      // the session tokens as a URL hash (#access_token=...&refresh_token=...).
      // Hashes are NOT sent to the server, so we return a small HTML page that
      // reads the hash client-side and POSTs it back.
      if (req.method === 'GET' && req.url.startsWith('/auth-callback')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          // Prevent the page from being cached
          'Cache-Control': 'no-store'
        });
        res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Notes App – Signing in…</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1e1e1e; color: #e8dcf4;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  p { font-size: 16px; }
</style>
</head>
<body><p id="m">Completing sign-in…</p>
<script>
  var hash = window.location.hash.substring(1) || window.location.search.substring(1);
  if (!hash) {
    document.getElementById('m').textContent = 'No auth tokens found. Please try again.';
  } else {
    fetch('/auth-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: hash
    }).then(function(r) {
      if (r.ok) {
        document.getElementById('m').textContent = 'Signed in! You can close this tab.';
      } else {
        document.getElementById('m').textContent = 'Sign-in failed. Please try again.';
      }
    }).catch(function() {
      document.getElementById('m').textContent = 'Sign-in failed. Please try again.';
    });
  }
</script>
</body>
</html>`);
        return;
      }

      // ── POST /auth-token ────────────────────────────────────────────────
      // Receives the token params from the callback page and forwards them
      // to the renderer via IPC.
      if (req.method === 'POST' && req.url === '/auth-token') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const accessToken = params.get('access_token');
          const refreshToken = params.get('refresh_token');
          if (accessToken && refreshToken && primaryWindow) {
            primaryWindow.webContents.send('auth:callback', body);
            if (primaryWindow.isMinimized()) primaryWindow.restore();
            primaryWindow.focus();
          }
          res.writeHead(accessToken ? 200 : 400);
          res.end(accessToken ? 'OK' : 'Missing tokens');
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Port 0 → OS picks a free port
    authServer.listen(0, '127.0.0.1', () => {
      authServerPort = authServer.address().port;
      console.log(`[main] Auth callback server listening on http://127.0.0.1:${authServerPort}`);
      resolve(authServerPort);
    });

    authServer.on('error', (err) => {
      console.error('[main] Auth server error:', err);
      resolve(null);
    });
  });
}

// ── IPC handlers ────────────────────────────────────────────────────────────
function registerHandlers() {
  ipcMain.handle('notes:openExternal', async (_event, url) => {
    await shell.openExternal(url);
  });

  // Renderer asks for the local callback URL to use as emailRedirectTo
  ipcMain.handle('notes:getAuthCallbackUrl', () => {
    if (!authServerPort) return null;
    return `http://127.0.0.1:${authServerPort}/auth-callback`;
  });

  // Write a base64-encoded attachment to a temp file and open it with the
  // system default application (e.g. double-click image in preview).
  ipcMain.handle('notes:openAttachmentFile', async (_event, filename, base64data) => {
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notesapp-'));
      const tmpFile = path.join(tmpDir, filename);
      const buffer = Buffer.from(base64data, 'base64');
      fs.writeFileSync(tmpFile, buffer);
      await shell.openPath(tmpFile);
      return true;
    } catch (e) {
      console.error('[main] openAttachmentFile failed:', e);
      return false;
    }
  });

  // Open a new note window. The new window gets ?secondary=true so it proxies
  // all NoteStorage calls back to the primary window instead of initialising
  // its own PowerSync connection.
  ipcMain.handle('notes:newWindow', () => {
    createWindow(true);
  });

  // Relay a NoteStorage method call from a secondary window to the primary
  // window's renderer via executeJavaScript. The primary window owns the
  // PowerSync connection so all reads/writes go through one database.
  const PROXY_METHODS = new Set([
    'getNote', 'setNote', 'renameNote', 'removeNote', 'trashNote',
    'getAllNoteNames', 'getAllNotes', 'refreshCache', 'triggerSync',
    'writeAttachment', 'readAttachment', 'renameAttachment',
    'removeAttachmentDir', 'renameAttachmentDir', 'listAttachments',
  ]);
  ipcMain.handle('notes:proxy', async (_event, method, args) => {
    if (!PROXY_METHODS.has(method)) throw new Error(`Disallowed proxy method: ${method}`);
    if (!primaryWindow) throw new Error('Primary window not available');
    // Call NoteStorage[method](...args) inside the primary renderer and return
    // the result. JSON-serialisable values (strings, arrays, booleans, null)
    // survive the structured-clone round-trip automatically.
    return primaryWindow.webContents.executeJavaScript(
      `typeof NoteStorage[${JSON.stringify(method)}] === 'function'` +
      ` ? NoteStorage[${JSON.stringify(method)}](...${JSON.stringify(args)})` +
      ` : null`
    );
  });

  // ── macOS button-drag: move the window when the user drags on a toolbar button ──
  // Renderer sends window-drag-start when the mouse exceeds the 5 px threshold
  // on a button. We poll the cursor position at ~16 ms and call setPosition().
  ipcMain.on('window-drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const id = event.sender.id;
    // Clear any previous drag for this window.
    const prev = _dragState.get(id);
    if (prev) clearInterval(prev);

    const { x: cursorX0, y: cursorY0 } = screen.getCursorScreenPoint();
    const [winX0, winY0] = win.getPosition();

    const timer = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(timer); _dragState.delete(id); return; }
      const { x, y } = screen.getCursorScreenPoint();
      win.setPosition(winX0 + (x - cursorX0), winY0 + (y - cursorY0));
    }, 16);

    _dragState.set(id, timer);
  });

  ipcMain.on('window-drag-stop', (event) => {
    const id = event.sender.id;
    const timer = _dragState.get(id);
    if (timer) { clearInterval(timer); _dragState.delete(id); }
  });
}

// ── Forward a deep-link URL to the renderer (protocol handler fallback) ──────
function handleDeepLink(url) {
  if (!url || !url.startsWith(PROTOCOL + '://')) return;
  if (primaryWindow) {
    if (primaryWindow.isMinimized()) primaryWindow.restore();
    primaryWindow.focus();
    primaryWindow.webContents.send('auth:callback', url);
  }
}

// ── Electron app lifecycle ─────────────────────────────────────────────────
function getWebPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web', 'index.html');
  }
  return path.join(__dirname, '..', 'web', 'index.html');
}

// secondary=true: additional window opened via Ctrl+Shift+N.
// These windows skip PowerSync init (no duplicate DB/WebSocket connections)
// and instead use localStorage with cross-window storage events for live sync.
// Per-window drag state: webContentsId → intervalId.
// Keyed per window so multiple windows can coexist safely.
const _dragState = new Map();

function createWindow(secondary = false) {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    title: 'Notes App',
    backgroundColor: '#1e1e1e',
    show: false,
    // macOS: hide the native title bar while keeping traffic lights.
    // trafficLightPosition centres the 12 px buttons in the 28 px toolbar.
    // Tune x/y here if the toolbar height changes.
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 8 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  // Clear any button-drag interval when this window loses focus so we never
  // leak a running interval if mouseup fires outside the window.
  win.on('blur', () => {
    const id = win.webContents.id;
    const timer = _dragState.get(id);
    if (timer) { clearInterval(timer); _dragState.delete(id); }
  });

  // The first window ever created becomes the primary window that owns
  // the auth/PowerSync connection.
  if (!primaryWindow) {
    primaryWindow = win;
  }

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

  win.on('closed', () => {
    if (primaryWindow === win) {
      primaryWindow = null;
    }
  });

  if (secondary) {
    // Load with ?secondary=true so powersync-storage.js skips its init.
    win.loadFile(getWebPath(), { query: { secondary: 'true' } });
  } else {
    win.loadFile(getWebPath());
  }
}

registerHandlers();

app.whenReady().then(async () => {
  // Start the local auth-callback server before creating the window so the
  // renderer can request the callback URL as soon as it loads.
  await startAuthServer();

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
          "connect-src 'self' https://*.supabase.co https://*.powersync.journeyapps.com wss://*.powersync.journeyapps.com http://127.0.0.1:*"
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
    if (primaryWindow) {
      if (primaryWindow.isMinimized()) primaryWindow.restore();
      primaryWindow.focus();
    }
  });
}

app.on('window-all-closed', () => {
  if (authServer) authServer.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
