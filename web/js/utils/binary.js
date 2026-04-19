// binary.js — Shared base64 <-> binary helpers.
//
// Consolidates the chunk-safe Uint8Array ↔ base64 conversions that used to be
// duplicated across crypto-engine, crypto-storage, key-storage and app-state.
// Loaded before any encryption script via index.html.

'use strict';

const _CHUNK = 8192;

function uint8ToBase64(bytes) {
  if (!bytes) return '';
  let binary = '';
  for (let i = 0; i < bytes.length; i += _CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + _CHUNK));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function arrayBufferToBase64(buffer) {
  return uint8ToBase64(new Uint8Array(buffer));
}

window.BinaryUtil = {
  uint8ToBase64,
  base64ToUint8,
  arrayBufferToBase64
};

// Back-compat globals used by older call sites. Keep until all callers switch
// to BinaryUtil.* — they are simple aliases so the single implementation above
// is the only behaviour.
window.arrayBufferToBase64 = arrayBufferToBase64;
