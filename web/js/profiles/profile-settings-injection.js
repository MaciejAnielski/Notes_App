// profile-settings-injection.js — Renders the ## 👤 Profiles section inside
// the Settings note preview. Mirrors the structure of injectSyncSettings:
// finds the section by heading text, bails if .profile-controls is already
// injected, then builds a controls container and appends via _appendControls.

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

  function _avatarSpan(profile) {
    const av = document.createElement('span');
    av.className = 'profile-avatar profile-avatar-mini';
    av.textContent = profile.initial || (profile.name?.[0] || '?').toUpperCase();
    av.style.backgroundColor = profile.color || 'var(--accent)';
    av.style.color = _contrastingTextColor(profile.color);
    return av;
  }

  function _refreshSection(section) {
    const oldWrap = section.querySelector('.profile-controls');
    if (oldWrap) oldWrap.remove();
    _build(section);
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

  function _buildRow(profile, isActive, refresh) {
    const row = document.createElement('div');
    row.className = 'profile-row profile-row-managed';
    if (isActive) row.classList.add('active');

    row.appendChild(_avatarSpan(profile));

    // Name (click-to-rename)
    const nameWrap = document.createElement('div');
    nameWrap.className = 'profile-row-namewrap';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'profile-row-label';
    nameSpan.textContent = profile.name + (profile.supabaseEmail ? ` (${profile.supabaseEmail})` : '');
    nameWrap.appendChild(nameSpan);

    nameSpan.title = 'Click to rename';
    nameSpan.addEventListener('click', () => {
      const next = window.prompt('Rename profile', profile.name);
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed) return;
      window.ProfileStore.update(profile.id, { name: trimmed });
      window.ProfileAvatar?.refresh();
      refresh();
      if (typeof updateStatus === 'function') updateStatus('Profile renamed.', true);
    });
    row.appendChild(nameWrap);

    // Color picker
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'profile-color-picker';
    colorInput.value = profile.color || '#a272b0';
    colorInput.addEventListener('change', () => {
      window.ProfileStore.update(profile.id, { color: colorInput.value });
      window.ProfileAvatar?.refresh();
      refresh();
      if (typeof updateStatus === 'function') updateStatus('Profile colour updated.', true);
    });
    row.appendChild(colorInput);

    // Active pill or Switch button
    if (isActive) {
      const pill = document.createElement('span');
      pill.className = 'profile-active-pill';
      pill.textContent = 'Active';
      row.appendChild(pill);
    } else {
      const switchBtn = _btn('Switch', 'secondary');
      switchBtn.addEventListener('click', async () => {
        switchBtn.disabled = true;
        switchBtn.textContent = 'Switching…';
        await window.ProfileSwitcher?.switchTo(profile.id);
      });
      row.appendChild(switchBtn);
    }

    // Link / Unlink Supabase
    const supportsSync = !!(window.electronAPI || window.Capacitor?.isNativePlatform());
    if (supportsSync) {
      if (profile.supabaseEmail) {
        const unlinkBtn = _btn('Unlink', 'secondary');
        unlinkBtn.addEventListener('click', async () => {
          if (!window.confirm(`Unlink ${profile.supabaseEmail} from "${profile.name}"? Local notes for this profile remain on this device.`)) return;
          unlinkBtn.disabled = true;
          unlinkBtn.textContent = 'Unlinking…';
          try {
            await window.ProfileSwitcher.unlinkSupabase(profile.id);
            if (typeof updateStatus === 'function') updateStatus('Profile unlinked.', true);
            refresh();
          } catch (e) {
            unlinkBtn.disabled = false;
            unlinkBtn.textContent = 'Unlink';
            if (typeof updateStatus === 'function') updateStatus(e.message || 'Unlink failed.', false);
          }
        });
        row.appendChild(unlinkBtn);
      } else {
        const linkBtn = _btn('Link Supabase', 'secondary');
        linkBtn.addEventListener('click', async () => {
          const email = window.prompt('Email address to link to this profile:');
          if (!email) return;
          linkBtn.disabled = true;
          linkBtn.textContent = 'Sending…';
          try {
            await window.ProfileSwitcher.linkSupabase(profile.id, email);
            if (typeof updateStatus === 'function') {
              updateStatus(`Sign-in link sent to ${email}.`, true, true);
            }
          } catch (e) {
            linkBtn.disabled = false;
            linkBtn.textContent = 'Link Supabase';
            if (typeof updateStatus === 'function') updateStatus(e.message || 'Link failed.', false);
          }
        });
        row.appendChild(linkBtn);
      }
    }

    // Remove
    const removeBtn = _btn('Remove', 'secondary');
    removeBtn.classList.add('profile-row-remove');
    const profileCount = window.ProfileStore.list().length;
    if (profileCount <= 1 || isActive) {
      removeBtn.disabled = true;
      removeBtn.title = isActive
        ? 'Switch to a different profile first.'
        : 'You must keep at least one profile.';
    } else {
      removeBtn.addEventListener('click', async () => {
        if (!window.confirm(`Remove profile "${profile.name}" and all its notes? This cannot be undone.`)) return;
        removeBtn.disabled = true;
        removeBtn.textContent = 'Removing…';
        try {
          await window.ProfileSwitcher.removeProfile(profile.id);
          if (typeof updateStatus === 'function') updateStatus('Profile removed.', true);
          refresh();
        } catch (e) {
          removeBtn.disabled = false;
          removeBtn.textContent = 'Remove';
          if (typeof updateStatus === 'function') updateStatus(e.message || 'Remove failed.', false);
        }
      });
    }
    row.appendChild(removeBtn);

    if (SECONDARY) {
      // In secondary windows, profile management is read-only.
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

    const active = window.ProfileStore.getActive();
    if (active) {
      wrap.appendChild(_statusMsg(`Active: ${active.name}${active.supabaseEmail ? ` (${active.supabaseEmail})` : ''}`));
    }

    const list = document.createElement('div');
    list.className = 'profile-list';
    const refresh = () => _refreshSection(section);
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
