// profile-settings-injection.js — Renders the unified ## 👤 Profiles section.
//
// Each profile row carries every per-profile control: avatar (click to pick
// colour), name (click to rename), ACTIVE / inactive status, Sync ON/OFF
// chip, Encryption ON/OFF chip, Remove button. The active profile's Sync
// and Encryption chips expand inline panels that reuse the legacy
// _buildSignInForm / _buildSignedInView / _buildEncryptionActiveView /
// _buildNeedKeyView builders from markdown-renderer.js.

(function () {
  'use strict';

  const SECONDARY = new URLSearchParams(window.location.search).get('secondary') === 'true';

  function _findSection(container) {
    for (const details of container.querySelectorAll('details')) {
      const h = details.querySelector('summary h2');
      if (h && h.textContent.includes('Profiles')) return details;
    }
    for (const h of container.querySelectorAll('h2')) {
      if (h.textContent.includes('Profiles')) return h.parentElement;
    }
    return null;
  }

  function _contrastingTextColor(bgHex) {
    const m = /^#?([\da-f]{6})$/i.exec(bgHex || '');
    if (!m) return '#fff';
    const v = parseInt(m[1], 16);
    const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#222' : '#fff';
  }

  function _refreshSection(section) {
    const oldWrap = section.querySelector('.profile-controls');
    if (oldWrap) oldWrap.remove();
    _build(section);
  }

  // Replace the name span with an <input> for inline rename. Commits on
  // Enter or blur, cancels on Escape. Used by all profile rows including
  // the auto-created Default profile.
  function _startInlineRename(nameSpan, profile, refresh) {
    if (!nameSpan.parentNode) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'profile-row-name-input';
    input.value = profile.name;
    input.maxLength = 64;
    input.spellcheck = false;
    input.autocomplete = 'off';

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const trimmed = input.value.trim();
      if (commit && trimmed && trimmed !== profile.name) {
        window.ProfileStore.update(profile.id, { name: trimmed });
        window.ProfileAvatar?.refresh();
        refresh();
        if (typeof updateStatus === 'function') updateStatus('Profile renamed.', true);
      } else {
        // Restore the original span if no commit happened.
        if (input.parentNode) input.replaceWith(nameSpan);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));

    nameSpan.replaceWith(input);
    input.focus();
    input.select();
  }

  function _statusMsg(text) {
    const el = document.createElement('p');
    el.className = 'sync-status-msg';
    el.textContent = text;
    return el;
  }

  function _btn(text, kind) {
    const b = document.createElement('button');
    b.className = 'sync-btn ' + (kind === 'primary' ? 'sync-btn-primary' : 'sync-btn-secondary');
    b.textContent = text;
    return b;
  }

  // ── Per-profile sync state (read-only summary) ─────────────────────────
  function _syncStateFor(profile, isActive) {
    if (profile.supabaseEmail) return { on: true, label: 'Sync ON', detail: profile.supabaseEmail };
    return { on: false, label: 'Sync OFF', detail: null };
  }

  // ── Per-profile encryption state ────────────────────────────────────────
  // Encryption is an account-level toggle on the Supabase user, so the live
  // status is only knowable for the active profile (we hold its session).
  // For inactive linked profiles we show '—'; for unlinked profiles N/A.
  function _encryptionStateFor(profile, isActive) {
    if (!profile.supabaseEmail) return { kind: 'na', label: 'E2E N/A' };
    if (!isActive) return { kind: 'unknown', label: 'E2E —' };
    const enc = window._encryption;
    if (!enc) return { kind: 'unknown', label: 'E2E —' };
    if (enc.active && enc.key) return { kind: 'on', label: 'E2E ON' };
    if (enc.enabled && !enc.key) return { kind: 'pair', label: 'Pair device' };
    return { kind: 'off', label: 'E2E OFF' };
  }

  // ── Chip element ────────────────────────────────────────────────────────
  // Compact pill that doubles as a state indicator and (when active) a
  // toggle. Class hooks: profile-chip, profile-chip-on / profile-chip-off /
  // profile-chip-disabled, profile-chip-active (when expanded panel open).
  function _chip(label, kindClass, opts = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'profile-chip ' + kindClass;
    el.textContent = label;
    if (opts.title) el.title = opts.title;
    if (opts.disabled) el.disabled = true;
    return el;
  }

  // ── Inline panel below a row ────────────────────────────────────────────
  // Created on demand when a chip is clicked. Reused: clicking the same chip
  // again removes the panel; clicking a different chip swaps content.
  // Every panel includes a close (✕) button so the user can dismiss it
  // even after starting a flow (e.g. typing an email but not submitting).
  function _ensurePanel(row) {
    let panel = row.nextElementSibling;
    if (!panel || !panel.classList.contains('profile-row-panel')) {
      panel = document.createElement('div');
      panel.className = 'profile-row-panel';
      row.parentNode.insertBefore(panel, row.nextSibling);
    }
    panel.innerHTML = '';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'profile-row-panel-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => _closePanel(row));
    panel.appendChild(closeBtn);
    return panel;
  }

  function _closePanel(row) {
    const panel = row.nextElementSibling;
    if (panel && panel.classList.contains('profile-row-panel')) {
      panel.remove();
    }
    row.querySelectorAll('.profile-chip-active').forEach(c => c.classList.remove('profile-chip-active'));
  }

  function _openSyncPanel(row, profile) {
    _closePanel(row);
    const panel = _ensurePanel(row);
    panel.classList.add('profile-row-panel-sync');
    const helpers = window._syncHelpers;

    if (!helpers || !helpers.available) {
      panel.appendChild(_statusMsg('Sync requires the desktop or iOS app.'));
      return;
    }

    if (profile.supabaseEmail) {
      // Already linked — show signed-in state with sign-out / unlink.
      if (typeof window._buildSignedInView === 'function' && helpers.authenticated) {
        window._buildSignedInView(panel, helpers);
      } else {
        panel.appendChild(_statusMsg(`Linked to ${profile.supabaseEmail}.`));
      }
      const unlinkBtn = _btn('Unlink Profile from Supabase', 'secondary');
      unlinkBtn.addEventListener('click', async () => {
        if (!window.confirm(`Unlink ${profile.supabaseEmail} from "${profile.name}"? Local notes for this profile remain on this device.`)) return;
        unlinkBtn.disabled = true;
        unlinkBtn.textContent = 'Unlinking…';
        try {
          await window.ProfileSwitcher.unlinkSupabase(profile.id);
        } catch (e) {
          unlinkBtn.disabled = false;
          unlinkBtn.textContent = 'Unlink Profile from Supabase';
          if (typeof updateStatus === 'function') updateStatus(e.message || 'Unlink failed.', false);
        }
      });
      panel.appendChild(unlinkBtn);
      return;
    }

    // Not linked — show email form. Reuse the legacy magic-link sign-in
    // form, but mark the pending profile id first so the auth-state listener
    // attributes the resulting session correctly.
    const emailWrap = document.createElement('div');
    emailWrap.className = 'sync-step';
    emailWrap.appendChild(_statusMsg('Enter your email to receive a sign-in link.'));
    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'you@example.com';
    emailInput.className = 'sync-email-input';
    emailInput.autocomplete = 'email';
    emailWrap.appendChild(emailInput);
    const sendBtn = _btn('Send Sign-In Link', 'primary');
    emailWrap.appendChild(sendBtn);
    const errorEl = document.createElement('p');
    errorEl.className = 'sync-error';
    errorEl.style.display = 'none';
    emailWrap.appendChild(errorEl);
    panel.appendChild(emailWrap);

    const sendLink = async () => {
      errorEl.style.display = 'none';
      const email = emailInput.value.trim();
      if (!email) {
        errorEl.textContent = 'Please enter your email address.';
        errorEl.style.display = 'block';
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        await window.ProfileSwitcher.linkSupabase(profile.id, email);
        emailWrap.innerHTML = '';
        emailWrap.appendChild(_statusMsg(`Sign-in link sent to ${email}. Click it from your email and the app will reload.`));
      } catch (e) {
        errorEl.textContent = e.message || 'Failed to send link.';
        errorEl.style.display = 'block';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Sign-In Link';
      }
    };
    sendBtn.addEventListener('click', sendLink);
    emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink(); });
  }

  function _openEncryptionPanel(row, profile, encState) {
    _closePanel(row);
    const panel = _ensurePanel(row);
    panel.classList.add('profile-row-panel-enc');
    const enc = window._encryption;
    const userId = enc?.userId;

    if (!profile.supabaseEmail) {
      panel.appendChild(_statusMsg('Link this profile to Supabase first to enable encryption.'));
      return;
    }
    if (encState.kind === 'unknown') {
      panel.appendChild(_statusMsg('Switch to this profile to manage its encryption.'));
      return;
    }
    if (!userId) {
      panel.appendChild(_statusMsg('Sign in to manage encryption.'));
      return;
    }

    if (encState.kind === 'on') {
      if (typeof window._buildEncryptionActiveView === 'function') {
        window._buildEncryptionActiveView(panel, userId, enc.key);
      } else {
        panel.appendChild(_statusMsg('Encryption is on for this profile.'));
      }
      return;
    }
    if (encState.kind === 'pair') {
      if (typeof window._buildNeedKeyView === 'function') {
        window._buildNeedKeyView(panel, userId);
      } else {
        panel.appendChild(_statusMsg('This device needs to be paired to read encrypted notes.'));
      }
      return;
    }

    // OFF — same enable flow as the legacy section.
    panel.appendChild(_statusMsg('Encrypt your notes so only your devices can read them. The server will never see your content.'));
    const warnP = document.createElement('p');
    warnP.className = 'encryption-warning';
    warnP.textContent = 'Warning: If you lose access to all your devices and have no key backup, encrypted notes cannot be recovered.';
    panel.appendChild(warnP);
    const enableBtn = _btn('Enable Encryption', 'primary');
    enableBtn.addEventListener('click', async () => {
      enableBtn.disabled = true;
      enableBtn.textContent = 'Setting up…';
      try {
        const masterKey = await CryptoEngine.generateMasterKey();
        const rawBytes = await CryptoEngine.exportKey(masterKey);
        await KeyStorage.saveMasterKey(rawBytes, userId);
        await DevicePairing.enableEncryption(userId);
        await DevicePairing.registerDevice(userId);
        if (typeof updateStatus === 'function') updateStatus('Encryption enabled. Reloading…', true, true);
        window.location.reload();
      } catch (e) {
        console.error('[profiles] Enable encryption failed:', e);
        enableBtn.disabled = false;
        enableBtn.textContent = 'Enable Encryption';
        if (typeof updateStatus === 'function') updateStatus(e.message || 'Enable failed.', false);
      }
    });
    panel.appendChild(enableBtn);
  }

  // ── Row builder ─────────────────────────────────────────────────────────
  function _buildRow(profile, isActive, refresh) {
    const row = document.createElement('div');
    row.className = 'profile-row profile-row-managed';
    if (isActive) row.classList.add('active');

    // Avatar — click to pick a colour. Hidden <input type="color"> sits
    // inside the avatar so the native picker opens on click and the avatar
    // serves as both visual swatch and trigger.
    // Identity sub-flex: keeps the avatar and name at a fixed gap, decoupled
    // from the row's gap so chips wrapping on narrow screens cannot affect
    // the avatar/name spacing.
    const identity = document.createElement('div');
    identity.className = 'profile-row-identity';

    const avWrap = document.createElement('label');
    avWrap.className = 'profile-avatar profile-avatar-mini profile-avatar-pick';
    avWrap.textContent = profile.initial || (profile.name?.[0] || '?').toUpperCase();
    avWrap.style.backgroundColor = profile.color || 'var(--accent)';
    avWrap.style.color = _contrastingTextColor(profile.color);
    avWrap.title = 'Click to change colour';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'profile-avatar-color-input';
    colorInput.value = profile.color || '#a272b0';
    colorInput.addEventListener('change', () => {
      window.ProfileStore.update(profile.id, { color: colorInput.value });
      window.ProfileAvatar?.refresh();
      refresh();
      if (typeof updateStatus === 'function') updateStatus('Profile colour updated.', true);
    });
    avWrap.appendChild(colorInput);
    identity.appendChild(avWrap);

    // Name — click to rename inline. Replaces the span with an <input> on
    // click; commits on Enter or blur, cancels on Escape. Works for the
    // Default profile too (no special-casing).
    const nameSpan = document.createElement('span');
    nameSpan.className = 'profile-row-label';
    nameSpan.textContent = profile.name;
    nameSpan.title = 'Click to rename';
    nameSpan.addEventListener('click', () => _startInlineRename(nameSpan, profile, refresh));
    identity.appendChild(nameSpan);

    row.appendChild(identity);

    // Status pill — ACTIVE pill or Switch button
    if (isActive) {
      const pill = document.createElement('span');
      pill.className = 'profile-active-pill';
      pill.textContent = 'Active';
      row.appendChild(pill);
    } else {
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'profile-chip profile-chip-switch';
      switchBtn.textContent = 'Switch';
      switchBtn.addEventListener('click', async () => {
        switchBtn.disabled = true;
        switchBtn.textContent = 'Switching…';
        await window.ProfileSwitcher?.switchTo(profile.id);
      });
      row.appendChild(switchBtn);
    }

    const supportsSync = !!(window.electronAPI || window.Capacitor?.isNativePlatform());

    // Sync chip
    const syncState = _syncStateFor(profile, isActive);
    const syncChip = _chip(
      syncState.label,
      syncState.on ? 'profile-chip-on' : 'profile-chip-off',
      { title: syncState.detail || (supportsSync ? 'Click to manage sync' : 'Sync available on Desktop/iOS only') }
    );
    if (!supportsSync) syncChip.classList.add('profile-chip-disabled');
    syncChip.addEventListener('click', () => {
      if (!supportsSync) return;
      if (!isActive) {
        // For inactive profiles, switching first is required (we can't show
        // their session). Tell the user.
        if (typeof updateStatus === 'function') {
          updateStatus('Switch to this profile to manage its sync.', false);
        }
        return;
      }
      if (syncChip.classList.contains('profile-chip-active')) {
        syncChip.classList.remove('profile-chip-active');
        _closePanel(row);
        return;
      }
      syncChip.classList.add('profile-chip-active');
      _openSyncPanel(row, profile);
    });
    row.appendChild(syncChip);

    // Encryption chip
    const encState = _encryptionStateFor(profile, isActive);
    let encChipKind;
    switch (encState.kind) {
      case 'on': encChipKind = 'profile-chip-on'; break;
      case 'off': encChipKind = 'profile-chip-off'; break;
      case 'pair': encChipKind = 'profile-chip-warn'; break;
      default: encChipKind = 'profile-chip-disabled';
    }
    const encChip = _chip(encState.label, encChipKind, {
      title: encState.kind === 'na'
        ? 'Encryption requires a Supabase-linked profile.'
        : encState.kind === 'unknown'
          ? 'Switch to this profile to see live encryption state.'
          : 'Click to manage encryption'
    });
    if (encState.kind === 'na' || encState.kind === 'unknown' || !supportsSync) {
      encChip.classList.add('profile-chip-disabled');
    }
    encChip.addEventListener('click', () => {
      if (encChip.classList.contains('profile-chip-disabled')) return;
      if (encChip.classList.contains('profile-chip-active')) {
        encChip.classList.remove('profile-chip-active');
        _closePanel(row);
        return;
      }
      encChip.classList.add('profile-chip-active');
      _openEncryptionPanel(row, profile, encState);
    });
    row.appendChild(encChip);

    // Delete icon — replaces the previous "Remove" text label. Uses the
    // wastebasket glyph (🗑) for a compact icon button. aria-label preserves
    // semantics for screen readers.
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'profile-chip profile-chip-remove';
    removeBtn.textContent = '🗑';
    removeBtn.setAttribute('aria-label', 'Delete profile');
    removeBtn.title = 'Delete profile';
    const profileCount = window.ProfileStore.list().length;
    if (profileCount <= 1 || isActive) {
      removeBtn.disabled = true;
      removeBtn.classList.add('profile-chip-disabled');
      removeBtn.title = isActive
        ? 'Switch to a different profile first.'
        : 'You must keep at least one profile.';
    } else {
      removeBtn.addEventListener('click', async () => {
        if (!window.confirm(`Delete profile "${profile.name}" and all its notes? This cannot be undone.`)) return;
        removeBtn.disabled = true;
        removeBtn.classList.add('profile-chip-busy');
        try {
          await window.ProfileSwitcher.removeProfile(profile.id);
          if (typeof updateStatus === 'function') updateStatus('Profile deleted.', true);
          refresh();
        } catch (e) {
          removeBtn.disabled = false;
          removeBtn.classList.remove('profile-chip-busy');
          if (typeof updateStatus === 'function') updateStatus(e.message || 'Delete failed.', false);
        }
      });
    }
    row.appendChild(removeBtn);

    if (SECONDARY) {
      row.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
      row.title = 'Manage profiles from the main window.';
    }

    return row;
  }

  function _build(section) {
    if (section.querySelector('.profile-controls')) return;
    if (!window.ProfileStore) return;

    const wrap = document.createElement('div');
    wrap.className = 'profile-controls';

    const list = document.createElement('div');
    list.className = 'profile-list';
    const refresh = () => _refreshSection(section);
    const active = window.ProfileStore.getActive();
    for (const p of window.ProfileStore.list()) {
      list.appendChild(_buildRow(p, p.id === active?.id, refresh));
    }
    wrap.appendChild(list);

    const addBtn = _btn('Add Profile', 'primary');
    if (SECONDARY) addBtn.disabled = true;
    addBtn.addEventListener('click', () => {
      const name = window.prompt('Profile name:');
      if (!name || !name.trim()) return;
      const profile = window.ProfileStore.create({ name: name.trim() });
      window.ProfileAvatar?.refresh();
      _refreshSection(section);
      if (typeof updateStatus === 'function') {
        updateStatus(`Profile "${profile.name}" created.`, true);
      }
    });
    wrap.appendChild(addBtn);

    if (typeof window._appendControls === 'function') {
      window._appendControls(section, wrap);
    } else {
      section.appendChild(wrap);
    }
  }

  function injectProfileSettings(container) {
    const section = _findSection(container);
    if (!section) return;
    _build(section);
  }

  window.injectProfileSettings = injectProfileSettings;
})();
