// profile-store.js — Profile registry persisted in localStorage.
//
// localStorage is used (not IndexedDB) because file-list / theme bootstrap
// runs synchronously before IndexedDB is open. Refresh tokens are NOT stored
// here — they live encrypted at rest in IndexedDB via profile-session-vault.js.

(function () {
  'use strict';

  const STORAGE_KEY = 'profiles_v1';
  const MIGRATION_FLAG = 'profiles_v1_migrated';

  const DEFAULT_PROFILE_COLORS = [
    '#a272b0', '#5db7de', '#73a857', '#e07b5b', '#d4a55b',
    '#c25b8e', '#7e8be0', '#3fa28f'
  ];

  function _uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    // Fallback (rare — Crypto.randomUUID is in all supported browsers)
    return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.profiles) || !parsed.activeId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function _write(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function exists() {
    return _read() !== null;
  }

  function list() {
    const s = _read();
    return s ? s.profiles.slice() : [];
  }

  function getActiveId() {
    const s = _read();
    return s ? s.activeId : null;
  }

  function getActive() {
    const s = _read();
    if (!s) return null;
    return s.profiles.find(p => p.id === s.activeId) || s.profiles[0] || null;
  }

  function getById(id) {
    const s = _read();
    return s ? s.profiles.find(p => p.id === id) || null : null;
  }

  function _normaliseInitial(name, override) {
    if (override && override.length > 0) return override.slice(0, 1).toUpperCase();
    const trimmed = (name || '').trim();
    return trimmed ? trimmed[0].toUpperCase() : '?';
  }

  // Initialise the registry with a single Default profile if none exists.
  // Returns the new active profile.
  function ensureDefault() {
    const existing = _read();
    if (existing) return getActive();
    const id = _uuid();
    const now = Date.now();
    const profile = {
      id,
      name: 'Default',
      color: DEFAULT_PROFILE_COLORS[0],
      initial: 'D',
      supabaseEmail: null,
      createdAt: now,
      lastUsedAt: now
    };
    _write({ activeId: id, profiles: [profile] });
    return profile;
  }

  function create({ name, color }) {
    const s = _read() || { activeId: null, profiles: [] };
    const cleanName = (name || '').trim() || 'Profile';
    const id = _uuid();
    const now = Date.now();
    const usedColors = new Set(s.profiles.map(p => p.color));
    const fallbackColor = DEFAULT_PROFILE_COLORS.find(c => !usedColors.has(c)) || DEFAULT_PROFILE_COLORS[0];
    const profile = {
      id,
      name: cleanName,
      color: color || fallbackColor,
      initial: _normaliseInitial(cleanName),
      supabaseEmail: null,
      createdAt: now,
      lastUsedAt: now
    };
    s.profiles.push(profile);
    if (!s.activeId) s.activeId = id;
    _write(s);
    return profile;
  }

  // Patch is a partial profile object: {name?, color?, initial?, supabaseEmail?, lastUsedAt?}.
  function update(id, patch) {
    const s = _read();
    if (!s) return null;
    const idx = s.profiles.findIndex(p => p.id === id);
    if (idx === -1) return null;
    const merged = { ...s.profiles[idx], ...patch };
    // Auto-derive initial from the new name when the caller renamed without
    // also providing an explicit initial — otherwise the avatar would keep
    // the old letter.
    if (patch.name !== undefined && patch.initial === undefined) {
      merged.initial = _normaliseInitial(merged.name);
    }
    s.profiles[idx] = merged;
    _write(s);
    return merged;
  }

  function remove(id) {
    const s = _read();
    if (!s) return false;
    if (s.profiles.length <= 1) return false;
    if (s.activeId === id) return false;
    const before = s.profiles.length;
    s.profiles = s.profiles.filter(p => p.id !== id);
    if (s.profiles.length === before) return false;
    _write(s);
    return true;
  }

  function setActive(id) {
    const s = _read();
    if (!s) return false;
    if (!s.profiles.some(p => p.id === id)) return false;
    s.activeId = id;
    const idx = s.profiles.findIndex(p => p.id === id);
    if (idx >= 0) s.profiles[idx].lastUsedAt = Date.now();
    _write(s);
    return true;
  }

  window.ProfileStore = {
    STORAGE_KEY,
    MIGRATION_FLAG,
    DEFAULT_PROFILE_COLORS,
    exists,
    list,
    getActive,
    getActiveId,
    getById,
    ensureDefault,
    create,
    update,
    remove,
    setActive
  };
})();
