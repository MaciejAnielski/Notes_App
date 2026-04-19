// KeyStorage — platform-abstracted persistence for the E2E encryption master key.
//
// - Web:      IndexedDB 'encryption_keys' store (weakest — browser sandbox only)
// - Electron: IPC → main process → safeStorage (OS keychain-backed)
// - iOS:      IndexedDB (Capacitor WebView sandbox; Keychain via plugin is future work)
//
// Keys are stored as raw Uint8Array (32 bytes). User ID namespacing ensures
// multiple accounts on the same device don't collide.

'use strict';

const _KEY_STORE_NAME = 'encryption_keys';
const _KEY_DB_NAME = 'NotesAppKeysDB';
const _KEY_DB_VERSION = 1;

let _keyDbPromise = null;

function _getKeyDB() {
  if (_keyDbPromise) return _keyDbPromise;
  _keyDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(_KEY_DB_NAME, _KEY_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_KEY_STORE_NAME)) {
        db.createObjectStore(_KEY_STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => {
      _keyDbPromise = null; // allow retry on next call
      reject(req.error);
    };
  });
  return _keyDbPromise;
}

function _idbGet(key) {
  return _getKeyDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(_KEY_STORE_NAME, 'readonly');
    const req = tx.objectStore(_KEY_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function _idbPut(record) {
  return _getKeyDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(_KEY_STORE_NAME, 'readwrite');
    tx.objectStore(_KEY_STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function _idbDelete(key) {
  return _getKeyDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(_KEY_STORE_NAME, 'readwrite');
    tx.objectStore(_KEY_STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// ── Device ID ────────────────────────────────────────────────────────────

function _generateDeviceId() {
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── KeyStorage public interface ──────────────────────────────────────────

window.KeyStorage = {

  /**
   * Save the master key for the given user.
   * @param {Uint8Array} rawBytes - 32-byte raw AES key
   * @param {string} userId - Supabase user ID (for namespacing)
   */
  async saveMasterKey(rawBytes, userId) {
    const id = 'mk_' + userId;

    // Electron: use safeStorage via IPC
    if (window.electronAPI?.saveEncryptedKey) {
      const b64 = window.BinaryUtil.uint8ToBase64(rawBytes);
      await window.electronAPI.saveEncryptedKey(id, b64);
      return;
    }

    // Web / iOS: IndexedDB
    await _idbPut({ id, key: Array.from(rawBytes) });
  },

  /**
   * Load the master key for the given user.
   * @param {string} userId - Supabase user ID
   * @returns {Uint8Array|null} 32-byte key or null if not found
   */
  async loadMasterKey(userId) {
    const id = 'mk_' + userId;

    // Electron: use safeStorage via IPC
    if (window.electronAPI?.loadEncryptedKey) {
      const b64 = await window.electronAPI.loadEncryptedKey(id);
      if (!b64) return null;
      return window.BinaryUtil.base64ToUint8(b64);
    }

    // Web / iOS: IndexedDB
    const rec = await _idbGet(id);
    if (!rec || !rec.key) return null;
    return new Uint8Array(rec.key);
  },

  /**
   * Check if a master key exists for the given user.
   */
  async hasMasterKey(userId) {
    const raw = await this.loadMasterKey(userId);
    return raw !== null;
  },

  /**
   * Delete the master key for the given user.
   */
  async deleteMasterKey(userId) {
    const id = 'mk_' + userId;

    if (window.electronAPI?.deleteEncryptedKey) {
      await window.electronAPI.deleteEncryptedKey(id);
      return;
    }

    await _idbDelete(id);
  },

  /**
   * Get or generate a persistent device ID.
   * Stored in localStorage (not sensitive — just an identifier).
   */
  getDeviceId() {
    let id = localStorage.getItem('encryption_device_id');
    if (!id) {
      id = _generateDeviceId();
      localStorage.setItem('encryption_device_id', id);
    }
    return id;
  },

  /**
   * Get a human-readable device name.
   */
  getDeviceName() {
    const isElectron = !!window.electronAPI;
    const isIOS = !!window.Capacitor?.isNativePlatform();
    const ua = navigator.userAgent;
    if (isElectron) {
      if (ua.includes('Macintosh') || ua.includes('Mac OS')) return 'Desktop (Mac)';
      if (ua.includes('Windows')) return 'Desktop (Windows)';
      if (ua.includes('Linux')) return 'Desktop (Linux)';
      return 'Desktop';
    }
    if (isIOS) return 'iOS';
    return 'Web Browser';
  }
};
