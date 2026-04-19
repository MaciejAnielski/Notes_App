// binary.test.js — Tests for web/js/utils/binary.js.
//
// binary.js is a classic script that attaches `window.BinaryUtil`.  We
// evaluate it in the jsdom `window` provided by jest-environment-jsdom so
// the same single-file asset runs here that runs in the browser.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'utils', 'binary.js'), 'utf8');

// Evaluate the module once into the shared jsdom window.
beforeAll(() => {
  // jest-environment-jsdom puts window/document on the global.
  // eslint-disable-next-line no-eval
  eval(SRC);
});

describe('BinaryUtil', () => {
  test('exposes the expected API', () => {
    expect(typeof window.BinaryUtil.uint8ToBase64).toBe('function');
    expect(typeof window.BinaryUtil.base64ToUint8).toBe('function');
    expect(typeof window.BinaryUtil.arrayBufferToBase64).toBe('function');
  });

  test('uint8ToBase64 round-trips through base64ToUint8', () => {
    const input = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const b64 = window.BinaryUtil.uint8ToBase64(input);
    const out = window.BinaryUtil.base64ToUint8(b64);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  test('empty Uint8Array maps to empty string', () => {
    expect(window.BinaryUtil.uint8ToBase64(new Uint8Array(0))).toBe('');
  });

  test('uint8ToBase64 handles the chunk boundary (8192) correctly', () => {
    // 8192 bytes is the chunk size; 8200 forces two chunks so regressions in
    // the loop bounds would show up as a truncated or doubled-up output.
    const n = 8200;
    const input = new Uint8Array(n);
    for (let i = 0; i < n; i++) input[i] = i & 0xff;
    const b64 = window.BinaryUtil.uint8ToBase64(input);
    const out = window.BinaryUtil.base64ToUint8(b64);
    expect(out.length).toBe(n);
    for (let i = 0; i < n; i++) expect(out[i]).toBe(i & 0xff);
  });

  test('arrayBufferToBase64 matches uint8ToBase64 for the same bytes', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    expect(window.BinaryUtil.arrayBufferToBase64(bytes.buffer))
      .toBe(window.BinaryUtil.uint8ToBase64(bytes));
  });

  test('null/undefined Uint8Array yields empty string', () => {
    expect(window.BinaryUtil.uint8ToBase64(null)).toBe('');
    expect(window.BinaryUtil.uint8ToBase64(undefined)).toBe('');
  });

  test('back-compat alias window.arrayBufferToBase64 works', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(typeof window.arrayBufferToBase64).toBe('function');
    expect(window.arrayBufferToBase64(bytes.buffer))
      .toBe(window.BinaryUtil.arrayBufferToBase64(bytes.buffer));
  });
});
