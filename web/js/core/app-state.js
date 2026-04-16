// app-state.js — Shared state, DOM references, and utility functions.
//
// This module is loaded first and provides the foundation that all other
// modules depend on: DOM element references, application state variables,
// search predicates, formatting helpers, and attachment utilities.

// ── Lazy script loader ───────────────────────────────────────────────────
// Used to defer loading of vis-network (graph view only) until needed.
// MathJax and Mermaid are now preloaded in index.html at startup.
const _loadedScripts = new Set();
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (_loadedScripts.has(src)) { resolve(); return; }
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      // Tag exists but hasn't finished loading yet — wait for it.
      existing.addEventListener('load', () => { _loadedScripts.add(src); resolve(); }, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.addEventListener('load', () => { _loadedScripts.add(src); resolve(); }, { once: true });
    s.addEventListener('error', reject, { once: true });
    document.head.appendChild(s);
  });
}

// ── Marked configuration ──────────────────────────────────────────────────
// Disable indented code blocks so indented text renders as normal paragraphs.
// Fenced code blocks (``` ... ```) still work correctly.
if (typeof marked !== 'undefined') {
  marked.use({
    breaks: true,
    tokenizer: {
      code(src) {
        // Suppress the indented code block rule entirely
        const indentedCode = /^(?:(?:    |\t)[^\n]+(?:\n|$))+/;
        if (indentedCode.test(src)) return undefined;
      }
    }
  });
}

// ── DOM element references ────────────────────────────────────────────────
const textarea = document.getElementById('editor');
const previewDiv = document.getElementById('preview');
const toggleViewBtn = document.getElementById('toggle-view');
const newNoteBtn = document.getElementById('new-note');
const downloadAllBtn = document.getElementById('download-all');
const exportNoteBtn = document.getElementById('export-note');
const exportAllHtmlBtn = document.getElementById('export-all-html');
const deleteBtn = document.getElementById('delete-note');
const deleteAllBtn = document.getElementById('delete-all');
const importZipBtn = document.getElementById('import-zip');
const importZipInput = document.getElementById('import-zip-input');
const searchBox = document.getElementById('searchBox');
const searchTasksBox = document.getElementById('searchTasksBox');
const fileList = document.getElementById('fileList');
const todoList = document.getElementById('todoList');
const statusDiv = document.getElementById('status-message');
const deleteSelectedBtn = document.getElementById('delete-selected');
const exportSelectedBtn = document.getElementById('export-selected');
const findBtn = document.getElementById('find-btn');
const panelLists = document.getElementById('panel-lists');
const panelArrow = document.getElementById('panel-arrow');
const panelPin = document.getElementById('panel-pin');
const panelOpenBtn = document.getElementById('panel-open-btn');
const filesContainer = document.getElementById('files-container');
const todosContainer = document.getElementById('todo-container');
const scheduleContainer = document.getElementById('schedule-container');
const scheduleGrid = document.getElementById('scheduleGrid');
const scheduleDateLabel = document.getElementById('schedule-date-label');
const schedulePrevBtn = document.getElementById('schedule-prev');
const scheduleNextBtn = document.getElementById('schedule-next');

// ── Cached media queries ──────────────────────────────────────────────────
// On Electron the window can be narrowed below 650 px without entering mobile
// mode — we always return matches:false so every mobileMediaQuery guard is a
// no-op on desktop.  Only genuine mobile/web builds use real matchMedia.
const _noMQ = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
const mobileMediaQuery = window.electronAPI ? _noMQ : window.matchMedia('(max-width: 650px) and (any-pointer: coarse)');

// ── Application state ─────────────────────────────────────────────────────
let isPreview = false;
let autoSaveTimer = null;
let currentFileName = null;
let linkedNoteChain = [];
// Track the last content that was saved or loaded from storage so we can
// detect whether the user has unsaved edits when a sync event arrives.
let _lastSavedContent = null;
// Track the last content received from remote (distinct from
// _lastSavedContent which tracks what we last *wrote*).  Updated only on
// remote reads, not on local saves.  Lets sync handlers detect that a local
// save hasn't been confirmed by the remote yet, preventing silent overwrites.
let _lastRemoteContent = null;
// Per-note Maps used by the sync watcher to protect notes that are not
// currently open in the editor.  Keyed by note name (same as currentFileName).
//   _perNoteSavedContent  — last content this device wrote for the note
//   _perNoteRemoteContent — last content confirmed as received from remote
// When the two differ, the note has unconfirmed local saves.
// Only populated for notes the user has actually opened on this device.
const _perNoteSavedContent = new Map();
const _perNoteRemoteContent = new Map();
// When the note title is edited, the desired new filename is held here and
// applied only when the user commits (View toggle, note switch, new note).
// This prevents repeated filesystem renames while the user is mid-typing.
let _pendingRename = null;
// Monotonically increasing counter used to detect stale async operations.
// Incremented at the start of each loadNote() call; any async continuation
// that sees a different value knows a newer load has started and should bail.
let _loadNoteGeneration = 0;

const PROJECTS_NOTE = 'Projects';
const CALENDARS_NOTE = 'Settings';
const GRAPH_NOTE = 'Note Graph';
const SEASON_ORDER = ['Winter', 'Spring', 'Summer', 'Autumn'];

// ── Encryption state ─────────────────────────────────────────────────────
// In-memory encryption key and status. The key is loaded from KeyStorage
// during app-init and cleared on tab close (never persisted in JS memory
// beyond the session).
window._encryption = {
  key: null,        // CryptoKey (AES-GCM master key) or null
  enabled: false,   // true if this user has encryption enabled (server record)
  active: false,    // true if key is loaded and NoteStorage is wrapped
  userId: null      // current user ID (for key namespacing)
};
// True when running as a secondary Electron window (opened via Ctrl+Shift+N).
// Secondary windows inherit the primary window's note trail but do not write
// back to the primary's localStorage key, so trail changes in secondary
// windows never affect the primary.
const _isSecondary = new URLSearchParams(window.location.search).get('secondary') === 'true';
if (_isSecondary) {
  document.body.classList.add('secondary-window');

  // Re-derive the full colour palette with a subtly muted background so that
  // every background-coloured surface (toolbar, editor, sidebar, preview, etc.)
  // shifts together harmoniously, while text and accent colours — which are
  // derived from `accent`, not `bg` — remain unchanged.
  // We wrap `applyTheme` so that Settings-triggered theme changes also apply
  // the shift without any extra wiring.
  const _shiftBgForSecondary = bg => {
    const [h, s, l] = _hexToHSL(bg);
    const dark = l < 50;
    // Pull saturation down and nudge lightness so the bg reads as clearly
    // different without becoming an unrelated colour.
    return _hslToHex(h, s * 0.55, l + (dark ? -5 : 5));
  };
  const _origApplyTheme = window.applyTheme;
  window.applyTheme = (bg, accent) => _origApplyTheme(_shiftBgForSecondary(bg), accent);
  // Immediately re-apply so the shift takes effect on the current theme.
  const { background, accent } = getCurrentTheme();
  window.applyTheme(background, accent);
}
// Set to true in secondary windows once the trail has been cleared (new note
// created or a note outside the trail was opened).  After severing, the
// secondary window's trail is fully independent and no longer mirrors the
// primary's linked_chain localStorage key.
let _chainSevered = false;
let projectsViewActive = false;
// Matches all schedule syntax variants:
//   > YYMMDD HHMM HHMM   (timed)
//   > YYMMDD YYMMDD       (multi-day all-day)
//   > YYMMDD              (single all-day)
const SCHEDULE_RE = /\s*>\s*\d{6}(?:\s+(?:\d{6}|\d{4}\s+\d{4}))?(?:\s+@\S+)?\s*$/;

const savedPreview = localStorage.getItem('is_preview') === 'true';
const lastFile = localStorage.getItem('current_file');

let _buttonBusy = false;
let statusTimeout = null;
// Set by the iOS Capacitor block; called by the status-area click handler.
let _forceSyncCallback = null;

let scheduleDate = new Date();
let scheduleNowTimer = null;
let scheduleNeedsScrollToNow = false;
let peekHideTimer = null;
let isPanelPinned = localStorage.getItem('panel_pinned') === 'true';

// ── Helper: measure true visual Y offset of a character position ──────────
// Returns the pixel distance from the top of the textarea's content area to
// the line that contains charOffset, correctly accounting for long lines that
// wrap across multiple visual rows (unlike the naive lineCount * lineHeight
// approach which only counts \n characters).
function getLineScrollY(ta, charOffset) {
  const style = window.getComputedStyle(ta);
  const paddingL = parseFloat(style.paddingLeft) || 0;
  const paddingR = parseFloat(style.paddingRight) || 0;
  const mirror = document.createElement('div');
  mirror.style.cssText =
    'position:absolute;top:0;left:-9999px;visibility:hidden;overflow:hidden;' +
    'white-space:pre-wrap;word-break:break-word;' +
    'width:' + (ta.clientWidth - paddingL - paddingR) + 'px;' +
    'font-family:' + style.fontFamily + ';' +
    'font-size:' + style.fontSize + ';' +
    'font-weight:' + style.fontWeight + ';' +
    'font-style:' + style.fontStyle + ';' +
    'line-height:' + style.lineHeight + ';' +
    'letter-spacing:' + style.letterSpacing + ';';
  mirror.appendChild(document.createTextNode(ta.value.substring(0, charOffset)));
  const caret = document.createElement('span');
  caret.textContent = '\u200b';
  mirror.appendChild(caret);
  document.body.appendChild(mirror);
  const y = caret.offsetTop;
  document.body.removeChild(mirror);
  return y;
}

// ── Helper: close mobile panel overlay ────────────────────────────────────
function closeMobilePanel(panelSide) {
  if (!mobileMediaQuery.matches) return;
  const overlay = document.getElementById('mobile-overlay');
  if (panelSide === 'left') {
    document.getElementById('panel-lists').classList.remove('mobile-open-left');
  } else {
    const rightPanel = document.getElementById('mobile-right-panel');
    if (rightPanel) rightPanel.classList.remove('mobile-open-right');
  }
  if (overlay) overlay.classList.remove('active');
}

// ── Button busy guard ─────────────────────────────────────────────────────
function withBusyGuard(asyncFn) {
  return async function (...args) {
    if (_buttonBusy) return;
    _buttonBusy = true;
    const buttons = document.querySelectorAll('#button-container button, #tools-overflow-row button');
    buttons.forEach(b => b.classList.add('btn-busy'));
    try {
      await asyncFn.apply(this, args);
    } finally {
      _buttonBusy = false;
      buttons.forEach(b => b.classList.remove('btn-busy'));
    }
  };
}

// ── Formatting / utility functions ────────────────────────────────────────

function toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function getFormattedDate() {
  const date = new Date();
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// Format date as YYMMDDHHMMSS for backup/export filenames
function formatTimestamp() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}${hh}${min}${ss}`;
}

function toYYMMDD(d) {
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

function formatScheduleDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function getSeason(mm) {
  const m = parseInt(mm, 10);
  if (m === 12 || m <= 2) return 'Winter';
  if (m <= 5)             return 'Spring';
  if (m <= 8)             return 'Summer';
  return 'Autumn';
}

function saveChain() {
  if (_isSecondary) {
    // Secondary windows keep their chain in memory only — never write to the
    // primary window's localStorage key.  When the chain is cleared, mark it
    // as severed so storage-event mirroring from the primary stops.
    if (linkedNoteChain.length === 0 && !_chainSevered) {
      _chainSevered = true;
    }
    return;
  }
  localStorage.setItem('linked_chain', JSON.stringify(linkedNoteChain));
}

// ── Status display ────────────────────────────────────────────────────────

// Smoothly animate the pill to its new natural width after a content change.
// Only animates when the pill is explicitly visible (style.opacity === '1').
let _pillResizeTimer = null;
// In-flight cross-fade delay for updateStatus content swaps.
let _crossFadeTimer = null;

function _animatePillResize(pillEl, changeFn) {
  if (!pillEl || pillEl.style.opacity !== '1') { changeFn(); return; }

  // Cancel any in-flight width cleanup and reset to natural width before
  // measuring — this prevents stale explicit px values from inflating oldW.
  if (_pillResizeTimer) { clearTimeout(_pillResizeTimer); _pillResizeTimer = null; }
  pillEl.style.width = '';
  void pillEl.offsetWidth; // flush layout so measurement is accurate

  const oldW = pillEl.getBoundingClientRect().width;

  // Lock pill at old width, run the text change, then measure the new natural width.
  pillEl.style.width = oldW + 'px';
  changeFn();
  pillEl.style.width = '';                        // release lock to measure new size
  const newW = pillEl.getBoundingClientRect().width;

  if (Math.abs(newW - oldW) < 1) return;         // no meaningful change, leave width as auto

  // Snap back to old width (already measured), then let CSS transition animate to new.
  pillEl.style.width = oldW + 'px';
  void pillEl.offsetWidth; // force reflow so the browser sees the snap
  pillEl.style.width = newW + 'px';

  _pillResizeTimer = setTimeout(() => {
    pillEl.style.width = '';
    _pillResizeTimer = null;
  }, 280);
}

// persistent=true: message stays visible until next updateStatus call
function updateStatus(message, success, persistent = false) {
  const pillEl = document.getElementById('bottom-status-area');

  // Cancel any in-flight cross-fade and auto-hide timers so a rapid sequence
  // of calls always converges on the latest message without stale side-effects.
  if (_crossFadeTimer) { clearTimeout(_crossFadeTimer); _crossFadeTimer = null; }
  if (statusTimeout)   { clearTimeout(statusTimeout);   statusTimeout   = null; }

  // Remove any active scroll-fade so its !important opacity cannot mask the
  // restore below, then make the pill live so _animatePillResize can see it.
  if (pillEl) { pillEl.classList.remove('scroll-faded'); pillEl.style.opacity = '1'; pillEl.style.pointerEvents = ''; }

  // Inner helper: swap text content, animate pill width, then fade text in.
  // Also schedules the auto-hide timer (unless persistent).
  function applyMessage() {
    _animatePillResize(pillEl, () => {
      statusDiv.textContent = toTitleCase(message);
      statusDiv.style.color = success ? 'var(--success)' : 'var(--error)';
    });
    // Fade text in on the next frame so the browser has committed the new
    // text node and the CSS transition fires cleanly.
    requestAnimationFrame(() => { statusDiv.style.opacity = '1'; });

    if (!persistent) {
      statusTimeout = setTimeout(() => {
        statusDiv.style.opacity = '0';
        if (pillEl) { pillEl.style.opacity = '0'; pillEl.style.pointerEvents = 'none'; }
      }, 3000);
    }
  }

  // Cross-fade when a message is already visible: fade the text out fully
  // first (150 ms — matches #status-message transition in toolbar.css), then
  // swap the content and animate the pill to its new size.  This avoids the
  // brief "empty-pill" artefact of the old double-rAF approach and gives a
  // clear sequential animation: out → resize + in.
  const wasVisible = statusDiv.style.opacity === '1';
  if (wasVisible) {
    statusDiv.style.opacity = '0';
    _crossFadeTimer = setTimeout(() => {
      _crossFadeTimer = null;
      applyMessage();
    }, 150);
  } else {
    applyMessage();
  }
}

// ── Attachment helpers ────────────────────────────────────────────────────

function noteNameToAttachmentDir(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_') + '.attachments';
}

function sanitizeAttachmentName(text) {
  return (text
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()) || 'attachment';
}

function mimeForExtension(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff',
    heic: 'image/heic', heif: 'image/heif',
    pdf: 'application/pdf',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    zip: 'application/zip', txt: 'text/plain',
  };
  return map[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function insertAtCursor(text) {
  const start = textarea.selectionStart;
  const end   = textarea.selectionEnd;
  const before = textarea.value.substring(0, start);
  const after  = textarea.value.substring(end);
  const nl = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  textarea.value = before + nl + text + '\n' + after;
  const pos = start + nl.length + text.length + 1;
  textarea.selectionStart = textarea.selectionEnd = pos;
  textarea.focus();
  // Dispatch input event so syntax highlighting and other listeners update
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

// Module-level regex constants — hoisted out of frequently-called functions.
const _RE_ATTACH_REF    = /!?\[([^\]]*)\]\(attachment:([^)\s]+)\)/g;
const _RE_QUOTE_DOUBLE  = /[\u201C\u201D\u201E\u201F\u2033\u2036]/g;
const _RE_QUOTE_SINGLE  = /[\u2018\u2019\u201A\u201B\u2032\u2035]/g;
const _RE_MATH_BLOCK_AS = /\$\$([^$]+)\$\$/g;
const _RE_MATH_INLINE_AS = /\$([^$\n]+)\$/g;
const _RE_MATH_PAREN_AS  = /\\\((.+?)\\\)/gs;
const _RE_MATH_BRACK_AS  = /\\\[(.+?)\\\]/gs;
const _RE_TS_TIMED    = />\s*(\d{6})\s+\d{4}\s+\d{4}\s*$/;
const _RE_TS_MULTIDAY = />\s*(\d{6})\s+(\d{6})\s*$/;
const _RE_TS_ALLDAY   = />\s*(\d{6})\s*$/;

function parseAttachmentRefs(content) {
  const refs = new Map();
  if (!content) return refs;
  _RE_ATTACH_REF.lastIndex = 0;
  let m;
  while ((m = _RE_ATTACH_REF.exec(content)) !== null) refs.set(m[2], m[1]);
  return refs;
}

// ── Search predicates ─────────────────────────────────────────────────────

function normalizeQuotes(str) {
  return str.replace(_RE_QUOTE_DOUBLE, '"')
            .replace(_RE_QUOTE_SINGLE, "'");
}

function createSearchPredicate(query, makeTermPredicate) {
  if (!query) return () => true;
  query = normalizeQuotes(query);

  if (!makeTermPredicate) {
    makeTermPredicate = (term) => (n, c) => n.includes(term) || c.includes(term);
  }

  // Tokenize by splitting on explicit AND/OR/NOT keywords (word boundaries,
  // case-insensitive). Everything between keywords is a single literal term
  // that may contain spaces — spaces are NOT implicit AND operators.
  const rawParts = query.split(/\b(AND|OR|NOT)\b/i);
  const tokens = [];
  for (const part of rawParts) {
    const up = part.trim().toUpperCase();
    if (up === 'AND' || up === 'OR' || up === 'NOT') {
      tokens.push(up);
    } else {
      const literal = part.trim();
      if (literal) tokens.push(literal);
    }
  }
  if (tokens.length === 0) return () => true;

  let index = 0;

  function parseExpression() {
    let left = parseTerm();
    while (tokens[index] && tokens[index] === 'OR') {
      index++;
      const right = parseTerm();
      const prev = left;
      left = (...args) => prev(...args) || right(...args);
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (tokens[index] && tokens[index] === 'AND') {
      index++;
      const right = parseFactor();
      const prev = left;
      left = (...args) => prev(...args) && right(...args);
    }
    return left;
  }

  function parseFactor() {
    if (tokens[index] && tokens[index] === 'NOT') {
      index++;
      const next = parseFactor();
      return (...args) => !next(...args);
    }
    const token = tokens[index++] || '';
    return makeTermPredicate(token);
  }

  return parseExpression();
}

function makeNoteTermPredicate(token) {
  if (token.startsWith('"') && token.endsWith('"') && token.length > 2) {
    const t = token.slice(1, -1);
    return (n, c) => n.includes(t);
  }
  return (n, c) => n.includes(token) || c.includes(token);
}

const TASK_COLOR_STATUS = {
  red: 'overdue',
  amber: 'today',
  green: 'future',
  grey: 'unscheduled',
  gray: 'unscheduled'
};

function makeTaskTermPredicate(token) {
  if (token.startsWith('"') && token.endsWith('"') && token.length > 2) {
    const t = token.slice(1, -1);
    const status = TASK_COLOR_STATUS[t];
    if (status !== undefined) {
      return (n, c, s) => s === status;
    }
    return (n, c, s) => n.includes(t);
  }
  return (n, c, s) => n.includes(token) || c.includes(token);
}

function getTaskScheduleStatus(line) {
  const todayStr = toYYMMDD(new Date());
  // Timed: > YYMMDD HHMM HHMM
  let m = line.match(_RE_TS_TIMED);
  if (m) {
    if (m[1] < todayStr) return 'overdue';
    if (m[1] === todayStr) return 'today';
    return 'future';
  }
  // Multi-day: > YYMMDD YYMMDD (start end)
  m = line.match(_RE_TS_MULTIDAY);
  if (m) {
    const endDate = m[2];
    if (endDate < todayStr) return 'overdue';
    if (m[1] <= todayStr && todayStr <= endDate) return 'today';
    return 'future';
  }
  // All-day: > YYMMDD
  m = line.match(_RE_TS_ALLDAY);
  if (m) {
    if (m[1] < todayStr) return 'overdue';
    if (m[1] === todayStr) return 'today';
    return 'future';
  }
  return 'unscheduled';
}

function getTaskDotClass(scheduleDateStr) {
  if (!scheduleDateStr) return 'dot-unscheduled';
  const todayStr = toYYMMDD(new Date());
  if (scheduleDateStr < todayStr) return 'dot-overdue';
  if (scheduleDateStr === todayStr) return 'dot-today';
  return 'dot-future';
}

// ── Text helpers used by schedule and search ──────────────────────────────

function stripMarkdownText(text) {
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  text = text.replace(/^#+\s*/, '');
  text = text.replace(/\s*>\s*$/, '');
  text = text.replace(/^\s*[-*+]\s+/, '');
  text = text.replace(/^\s*\d+[.)]\s+/, '');
  // Strip math delimiters so plain-text consumers (notifications, search)
  // receive readable content instead of raw LaTeX syntax.
  text = text.replace(_RE_MATH_BLOCK_AS, '$1');
  text = text.replace(_RE_MATH_INLINE_AS, '$1');
  text = text.replace(_RE_MATH_PAREN_AS, '$1');
  text = text.replace(_RE_MATH_BRACK_AS, '$1');
  const tmp = document.createElement('span');
  tmp.innerHTML = marked.parseInline(text);
  text = tmp.textContent;
  text = text.replace(/[[\]]/g, '');
  return text.trim();
}

// ── Expand collapsed <details> ancestors ─────────────────────────────────
// Opens the given element and all ancestor <details> elements up to previewDiv.
// Used to reveal content that is hidden inside a collapsed heading section.
// Opens all ancestor <details> unconditionally, including autocollapsed ones.
// Toggle-view deliberately does NOT call this — only explicit navigation
// (schedule, task view, find-and-replace) should force sections open.
function expandCollapsedAncestors(el) {
  let node = el;
  while (node && node !== previewDiv) {
    if (node.tagName === 'DETAILS' && !node.open) node.open = true;
    node = node.parentElement;
  }
}

function highlightTextInPreview(text, caseSensitive = false, occurrenceIndex = 0) {
  const needle = caseSensitive ? text : text.toLowerCase();
  const elements = previewDiv.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote');
  let seen = 0;
  let lastMatch = null;
  for (const el of elements) {
    const haystack = caseSensitive ? el.textContent : el.textContent.toLowerCase();
    if (haystack.includes(needle)) {
      if (seen === occurrenceIndex) {
        expandCollapsedAncestors(el);
        el.classList.add('schedule-highlight');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.addEventListener('animationend', () => el.classList.remove('schedule-highlight'), { once: true });
        return;
      }
      lastMatch = el;
      seen++;
    }
  }
  if (lastMatch) {
    expandCollapsedAncestors(lastMatch);
    lastMatch.classList.add('schedule-highlight');
    lastMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });
    lastMatch.addEventListener('animationend', () => lastMatch.classList.remove('schedule-highlight'), { once: true });
  }
}
