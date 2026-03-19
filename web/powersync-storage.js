// PowerSync + Supabase NoteStorage implementation
// Provides sync on Desktop (Electron) and iOS (Capacitor).
// Web (plain browser) never loads this file — it keeps using localStorage.
//
// Architecture: LOCAL-FIRST
// - Notes: stored in local SQLite via PowerSync, synced automatically.
// - Attachments: binary data stored in local SQLite (local_data column),
//   metadata synced via PowerSync, binaries synced to/from Supabase Storage
//   in the background. All operations succeed offline.

(async function () {
  'use strict';

  // Only activate on Desktop or iOS — never on plain web
  const isElectron = !!window.electronAPI;
  const isIOS = !!window.Capacitor?.isNativePlatform();
  if (!isElectron && !isIOS) return;

  try { // top-level catch so errors are never silently swallowed

  console.log('[powersync] Detected platform:', isElectron ? 'Electron' : 'iOS (Capacitor)');

  const config = window.POWERSYNC_CONFIG;
  if (!config || config.supabaseUrl.includes('YOUR_')) {
    console.warn('[powersync] Config not set — skipping PowerSync init. Using fallback storage.');
    return;
  }
  console.log('[powersync] Config loaded. Supabase URL:', config.supabaseUrl);

  if (!window.PowerSync || !window.SupabaseClient) {
    console.error('[powersync] PowerSync or SupabaseClient globals not found. The vendor bundle may not have loaded correctly.');
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
    user_id: column.text,
    // Local-only columns (not in Supabase schema or sync stream).
    // PowerSync stores them locally and leaves them untouched during sync.
    local_data: column.text,   // base64-encoded binary data
    sync_state: column.text    // 'pending' | 'synced' | 'error'
  });

  // ── Supabase client ─────────────────────────────────────────────────────
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  });

  // ── Magic link auth ─────────────────────────────────────────────────────
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data?.session;
  } catch (e) {
    console.error('[powersync] Failed to get session:', e);
  }

  if (!session) {
    // No session — prompt user to sign in via magic link (email OTP).
    // Expose auth helpers so the UI can drive the flow.
    window._powersyncAuth = {
      async sendCode(email) {
        const { error } = await supabase.auth.signInWithOtp({ email });
        if (error) throw error;
      },
      async verifyCode(email, token) {
        const { data, error } = await supabase.auth.verifyOtp({
          email, token, type: 'email'
        });
        if (error) throw error;
        session = data.session;
        return session;
      }
    };

    // Signal that auth is needed and wait for the UI to resolve it
    const authPromise = new Promise(resolve => {
      window.addEventListener('powersync:auth-complete', () => resolve(), { once: true });
    });
    window.dispatchEvent(new CustomEvent('powersync:needs-auth'));
    await authPromise;

    // Re-fetch session after auth
    if (!session) {
      const { data } = await supabase.auth.getSession();
      session = data?.session;
    }
    if (!session) {
      console.error('[powersync] Auth completed but no session available.');
      return;
    }
  }

  console.log('[powersync] Authenticated. User ID:', session?.user?.id);

  // Listen for session refresh
  supabase.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
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

          // Strip local-only columns before sending to Supabase
          if (table === 'attachments') {
            delete data.local_data;
            delete data.sync_state;
          }

          if (op.op === 'PUT') {
            // Upsert: insert or update
            data.id = op.id;
            // Always use the current session user — stale user_ids from a
            // previous anonymous session would violate the FK constraint.
            data.user_id = session?.user?.id;
            const { error } = await supabase.from(table).upsert(data);
            if (error) throw error;
          } else if (op.op === 'PATCH') {
            const { error } = await supabase.from(table).update(data).eq('id', op.id);
            if (error) throw error;
          } else if (op.op === 'DELETE') {
            // When deleting attachments, also clean up Supabase Storage
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
        // FK constraint violation (23503): the referenced user no longer exists
        // (e.g. old anonymous user was deleted).  Retrying will never succeed —
        // discard this transaction so the queue can progress.
        if (e?.code === '23503') {
          console.warn('[powersync] Discarding transaction with orphaned user_id (FK violation):', e.details);
          await transaction.complete();
          return;
        }
        console.error('[powersync] Upload failed:', e);
        throw e; // PowerSync will retry
      }
    }
  };

  // ── Initialize PowerSync database ───────────────────────────────────────
  // Worker paths must be specified explicitly so the SDK does not try to
  // resolve them relative to the bundle via import.meta.url (which would
  // produce wrong paths and cause db.init() to hang silently).
  console.log('[powersync] Creating PowerSyncDatabase...');
  const db = new PowerSyncDatabase({
    schema: new Schema({ notes, attachments }),
    database: {
      dbFilename: 'notes-app.db',
      worker: 'vendor/worker/WASQLiteDB.umd.js'
    },
    sync: {
      worker: 'vendor/worker/SharedSyncImplementation.umd.js'
    }
  });

  console.log('[powersync] Calling db.init()...');
  await db.init();
  console.log('[powersync] Database initialized.');

console.log('[powersync] Calling db.connect()...');
  await db.connect(connector);
  console.log('[powersync] Connected to sync service.');

  // Expose for external use (migration, force sync, change watching)
  window._powersyncDB = db;
  window._supabase = supabase;

  // ── Helper: get current user ID ─────────────────────────────────────────
  function getUserId() {
    return session?.user?.id || null;
  }

  // ── Background attachment sync ──────────────────────────────────────────

  // Chunked base64 encoding — avoids slow character-by-character concatenation.
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
    const userId = getUserId();
    if (!userId) return;
    try {
      const pending = await db.getAll(
        'SELECT id, storage_path, local_data FROM attachments WHERE sync_state = ? AND user_id = ? AND local_data IS NOT NULL',
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
            'UPDATE attachments SET sync_state = ? WHERE id = ?',
            ['synced', row.id]
          );
        } catch (e) {
          console.warn('[powersync] Attachment upload failed (will retry):', row.storage_path, e.message);
          await db.execute(
            'UPDATE attachments SET sync_state = ? WHERE id = ?',
            ['error', row.id]
          ).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[powersync] syncPendingAttachments error:', e);
    }
  }

  async function downloadMissingAttachments() {
    const userId = getUserId();
    if (!userId) return;
    try {
      const missing = await db.getAll(
        'SELECT id, storage_path FROM attachments WHERE local_data IS NULL AND storage_path IS NOT NULL AND user_id = ?',
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
            'UPDATE attachments SET local_data = ?, sync_state = ? WHERE id = ?',
            [b64, 'synced', row.id]
          );
        } catch (e) {
          // Download failed (likely offline) — will retry on next change event
          console.warn('[powersync] Attachment download deferred:', row.storage_path, e.message);
        }
      }
    } catch (e) {
      console.error('[powersync] downloadMissingAttachments error:', e);
    }
  }

  // Retry pending uploads and fetch missing data when connectivity is restored
  window.addEventListener('online', () => {
    scheduleSyncPending();
    scheduleDownloadMissing();
  });

  // ── NoteStorage implementation ──────────────────────────────────────────
  window.PowerSyncNoteStorage = {
    async getNote(name) {
      const userId = getUserId();
      if (!userId) return null;
      const result = await db.get(
        'SELECT content FROM notes WHERE name = ? AND user_id = ? AND deleted = 0',
        [name, userId]
      ).catch(() => null);
      return result?.content ?? null;
    },

    async setNote(name, content) {
      const userId = getUserId();
      if (!userId) return;
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
        await db.execute(
          'INSERT INTO notes (id, name, content, deleted, updated_at, created_at, user_id) VALUES (uuid(), ?, ?, 0, ?, ?, ?)',
          [name, content, now, now, userId]
        );
      }
    },

    async removeNote(name) {
      const userId = getUserId();
      if (!userId) return;
      await db.execute(
        'DELETE FROM notes WHERE name = ? AND user_id = ?',
        [name, userId]
      );
    },

    async trashNote(name) {
      const userId = getUserId();
      if (!userId) return;
      const now = new Date().toISOString();
      await db.execute(
        'UPDATE notes SET deleted = 1, updated_at = ? WHERE name = ? AND user_id = ? AND deleted = 0',
        [now, name, userId]
      );
    },

    async getAllNoteNames() {
      const userId = getUserId();
      if (!userId) return [];
      const results = await db.getAll(
        'SELECT name FROM notes WHERE user_id = ? AND deleted = 0',
        [userId]
      );
      return results.map(r => r.name);
    },

    async getAllNotes() {
      const userId = getUserId();
      if (!userId) return [];
      const results = await db.getAll(
        'SELECT name, content FROM notes WHERE user_id = ? AND deleted = 0',
        [userId]
      );
      return results.map(r => ({ name: r.name, content: r.content }));
    },

    async clear() {
      const userId = getUserId();
      if (!userId) return 0;
      const notes = await db.getAll(
        'SELECT id FROM notes WHERE user_id = ? AND deleted = 0',
        [userId]
      );
      if (notes.length === 0) return 0;
      await db.execute(
        'DELETE FROM notes WHERE user_id = ? AND deleted = 0',
        [userId]
      );
      return notes.length;
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

        if (existing) {
          await db.execute(
            'UPDATE attachments SET storage_path = ?, local_data = ?, sync_state = ?, updated_at = ? WHERE id = ?',
            [storagePath, base64data, 'pending', now, existing.id]
          );
        } else {
          await db.execute(
            'INSERT INTO attachments (id, note_name, filename, storage_path, local_data, sync_state, updated_at, created_at, user_id) VALUES (uuid(), ?, ?, ?, ?, ?, ?, ?, ?)',
            [noteName, filename, storagePath, base64data, 'pending', now, now, userId]
          );
        }
        // Background upload — non-blocking
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
          'SELECT id, storage_path, local_data FROM attachments WHERE note_name = ? AND filename = ? AND user_id = ?',
          [noteName, filename, userId]
        ).catch(() => null);
        if (!rec) return null;

        // Fast path: local data available (works offline)
        if (rec.local_data) return rec.local_data;

        // Slow path: synced from another device, binary not yet downloaded
        try {
          const { data, error } = await supabase.storage
            .from('attachments')
            .download(rec.storage_path);
          if (error) throw error;
          const b64 = bufferToBase64(await data.arrayBuffer());
          // Cache locally for offline access
          await db.execute(
            'UPDATE attachments SET local_data = ?, sync_state = ? WHERE id = ?',
            [b64, 'synced', rec.id]
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
        // Update locally immediately — background sync will handle remote move
        await db.execute(
          'UPDATE attachments SET filename = ?, storage_path = ?, sync_state = ?, updated_at = ? WHERE note_name = ? AND filename = ? AND user_id = ?',
          [newFilename, newPath, 'pending', now, noteName, oldFilename, userId]
        );
        // Background: move on Supabase Storage, then clean up old path (fire-and-forget)
        const oldPath = `${userId}/${noteName}/${oldFilename}`;
        supabase.storage.from('attachments').move(oldPath, newPath).then(({ error }) => {
          if (!error) {
            db.execute(
              'UPDATE attachments SET sync_state = ? WHERE note_name = ? AND filename = ? AND user_id = ?',
              ['synced', noteName, newFilename, userId]
            ).catch(() => {});
          } else {
            // Move failed — syncPendingAttachments will re-upload at the new path.
            // Clean up the old path to prevent orphans.
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
        // Collect remote paths for background cleanup
        const recs = await db.getAll(
          'SELECT storage_path, sync_state FROM attachments WHERE note_name = ? AND user_id = ?',
          [noteName, userId]
        );
        // Delete locally immediately
        await db.execute(
          'DELETE FROM attachments WHERE note_name = ? AND user_id = ?',
          [noteName, userId]
        );
        // Background: clean up Supabase Storage for all remote paths (fire-and-forget)
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
          'SELECT id, filename, storage_path, sync_state FROM attachments WHERE note_name = ? AND user_id = ?',
          [oldNoteName, userId]
        );
        for (const rec of recs) {
          const newPath = `${userId}/${newNoteName}/${rec.filename}`;
          const now = new Date().toISOString();
          // Update locally immediately
          await db.execute(
            'UPDATE attachments SET note_name = ?, storage_path = ?, sync_state = ?, updated_at = ? WHERE id = ?',
            [newNoteName, newPath, 'pending', now, rec.id]
          );
          // Background: move on Supabase Storage (fire-and-forget)
          if (rec.sync_state === 'synced') {
            supabase.storage.from('attachments').move(rec.storage_path, newPath).then(({ error }) => {
              if (!error) {
                db.execute(
                  'UPDATE attachments SET sync_state = ? WHERE id = ?',
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

    // Expose sync-related state
    isSyncEnabled: true,

    async triggerSync() {
      try {
        // Disconnect and reconnect to force a fresh sync
        await db.disconnect();
        await db.connect(connector);
        // Also process pending attachment uploads and download missing data
        await syncPendingAttachments();
        await downloadMissingAttachments();
      } catch (e) {
        console.error('[powersync] triggerSync failed:', e);
      }
    }
  };

  // Signal readiness so storage.js and app-init.js can pick up PowerSyncNoteStorage
  console.log('[powersync] Ready. NoteStorage overridden with PowerSync implementation.');
  window.dispatchEvent(new CustomEvent('powersync:ready'));

  // ── Reactive change notifications ─────────────────────────────────────
  // Watch the notes table for changes and dispatch a custom event so
  // app-init.js can refresh the UI reactively.
  const abortController = new AbortController();
  (async () => {
    try {
      for await (const _update of db.watch('SELECT COUNT(*) as c FROM notes WHERE deleted = 0', [], { signal: abortController.signal })) {
        window.dispatchEvent(new CustomEvent('powersync:change'));
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[powersync] watch error:', e);
    }
  })();

  // Watch attachments table — download missing binary data when new metadata arrives
  (async () => {
    try {
      for await (const _update of db.watch('SELECT COUNT(*) as c FROM attachments', [], { signal: abortController.signal })) {
        scheduleDownloadMissing();
        window.dispatchEvent(new CustomEvent('powersync:change'));
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[powersync] attachments watch error:', e);
    }
  })();

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    abortController.abort();
  });

  } catch (err) {
    console.error('[powersync] Initialization failed:', err);
  }
})();
