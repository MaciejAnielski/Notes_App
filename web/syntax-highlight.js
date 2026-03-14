// syntax-highlight.js — Syntax-highlighted edit mode using transparent overlay.
//
// Layers a <pre> element beneath a transparent <textarea> where both share
// identical CSS metrics (font, size, line-height, padding, white-space, etc.)
// so that the highlight layer stays perfectly in sync with the cursor.
//
// Critical constraint: the highlight spans ONLY set `color` and optionally
// `background-color` — never font-size, font-weight, font-style,
// letter-spacing, or word-spacing, as those alter text metrics and cause
// the cursor to drift out of alignment with the rendered text.

let _highlightPre = null;
let _editorWrapper = null;

// ── Initialise overlay ────────────────────────────────────────────────────

function initSyntaxHighlight() {
  if (!textarea) return;

  // Wrap textarea in a positioned container that takes its flex slot
  const wrapper = document.createElement('div');
  wrapper.id = 'editor-wrapper';
  textarea.parentNode.insertBefore(wrapper, textarea);
  wrapper.appendChild(textarea);

  // Create the highlight layer (sits behind the transparent textarea)
  const pre = document.createElement('pre');
  pre.id = 'editor-highlight';
  pre.setAttribute('aria-hidden', 'true');
  wrapper.insertBefore(pre, textarea);

  _highlightPre = pre;
  _editorWrapper = wrapper;

  // Mirror wrapper visibility whenever textarea's display style changes.
  // This keeps the wrapper (and the pre behind it) hidden in preview mode.
  const visObserver = new MutationObserver(() => {
    const hidden = textarea.style.display === 'none';
    wrapper.style.display = hidden ? 'none' : '';
    if (!hidden) _updateHighlight();
  });
  visObserver.observe(textarea, { attributes: true, attributeFilter: ['style'] });

  // Re-render highlight on every keystroke and sync scroll on every scroll
  textarea.addEventListener('input', _updateHighlight);
  textarea.addEventListener('scroll', _syncScroll);

  // Initial render
  _updateHighlight();
}

// ── Highlight update & scroll sync ───────────────────────────────────────

function _updateHighlight() {
  if (!_highlightPre) return;
  _highlightPre.innerHTML = highlightMarkdown(textarea.value);
}

function _syncScroll() {
  if (!_highlightPre) return;
  _highlightPre.scrollTop  = textarea.scrollTop;
  _highlightPre.scrollLeft = textarea.scrollLeft;
}

// ── HTML escape (raw text → safe HTML) ───────────────────────────────────

function _esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Inline token highlighter ─────────────────────────────────────────────
// Processes a single already-HTML-escaped line.
// Returns the line with <span class="hl-*"> wrappers applied.

function _applyInline(line) {
  // 1. Protect inline code `...` from being processed by other patterns.
  //    Replace each `code` span with a null-byte placeholder.
  const slots = [];
  line = line.replace(/`([^`\n]+)`/g, (_, inner) => {
    const idx = slots.length;
    slots.push(`<span class="hl-code">\`${inner}\`</span>`);
    return `\x00${idx}\x00`;
  });

  // 2. Bold-italic (*** or ___)
  line = line.replace(/\*\*\*([^*\n]+?)\*\*\*/g,
    '<span class="hl-bold-italic">***$1***</span>');
  line = line.replace(/___([^_\n]+?)___/g,
    '<span class="hl-bold-italic">___$1___</span>');

  // 3. Bold (** or __)
  line = line.replace(/\*\*([^*\n]+?)\*\*/g,
    '<span class="hl-bold">**$1**</span>');
  line = line.replace(/__([^_\n]+?)__/g,
    '<span class="hl-bold">__$1__</span>');

  // 4. Italic (* or _ — single, not double)
  line = line.replace(/(?<![*\\])\*([^*\n]+?)\*(?![*])/g,
    '<span class="hl-italic">*$1*</span>');
  line = line.replace(/(?<![_\\])_([^_\n]+?)_(?![_])/g,
    '<span class="hl-italic">_$1_</span>');

  // 5. Strikethrough ~~text~~
  line = line.replace(/~~([^~\n]+?)~~/g,
    '<span class="hl-strike">~~$1~~</span>');

  // 6. Highlight ==text== (custom extension)
  line = line.replace(/==([^=\n]+?)==/g,
    '<span class="hl-highlight">==<span class="hl-highlight-text">$1</span>==</span>');

  // 7. Links [text](url)
  line = line.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g,
    '<span class="hl-link">[$1]($2)</span>');

  // 8. Wiki links [[text]]
  line = line.replace(/\[\[([^\]\n]+)\]\]/g,
    '<span class="hl-wiki">[[$1]]</span>');

  // 9. Unordered list markers at line start (-, *, +)
  line = line.replace(/^(\s*)([-*+])(\s)/,
    '$1<span class="hl-list-marker">$2</span>$3');

  // 10. Ordered list markers at line start (1. / 1))
  line = line.replace(/^(\s*)(\d+[.)])(\s)/,
    '$1<span class="hl-list-marker">$2</span>$3');

  // 11. Schedule syntax at end of line — > YYMMDD [HHMM HHMM | YYMMDD] [@cal]
  //     (the > is HTML-escaped as &gt; at this point)
  line = line.replace(
    /(\s*&gt;\s*\d{6}(?:\s+(?:\d{6}|\d{4}\s+\d{4}))?(?:\s+@\S+)?\s*)$/,
    '<span class="hl-schedule">$1</span>'
  );

  // Restore protected inline code slots
  line = line.replace(/\x00(\d+)\x00/g, (_, i) => slots[+i]);

  return line;
}

// ── Main markdown highlighter ─────────────────────────────────────────────
// Converts raw textarea text → HTML for the highlight pre element.

function highlightMarkdown(rawText) {
  const escaped = _esc(rawText);
  const lines = escaped.split('\n');
  let inFence = false;
  let fenceMarker = '';

  const result = lines.map(line => {
    // ── Fenced code block detection (``` or ~~~) ──
    const fenceMatch = line.match(/^(\s*)(```|~~~)(\S*)(.*)/);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        return `<span class="hl-fence">${line}</span>`;
      } else if (line.trim() === fenceMarker || line.trim().startsWith(fenceMarker) && line.trim().length === fenceMarker.length) {
        inFence = false;
        fenceMarker = '';
        return `<span class="hl-fence">${line}</span>`;
      }
    }
    if (inFence) {
      return `<span class="hl-code-block">${line}</span>`;
    }

    // ── Horizontal rule (--- *** ___) ──
    if (/^(\s*)(---+|\*\*\*+|___+)\s*$/.test(line)) {
      return `<span class="hl-hr">${line}</span>`;
    }

    // ── Headings # through ###### ──
    const hMatch = line.match(/^(#{1,6})(\s|$)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const markerHtml = `<span class="hl-heading-marker">${hMatch[1]}</span>`;
      const rest = _applyInline(line.slice(hMatch[1].length));
      return `<span class="hl-h${level}">${markerHtml}${rest}</span>`;
    }

    // ── Blockquote (> at line start, HTML-escaped as &gt;) ──
    if (/^\s*&gt;/.test(line)) {
      const withMarker = line.replace(
        /^(\s*)(&gt;)(\s*)/,
        '$1<span class="hl-blockquote-marker">$2</span>$3'
      );
      return `<span class="hl-blockquote">${_applyInline(withMarker)}</span>`;
    }

    return _applyInline(line);
  });

  return result.join('\n');
}

// ── Auto-init ─────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSyntaxHighlight);
} else {
  initSyntaxHighlight();
}
