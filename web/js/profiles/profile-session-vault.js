// profile-session-vault.js — Per-profile Supabase refresh-token storage.
//
// Refresh tokens are encrypted at rest in IndexedDB using AES-GCM under a
// key derived (PBKDF2) from a stable browser fingerprint plus a per-install
// random salt persisted in localStorage. This is OBFUSCATION, not strong
// protection: a compromised JS context can recompute the key from window
// properties. It defends against casual exfiltration (e.g. someone with
// brief access to the IndexedDB file). Same threat model as KeyStorage.

(function () {
  'use strict';

  const STORE_NAME = 'profile_sessions';
  const SALT_KEY = 'profile_kdf_salt';

  let _keyPromise = null;

  function _getOrCreateSalt() {
    let salt = localStorage.getItem(SALT_KEY);
    if (salt) return salt;
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    salt = btoa(String.fromCharCode(...bytes));
    localStorage.setItem(SALT_KEY, salt);
    return salt;
  }

  async function _deriveKey() {
    if (_keyPromise) return _keyPromise;
    _keyPromise = (async () => {
      const fingerprint = (navigator.userAgent || '') + '|' + (window.location.origin || '');
      const salt = _getOrCreateSalt();
      const enc = new TextEncoder();
      const baseKey = await window.crypto.subtle.importKey(
        'raw',
        enc.encode(fingerprint),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );
      const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
      return window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    })();
    return _keyPromise;
  }

  function _b64encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function _b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function _encrypt(plaintext) {
    const key = await _deriveKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder().encode(plaintext);
    const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc);
    return { iv: _b64encode(iv), ciphertext: _b64encode(new Uint8Array(ct)) };
  }

  async function _decrypt(record) {
    const key = await _deriveKey();
    const iv = _b64decode(record.iv);
    const ct = _b64decode(record.ciphertext);
    const pt = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  async function _getDB() {
    if (!window.NoteStorage?._getRawDB) {
      throw new Error('[profile-session-vault] NoteStorage._getRawDB not available');
    }
    return window.NoteStorage._getRawDB();
  }

  function _txStore(db, mode) {
    const tx = db.transaction(STORE_NAME, mode);
    return { tx, store: tx.objectStore(STORE_NAME) };
  }

  function _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function _txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // session: { access_token, refresh_token, email }
  async function save(profileId, session) {
    if (!profileId || !session?.refresh_token) return false;
    try {
      const payload = JSON.stringify({
        access_token: session.access_token || null,
        refresh_token: session.refresh_token,
        email: session.email || null
      });
      const enc = await _encrypt(payload);
      const db = await _getDB();
      const { tx, store } = _txStore(db, 'readwrite');
      store.put({ profileId, iv: enc.iv, ciphertext: enc.ciphertext });
      await _txDone(tx);
      return true;
    } catch (e) {
      console.error('[profile-session-vault] save failed:', e);
      return false;
    }
  }

  async function load(profileId) {
    if (!profileId) return null;
    try {
      const db = await _getDB();
      const { store } = _txStore(db, 'readonly');
      const rec = await _req(store.get(profileId));
      if (!rec || !rec.ciphertext) return null;
      const json = await _decrypt(rec);
      return JSON.parse(json);
    } catch (e) {
      console.error('[profile-session-vault] load failed:', e);
      return null;
    }
  }

  async function clear(profileId) {
    if (!profileId) return false;
    try {
      const db = await _getDB();
      const { tx, store } = _txStore(db, 'readwrite');
      store.delete(profileId);
      await _txDone(tx);
      return true;
    } catch (e) {
      console.error('[profile-session-vault] clear failed:', e);
      return false;
    }
  }

  window.ProfileSessionVault = { save, load, clear };
})();
