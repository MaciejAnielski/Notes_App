// DevicePairing — ECDH key exchange protocol for transferring the master
// encryption key between devices, using Supabase as a temporary relay.
//
// The pairing ceremony:
//   Device A (initiator, has master key):
//     1. Generates ECDH key pair + 6-digit code
//     2. Stores public key + hashed code in Supabase device_pairing table
//     3. Displays code (and QR) to user
//     4. Polls for Device B's public key
//     5. Derives shared secret, wraps master key, uploads
//
//   Device B (joiner, needs master key):
//     1. User enters 6-digit code (or scans QR)
//     2. Generates own ECDH key pair
//     3. Looks up pairing request, submits own public key
//     4. Polls for wrapped master key
//     5. Derives same shared secret, unwraps master key
//     6. Saves to local KeyStorage
//
// Includes a minimal QR code generator (no external dependencies).

'use strict';

window.DevicePairing = {

  /**
   * Initiate a pairing session (Device A — has the master key).
   * @param {CryptoKey} masterKey - the AES-GCM master key to share
   * @param {string} userId - Supabase user ID
   * @returns {{ code: string, qrDataUrl: string, waitForCompletion: () => Promise<void>, cancel: () => void }}
   */
  async initiatePairing(masterKey, userId) {
    const supabase = window._supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');

    // Generate ECDH key pair
    const ecdhKeyPair = await CryptoEngine.generateECDHKeyPair();
    const pubB64 = await CryptoEngine.exportPublicKey(ecdhKeyPair.publicKey);

    // Generate pairing code
    const code = CryptoEngine.generatePairingCode();
    const codeHash = await CryptoEngine.hashPairingCode(code);

    // Insert pairing request
    const { data: row, error } = await supabase.from('device_pairing').insert({
      user_id: userId,
      pairing_code_hash: codeHash,
      initiator_ecdh_public: pubB64,
      status: 'waiting'
    }).select('id').single();

    if (error) throw new Error('Failed to create pairing request: ' + error.message);
    const pairingId = row.id;

    // Generate QR code data URL
    const qrDataUrl = _generateQRDataUrl(code);

    let cancelled = false;

    function cancel() {
      cancelled = true;
      supabase.from('device_pairing')
        .update({ status: 'expired' })
        .eq('id', pairingId)
        .then(() => {});
    }

    async function waitForCompletion() {
      const masterKeyBytes = await CryptoEngine.exportKey(masterKey);

      // Poll for joiner's public key
      for (let i = 0; i < 300; i++) { // 300 × 2s = 10 minutes
        if (cancelled) throw new Error('Pairing cancelled');

        await _sleep(2000);

        const { data } = await supabase.from('device_pairing')
          .select('joiner_ecdh_public, status')
          .eq('id', pairingId)
          .single();

        if (!data || data.status === 'expired') throw new Error('Pairing expired');

        if (data.joiner_ecdh_public && data.status === 'accepted') {
          // Derive shared secret
          const joinerPub = await CryptoEngine.importPublicKey(data.joiner_ecdh_public);
          const wrappingKey = await CryptoEngine.deriveWrappingKey(
            ecdhKeyPair.privateKey, joinerPub
          );

          // Wrap and upload the master key
          const wrappedKey = await CryptoEngine.wrapMasterKey(masterKeyBytes, wrappingKey);
          const { error: updateErr } = await supabase.from('device_pairing')
            .update({ encrypted_master_key: wrappedKey, status: 'completed' })
            .eq('id', pairingId);

          if (updateErr) throw new Error('Failed to upload wrapped key: ' + updateErr.message);

          return; // Done
        }
      }

      throw new Error('Pairing timed out');
    }

    return { code, qrDataUrl, waitForCompletion, cancel };
  },

  /**
   * Join a pairing session (Device B — needs the master key).
   * @param {string} code - 6-digit pairing code
   * @param {string} userId - Supabase user ID
   * @returns {Uint8Array} raw master key bytes
   */
  async joinPairing(code, userId) {
    const supabase = window._supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');

    const codeHash = await CryptoEngine.hashPairingCode(code);

    // Look up pairing request
    const { data: rows, error } = await supabase.from('device_pairing')
      .select('*')
      .eq('pairing_code_hash', codeHash)
      .eq('user_id', userId)
      .eq('status', 'waiting')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw new Error('Lookup failed: ' + error.message);
    if (!rows || rows.length === 0) throw new Error('Invalid or expired pairing code');

    const pairing = rows[0];

    // Generate own ECDH key pair
    const ecdhKeyPair = await CryptoEngine.generateECDHKeyPair();
    const myPubB64 = await CryptoEngine.exportPublicKey(ecdhKeyPair.publicKey);

    // Submit our public key
    const { error: updateErr } = await supabase.from('device_pairing')
      .update({ joiner_ecdh_public: myPubB64, status: 'accepted' })
      .eq('id', pairing.id);

    if (updateErr) throw new Error('Failed to submit public key: ' + updateErr.message);

    // Import initiator's public key
    const initiatorPub = await CryptoEngine.importPublicKey(pairing.initiator_ecdh_public);

    // Poll for the wrapped master key
    for (let i = 0; i < 150; i++) { // 150 × 2s = 5 minutes
      await _sleep(2000);

      const { data } = await supabase.from('device_pairing')
        .select('encrypted_master_key, status')
        .eq('id', pairing.id)
        .single();

      if (!data || data.status === 'expired') throw new Error('Pairing expired');

      if (data.encrypted_master_key && data.status === 'completed') {
        // Derive the same shared secret
        const wrappingKey = await CryptoEngine.deriveWrappingKey(
          ecdhKeyPair.privateKey, initiatorPub
        );

        // Unwrap the master key
        const masterKeyBytes = await CryptoEngine.unwrapMasterKey(
          data.encrypted_master_key, wrappingKey
        );

        // Mark as consumed
        await supabase.from('device_pairing')
          .update({ status: 'consumed' })
          .eq('id', pairing.id)
          .then(() => {});

        return masterKeyBytes;
      }
    }

    throw new Error('Pairing timed out waiting for key');
  },

  // ── Device management ──────────────────────────────────────────────────

  /**
   * Register this device in user_devices.
   */
  async registerDevice(userId) {
    const supabase = window._supabaseClient;
    if (!supabase) return;
    const deviceId = KeyStorage.getDeviceId();
    const deviceName = KeyStorage.getDeviceName();
    await supabase.from('user_devices').upsert({
      user_id: userId,
      device_id: deviceId,
      device_name: deviceName
    }, { onConflict: 'user_id,device_id' }).then(() => {});
  },

  /**
   * List all registered devices for the user.
   */
  async listDevices(userId) {
    const supabase = window._supabaseClient;
    if (!supabase) return [];
    const { data, error } = await supabase.from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) { console.error('[pairing] listDevices error:', error); return []; }
    return data || [];
  },

  /**
   * Remove a device from the registry.
   */
  async removeDevice(userId, deviceId) {
    const supabase = window._supabaseClient;
    if (!supabase) return;
    await supabase.from('user_devices')
      .delete()
      .eq('user_id', userId)
      .eq('device_id', deviceId);
  },

  // ── Encryption metadata ────────────────────────────────────────────────

  /**
   * Check if encryption is enabled for this user (server-side record exists).
   */
  async isEncryptionEnabled(userId) {
    const supabase = window._supabaseClient;
    if (!supabase) return false;
    const { data, error } = await supabase.from('user_encryption')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return false;
    return data !== null;
  },

  /**
   * Mark encryption as enabled for this user.
   */
  async enableEncryption(userId) {
    const supabase = window._supabaseClient;
    if (!supabase) return;
    await supabase.from('user_encryption').upsert({
      user_id: userId,
      encryption_version: 1
    }, { onConflict: 'user_id' });
  },

  // ── Key backup helpers ─────────────────────────────────────────────────

  /**
   * Export the master key as a passphrase-protected backup file.
   * Triggers a browser download of a JSON file.
   */
  async exportKeyBackup(masterKey, passphrase) {
    const rawBytes = await CryptoEngine.exportKey(masterKey);
    const backup = await CryptoEngine.exportKeyBackup(rawBytes, passphrase);
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'notesapp-key-backup.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Import a master key from a backup file.
   * @param {File} file - the JSON backup file
   * @param {string} passphrase
   * @returns {Uint8Array} raw master key bytes
   */
  async importKeyBackup(file, passphrase) {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (backup.version !== 1) throw new Error('Unsupported backup version');
    return CryptoEngine.importKeyBackup(backup, passphrase);
  }
};

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Minimal QR Code Generator ────────────────────────────────────────────
// Generates a QR code as a data URL (PNG via canvas).
// Supports numeric mode for 6-digit codes (very small QR).
// Based on the QR code specification with simplified encoding.

function _generateQRDataUrl(text) {
  const modules = _generateQRModules(text);
  if (!modules) return '';
  const size = modules.length;
  const scale = 6;
  const border = 4;
  const imgSize = (size + border * 2) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = imgSize;
  canvas.height = imgSize;
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, imgSize, imgSize);

  // Draw modules
  ctx.fillStyle = '#000000';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }

  return canvas.toDataURL('image/png');
}

// Minimal QR code encoder — Version 1, Error Correction Level L, Byte mode.
// Sufficient for encoding 6-digit pairing codes.

function _generateQRModules(text) {
  // For simplicity and reliability, use a lookup-table approach for
  // the specific case of short numeric strings (up to 10 chars).
  // This implements a Version 1 (21×21) QR code with EC level M.

  const data = _encodeQRData(text);
  if (!data) return null;

  const size = 21; // Version 1
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  // Place finder patterns
  _placeFinderPattern(modules, reserved, 0, 0);
  _placeFinderPattern(modules, reserved, size - 7, 0);
  _placeFinderPattern(modules, reserved, 0, size - 7);

  // Place timing patterns
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = i % 2 === 0;
    reserved[6][i] = true;
    modules[i][6] = i % 2 === 0;
    reserved[i][6] = true;
  }

  // Dark module
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  // Place data bits
  _placeDataBits(modules, reserved, data, size);

  // Apply mask pattern 0 (checkerboard: (row + col) % 2 === 0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && (y + x) % 2 === 0) {
        modules[y][x] = !modules[y][x];
      }
    }
  }

  // Place format info (mask 0, EC level M = 0)
  // Format info bits for M-0: 101010000010010
  const formatBits = [1,0,1,0,1,0,0,0,0,0,1,0,0,1,0];
  _placeFormatInfo(modules, formatBits, size);

  return modules;
}

function _encodeQRData(text) {
  // Byte mode encoding for Version 1-M (max 14 bytes)
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 14) return null;

  const bits = [];

  // Mode indicator: 0100 (byte mode)
  bits.push(0, 1, 0, 0);

  // Character count (8 bits for Version 1 byte mode)
  for (let i = 7; i >= 0; i--) bits.push((bytes.length >> i) & 1);

  // Data
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  }

  // Terminator (up to 4 zeros)
  const totalDataBits = 128; // Version 1-M: 16 data codewords × 8
  const remaining = totalDataBits - bits.length;
  for (let i = 0; i < Math.min(4, remaining); i++) bits.push(0);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad codewords
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    const pb = padBytes[padIdx % 2];
    for (let i = 7; i >= 0; i--) bits.push((pb >> i) & 1);
    padIdx++;
  }

  // Convert to codewords
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | (bits[i + j] || 0);
    codewords.push(val);
  }

  // Generate EC codewords (10 for Version 1-M)
  const ecCodewords = _generateECCodewords(codewords, 10);

  // Combine and convert back to bits
  const allCodewords = [...codewords, ...ecCodewords];
  const allBits = [];
  for (const cw of allCodewords) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
  }

  return allBits;
}

function _generateECCodewords(data, ecCount) {
  // Reed-Solomon error correction using GF(256)
  const gf256Exp = new Array(256);
  const gf256Log = new Array(256);
  let val = 1;
  for (let i = 0; i < 256; i++) {
    gf256Exp[i] = val;
    gf256Log[val] = i;
    val <<= 1;
    if (val >= 256) val ^= 0x11d;
  }
  gf256Log[0] = undefined;

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return gf256Exp[(gf256Log[a] + gf256Log[b]) % 255];
  }

  // Generator polynomial for ecCount EC codewords
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    const factor = gf256Exp[i];
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], factor);
    }
    gen = newGen;
  }

  // Polynomial division
  const result = new Array(ecCount).fill(0);
  const msg = [...data, ...result];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }

  return msg.slice(data.length);
}

function _placeFinderPattern(modules, reserved, row, col) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const y = row + dy;
      const x = col + dx;
      if (y < 0 || y >= modules.length || x < 0 || x >= modules.length) continue;
      const inOuter = dy === 0 || dy === 6 || dx === 0 || dx === 6;
      const inInner = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
      const inSep = dy === -1 || dy === 7 || dx === -1 || dx === 7;
      modules[y][x] = !inSep && (inOuter || inInner);
      reserved[y][x] = true;
    }
  }
}

function _placeDataBits(modules, reserved, bits, size) {
  let bitIdx = 0;
  let x = size - 1;
  let upward = true;

  while (x >= 0) {
    if (x === 6) { x--; continue; } // skip timing column

    const startY = upward ? size - 1 : 0;
    const endY = upward ? -1 : size;
    const stepY = upward ? -1 : 1;

    for (let y = startY; y !== endY; y += stepY) {
      for (let dx = 0; dx <= 1; dx++) {
        const col = x - dx;
        if (col < 0) continue;
        if (reserved[y][col]) continue;
        if (bitIdx < bits.length) {
          modules[y][col] = bits[bitIdx] === 1;
          bitIdx++;
        }
      }
    }

    x -= 2;
    upward = !upward;
  }
}

function _placeFormatInfo(modules, bits, size) {
  // Around top-left finder pattern
  const positions0 = [
    [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
    [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
  ];
  for (let i = 0; i < 15; i++) {
    const [y, x] = positions0[i];
    modules[y][x] = bits[i] === 1;
  }

  // Bottom-left and top-right
  for (let i = 0; i < 7; i++) {
    modules[size - 1 - i][8] = bits[i] === 1;
  }
  for (let i = 7; i < 15; i++) {
    modules[8][size - 15 + i] = bits[i] === 1;
  }
}
