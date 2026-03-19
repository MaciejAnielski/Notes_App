// PowerSync + Supabase NoteStorage implementation
// Replaces iCloud file-based sync on Desktop (Electron) and iOS (Capacitor).
// Web (plain browser) never loads this file — it keeps using localStorage.

(async function () {
  'use strict';

  // Only activate on Desktop or iOS — never on plain web
  const isElectron = !!window.electronAPI;
  const isIOS = !!window.Capacitor?.isNativePlatform();
  if (!isElectron && !isIOS) return;

  const config = window.POWERSYNC_CONFIG;
  if (!config || config.supabaseUrl.includes('YOUR_')) {
    console.warn('[powersync] Config not set — skipping PowerSync init. Using fallback storage.');
    return;
  }

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
  });

  // ── Supabase client ─────────────────────────────────────────────────────
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true
    }
  });

  // ── Anonymous auth ──────────────────────────────────────────────────────
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data?.session;
  } catch (e) {
    console.error('[powersync] Failed to get session:', e);
  }

  if (!session) {
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    } catch (e) {
      console.error('[powersync] Anonymous sign-in failed:', e);
      return; // Fall back to default storage
    }
  }

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

          if (op.op === 'PUT') {
            // Upsert: insert or update
            data.id = op.id;
            if (!data.user_id) data.user_id = session?.user?.id;
            const { error } = await supabase.from(table).upsert(data);
            if (error) throw error;
          } else if (op.op === 'PATCH') {
            const { error } = await supabase.from(table).update(data).eq('id', op.id);
            if (error) throw error;
          } else if (op.op === 'DELETE') {
            const { error } = await supabase.from(table).delete().eq('id', op.id);
            if (error) throw error;
          }
        }
        await transaction.complete();
      } catch (e) {
        console.error('[powersync] Upload failed:', e);
        throw e; // PowerSync will retry
      }
    }
  };

  // ── Initialize PowerSync database ───────────────────────────────────────
  const db = new PowerSyncDatabase({
    schema: new Schema({ notes, attachments }),
    database: { dbFilename: 'notes-app.db' }
  });

  await db.init();
  await db.connect(connector);

  // Expose for external use (migration, force sync, change watching)
  window._powersyncDB = db;
  window._supabase = supabase;

  // ── Helper: get current user ID ─────────────────────────────────────────
  function getUserId() {
    return session?.user?.id || null;
  }

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

    // ── Backup/Export stubs ─────────────────────────────────────────────
    // Backups and exports are stored in Supabase Storage, not in the
    // synced SQLite database. For now, these are no-ops that match the
    // web localStorage behavior. Full Supabase Storage integration for
    // backups/exports can be added as a follow-up.
    async writeBackup(filename, data) {},
    async writeExport(filename, data) {},

    // ── Attachments via Supabase Storage ────────────────────────────────
    async writeAttachment(noteName, filename, base64data) {
      const userId = getUserId();
      if (!userId) return false;
      try {
        const storagePath = `${userId}/${noteName}/${filename}`;
        const bytes = Uint8Array.from(atob(base64data), c => c.charCodeAt(0));
        const { error: uploadError } = await supabase.storage
          .from('attachments')
          .upload(storagePath, bytes, { upsert: true });
        if (uploadError) throw uploadError;

        // Upsert attachment record
        const now = new Date().toISOString();
        const existing = await db.get(
          'SELECT id FROM attachments WHERE note_name = ? AND filename = ? AND user_id = ?',
          [noteName, filename, userId]
        ).catch(() => null);

        if (existing) {
          await db.execute(
            'UPDATE attachments SET storage_path = ?, updated_at = ? WHERE id = ?',
            [storagePath, now, existing.id]
          );
        } else {
          await db.execute(
            'INSERT INTO attachments (id, note_name, filename, storage_path, updated_at, created_at, user_id) VALUES (uuid(), ?, ?, ?, ?, ?, ?)',
            [noteName, filename, storagePath, now, now, userId]
          );
        }
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
          'SELECT storage_path FROM attachments WHERE note_name = ? AND filename = ? AND user_id = ?',
          [noteName, filename, userId]
        ).catch(() => null);
        if (!rec) return null;

        const { data, error } = await supabase.storage
          .from('attachments')
          .download(rec.storage_path);
        if (error) throw error;
        const buf = await data.arrayBuffer();
        const binary = new Uint8Array(buf);
        let base64 = '';
        for (let i = 0; i < binary.length; i++) {
          base64 += String.fromCharCode(binary[i]);
        }
        return btoa(base64);
      } catch (e) {
        console.error('[powersync] readAttachment failed:', e);
        return null;
      }
    },

    async renameAttachment(noteName, oldFilename, newFilename) {
      const userId = getUserId();
      if (!userId) return false;
      try {
        const oldPath = `${userId}/${noteName}/${oldFilename}`;
        const newPath = `${userId}/${noteName}/${newFilename}`;
        const { error } = await supabase.storage
          .from('attachments')
          .move(oldPath, newPath);
        if (error) throw error;

        const now = new Date().toISOString();
        await db.execute(
          'UPDATE attachments SET filename = ?, storage_path = ?, updated_at = ? WHERE note_name = ? AND filename = ? AND user_id = ?',
          [newFilename, newPath, now, noteName, oldFilename, userId]
        );
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
          'SELECT storage_path FROM attachments WHERE note_name = ? AND user_id = ?',
          [noteName, userId]
        );
        if (recs.length > 0) {
          const paths = recs.map(r => r.storage_path);
          await supabase.storage.from('attachments').remove(paths);
        }
        await db.execute(
          'DELETE FROM attachments WHERE note_name = ? AND user_id = ?',
          [noteName, userId]
        );
      } catch (e) {
        console.error('[powersync] removeAttachmentDir failed:', e);
      }
    },

    async renameAttachmentDir(oldNoteName, newNoteName) {
      const userId = getUserId();
      if (!userId) return;
      try {
        const recs = await db.getAll(
          'SELECT id, filename, storage_path FROM attachments WHERE note_name = ? AND user_id = ?',
          [oldNoteName, userId]
        );
        for (const rec of recs) {
          const newPath = `${userId}/${newNoteName}/${rec.filename}`;
          await supabase.storage.from('attachments').move(rec.storage_path, newPath);
          const now = new Date().toISOString();
          await db.execute(
            'UPDATE attachments SET note_name = ?, storage_path = ?, updated_at = ? WHERE id = ?',
            [newNoteName, newPath, now, rec.id]
          );
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
      } catch (e) {
        console.error('[powersync] triggerSync failed:', e);
      }
    }
  };

  // ── Reactive change notifications ─────────────────────────────────────
  // Watch the notes table for changes and dispatch a custom event so
  // app-init.js can refresh the UI (replaces iCloud polling/file watcher).
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

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    abortController.abort();
  });
})();
