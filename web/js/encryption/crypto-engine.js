// CryptoEngine — Web Crypto API primitives for E2E encryption.
//
// All operations use the browser's native SubtleCrypto API:
// - AES-256-GCM for symmetric encryption (notes + attachments)
// - ECDH (P-256) for key exchange during device pairing
// - HKDF for deriving wrapping keys from ECDH shared secrets
//
// No external dependencies. Works in browsers, Electron, and Capacitor.

'use strict';

const _CIPHER_PREFIX = 'enc:v1:';

window.CryptoEngine = {

  // ── Master key generation & import/export ──────────────────────────────

  /** Generate a new random 256-bit AES-GCM master key. */
  async generateMasterKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable (needed for export during pairing/backup)
      ['encrypt', 'decrypt']
    );
  },

  /** Export a CryptoKey as raw bytes (Uint8Array, 32 bytes). */
  async exportKey(cryptoKey) {
    const buf = await crypto.subtle.exportKey('raw', cryptoKey);
    return new Uint8Array(buf);
  },

  /** Import raw bytes (Uint8Array or ArrayBuffer) as an AES-GCM CryptoKey. */
  async importKey(rawBytes) {
    return crypto.subtle.importKey(
      'raw',
      rawBytes,
      { name: 'AES-GCM' },
      true, // extractable
      ['encrypt', 'decrypt']
    );
  },

  // ── Symmetric encryption (text) ────────────────────────────────────────

  /**
   * Encrypt a plaintext string.
   * Returns "enc:v1:<base64(12-byte-IV || ciphertext || GCM-tag)>"
   */
  async encrypt(plaintext, masterKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      encoded
    );
    // Concatenate IV + ciphertext (GCM tag is appended by the browser)
    const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), iv.length);
    return _CIPHER_PREFIX + _uint8ToBase64(combined);
  },

  /**
   * Decrypt a ciphertext string produced by encrypt().
   * Expects "enc:v1:<base64(IV || ciphertext)>" format.
   */
  async decrypt(ciphertext, masterKey) {
    if (!ciphertext.startsWith(_CIPHER_PREFIX)) {
      throw new Error('CryptoEngine.decrypt: not an encrypted string');
    }
    const b64 = ciphertext.slice(_CIPHER_PREFIX.length);
    const combined = _base64ToUint8(b64);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      data
    );
    return new TextDecoder().decode(plainBuf);
  },

  /** Check whether a string is encrypted (starts with the cipher prefix). */
  isEncrypted(content) {
    return typeof content === 'string' && content.startsWith(_CIPHER_PREFIX);
  },

  // ── Symmetric encryption (binary / attachments) ────────────────────────

  /**
   * Encrypt a Uint8Array. Returns Uint8Array(IV || ciphertext || tag).
   */
  async encryptBytes(data, masterKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      data
    );
    const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), iv.length);
    return combined;
  },

  /**
   * Decrypt a Uint8Array produced by encryptBytes().
   */
  async decryptBytes(combined, masterKey) {
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      data
    );
    return new Uint8Array(plainBuf);
  },

  // ── ECDH key exchange (for device pairing) ─────────────────────────────

  /** Generate an ECDH P-256 key pair for the pairing ceremony. */
  async generateECDHKeyPair() {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // private key not extractable
      ['deriveBits']
    );
  },

  /** Export an ECDH public key as a base64 string (SPKI format). */
  async exportPublicKey(publicKey) {
    const buf = await crypto.subtle.exportKey('spki', publicKey);
    return _uint8ToBase64(new Uint8Array(buf));
  },

  /** Import an ECDH public key from a base64 SPKI string. */
  async importPublicKey(b64) {
    const bytes = _base64ToUint8(b64);
    return crypto.subtle.importKey(
      'spki',
      bytes.buffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
  },

  /**
   * Derive a wrapping key from an ECDH shared secret.
   * Uses deriveBits → HKDF → AES-GCM-256.
   * salt binds the derivation to the specific pairing session so the same
   * shared secret can never unwrap keys across sessions.
   */
  async deriveWrappingKey(privateKey, publicKey, salt) {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256
    );
    const hkdfKey = await crypto.subtle.importKey(
      'raw', sharedBits, 'HKDF', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt instanceof Uint8Array ? salt : new Uint8Array(32),
        info: new TextEncoder().encode('notesapp-pairing-v2')
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  /** SHA-256 hash raw bytes. Returns a Uint8Array(32). */
  async sha256Bytes(bytes) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(buf);
  },

  /**
   * Wrap (encrypt) a master key with a wrapping key derived from ECDH.
   * Returns base64(IV || encrypted-master-key-bytes).
   */
  async wrapMasterKey(masterKeyBytes, wrappingKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      masterKeyBytes
    );
    const combined = new Uint8Array(iv.length + encBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encBuf), iv.length);
    return _uint8ToBase64(combined);
  },

  /**
   * Unwrap (decrypt) a master key with a wrapping key derived from ECDH.
   * Input: base64 string from wrapMasterKey(). Returns raw master key bytes.
   */
  async unwrapMasterKey(wrappedB64, wrappingKey) {
    const combined = _base64ToUint8(wrappedB64);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const rawBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      data
    );
    return new Uint8Array(rawBuf);
  },

  // ── Pairing code utilities ─────────────────────────────────────────────

  /** Generate a random 6-digit numeric pairing code. */
  generatePairingCode() {
    const arr = crypto.getRandomValues(new Uint32Array(1));
    return String(arr[0] % 1000000).padStart(6, '0');
  },

  /** SHA-256 hash a pairing code. Returns hex string. */
  async hashPairingCode(code) {
    const encoded = new TextEncoder().encode(code);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(hash)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },

  // ── Key backup (passphrase-protected export/import) ────────────────────

  /**
   * Export the master key encrypted with a user-chosen passphrase.
   * Returns a JSON object suitable for saving as a backup file.
   */
  async exportKeyBackup(masterKeyBytes, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      masterKeyBytes
    );
    return {
      version: 1,
      salt: _uint8ToBase64(salt),
      iv: _uint8ToBase64(iv),
      encryptedKey: _uint8ToBase64(new Uint8Array(encBuf))
    };
  },

  /**
   * Import a master key from a passphrase-protected backup.
   * Returns raw master key bytes (Uint8Array).
   */
  async importKeyBackup(backup, passphrase) {
    const salt = _base64ToUint8(backup.salt);
    const iv = _base64ToUint8(backup.iv);
    const encData = _base64ToUint8(backup.encryptedKey);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const rawBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      encData
    );
    return new Uint8Array(rawBuf);
  }
};

// ── Base64 helpers (binary-safe, no padding issues) ──────────────────────

function _uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function _base64ToUint8(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
