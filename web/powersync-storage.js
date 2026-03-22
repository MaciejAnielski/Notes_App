// PowerSync + Supabase NoteStorage implementation
// Provides sync on Desktop (Electron) and Mobile (Capacitor — iOS/Android).
// Web (plain browser) never loads this file — it keeps using localStorage.
//
// Architecture: LOCAL-FIRST
// - Notes: stored in local SQLite via PowerSync, synced automatically.
// - Attachments: binary data stored in local SQLite (local_data column),
//   metadata synced via PowerSync, binaries synced to/from Supabase Storage
//   in the background. All operations succeed offline.
//
// Platform SQLite drivers:
// - Desktop (Electron): WASM SQLite via @journeyapps/wa-sqlite (web SDK)
// - iOS/Android (Capacitor): Native SQLite via @capacitor-community/sqlite
//   (PowerSync Capacitor SDK auto-detects and uses the native driver)
//
// Sync Opt-In:
// - Sync is disabled by default. User enables it via the Settings note.
// - PowerSync only initializes when sync_enabled=true AND a valid session exists.
// - Auth uses Supabase magic link (email). User clicks the link in their email.
// - On Electron, magic links are handled via the 'notesapp://' custom protocol.
// - On iOS, magic links are handled via Capacitor's App.addListener('appUrlOpen').

(async function () {
  'use strict';

  // Only activate on Desktop or iOS — never on plain web
  const isElectron = !!window.electronAPI;
  const isIOS = !!window.Capacitor?.isNativePlatform();
  if (!isElectron && !isIOS) return;

  // Secondary windows (opened via Ctrl+Shift+N) delegate all NoteStorage
  // operations to the primary window via IPC so there is only one PowerSync
  // connection and one SQLite database across all windows.
  // Changes are pushed back via BroadcastChannel so secondary windows stay
  // reactive without any extra connections.
  const isSecondary = new URLSearchParams(window.location.search).get('secondary') === 'true';
  if (isSecondary) {
    console.log('[powersync] Secondary window — proxying NoteStorage to primary window.');
    // Every NoteStorage method becomes an IPC call forwarded to the primary.
    const PROXY_METHODS = [
      'getNote', 'setNote', 'renameNote', 'removeNote', 'trashNote',
      'getAllNoteNames', 'getAllNotes', 'refreshCache', 'triggerSync',
      'writeAttachment', 'readAttachment', 'renameAttachment',
      'removeAttachmentDir', 'renameAttachmentDir', 'listAttachments',
    ];
    const proxy = {};
    for (const method of PROXY_METHODS) {
      proxy[method] = (...args) => window.electronAPI.proxyNoteStorage(method, args);
    }
    window.PowerSyncNoteStorage = proxy;
    // Re-dispatch powersync:change locally whenever the primary window broadcasts
    // a change, so handlePowerSyncChange() runs and the UI stays current.
    const changeChannel = new BroadcastChannel('notes:powersync:change');
    changeChannel.onmessage = () => window.dispatchEvent(new CustomEvent('powersync:change'));
    window.dispatchEvent(new CustomEvent('powersync:ready'));
    return;
  }

  try { // top-level catch so errors are never silently swallowed

  console.log('[powersync] Detected platform:', isElectron ? 'Electron' : 'iOS (Capacitor)');

  const config = window.POWERSYNC_CONFIG;
  if (!config || config.supabaseUrl.includes('YOUR_')) {
    console.warn('[powersync] Config not set — skipping PowerSync init. Using fallback storage.');
    window.dispatchEvent(new CustomEvent('powersync:disabled'));
    return;
  }
  console.log('[powersync] Config loaded. Supabase URL:', config.supabaseUrl);

  if (!window.PowerSync || !window.SupabaseClient) {
    console.error('[powersync] PowerSync or SupabaseClient globals not found.');
    window.dispatchEvent(new CustomEvent('powersync:disabled'));
    return;
  }
  console.log('[powersync] Vendor libraries loaded successfully.');

  const { PowerSyncDatabase, column, Schema, Table } = window.PowerSync;
  const { createClient } = window.SupabaseClient;

  // ── Schema ──────────────────────────────────────────────────────────────
  const notes = new Table({
    name: column.text,
    content: column.text,
    deleted: column.integer,  // boolean as 0/1
    updated_at: column.text,
    created_at: column.text,
    user_id: column.text
  });

  const attachments = new Table({
    note_name: column.text,
    filename: column.text,
    storage_path: column.text,
    updated_at: column.text,
    created_at: column.text,
    user_id: column.text
    // local_data and sync_state are stored in a separate local-only table
    // (local_attachment_data) to prevent PowerSync sync-loop: when these
    // columns were in the synced schema, the sync stream would NULL them,
    // downloadMissingAttachments would re-populate them, generating another
    // CRUD entry → infinite PATCH cycle on iOS.
  });

  // ── Supabase client ─────────────────────────────────────────────────────
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  // ── Global sync helpers (available immediately, before PowerSync init) ──
  // The Settings note reads this to show auth state and drive the sign-in flow.
  const syncEnabled = localStorage.getItem('sync_enabled') === 'true';

  // Fetch the local auth-callback URL from the Electron main process.
  // This is http://127.0.0.1:<port>/auth-callback — used as emailRedirectTo
  // so magic links open a local page that extracts tokens and posts them back.
  // Falls back to config.redirectTo (for protocol-handler / iOS use cases).
  let _authCallbackUrl = config.redirectTo || null;
  if (isElectron && window.electronAPI?.getAuthCallbackUrl) {
    window.electronAPI.getAuthCallbackUrl().then(url => {
      if (url) _authCallbackUrl = url;
    }).catch(() => {});
  }

  window._syncHelpers = {
    available: true,
    enabled: syncEnabled,
    authenticated: false,
    userEmail: null,

    /** User chose to enable sync. Sets the flag and reloads. */
    async enable() {
      localStorage.setItem('sync_enabled', 'true');
      window.location.reload();
    },

    /** User chose to disable sync. Clears session and reloads. */
    async disable() {
      localStorage.removeItem('sync_enabled');
      await supabase.auth.signOut().catch(() => {});
      window.location.reload();
    },

    /**
     * Send a magic link to the given email address.
     * On Electron the emailRedirectTo points to the local auth-callback server
     * so clicking the link in the system browser automatically passes the
     * tokens back to this app.
     */
    async sendMagicLink(email) {
      // Re-fetch the callback URL right before sending in case the server
      // wasn't ready when the module first loaded.
      if (isElectron && window.electronAPI?.getAuthCallbackUrl && !_authCallbackUrl) {
        _authCallbackUrl = await window.electronAPI.getAuthCallbackUrl().catch(() => null);
      }
      const options = _authCallbackUrl ? { emailRedirectTo: _authCallbackUrl } : {};
      const { error } = await supabase.auth.signInWithOtp({ email, options });
      if (error) throw error;
    },

    /**
     * Verify a one-time code (for Supabase projects configured for email OTP).
     * Most Supabase projects send a magic link instead — use sendMagicLink().
     */
    async verifyOtp(email, token) {
      const { data, error } = await supabase.auth.verifyOtp({
        email, token, type: 'email'
      });
      if (error) throw error;
      return data.session;
    },

    /** Sign out and reload. */
    async signOut() {
      await supabase.auth.signOut().catch(() => {});
      window.location.reload();
    },

    getSession: () => supabase.auth.getSession(),
    onAuthStateChange: (cb) => supabase.auth.onAuthStateChange(cb)
  };

  // ── Magic link token handler ─────────────────────────────────────────────
  // Accepts either:
  //   • A raw URL-encoded param string from the local HTTP server POST
  //     (e.g. "access_token=xxx&refresh_token=yyy&token_type=bearer&…")
  //   • A full URL from the notesapp:// protocol handler or iOS deep link
  //     (e.g. "notesapp://auth/callback#access_token=xxx&…"  — implicit flow)
  //     (e.g. "notesapp://auth/callback?code=xxx&…"          — PKCE flow)
  //
  // Supabase projects created after 2024 default to PKCE flow, which sends a
  // ?code= parameter that must be exchanged for a session via
  // exchangeCodeForSession(). Older projects use implicit flow with tokens in
  // the URL hash. Both are handled here.
  window._handleAuthPayload = async function (payload) {
    try {
      let fullUrl = payload || '';
      let paramStr = fullUrl;

      // If it looks like a URL, extract the hash or query portion
      if (fullUrl.includes('://') || fullUrl.startsWith('http')) {
        if (fullUrl.includes('#')) {
          paramStr = fullUrl.substring(fullUrl.indexOf('#') + 1);
        } else if (fullUrl.includes('?')) {
          paramStr = fullUrl.substring(fullUrl.indexOf('?') + 1);
        }
      }

      const params = new URLSearchParams(paramStr);

      // ── PKCE flow: exchange authorization code for session ────────────────
      const code = params.get('code');
      if (code) {
        console.log('[powersync] Exchanging auth code for session (PKCE)…');
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
        // onAuthStateChange(SIGNED_IN) will fire and trigger a page reload
        return;
      }

      // ── Implicit flow: set session directly from tokens ───────────────────
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (!accessToken || !refreshToken) {
        console.warn('[powersync] Auth payload missing tokens or code:', paramStr.slice(0, 80));
        return;
      }
      console.log('[powersync] Setting session from auth callback (implicit flow)…');
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (error) throw error;
      // onAuthStateChange(SIGNED_IN) will fire and trigger a page reload
    } catch (e) {
      console.error('[powersync] Failed to handle auth payload:', e);
    }
  };

  // Register auth callback from Electron (via preload IPC)
  if (isElectron && window.electronAPI?.onAuthCallback) {
    window.electronAPI.onAuthCallback((payload) => {
      window._handleAuthPayload(payload);
    });
  }

  // Register auth callback from iOS Capacitor
  if (isIOS) {
    try {
      const CapApp = window.Capacitor?.Plugins?.App;
      if (CapApp) {
        CapApp.addListener('appUrlOpen', (data) => {
          if (data?.url) window._handleAuthPayload(data.url);
        });
      }
    } catch (_) { /* App plugin not available */ }
  }

  // ── If sync is not enabled by user, bail early ───────────────────────────
  if (!syncEnabled) {
    console.log('[powersync] Sync not enabled by user. Using local storage.');
    window.dispatchEvent(new CustomEvent('powersync:disabled'));
    return;
  }

  // ── Check for existing session ───────────────────────────────────────────
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data?.session;

    // getSession() may return a cached token belonging to a deleted user.
    // Validate against the server.
    if (session) {
      const { error: userErr } = await supabase.auth.getUser();
      if (userErr) {
        console.warn('[powersync] Cached session is invalid — signing out:', userErr.message);
        await supabase.auth.signOut();
        session = null;
      }
    }
  } catch (e) {
    console.error('[powersync] Failed to get session:', e);
  }

  // ── If no session, wait for user to sign in via Settings note ────────────
  if (!session) {
    console.log('[powersync] Sync enabled but no session. Waiting for sign-in via Settings…');
    window._syncHelpers.authenticated = false;

    // Listen for sign-in (magic link click or OTP verify)
    supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (event === 'SIGNED_IN' && newSession) {
        window._syncHelpers.authenticated = true;
        window._syncHelpers.userEmail = newSession.user?.email || null;
        // Reload so PowerSync can fully initialise with the fresh session
        window.location.reload();
      }
    });

    // Signal to app-init.js to proceed with localStorage (don't wait for PowerSync)
    window.dispatchEvent(new CustomEvent('powersync:auth-required'));
    return;
  }

  // ── Valid session — mark auth state and initialise PowerSync ─────────────
  window._syncHelpers.authenticated = true;
  window._syncHelpers.userEmail = session.user?.email || null;
  console.log('[powersync] Authenticated. User ID:', session.user?.id);

  // Keep session reference in sync with refresh/logout events
  supabase.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
    if (window._syncHelpers) {
      window._syncHelpers.authenticated = !!newSession;
      window._syncHelpers.userEmail = newSession?.user?.email || null;
    }
  });

  // ── PowerSync connector ─────────────────────────────────────────────────
  const connector = {
    async fetchCredentials() {
      const { data } = await supabase.auth.getSession();
      const s = data?.session;
      if (!s) return null;
      return {
        endpoint: config.powersyncUrl,
        token: s.access_token,
        expiresAt: s.expires_at ? new Date(s.expires_at * 1000) : undefined
      };
    },

    async uploadData(database) {
      const transaction = await database.getNextCrudTransaction();
      if (!transaction) return;

      try {
        for (const op of transaction.crud) {
          const table = op.table;
          const data = { ...op.opData };

          // Strip local-only columns that may linger in the CRUD queue from
          // before the schema migration (they don't exist in Supabase).
          if (table === 'attachments') {
            delete data.local_data;
            delete data.sync_state;
          }

          if (op.op === 'PUT') {
            data.id = op.id;
            data.user_id = session?.user?.id;
            const { error } = await supabase.from(table).upsert(data, { onConflict: 'id' });
            if (error) {
              // A note with this name already exists under a different UUID (created on
              // another device). Fall back to updating the existing row by (user_id, name).
              // Do NOT include `id` in the update — changing the primary key of an
              // existing row can violate the PK constraint if the new UUID already exists,
              // causing an infinite retry loop.  PowerSync will reconcile the local UUID
              // when it receives the next sync snapshot from the server.
              if (error.code === '23505' && table === 'notes') {
                const { id: _dropId, ...updateData } = data;
                // Coerce SQLite integer booleans to PostgreSQL booleans before sending.
                if ('deleted' in updateData) updateData.deleted = !!updateData.deleted;
                // Only update the non-deleted row. Without this filter the UPDATE can
                // accidentally set deleted=false on a previously-deleted note that shares
                // the same name, producing two non-deleted rows and re-triggering 23505.
                const { error: updateErr } = await supabase.from('notes')
                  .update(updateData)
                  .eq('user_id', data.user_id)
                  .eq('name', data.name)
                  .eq('deleted', false);
                if (updateErr) throw updateErr;
              } else {
                throw error;
              }
            }
          } else if (op.op === 'PATCH') {
            const { error } = await supabase.from(table).update(data).eq('id', op.id);
            if (error) throw error;
          } else if (op.op === 'DELETE') {
            if (table === 'attachments' && data.storage_path) {
              try {
                await supabase.storage.from('attachments').remove([data.storage_path]);
              } catch (storageErr) {
                console.warn('[powersync] Storage cleanup on delete failed (non-fatal):', storageErr);
              }
            }
            const { error } = await supabase.from(table).delete().eq('id', op.id);
            if (error) throw error;
          }
        }
        await transaction.complete();
      } catch (e) {
        if (e?.code === '23503') {
          console.warn('[powersync] Discarding transaction with orphaned user_id (FK violation):', e.details);
          await transaction.complete();
          return;
        }
        console.error('[powersync] Upload failed:', e);
        throw e;
      }
    }
  };

  // ── Initialize PowerSync database ───────────────────────────────────────
  // On iOS/Android the @powersync/capacitor SDK uses native SQLite via
  // @capacitor-community/sqlite — no WASM needed. The Capacitor SDK's
  // PowerSyncDatabase auto-detects the platform and picks the right driver.
  //
  // On Desktop (Electron) the original web-based PowerSyncDatabase uses
  // WASM SQLite with worker threads for multi-window support.

  let db = null;

  async function _createAndInitDB() {
    console.log('[powersync] Creating PowerSyncDatabase...');
    const dbConfig = {
      schema: new Schema({ notes, attachments }),
      database: {
        dbFilename: 'notes-app.db',
        // On Electron, use WASM SQLite workers for multi-window support.
        // On iOS/Android (Capacitor SDK), the native SQLite driver is used
        // automatically — no worker config needed.
        ...(isElectron ? { worker: 'vendor/worker/WASQLiteDB.umd.js' } : {})
      },
      flags: {
        externallyUnload: true,
        // Disable multi-tab on iOS — single WebView only.
        ...(isIOS ? { enableMultiTabs: false } : {})
      }
    };
    if (isElectron) {
      dbConfig.sync = { worker: 'vendor/worker/SharedSyncImplementation.umd.js' };
    }
    db = new PowerSyncDatabase(dbConfig);
    console.log('[powersync] Calling db.init()...');
    await db.init();
    console.log('[powersync] Database initialized.');

    // Create local-only table for attachment binary data and sync state.
    // This table is NOT part of the PowerSync schema, so changes to it
    // never generate CRUD operations or enter the sync stream — breaking
    // the infinite PATCH loop that occurred when these columns lived in
    // the synced attachments table.
    await db.execute(`CREATE TABLE IF NOT EXISTS local_attachment_data (
      attachment_id TEXT PRIMARY KEY,
      local_data TEXT,
      sync_state TEXT DEFAULT 'pending'
    )`);
    console.log('[powersync] local_attachment_data table ready.');

    window._powersyncDB = db;
  }

  // ── Helper: get current user ID ─────────────────────────────────────────
  function getUserId() {
    return session?.user?.id || null;
  }

  // ── Background attachment sync ──────────────────────────────────────────

  function bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  let _syncDebounceTimer = null;
  let _downloadDebounceTimer = null;

  function scheduleSyncPending() {
    if (_syncDebounceTimer) return;
    _syncDebounceTimer = setTimeout(() => {
      _syncDebounceTimer = null;
      syncPendingAttachments();
    }, 1000);
  }

  function scheduleDownloadMissing() {
    if (_downloadDebounceTimer) return;
    _downloadDebounceTimer = setTimeout(() => {
      _downloadDebounceTimer = null;
      downloadMissingAttachments();
    }, 1000);
  }

  async function syncPendingAttachments() {
    if (!db) return;
    const userId = getUserId();
    if (!userId) return;
    try {
      const pending = await db.getAll(
        'SELECT l.attachment_id, l.local_data, a.storage_path FROM local_attachment_data l JOIN attachments a ON a.id = l.attachment_id WHERE l.sync_state = ? AND a.user_id = ? AND l.local_data IS NOT NULL',
        ['pending', userId]
      );
      for (const row of pending) {
        try {
          const bytes = Uint8Array.from(atob(row.local_data), c => c.charCodeAt(0));
          const { error } = await supabase.storage
            .from('attachments')
            .upload(row.storage_path, bytes, { upsert: true });
          if (error) throw error;
          await db.execute(
            'UPDATE local_attachment_data SET sync_state = ? WHERE attachment_id = ?',
            ['synced', row.attachment_id]
          );
        } catch (e) {
          console.warn('[powersync] Attachment upload failed (will retry):', row.storage_path, e.message);
          await db.execute(
            'UPDATE local_attachment_data SET sync_state = ? WHERE attachment_id = ?',
            ['error', row.attachment_id]
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[powersync] syncPendingAttachments error:', e);
    }
  }

  async function downloadMissingAttachments() {
    if (!db) return;
    const userId = getUserId();
    if (!userId) return;
    try {
      const missing = await db.getAll(
        'SELECT a.id, a.storage_path FROM attachments a LEFT JOIN local_attachment_data l ON l.attachment_id = a.id WHERE l.local_data IS NULL AND a.storage_path IS NOT NULL AND a.user_id = ?',
        [userId]
      );
      for (const row of missing) {
        try {
          const { data, error } = await supabase.storage
            .from('attachments')
            .download(row.storage_path);
          if (error) throw error;
          const b64 = bufferToBase64(await data.arrayBuffer());
          await db.execute(
            'INSERT OR REPLACE INTO local_attachment_data (attachment_id, local_data, sync_state) VALUES (?, ?, ?)',
            [row.id, b64, 'synced']
          );
        } catch (e) {
          console.warn('[powersync] Attachment download deferred:', row.storage_path, e.message);
        }
      }
    } catch (e) {
      console.error('[powersync] downloadMissingAttachments error:', e);
    }
  }

  window.addEventListener('online', () => {
    if (!db) return;
    scheduleSyncPending();
    scheduleDownloadMissing();
  });

  // ── In-memory note content cache ──────────────────────────────────────
  // Eliminates SQLite round-trips when switching between notes. Populated
  // on first getAllNotes() call (during loading screen) and kept in sync
  // by setNote/removeNote/trashNote and the sync change watcher.
  // When _noteCacheReady is true, getNote() and getAllNotes() resolve from
  // memory instead of hitting the database.
  let _noteCache = new Map();       // name → content
  let _noteCacheReady = false;

  // ── NoteStorage builder (called after db.init) ─────────────────────────
  function _buildNoteStorage() {
    window.PowerSyncNoteStorage = {
      async getNote(name) {
        if (_noteCacheReady && _noteCache.has(name)) {
          return _noteCache.get(name);
        }
        const userId = getUserId();
        if (!userId) return null;
        const result = await db.get(
          'SELECT content FROM notes WHERE name = ? AND user_id = ? AND deleted = 0',
          [name, userId]
        ).catch(() => null);
        const content = result?.content ?? null;
        if (content !== null) _noteCache.set(name, content);
        return content;
      },

      async setNote(name, content) {
        const userId = getUserId();
        if (!userId) return;
        _noteCache.set(name, content);
        const now = new Date().toISOString();
        const existing = await db.get(
          'SELECT id FROM notes WHERE name = ? AND user_id = ? AND deleted = 0',
          [name, userId]
        ).catch(() => null);

        if (existing) {
          await db.execute(
            'UPDATE notes SET content = ?, updated_at = ? WHERE id = ?',
            [content, now, existing.id]
          );
        } else {
          // Remove any soft-deleted rows with this name left over from older
          // database versions before inserting the new row. Without this,
          // Supabase's partial unique index (on non-deleted rows) would allow
          // the insert, but the lingering deleted row wastes space and can
          // confuse the sync conflict handler.
          await db.execute(
            'DELETE FROM notes WHERE name = ? AND user_id = ? AND deleted = 1',
            [name, userId]
          ).catch(() => null);
          await db.execute(
            'INSERT INTO notes (id, name, content, deleted, updated_at, created_at, user_id) VALUES (uuid(), ?, ?, 0, ?, ?, ?)',
            [name, content, now, now, userId]
          );
        }
      },

      // Rename a note in-place by updating the name column directly.
      // This generates a single PATCH CRUD op (UPDATE name = ?) which
      // uploads as a single UPDATE to Supabase — more reliable than the
      // delete-then-insert pattern which can race against the sync stream.
      async renameNote(oldName, newName, content) {
        const userId = getUserId();
        if (!userId) return;
        _noteCache.delete(oldName);
        _noteCache.set(newName, content);
        const now = new Date().toISOString();
        await db.execute(
          'UPDATE notes SET name = ?, content = ?, updated_at = ? WHERE name = ? AND user_id = ? AND deleted = 0',
          [newName, content, now, oldName, userId]
        );
      },

      async removeNote(name) {
        _noteCache.delete(name);
        const userId = getUserId();
        if (!userId) return;
        await db.execute(
          'DELETE FROM notes WHERE name = ? AND user_id = ?',
          [name, userId]
        );
      },

      async trashNote(name) {
        _noteCache.delete(name);
        const userId = getUserId();
        if (!userId) return;
        // Hard-delete so the row is fully removed from Supabase and all other
        // devices via PowerSync's DELETE CRUD propagation. Soft-delete
        // (deleted=1) left rows in the database permanently and prevented
        // re-creation of a note with the same name on other devices.
        await db.execute(
          'DELETE FROM notes WHERE name = ? AND user_id = ?',
          [name, userId]
        );
      },

      async getAllNoteNames() {
        if (_noteCacheReady) return Array.from(_noteCache.keys());
        const userId = getUserId();
        if (!userId) return [];
        const results = await db.getAll(
          'SELECT name FROM notes WHERE user_id = ? AND deleted = 0',
          [userId]
        );
        return results.map(r => r.name);
      },

      async getAllNotes() {
        if (_noteCacheReady) {
          const out = [];
          for (const [name, content] of _noteCache) {
            out.push({ name, content });
          }
          return out;
        }
        const userId = getUserId();
        if (!userId) return [];
        const results = await db.getAll(
          'SELECT name, content FROM notes WHERE user_id = ? AND deleted = 0',
          [userId]
        );
        // Populate cache on first full fetch
        _noteCache.clear();
        for (const r of results) {
          _noteCache.set(r.name, r.content);
        }
        _noteCacheReady = true;
        return results.map(r => ({ name: r.name, content: r.content }));
      },

      // Refresh the in-memory cache from the database. Called after sync
      // events to pick up remotely-changed notes without individual queries.
      async refreshCache() {
        const userId = getUserId();
        if (!userId) return;
        const results = await db.getAll(
          'SELECT name, content FROM notes WHERE user_id = ? AND deleted = 0',
          [userId]
        );
        _noteCache.clear();
        for (const r of results) {
          _noteCache.set(r.name, r.content);
        }
        _noteCacheReady = true;
      },

      async clear() {
        _noteCache.clear();
        _noteCacheReady = false;
        const userId = getUserId();
        if (!userId) return 0;
        const allNotes = await db.getAll(
          'SELECT id FROM notes WHERE user_id = ? AND deleted = 0',
          [userId]
        );
        if (allNotes.length === 0) return 0;
        await db.execute(
          'DELETE FROM notes WHERE user_id = ? AND deleted = 0',
          [userId]
        );
        return allNotes.length;
      },

      // ── Attachments — local-first with background sync ────────────────

      async writeAttachment(noteName, filename, base64data) {
        const userId = getUserId();
        if (!userId) return false;
        try {
          const storagePath = `${userId}/${noteName}/${filename}`;
          const now = new Date().toISOString();
          const existing = await db.get(
            'SELECT id FROM attachments WHERE note_name = ? AND filename = ? AND user_id = ?',
            [noteName, filename, userId]
          ).catch(() => null);

          let attachmentId;
          if (existing) {
            attachmentId = existing.id;
            await db.execute(
              'UPDATE attachments SET storage_path = ?, updated_at = ? WHERE id = ?',
              [storagePath, now, attachmentId]
            );
          } else {
            // Generate a UUID for the new attachment so we can reference it
            // in the local_attachment_data table.
            const row = await db.get('SELECT uuid() as id');
            attachmentId = row.id;
            await db.execute(
              'INSERT INTO attachments (id, note_name, filename, storage_path, updated_at, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [attachmentId, noteName, filename, storagePath, now, now, userId]
            );
          }
          // Store binary data in the local-only table (no CRUD generated)
          await db.execute(
            'INSERT OR REPLACE INTO local_attachment_data (attachment_id, local_data, sync_state) VALUES (?, ?, ?)',
            [attachmentId, base64data, 'pending']
          );
          scheduleSyncPending();
          return true;
        } catch (e) {
          console.error('[powersync] writeAttachment failed:', e);
          return false;
        }
      },

      async readAttachment(noteName, filename) {
        const userId = getUserId();
        if (!userId) return null;
        try {
          const rec = await db.get(
            'SELECT id, storage_path FROM attachments WHERE note_name = ? AND filename = ? AND user_id = ?',
            [noteName, filename, userId]
          ).catch(() => null);
          if (!rec) return null;

          // Check local-only table for cached binary data
          const local = await db.get(
            'SELECT local_data FROM local_attachment_data WHERE attachment_id = ?',
            [rec.id]
          ).catch(() => null);
          if (local?.local_data) return local.local_data;

          try {
            const { data, error } = await supabase.storage
              .from('attachments')
              .download(rec.storage_path);
            if (error) throw error;
            const b64 = bufferToBase64(await data.arrayBuffer());
            await db.execute(
              'INSERT OR REPLACE INTO local_attachment_data (attachment_id, local_data, sync_state) VALUES (?, ?, ?)',
              [rec.id, b64, 'synced']
            ).catch(() => {});
            return b64;
          } catch (dlErr) {
            console.warn('[powersync] readAttachment download deferred (offline?):', dlErr.message);
            return null;
          }
        } catch (e) {
          console.error('[powersync] readAttachment failed:', e);
          return null;
        }
      },

      async renameAttachment(noteName, oldFilename, newFilename) {
        const userId = getUserId();
        if (!userId) return false;
        try {
          const newPath = `${userId}/${noteName}/${newFilename}`;
          const now = new Date().toISOString();
          // Get the attachment ID before updating
          const rec = await db.get(
            'SELECT id FROM attachments WHERE note_name = ? AND filename = ? AND user_id = ?',
            [noteName, oldFilename, userId]
          ).catch(() => null);
          await db.execute(
            'UPDATE attachments SET filename = ?, storage_path = ?, updated_at = ? WHERE note_name = ? AND filename = ? AND user_id = ?',
            [newFilename, newPath, now, noteName, oldFilename, userId]
          );
          if (rec) {
            await db.execute(
              'UPDATE local_attachment_data SET sync_state = ? WHERE attachment_id = ?',
              ['pending', rec.id]
            ).catch(() => {});
          }
          const oldPath = `${userId}/${noteName}/${oldFilename}`;
          supabase.storage.from('attachments').move(oldPath, newPath).then(({ error }) => {
            if (!error && rec) {
              db.execute(
                'UPDATE local_attachment_data SET sync_state = ? WHERE attachment_id = ?',
                ['synced', rec.id]
              ).catch(() => {});
            } else if (error) {
              supabase.storage.from('attachments').remove([oldPath]).catch(() => {});
            }
          }).catch(() => {
            supabase.storage.from('attachments').remove([oldPath]).catch(() => {});
          });
          return true;
        } catch (e) {
          console.error('[powersync] renameAttachment failed:', e);
          return false;
        }
      },

      async removeAttachmentDir(noteName) {
        const userId = getUserId();
        if (!userId) return;
        try {
          const recs = await db.getAll(
            'SELECT id, storage_path FROM attachments WHERE note_name = ? AND user_id = ?',
            [noteName, userId]
          );
          // Clean up local binary data
          for (const rec of recs) {
            await db.execute(
              'DELETE FROM local_attachment_data WHERE attachment_id = ?',
              [rec.id]
            ).catch(() => {});
          }
          await db.execute(
            'DELETE FROM attachments WHERE note_name = ? AND user_id = ?',
            [noteName, userId]
          );
          const remotePaths = recs.filter(r => r.storage_path).map(r => r.storage_path);
          if (remotePaths.length > 0) {
            supabase.storage.from('attachments').remove(remotePaths).catch(e => {
              console.warn('[powersync] Storage cleanup on remove failed (non-fatal):', e.message);
            });
          }
        } catch (e) {
          console.error('[powersync] removeAttachmentDir failed:', e);
        }
      },

      async renameAttachmentDir(oldNoteName, newNoteName) {
        const userId = getUserId();
        if (!userId) return;
        try {
          const recs = await db.getAll(
            'SELECT a.id, a.filename, a.storage_path, l.sync_state FROM attachments a LEFT JOIN local_attachment_data l ON l.attachment_id = a.id WHERE a.note_name = ? AND a.user_id = ?',
            [oldNoteName, userId]
          );
          for (const rec of recs) {
            const newPath = `${userId}/${newNoteName}/${rec.filename}`;
            const now = new Date().toISOString();
            await db.execute(
              'UPDATE attachments SET note_name = ?, storage_path = ?, updated_at = ? WHERE id = ?',
              [newNoteName, newPath, now, rec.id]
            );
            await db.execute(
              'UPDATE local_attachment_data SET sync_state = ? WHERE attachment_id = ?',
              ['pending', rec.id]
            ).catch(() => {});
            if (rec.sync_state === 'synced') {
              supabase.storage.from('attachments').move(rec.storage_path, newPath).then(({ error }) => {
                if (!error) {
                  db.execute(
                    'UPDATE local_attachment_data SET sync_state = ? WHERE attachment_id = ?',
                    ['synced', rec.id]
                  ).catch(() => {});
                }
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error('[powersync] renameAttachmentDir failed:', e);
        }
      },

      async listAttachments(noteName) {
        const userId = getUserId();
        if (!userId) return [];
        const recs = await db.getAll(
          'SELECT filename FROM attachments WHERE note_name = ? AND user_id = ?',
          [noteName, userId]
        );
        return recs.map(r => r.filename);
      },

      isSyncEnabled: true,

      async triggerSync() {
        try {
          await db.disconnect();
          await db.connect(connector);
          await syncPendingAttachments();
          await downloadMissingAttachments();
        } catch (e) {
          console.error('[powersync] triggerSync failed:', e);
        }
      }
    };
  }

  // ── Initialize PowerSync on all native platforms (Electron + Capacitor) ─
  await _createAndInitDB();
  await db.connect(connector);
  console.log('[powersync] Connected to sync service.');

  _buildNoteStorage();

  // Signal readiness — UI can now query local data via NoteStorage
  console.log('[powersync] Ready. NoteStorage overridden with PowerSync implementation.');
  window.dispatchEvent(new CustomEvent('powersync:ready'));

  // ── Reactive change notifications ─────────────────────────────────────
  const abortController = new AbortController();
  // Broadcast changes to secondary windows so they can refresh via their proxy.
  const _psChangeChannel = new BroadcastChannel('notes:powersync:change');
  let _changeDebounce = null;
  let _settledTimer = null;
  let _hasFiredSettled = false;
  function _scheduleChange() {
    clearTimeout(_changeDebounce);
    _changeDebounce = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('powersync:change'));
      _psChangeChannel.postMessage('change');
      clearTimeout(_settledTimer);
      _settledTimer = setTimeout(() => {
        if (!_hasFiredSettled) {
          _hasFiredSettled = true;
          window.dispatchEvent(new CustomEvent('powersync:settled'));
        }
      }, 3000);
    }, 100);
  }

  (async () => {
    try {
      for await (const _update of db.watch('SELECT COUNT(*) as c FROM notes WHERE deleted = 0', [], { signal: abortController.signal })) {
        _scheduleChange();
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[powersync] watch error:', e);
    }
  })();

  (async () => {
    try {
      for await (const _update of db.watch('SELECT COUNT(*) as c FROM attachments', [], { signal: abortController.signal })) {
        scheduleDownloadMissing();
        _scheduleChange();
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[powersync] attachments watch error:', e);
    }
  })();

  window.addEventListener('pagehide', () => {
    abortController.abort();
    db.close({ disconnect: false });
  });

  } catch (err) {
    console.error('[powersync] Initialization failed:', err);
    window.dispatchEvent(new CustomEvent('powersync:disabled'));
  }
})();
