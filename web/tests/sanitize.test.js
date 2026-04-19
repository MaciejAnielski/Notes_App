// sanitize.test.js — XSS battery for web/js/utils/sanitize.js.
//
// sanitize.js uses the browser's DOMParser to parse untrusted HTML into a
// detached document (no scripts run during parsing) and then strips any node
// or attribute that isn't on the allowlist.  These tests verify both the
// positive "safe input round-trips" cases and the negative "known XSS
// payloads are neutered" cases.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'utils', 'sanitize.js'), 'utf8');

beforeAll(() => {
  // eslint-disable-next-line no-eval
  eval(SRC);
});

describe('sanitizeHtml — safe input round-trips', () => {
  test('plain paragraphs with text are preserved', () => {
    const out = window.sanitizeHtml('<p>Hello <strong>world</strong></p>');
    expect(out).toContain('<p>');
    expect(out).toContain('<strong>world</strong>');
  });

  test('ordered and unordered lists are preserved', () => {
    const html = '<ul><li>a</li><li>b</li></ul>';
    expect(window.sanitizeHtml(html)).toContain('<li>a</li>');
  });

  test('tables keep their structural tags', () => {
    const html = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
    const out = window.sanitizeHtml(html);
    expect(out).toContain('<table>');
    expect(out).toContain('<th>');
    expect(out).toContain('<td>');
  });

  test('http(s) links are kept and target=_blank forces rel=noopener', () => {
    const out = window.sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });
});

describe('sanitizeHtml — XSS neutering', () => {
  test('drops <script> tags entirely', () => {
    const out = window.sanitizeHtml('<p>hi</p><script>alert(1)</script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('alert(1)');
  });

  test('drops inline event-handler attributes', () => {
    const out = window.sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toMatch(/onerror/i);
    // src="x" may survive, but onerror must not
    expect(out).not.toContain('alert(1)');
  });

  test('blocks javascript: URIs on anchors', () => {
    const out = window.sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  test('blocks javascript: URIs regardless of case / whitespace', () => {
    const payloads = [
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="  javascript:alert(1)">x</a>',
      '<a href="\tjavascript:alert(1)">x</a>'
    ];
    for (const p of payloads) {
      const out = window.sanitizeHtml(p);
      expect(out.toLowerCase()).not.toContain('javascript:');
    }
  });

  test('blocks vbscript: URIs', () => {
    const out = window.sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>');
    expect(out.toLowerCase()).not.toContain('vbscript:');
  });

  test('blocks data:text/html URIs but allows data:image/*', () => {
    const bad = window.sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(bad.toLowerCase()).not.toContain('data:text/html');
    const good = window.sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(good.toLowerCase()).toContain('data:image/png');
  });

  test('drops <iframe>, <object>, <embed>, <form>, <link>, <meta>, <base>', () => {
    const html = '<iframe src="x"></iframe><object data="x"></object><embed src="x"><form><input></form><link rel="stylesheet" href="x"><meta http-equiv="refresh"><base href="//evil">';
    const out = window.sanitizeHtml(html).toLowerCase();
    for (const tag of ['<iframe', '<object', '<embed', '<form', '<link', '<meta', '<base']) {
      expect(out).not.toContain(tag);
    }
  });

  test('drops inline <style> tags', () => {
    const out = window.sanitizeHtml('<p>hi</p><style>body{display:none}</style>');
    expect(out.toLowerCase()).not.toContain('<style');
  });

  test('sanitizes dangerous style properties on preserved elements', () => {
    const out = window.sanitizeHtml('<p style="background: url(javascript:alert(1))">x</p>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  test('drops svg and math namespaces which can smuggle scripts', () => {
    const out = window.sanitizeHtml('<svg><script>alert(1)</script></svg><math><mi//xlink:href="javascript:1"/></math>');
    expect(out.toLowerCase()).not.toContain('<svg');
    expect(out.toLowerCase()).not.toContain('<math');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  test('non-string input returns empty string', () => {
    expect(window.sanitizeHtml(null)).toBe('');
    expect(window.sanitizeHtml(undefined)).toBe('');
    expect(window.sanitizeHtml(0)).toBe('');
    expect(window.sanitizeHtml({})).toBe('');
  });
});

describe('safeRenderMarkdown / safeRenderMarkdownInline', () => {
  beforeAll(() => {
    // Provide a tiny stub `marked` so the wrappers have something to call.
    // The real marked is loaded from a CDN in the browser; for these tests
    // we only care that the wrappers pipe the output through sanitizeHtml.
    window.marked = {
      parse: (s) => `<p>${s}</p>`,
      parseInline: (s) => s
    };
  });

  test('safeRenderMarkdown passes the marked output through sanitizeHtml', () => {
    const out = window.safeRenderMarkdown('plain text <script>alert(1)</script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).toContain('plain text');
  });

  test('safeRenderMarkdown returns empty string when marked is missing', () => {
    const saved = window.marked;
    window.marked = undefined;
    expect(window.safeRenderMarkdown('anything')).toBe('');
    window.marked = saved;
  });

  test('safeRenderMarkdownInline tolerates null/undefined', () => {
    expect(window.safeRenderMarkdownInline(null)).toBe('');
    expect(window.safeRenderMarkdownInline(undefined)).toBe('');
  });
});
