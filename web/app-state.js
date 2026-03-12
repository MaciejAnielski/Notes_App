// app-state.js — Shared state, DOM references, and utility functions.
//
// This module is loaded first and provides the foundation that all other
// modules depend on: DOM element references, application state variables,
// search predicates, formatting helpers, and attachment utilities.

// ── Marked configuration ──────────────────────────────────────────────────
// Disable indented code blocks so indented text renders as normal paragraphs.
// Fenced code blocks (``` ... ```) still work correctly.
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
const backupStatusEl = document.getElementById('last-backup-status');
const panelLists = document.getElementById('panel-lists');
const panelArrow = document.getElementById('panel-arrow');
const panelPin = document.getElementById('panel-pin');
const filesContainer = document.getElementById('files-container');
const todosContainer = document.getElementById('todo-container');
const scheduleContainer = document.getElementById('schedule-container');
const scheduleGrid = document.getElementById('scheduleGrid');
const scheduleDateLabel = document.getElementById('schedule-date-label');
const schedulePrevBtn = document.getElementById('schedule-prev');
const scheduleNextBtn = document.getElementById('schedule-next');

// ── Cached media queries ──────────────────────────────────────────────────
const mobileMediaQuery = window.matchMedia('(max-width: 650px)');
const mobileTouchQuery = window.matchMedia('(hover: none) and (max-width: 650px)');

// ── Application state ─────────────────────────────────────────────────────
let isPreview = false;
let autoSaveTimer = null;
let currentFileName = null;
let linkedNoteChain = [];
// Track the last content that was saved or loaded from storage so we can
// detect whether the user has unsaved edits when a sync event arrives.
let _lastSavedContent = null;

const PROJECTS_NOTE = 'Projects';
const CALENDARS_NOTE = 'Calendars';
const SEASON_ORDER = ['Winter', 'Spring', 'Summer', 'Autumn'];
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
// Cached notes-dir path for desktop — avoids an IPC call on every render.
let _notesDirCache = null;

let scheduleDate = new Date();
let scheduleNowTimer = null;
let peekHideTimer = null;
let isPanelPinned = localStorage.getItem('panel_pinned') === 'true';

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
  localStorage.setItem('linked_chain', JSON.stringify(linkedNoteChain));
}

// ── Status display ────────────────────────────────────────────────────────

// persistent=true: message stays visible until next updateStatus call
function updateStatus(message, success, persistent = false) {
  statusDiv.textContent = toTitleCase(message);
  statusDiv.style.color = success ? 'green' : 'red';
  statusDiv.style.opacity = '1';
  backupStatusEl.style.opacity = '0';
  if (statusTimeout) clearTimeout(statusTimeout);
  if (persistent) {
    statusTimeout = null;
  } else {
    statusTimeout = setTimeout(() => {
      statusDiv.style.opacity = '0';
      backupStatusEl.style.opacity = '1';
    }, 3000);
  }
}

function updateBackupStatus() {
  const el = document.getElementById('last-backup-status');
  if (!el) return;
  const isICloud = !!(window.electronAPI?.notes ||
    (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage?.isICloudEnabled !== false && window.CapacitorNoteStorage));
  const t = localStorage.getItem('last_backup_time');
  const prefix = isICloud ? 'iCloud · ' : '';
  if (!t) { el.textContent = isICloud ? 'Saved to iCloud · Never Backed Up' : 'Never Backed Up'; return; }
  const diff = Date.now() - parseInt(t, 10);
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  let ago;
  if (mins < 1)       ago = 'Just Now';
  else if (mins < 60) ago = `${mins}m Ago`;
  else if (hours < 24) ago = `${hours}h Ago`;
  else                 ago = `${days}d Ago`;
  el.textContent = `${prefix}Last Backup ${ago}`;
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
}

function parseAttachmentRefs(content) {
  const refs = new Map();
  if (!content) return refs;
  const re = /!?\[([^\]]*)\]\(attachment:([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(content)) !== null) refs.set(m[2], m[1]);
  return refs;
}

// ── Search predicates ─────────────────────────────────────────────────────

function normalizeQuotes(str) {
  return str.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
            .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
}

function createSearchPredicate(query, makeTermPredicate) {
  if (!query) return () => true;
  query = normalizeQuotes(query);

  if (!makeTermPredicate) {
    makeTermPredicate = (term) => (n, c) => n.includes(term) || c.includes(term);
  }

  const tokens = query.split(/\s+/).filter(Boolean);
  let index = 0;

  function parseExpression() {
    let left = parseTerm();
    while (tokens[index] && tokens[index].toUpperCase() === 'OR') {
      index++;
      const right = parseTerm();
      const prev = left;
      left = (...args) => prev(...args) || right(...args);
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (tokens[index] && tokens[index].toUpperCase() !== 'OR') {
      if (tokens[index].toUpperCase() === 'AND') {
        index++;
      }
      const right = parseFactor();
      const prev = left;
      left = (...args) => prev(...args) && right(...args);
    }
    return left;
  }

  function parseFactor() {
    if (tokens[index] && tokens[index].toUpperCase() === 'NOT') {
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
  let m = line.match(/>\s*(\d{6})\s+\d{4}\s+\d{4}\s*$/);
  if (m) {
    if (m[1] < todayStr) return 'overdue';
    if (m[1] === todayStr) return 'today';
    return 'future';
  }
  // Multi-day: > YYMMDD YYMMDD (start end)
  m = line.match(/>\s*(\d{6})\s+(\d{6})\s*$/);
  if (m) {
    const endDate = m[2];
    if (endDate < todayStr) return 'overdue';
    if (m[1] <= todayStr && todayStr <= endDate) return 'today';
    return 'future';
  }
  // All-day: > YYMMDD
  m = line.match(/>\s*(\d{6})\s*$/);
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
  const tmp = document.createElement('span');
  tmp.innerHTML = marked.parseInline(text);
  text = tmp.textContent;
  text = text.replace(/[[\]]/g, '');
  return text.trim();
}

function highlightTextInPreview(text, caseSensitive = false, occurrenceIndex = 0) {
  const needle = caseSensitive ? text : text.toLowerCase();
  const elements = previewDiv.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th');
  let seen = 0;
  let lastMatch = null;
  for (const el of elements) {
    const haystack = caseSensitive ? el.textContent : el.textContent.toLowerCase();
    if (haystack.includes(needle)) {
      if (seen === occurrenceIndex) {
        el.classList.add('schedule-highlight');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => el.classList.remove('schedule-highlight'), 2000);
        return;
      }
      lastMatch = el;
      seen++;
    }
  }
  if (lastMatch) {
    lastMatch.classList.add('schedule-highlight');
    lastMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => lastMatch.classList.remove('schedule-highlight'), 2000);
  }
}
