// sanitize.js — HTML sanitizer for rendered markdown.
//
// Parses marked output with DOMParser into a detached document (no scripts
// execute), walks the tree, and drops anything not on a strict allowlist.
// Exposes window.safeRenderMarkdown / safeRenderMarkdownInline for callers
// that set innerHTML on user-visible surfaces.

'use strict';

const _ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr'
]);

const _GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'dir', 'lang', 'style', 'align']);

const _TAG_ATTRS = {
  a: new Set(['href', 'target', 'rel', 'name']),
  img: new Set(['src', 'alt', 'width', 'height']),
  input: new Set(['type', 'checked', 'disabled']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  details: new Set(['open'])
};

function _isSafeUrl(url) {
  if (!url) return false;
  const trimmed = String(url).trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') ||
      trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return true;
  const s = scheme[1].toLowerCase();
  if (s === 'http' || s === 'https' || s === 'mailto' || s === 'tel') return true;
  if (s === 'data') {
    return /^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp)[;,]/i.test(trimmed);
  }
  return false;
}

function _isSafeStyle(styleStr) {
  if (!styleStr) return true;
  const lower = String(styleStr).toLowerCase();
  if (lower.includes('javascript:')) return false;
  if (lower.includes('vbscript:')) return false;
  if (lower.includes('expression(')) return false;
  if (lower.includes('behavior:')) return false;
  if (lower.includes('@import')) return false;
  if (/url\s*\(/.test(lower)) return false;
  return true;
}

function _sanitizeElement(el) {
  const tag = el.tagName.toLowerCase();
  if (!_ALLOWED_TAGS.has(tag)) {
    // Replace disallowed element with its text content to keep readable output.
    const text = document.createTextNode(el.textContent || '');
    el.replaceWith(text);
    return;
  }
  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type !== 'checkbox') { el.remove(); return; }
  }
  const allowed = _TAG_ATTRS[tag] || null;
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
    const permitted = _GLOBAL_ATTRS.has(name)
      || (allowed && allowed.has(name))
      || name.startsWith('data-')
      || name.startsWith('aria-');
    if (!permitted) { el.removeAttribute(attr.name); continue; }
    if ((name === 'href' || name === 'src') && !_isSafeUrl(value)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style' && !_isSafeStyle(value)) {
      el.removeAttribute(attr.name);
      continue;
    }
  }
  if (tag === 'a' && el.getAttribute('target') === '_blank') {
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

function sanitizeHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    'text/html'
  );
  const body = doc.body;
  body.querySelectorAll(
    'script, style, iframe, object, embed, link, meta, frame, frameset, svg, math, form, base'
  ).forEach(n => n.remove());
  for (const el of Array.from(body.querySelectorAll('*'))) {
    _sanitizeElement(el);
  }
  return body.innerHTML;
}

window.sanitizeHtml = sanitizeHtml;

window.safeRenderMarkdown = function (src) {
  if (typeof marked === 'undefined') return '';
  try {
    return sanitizeHtml(marked.parse(src == null ? '' : String(src)));
  } catch (e) {
    console.warn('[sanitize] render failed:', e);
    return '';
  }
};

window.safeRenderMarkdownInline = function (src) {
  if (typeof marked === 'undefined') return '';
  try {
    return sanitizeHtml(marked.parseInline(src == null ? '' : String(src)));
  } catch (e) {
    console.warn('[sanitize] renderInline failed:', e);
    return '';
  }
};
