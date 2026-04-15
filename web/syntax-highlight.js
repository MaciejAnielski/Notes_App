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
let _searchMatchIdx = -1;
let _searchMatchLen = 0;
let _searchHighlightTimer = null;

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

  // Re-render highlight on input (debounced to avoid excessive work while
  // typing) and sync scroll position on every scroll event.
  let _highlightTimer = null;
  textarea.addEventListener('input', () => {
    clearTimeout(_highlightTimer);
    _highlightTimer = setTimeout(_updateHighlight, 10);
  });
  textarea.addEventListener('scroll', _syncScroll);

  // Initial render
  _updateHighlight();
}

// ── Highlight update & scroll sync ───────────────────────────────────────

function _updateHighlight() {
  if (!_highlightPre) return;
  _highlightPre.innerHTML = highlightMarkdown(textarea.value);
  if (_searchMatchIdx >= 0 && _searchMatchLen > 0) {
    _applySearchHighlight();
  }
  // Re-inject table row ghost text after every highlight refresh so it survives
  // innerHTML rewrites caused by typing, auto-save, calendar sync, etc.
  if (typeof window._tableGhostApply === 'function') window._tableGhostApply();
}

// Walk the pre's text nodes and wrap the character range in a <mark>.
function _applySearchHighlight() {
  const walker = document.createTreeWalker(_highlightPre, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  const endTarget = _searchMatchIdx + _searchMatchLen;
  let startNode = null, startOff = 0;
  let endNode = null, endOff = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (startNode === null && charCount + len > _searchMatchIdx) {
      startNode = node;
      startOff = _searchMatchIdx - charCount;
    }
    if (startNode !== null && charCount + len >= endTarget) {
      endNode = node;
      endOff = endTarget - charCount;
      break;
    }
    charCount += len;
  }
  if (!startNode || !endNode) return;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const mark = document.createElement('mark');
    mark.className = 'hl-search-match';
    range.surroundContents(mark);
  } catch (_) { /* range spans element boundaries — skip visual mark */ }
}

function _syncScroll() {
  if (!_highlightPre) return;
  // Use CSS transform rather than scrollTop so there is no browser-side
  // clamping when the textarea is scrolled to its maximum position.
  // scrollTop-based sync can be clamped if the pre's scrollHeight is even
  // 1 px shorter than the textarea's, causing cursor/text misalignment at
  // the very bottom of a long note.
  _highlightPre.style.transform =
    'translateY(-' + textarea.scrollTop + 'px) translateX(-' + textarea.scrollLeft + 'px)';
}

// ── HTML escape (raw text → safe HTML) ───────────────────────────────────
// Escapes &, <, > — sufficient for text content inside elements.
// graph-view.js has a separate _escHtml that also escapes " for use in
// HTML attribute values; keeping them file-local avoids load-order coupling.

function _esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Module-level regex constants for _applyInline ────────────────────────
// Defined once at load time rather than being recreated on every keystroke.
const _RE_CODE       = /`([^`\n]+)`/g;
const _RE_BOLD_STAR  = /\*\*\*([^*\n]+?)\*\*\*/g;
const _RE_BOLD_UNDER = /___([^_\n]+?)___/g;
const _RE_BOLD2_STAR = /\*\*([^*\n]+?)\*\*/g;
const _RE_BOLD2_UNDR = /__([^_\n]+?)__/g;
const _RE_ITALIC     = /(?<![*\\])\*([^*\n]+?)\*(?![*])/g;
const _RE_STRIKE     = /~~([^~\n]+?)~~/g;
const _RE_HILITE     = /==([^=\n]+?)==/g;
const _RE_IMAGE      = /!\[([^\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const _RE_LINK       = /\[([^\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const _RE_WIKI       = /\[\[([^\]\n]+)\]\]/g;
const _RE_TASK       = /^(\s*)([-*+]\s\[[ xX]\])(\s)/;
const _RE_ULIST      = /^(\s*)([-*+])(\s)/;
const _RE_OLIST      = /^(\s*)(\d+[.)]|[a-zA-Z][.)])(\s)/;
const _RE_FOOTNOTE   = /\[\^([^\]\n]+)\]/g;
const _RE_SCHEDULE   = /(\s*&gt;\s*\d{6}(?:\s+(?:\d{6}|\d{4}\s+\d{4}))?(?:\s+@\S+)?\s*)$/;
const _RE_SLOT       = /\x00(\d+)\x00/g;
const _RE_TASK_MARKER = /hl-task-marker/;

// ── Inline token highlighter ─────────────────────────────────────────────
// Processes a single already-HTML-escaped line.
// Returns the line with <span class="hl-*"> wrappers applied.

function _applyInline(line) {
  // 1. Protect inline code `...` from being processed by other patterns.
  //    Replace each `code` span with a null-byte placeholder.
  const slots = [];
  line = line.replace(_RE_CODE, (_, inner) => {
    const idx = slots.length;
    slots.push(`<span class="hl-code">\`${inner}\`</span>`);
    return `\x00${idx}\x00`;
  });

  // 2. Bold-italic (*** or ___)
  line = line.replace(_RE_BOLD_STAR,  '<span class="hl-bold-italic">***$1***</span>');
  line = line.replace(_RE_BOLD_UNDER, '<span class="hl-bold-italic">___$1___</span>');

  // 3. Bold (** or __)
  line = line.replace(_RE_BOLD2_STAR, '<span class="hl-bold">**$1**</span>');
  line = line.replace(_RE_BOLD2_UNDR, '<span class="hl-bold">__$1__</span>');

  // 4. Italic — asterisks only (* text *), not underscores
  // Underscores no longer trigger italic emphasis
  line = line.replace(_RE_ITALIC, '<span class="hl-italic">*$1*</span>');

  // 5. Strikethrough ~~text~~
  line = line.replace(_RE_STRIKE, '<span class="hl-strike">~~$1~~</span>');

  // 6. Highlight ==text== (custom extension)
  line = line.replace(_RE_HILITE,
    '<span class="hl-highlight">==<span class="hl-highlight-text">$1</span>==</span>');

  // 7. Image syntax ![alt](url) — must come before links to avoid partial match
  // URL group allows one level of balanced parentheses (e.g. Wikipedia URLs).
  line = line.replace(_RE_IMAGE, '<span class="hl-image">![$1]($2)</span>');

  // 8. Links [text](url)
  // URL group allows one level of balanced parentheses (e.g. Wikipedia URLs).
  line = line.replace(_RE_LINK, '<span class="hl-link">[$1]($2)</span>');

  // 9. Wiki links [[text]]
  line = line.replace(_RE_WIKI, '<span class="hl-wiki">[[$1]]</span>');

  // 10. Task list checkboxes: - [ ] or - [x] — highlight full marker including checkbox
  line = line.replace(_RE_TASK, '$1<span class="hl-task-marker">$2</span>$3');

  // 11. Unordered list markers at line start (-, *, +) — skip if already handled as task
  if (!_RE_TASK_MARKER.test(line)) {
    line = line.replace(_RE_ULIST, '$1<span class="hl-list-marker">$2</span>$3');
  }

  // 12. Ordered list markers at line start (1. / 1)) and lettered (a. / a))
  line = line.replace(_RE_OLIST, '$1<span class="hl-list-marker">$2</span>$3');

  // 13. Footnote references [^id]
  line = line.replace(_RE_FOOTNOTE, '<span class="hl-footnote">[^$1]</span>');

  // 14. Schedule syntax at end of line — > YYMMDD [HHMM HHMM | YYMMDD] [@cal]
  //     (the > is HTML-escaped as &gt; at this point)
  line = line.replace(_RE_SCHEDULE, '<span class="hl-schedule">$1</span>');

  // Restore protected inline code slots
  line = line.replace(_RE_SLOT, (_, i) => slots[+i]);

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
      } else if (line.trim() === fenceMarker) {
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

    // ── Footnote definition [^id]: text ──
    const fnDefMatch = line.match(/^(\[\^[^\]\n]+\]:)(\s.*)?$/);
    if (fnDefMatch) {
      const marker = `<span class="hl-footnote">${fnDefMatch[1]}</span>`;
      const rest = fnDefMatch[2] ? _applyInline(fnDefMatch[2]) : '';
      return `${marker}${rest}`;
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

// ── Public API ────────────────────────────────────────────────────────────

// Call after programmatically setting textarea.value to keep the highlight
// layer in sync (e.g. when loading a different note in edit mode).
function refreshHighlight() {
  _updateHighlight();
  _syncScroll();
}

// Briefly highlights the matched text in the pre layer (edit mode).
// charIndex/length are character offsets into textarea.value.
function flashSearchHighlight(charIndex, length) {
  clearTimeout(_searchHighlightTimer);
  _searchMatchIdx = charIndex;
  _searchMatchLen = length;
  _updateHighlight();
  _searchHighlightTimer = setTimeout(() => {
    _searchMatchIdx = -1;
    _searchMatchLen = 0;
    _updateHighlight();
  }, 2000);
}

// ── Auto-init ─────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSyntaxHighlight);
} else {
  initSyntaxHighlight();
}
