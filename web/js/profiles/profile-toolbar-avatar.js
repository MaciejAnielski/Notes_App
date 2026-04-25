// profile-toolbar-avatar.js — Toolbar avatar button + switcher dropdown.
//
// Renders a small circular button at the right edge of #button-container that
// shows the active profile's initial on its colour. Clicking opens a dropdown
// listing all profiles (with active highlighted) plus a "Manage profiles"
// link that navigates to the Settings note's Profiles section.

(function () {
  'use strict';

  const SECONDARY = new URLSearchParams(window.location.search).get('secondary') === 'true';

  let _btn = null;
  let _dropdown = null;
  let _outsideClick = null;

  function _ensureContrastingTextColor(bgHex) {
    // Quick luminance heuristic; returns black or white for max contrast.
    const m = /^#?([\da-f]{6})$/i.exec(bgHex || '');
    if (!m) return '#fff';
    const v = parseInt(m[1], 16);
    const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#222' : '#fff';
  }

  function _paintButton() {
    if (!_btn || !window.ProfileStore) return;
    const active = window.ProfileStore.getActive();
    if (!active) return;
    _btn.textContent = active.initial || (active.name?.[0] || '?').toUpperCase();
    _btn.style.backgroundColor = active.color || 'var(--accent)';
    _btn.style.color = _ensureContrastingTextColor(active.color);
    const linkSuffix = active.supabaseEmail ? ` (${active.supabaseEmail})` : '';
    _btn.title = `Profile: ${active.name}${linkSuffix} — click to switch`;
    _btn.setAttribute('aria-label', _btn.title);
  }

  function _close() {
    if (!_dropdown) return;
    _dropdown.hidden = true;
    _btn?.setAttribute('aria-expanded', 'false');
    if (_outsideClick) {
      document.removeEventListener('click', _outsideClick, true);
      document.removeEventListener('keydown', _onKey, true);
      _outsideClick = null;
    }
  }

  function _onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      _close();
      _btn?.focus();
    }
  }

  function _buildRow(profile, isActive) {
    const row = document.createElement('div');
    row.className = 'profile-row' + (isActive ? ' active' : '');
    row.setAttribute('role', 'menuitem');
    row.tabIndex = 0;

    const av = document.createElement('span');
    av.className = 'profile-avatar profile-avatar-mini';
    av.textContent = profile.initial || (profile.name?.[0] || '?').toUpperCase();
    av.style.backgroundColor = profile.color || 'var(--accent)';
    av.style.color = _ensureContrastingTextColor(profile.color);
    row.appendChild(av);

    const label = document.createElement('span');
    label.className = 'profile-row-label';
    label.textContent = profile.name;
    row.appendChild(label);

    if (profile.supabaseEmail) {
      const tag = document.createElement('span');
      tag.className = 'profile-row-tag';
      tag.textContent = '☁';
      tag.title = profile.supabaseEmail;
      row.appendChild(tag);
    }

    if (!isActive) {
      row.addEventListener('click', () => {
        _close();
        window.ProfileSwitcher?.switchTo(profile.id);
      });
    }
    return row;
  }

  function _open() {
    if (!_dropdown || !window.ProfileStore) return;
    _dropdown.innerHTML = '';
    const profiles = window.ProfileStore.list();
    const activeId = window.ProfileStore.getActiveId();
    for (const p of profiles) {
      _dropdown.appendChild(_buildRow(p, p.id === activeId));
    }

    const sep = document.createElement('div');
    sep.className = 'profile-dropdown-sep';
    _dropdown.appendChild(sep);

    const manage = document.createElement('div');
    manage.className = 'profile-row profile-manage-row';
    manage.setAttribute('role', 'menuitem');
    manage.tabIndex = 0;
    manage.textContent = 'Manage profiles…';
    manage.addEventListener('click', async () => {
      _close();
      if (typeof loadNote === 'function') {
        await loadNote('Settings');
        // Defer so the preview renders, then scroll to the Profiles heading.
        requestAnimationFrame(() => {
          const headings = document.querySelectorAll('#preview h2');
          for (const h of headings) {
            if (h.textContent.includes('Profiles')) {
              h.scrollIntoView({ block: 'start', behavior: 'smooth' });
              break;
            }
          }
        });
      }
    });
    _dropdown.appendChild(manage);

    _dropdown.hidden = false;
    _btn?.setAttribute('aria-expanded', 'true');

    _outsideClick = (e) => {
      const group = document.getElementById('profile-avatar-group');
      if (group && !group.contains(e.target)) _close();
    };
    document.addEventListener('click', _outsideClick, true);
    document.addEventListener('keydown', _onKey, true);
  }

  function mount() {
    _btn = document.getElementById('profile-avatar-btn');
    _dropdown = document.getElementById('profile-dropdown');
    if (!_btn || !_dropdown) return;

    if (SECONDARY) {
      // Secondary windows show the avatar (read-only) but disable the dropdown
      // — profile switching only happens from the primary window so all
      // windows reload together via BroadcastChannel.
      _paintButton();
      _btn.disabled = true;
      _btn.title = 'Switch profiles from the main window.';
      return;
    }

    _paintButton();

    _btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_dropdown.hidden) _open(); else _close();
    });
  }

  function refresh() {
    if (_dropdown && !_dropdown.hidden) {
      _close();
    }
    _paintButton();
  }

  window.ProfileAvatar = { mount, refresh };
})();
