// profile-switcher.js — Action layer for multi-profile support.
//
// Owns the bootstrap on page load, the switch flow, and the link/unlink/
// remove actions. Switching reloads the page (the same approach the existing
// helpers.disable() and helpers.signOut() use, since the Supabase session,
// PowerSync DB, and encryption master key are all coupled to load order).

(function () {
  'use strict';

  const PROFILE_CHANNEL = 'notes:profile:change';
  const PENDING_LINK_KEY = 'pending_link_profile_id';

  let _channel = null;
  function _getChannel() {
    if (_channel) return _channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    _channel = new BroadcastChannel(PROFILE_CHANNEL);
    return _channel;
  }

  function broadcastChange(detail) {
    const ch = _getChannel();
    if (ch) ch.postMessage(detail || { type: 'change' });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────
  // Runs once during app startup, AFTER NoteStorage is final (post-PowerSync)
  // but BEFORE any note content is read. Establishes a Default profile if
  // needed, migrates legacy notes into it on the IDB path, installs the
  // namespacing wrapper, restores the linked Supabase session if present,
  // and applies the per-profile theme.
  async function bootstrapActiveProfile() {
    if (!window.ProfileStore) {
      console.warn('[profile-switcher] ProfileStore unavailable; skipping bootstrap');
      return null;
    }

    const firstRun = !window.ProfileStore.exists();
    let active;
    if (firstRun) {
      active = window.ProfileStore.ensureDefault();
    } else {
      active = window.ProfileStore.getActive();
    }

    // One-time IDB migration (web path only). PowerSync paths skip the rename
    // and rely on read-fallback for legacy unprefixed rows.
    const migrated = !!localStorage.getItem(window.ProfileStore.MIGRATION_FLAG);
    const isWebOnly = !window.electronAPI && !window.Capacitor?.isNativePlatform();
    if (!migrated && isWebOnly && active) {
      try {
        await window.ProfileStorageWrapper._migrateIDBToProfile(active.id);
      } catch (e) {
        console.error('[profile-switcher] migration error:', e);
      }
    }
    // Set the migration flag regardless of platform — PowerSync paths use the
    // read-fallback strategy (unprefixed rows surface as Default-profile data
    // until they get rewritten on next save).
    if (!migrated) {
      localStorage.setItem(window.ProfileStore.MIGRATION_FLAG, '1');
    }

    // Install the namespacing wrapper around the now-final NoteStorage.
    if (window.ProfileStorageWrapper) {
      window.ProfileStorageWrapper.install();
    }

    // Restore Supabase session if this profile is linked.
    if (active?.supabaseEmail && window.ProfileSessionVault && window._supabaseClient) {
      try {
        const stored = await window.ProfileSessionVault.load(active.id);
        if (stored?.refresh_token) {
          const current = await window._supabaseClient.auth.getSession();
          const currentEmail = current?.data?.session?.user?.email || null;
          if (currentEmail !== stored.email) {
            await window._supabaseClient.auth.setSession({
              access_token: stored.access_token,
              refresh_token: stored.refresh_token
            });
          }
        }
      } catch (e) {
        console.warn('[profile-switcher] session restore failed:', e?.message);
      }
    }

    return active;
  }

  // Hook called by powersync-storage.js auth-state listener after a successful
  // SIGNED_IN event. If a profile linking flow is in progress, persist the
  // session and link the email to that profile.
  async function _onSupabaseAuthChange(event, session) {
    if (event !== 'SIGNED_IN' || !session) return;
    const pendingId = localStorage.getItem(PENDING_LINK_KEY);
    if (!pendingId) return;
    try {
      if (window.ProfileSessionVault) {
        await window.ProfileSessionVault.save(pendingId, {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          email: session.user?.email || null
        });
      }
      window.ProfileStore?.update(pendingId, {
        supabaseEmail: session.user?.email || null
      });
      localStorage.removeItem(PENDING_LINK_KEY);
      // Set this profile active and reload so the linked storage path runs cleanly.
      window.ProfileStore?.setActive(pendingId);
      localStorage.setItem('sync_enabled', 'true');
      broadcastChange({ type: 'linked', profileId: pendingId });
    } catch (e) {
      console.error('[profile-switcher] auth change handler failed:', e);
    }
  }

  // ── Switch ─────────────────────────────────────────────────────────────
  // Saves any pending edits, clears trail/search/current-file, then reloads.
  // Reload is required because encryption + PowerSync + theme all depend on
  // module load order; in-place re-init is fragile and matches no existing
  // pattern in the codebase.
  async function switchTo(targetId) {
    if (!window.ProfileStore) return false;
    const current = window.ProfileStore.getActive();
    if (!current || current.id === targetId) return true;
    const target = window.ProfileStore.getById(targetId);
    if (!target) return false;

    // Flush any pending edits to the current profile's storage.
    try {
      if (typeof autoSaveTimer !== 'undefined' && autoSaveTimer !== null) {
        clearTimeout(autoSaveTimer);
      }
      if (typeof autoSaveNote === 'function') {
        await autoSaveNote();
      }
    } catch (e) {
      console.warn('[profile-switcher] flush before switch failed:', e?.message);
    }

    // Reset trail / open note / search.
    localStorage.removeItem('current_file');
    localStorage.removeItem('linked_chain');

    // Cross-account switch: target is linked to a different Supabase account.
    const sameAccount = !!(
      current.supabaseEmail &&
      target.supabaseEmail &&
      current.supabaseEmail === target.supabaseEmail
    );
    const targetIsLinked = !!target.supabaseEmail;
    const currentIsLinked = !!current.supabaseEmail;

    if (window._supabaseClient && currentIsLinked && (!targetIsLinked || !sameAccount)) {
      try {
        if (window._powersyncDB?.disconnectAndClear) {
          await window._powersyncDB.disconnectAndClear().catch(() => {});
        }
        await window._supabaseClient.auth.signOut().catch(() => {});
      } catch (e) {
        console.warn('[profile-switcher] cross-account cleanup failed:', e?.message);
      }
    }

    // Switch active profile, broadcast, then reload.
    window.ProfileStore.setActive(targetId);
    if (targetIsLinked) {
      localStorage.setItem('sync_enabled', 'true');
    } else {
      localStorage.removeItem('sync_enabled');
    }
    broadcastChange({ type: 'switch', profileId: targetId });
    window.location.reload();
    return true;
  }

  // ── Link to Supabase ───────────────────────────────────────────────────
  // Sends a magic link tagged with this profile id. The auth state listener
  // (powersync-storage.js) consumes the pending key on SIGNED_IN and persists
  // the resulting session via ProfileSessionVault.
  async function linkSupabase(profileId, email) {
    if (!window._syncHelpers) {
      throw new Error('Sync helpers unavailable');
    }
    if (!email || !email.trim()) {
      throw new Error('Email required to link a profile.');
    }
    localStorage.setItem(PENDING_LINK_KEY, profileId);
    localStorage.setItem('sync_enabled', 'true');
    try {
      await window._syncHelpers.sendMagicLink(email.trim());
    } catch (e) {
      localStorage.removeItem(PENDING_LINK_KEY);
      throw e;
    }
  }

  // Unlink a profile from Supabase. Clears stored token and the supabaseEmail
  // metadata. If the unlinked profile is currently active, signs out + reloads.
  async function unlinkSupabase(profileId) {
    if (window.ProfileSessionVault) {
      await window.ProfileSessionVault.clear(profileId).catch(() => {});
    }
    window.ProfileStore?.update(profileId, { supabaseEmail: null });
    const active = window.ProfileStore?.getActive();
    if (active?.id === profileId) {
      try {
        if (window._powersyncDB?.disconnectAndClear) {
          await window._powersyncDB.disconnectAndClear().catch(() => {});
        }
        if (window._supabaseClient) {
          await window._supabaseClient.auth.signOut().catch(() => {});
        }
      } catch (e) {
        console.warn('[profile-switcher] unlink cleanup failed:', e?.message);
      }
      localStorage.removeItem('sync_enabled');
      broadcastChange({ type: 'unlink', profileId });
      window.location.reload();
    } else {
      broadcastChange({ type: 'unlink', profileId });
    }
  }

  // Remove a profile entirely. Refuses to remove the last profile or the
  // active profile (caller must switch first). Deletes all notes belonging to
  // the profile from the underlying storage and clears any session record.
  async function removeProfile(profileId) {
    const profiles = window.ProfileStore?.list() || [];
    if (profiles.length <= 1) {
      throw new Error('Cannot remove the last profile.');
    }
    const active = window.ProfileStore?.getActive();
    if (active?.id === profileId) {
      throw new Error('Switch to a different profile before removing this one.');
    }

    const PREFIX = window.ProfileStorageWrapper?.PREFIX_TAG || '__p';
    const targetPrefix = PREFIX + profileId + '__';

    // Remove notes belonging to this profile from the underlying storage.
    // Use _unprefixed so the wrapper's namespace filter does not hide them.
    const inner = window.NoteStorage?._unprefixed || window.NoteStorage;
    if (inner) {
      try {
        const allNames = await inner.getAllNoteNames();
        for (const n of allNames) {
          if (typeof n === 'string' && n.startsWith(targetPrefix)) {
            await inner.removeNote(n);
            await inner.removeAttachmentDir?.(n);
          }
        }
      } catch (e) {
        console.warn('[profile-switcher] remove notes failed:', e?.message);
      }
    }

    if (window.ProfileSessionVault) {
      await window.ProfileSessionVault.clear(profileId).catch(() => {});
    }

    window.ProfileStore?.remove(profileId);
    broadcastChange({ type: 'remove', profileId });
    return true;
  }

  window.ProfileSwitcher = {
    PROFILE_CHANNEL,
    PENDING_LINK_KEY,
    bootstrapActiveProfile,
    switchTo,
    linkSupabase,
    unlinkSupabase,
    removeProfile,
    broadcastChange,
    _onSupabaseAuthChange
  };
})();
