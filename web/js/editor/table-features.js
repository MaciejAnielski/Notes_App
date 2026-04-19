// table-features.js — Markdown table display enhancements and editor autofill.
//
// Display features (called from markdown-renderer.js after rendering):
//   alignTableColumns, wrapTablesForScroll, setupTableFeatures
// Source cleanup (called from markdown-renderer.js on view toggle):
//   _cleanupMarkdownTables, _saveAllTableSorts
// Editor autofill (attaches to textarea directly, requires textarea + _highlightPre globals):
//   Table row autofill suggestion block
//
// Globals used: textarea, _highlightPre, _lastRenderedContent, currentFileName, updateStatus
// Load order: after app-init.js (which defines textarea)

function alignTableColumns(container) {
  container.querySelectorAll('table').forEach(table => {
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    if (bodyRows.length === 0) return;

    const firstRow = bodyRows[0];
    const firstCells = Array.from(firstRow.querySelectorAll('td'));
    const headerCells = Array.from(table.querySelectorAll('thead tr th'));

    firstCells.forEach((cell, colIndex) => {
      const th = headerCells[colIndex];
      // Honor explicit markdown alignment emitted by marked as <th align="..."> /
      // <td align="..."> — only fall back to the numeric heuristic when no
      // alignment was specified in the source separator row.
      const explicit = th?.getAttribute('align') || cell.getAttribute('align');

      let align;
      if (explicit) {
        align = explicit;
      } else {
        const text = cell.textContent.trim();
        const cleaned = text.replace(/[,$€£¥%+ ]/g, '');
        const numeric = cleaned !== '' && !isNaN(Number(cleaned));
        align = numeric ? 'right' : 'left';
      }

      bodyRows.forEach(row => {
        const td = row.querySelectorAll('td')[colIndex];
        if (td) td.style.textAlign = align;
      });
      if (th) th.style.textAlign = align;
    });
  });
}

// Wrap every table in a scrollable div so wide tables scroll horizontally
// instead of overflowing, and so the pinned sidebar is accounted for
// (the wrapper's max-width is constrained by the body width automatically).
function wrapTablesForScroll(container) {
  container.querySelectorAll('table').forEach(table => {
    if (table.parentElement?.classList.contains('table-wrapper')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

// On desktop browsers a vertical wheel event bubbles past .table-wrapper
// (which only has overflow-x) and scrolls #preview vertically instead.
// Intercept wheel events over overflowing wrappers and redirect them to
// horizontal scroll — mirrors the same pattern used for MathJax in math-eval.js.
function setupTableWheelScroll() {
  const LINE_HEIGHT_PX = 40;
  previewDiv.addEventListener('wheel', (e) => {
    const wrapper = e.target.closest('.table-wrapper');
    if (!wrapper) return;
    if (wrapper.scrollWidth <= wrapper.clientWidth) return;
    e.preventDefault();
    const rawDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const normalizedDelta =
      e.deltaMode === 1 ? rawDelta * LINE_HEIGHT_PX :
      e.deltaMode === 2 ? rawDelta * window.innerHeight :
      rawDelta;
    wrapper.scrollLeft += normalizedDelta;
  }, { passive: false });
}

document.addEventListener('DOMContentLoaded', () => {
  setupTableWheelScroll();
});

// ── Table smart features: sorting, filtering, copy ─────────────────────────

// Per-table sort state: maps table element → { colIndex, direction }
// direction: 'default' | 'asc' | 'desc'
const _tableSortState = new WeakMap();

// Shared filter popup element (created once, reused)
let _tableFilterPopup = null;

function _getOrCreateTableFilterPopup() {
  if (!_tableFilterPopup) {
    _tableFilterPopup = document.createElement('div');
    _tableFilterPopup.id = 'table-filter-popup';
    document.body.appendChild(_tableFilterPopup);
    // Dismiss on click outside
    document.addEventListener('mousedown', e => {
      if (_tableFilterPopup && !_tableFilterPopup.contains(e.target)) {
        _tableFilterPopup.style.display = 'none';
      }
    });
  }
  return _tableFilterPopup;
}

// Parse all markdown-format tables from text.
// Returns array of { bodyStartLine, bodyRows } where bodyRows are the
// original source lines for tbody rows (in original order).
function _findMarkdownTables(text) {
  const lines = text.split('\n');
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    // A table starts with a pipe-containing line followed by a separator line
    if (
      i + 1 < lines.length &&
      /^\s*\|/.test(lines[i]) &&
      /^\s*\|[\s\-:|]+\|/.test(lines[i + 1])
    ) {
      const bodyStartLine = i + 2;
      let j = bodyStartLine;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      tables.push({
        bodyStartLine,
        bodyRows: lines.slice(bodyStartLine, j),
      });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

// Normalise markdown table formatting: single-space cell padding, '| - |' separators.
// Called when leaving edit mode so the source is always consistently formatted.
function _cleanupMarkdownTables(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (
      i + 1 < lines.length &&
      /^\s*\|/.test(lines[i]) &&
      /^\s*\|[\s\-:|]+\|/.test(lines[i + 1])
    ) {
      lines[i] = _normalizeTableRow(lines[i]);        // header
      i++;
      lines[i] = _normalizeTableSeparator(lines[i]);  // separator
      i++;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        lines[i] = _normalizeTableRow(lines[i]);       // body
        i++;
      }
    } else {
      i++;
    }
  }
  return lines.join('\n');
}

function _normalizeTableRow(line) {
  const raw = line.trim();
  const cells = raw.slice(1, raw.lastIndexOf('|')).split('|');
  return '|' + cells.map(c => ' ' + c.trim() + ' ').join('|') + '|';
}

function _normalizeTableSeparator(line) {
  const raw = line.trim();
  const cells = raw.slice(1, raw.lastIndexOf('|')).split('|');
  return '|' + cells.map(cell => {
    const t = cell.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':') && t.length > 1;
    if (left && right) return ' :-: ';
    if (right) return ' -: ';
    if (left) return ' :- ';
    return ' - ';
  }).join('|') + '|';
}

// Rewrite textarea.value so that sorted tables are persisted to the markdown source.
// Called only when leaving preview mode (view toggle or note switch) so that
// textarea.value is never modified mid-session — the original markdown rows
// remain available as the stable reference, meaning cycling back to 'default'
// always restores exactly the original order.
// _lastRenderedContent is also updated so the render cache stays valid.
// The actual NoteStorage write is left to the caller's existing save-on-navigate
// / auto-save logic (loadNote, toggleView) to avoid double-writes.
function _saveAllTableSorts(container) {
  if (!currentFileName) return;

  const tables = Array.from(container.querySelectorAll('table'));
  const mdTables = _findMarkdownTables(textarea.value);
  if (tables.length !== mdTables.length) return;

  const lines = textarea.value.split('\n');
  let changed = false;

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const mdTable = mdTables[i];
    const tbody = table.querySelector('tbody');
    if (!tbody) continue;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    const origIndices = rows.map(tr => Number(tr.dataset.origRow));
    const isDefault = origIndices.every((v, idx) => v === idx);
    if (isDefault) continue;

    // Replace body lines in the markdown with the new (sorted) order
    const newBodyLines = origIndices.map(idx => mdTable.bodyRows[idx]);
    for (let j = 0; j < newBodyLines.length; j++) {
      lines[mdTable.bodyStartLine + j] = newBodyLines[j];
    }
    changed = true;
  }

  if (changed) {
    const newText = lines.join('\n');
    textarea.value = newText;
    _lastRenderedContent = newText;
    // Reset data-origRow on every processed table so the saved order becomes
    // the new "default". This makes _saveAllTableSorts idempotent: a second
    // call (e.g. from toggleView after newNote already flushed) is a no-op.
    tables.forEach(table => {
      Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
        tr.dataset.origRow = String(i);
      });
      _tableSortState.delete(table);
    });
  }
}

function _applyTableFilter(table, colIndex, value) {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
    const td = tr.querySelectorAll('td')[colIndex];
    const cellText = td ? td.textContent.trim() : '';
    tr.style.display = cellText === value ? '' : 'none';
  });
}

function _updateSortIndicators(ths, activeCol, direction) {
  ths.forEach((th, i) => {
    let ind = th.querySelector('.sort-indicator');
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'sort-indicator';
      th.appendChild(ind);
    }
    if (i === activeCol && direction !== 'default') {
      ind.textContent = direction === 'asc' ? ' ▲' : ' ▼';
    } else {
      ind.textContent = '';
    }
  });
}

function _applyTableSort(table, colIndex, direction) {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));

  if (direction === 'default') {
    rows.sort((a, b) => Number(a.dataset.origRow) - Number(b.dataset.origRow));
  } else {
    rows.sort((a, b) => {
      const aCell = a.querySelectorAll('td')[colIndex];
      const bCell = b.querySelectorAll('td')[colIndex];
      const aText = aCell ? aCell.textContent.trim() : '';
      const bText = bCell ? bCell.textContent.trim() : '';
      const clean = s => s.replace(/[,$€£¥%+\s]/g, '');
      const aNum = Number(clean(aText));
      const bNum = Number(clean(bText));
      const bothNum = aText !== '' && bText !== '' && !isNaN(aNum) && !isNaN(bNum);
      const cmp = bothNum ? aNum - bNum : aText.localeCompare(bText);
      return direction === 'asc' ? cmp : -cmp;
    });
  }

  rows.forEach(tr => tbody.appendChild(tr));

  // Re-apply active column filter after sort (to keep hidden rows hidden)
  if (table._filterState) {
    _applyTableFilter(table, table._filterState.colIndex, table._filterState.value);
  }
}

function setupTableFeatures(container) {
  container.querySelectorAll('table').forEach(table => {
    // Tag each tbody row with its original (pre-sort) index
    Array.from(table.querySelectorAll('tbody tr')).forEach((tr, i) => {
      tr.dataset.origRow = String(i);
    });

    const ths = Array.from(table.querySelectorAll('thead tr th'));

    // ── Sorting: click on header ──────────────────────────────────────────
    ths.forEach((th, colIndex) => {
      th.classList.add('sortable-header');

      let _ptrDownX = 0, _ptrDownY = 0, _isDrag = false;

      th.addEventListener('mousedown', e => {
        _ptrDownX = e.clientX;
        _ptrDownY = e.clientY;
        _isDrag = false;
      });
      th.addEventListener('mousemove', e => {
        if (Math.abs(e.clientX - _ptrDownX) > 5 || Math.abs(e.clientY - _ptrDownY) > 5) {
          _isDrag = true;
        }
      });
      th.addEventListener('click', e => {
        // Don't sort when the user was click-dragging to select text
        if (_isDrag) return;
        const sel = window.getSelection ? window.getSelection().toString() : '';
        if (sel.length > 0) return;

        const state = _tableSortState.get(table) || { colIndex: -1, direction: 'default' };
        let newDir;
        if (state.colIndex !== colIndex || state.direction === 'default') {
          newDir = 'asc';
        } else if (state.direction === 'asc') {
          newDir = 'desc';
        } else {
          newDir = 'default';
        }

        _tableSortState.set(table, { colIndex, direction: newDir });
        _applyTableSort(table, colIndex, newDir);
        _updateSortIndicators(ths, colIndex, newDir);
      });
    });

    // ── Filter: right-click (or long-press) on header ────────────────────
    const _showFilterPopup = (th, colIndex, clientX, clientY, e) => {
      e.preventDefault();
      e.stopPropagation();

      const tbody = table.querySelector('tbody');
      if (!tbody) return;

      // Collect unique non-empty cell values for this column
      const allRows = Array.from(tbody.querySelectorAll('tr'));
      const values = new Set();
      allRows.forEach(tr => {
        const td = tr.querySelectorAll('td')[colIndex];
        if (td) {
          const v = td.textContent.trim();
          if (v) values.add(v);
        }
      });

      const popup = _getOrCreateTableFilterPopup();
      popup.innerHTML = '';

      const activeVal = table._filterState?.colIndex === colIndex
        ? table._filterState.value : null;

      // "All" clears the filter
      const allItem = document.createElement('div');
      allItem.className = 'wikilink-item' + (activeVal === null ? ' wikilink-item-active' : '');
      allItem.textContent = 'All';
      allItem.addEventListener('mousedown', ev => {
        ev.preventDefault();
        table._filterState = null;
        allRows.forEach(tr => { tr.style.display = ''; });
        popup.style.display = 'none';
      });
      popup.appendChild(allItem);

      // Sorted unique values
      Array.from(values).sort((a, b) => a.localeCompare(b)).forEach(val => {
        const item = document.createElement('div');
        item.className = 'wikilink-item' + (activeVal === val ? ' wikilink-item-active' : '');
        item.textContent = val;
        item.addEventListener('mousedown', ev => {
          ev.preventDefault();
          table._filterState = { colIndex, value: val };
          _applyTableFilter(table, colIndex, val);
          popup.style.display = 'none';
        });
        popup.appendChild(item);
      });

      // Position near the header cell
      popup.style.display = 'block';
      const popupW = popup.offsetWidth || 200;
      let left = clientX;
      let top = clientY + 4;
      if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
      if (left < 4) left = 4;
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    };

    ths.forEach((th, colIndex) => {
      // Desktop: contextmenu (right-click)
      th.addEventListener('contextmenu', e => {
        _showFilterPopup(th, colIndex, e.clientX, e.clientY, e);
      });

      // Prevent text-selection UI on long-press (mobile)
      th.addEventListener('selectstart', e => e.preventDefault());

      // Mobile: long-press (~500 ms)
      let _lpTimer = null;
      th.addEventListener('touchstart', e => {
        const t = e.touches[0];
        _lpTimer = setTimeout(() => {
          _lpTimer = null;
          _showFilterPopup(th, colIndex, t.clientX, t.clientY, e);
        }, 500);
      }, { passive: false });
      th.addEventListener('touchend', () => { clearTimeout(_lpTimer); _lpTimer = null; }, { passive: true });
      th.addEventListener('touchmove', () => { clearTimeout(_lpTimer); _lpTimer = null; }, { passive: true });
    });

    // ── Copy table: right-click (or long-press) on any body cell ─────────
    const _copyTable = e => {
      e.preventDefault();
      e.stopPropagation();

      // Build tab-separated text (header + visible body rows)
      const rows = [];

      // Header row — strip sort indicator text
      if (ths.length > 0) {
        rows.push(
          ths.map(th => {
            const ind = th.querySelector('.sort-indicator');
            return ind
              ? th.textContent.replace(ind.textContent, '').trim()
              : th.textContent.trim();
          }).join('\t')
        );
      }

      // Visible body rows
      Array.from(table.querySelectorAll('tbody tr')).forEach(tr => {
        if (tr.style.display === 'none') return;
        rows.push(
          Array.from(tr.querySelectorAll('td'))
            .map(td => td.textContent.trim())
            .join('\t')
        );
      });

      const text = rows.join('\n');
      // Glow the table element directly so the animation follows the table
      // border, not the wider scrollable wrapper div.
      const _glowTarget = table;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          _tableCopyGlow(_glowTarget);
          updateStatus('Table copied to clipboard.', true);
        }).catch(() => {
          _fallbackCopy(text, _glowTarget);
        });
      } else {
        _fallbackCopy(text, _glowTarget);
      }
    };

    Array.from(table.querySelectorAll('tbody td')).forEach(td => {
      td.addEventListener('contextmenu', _copyTable);

      // Mobile long-press
      let _lpTimer = null;
      td.addEventListener('touchstart', () => {
        _lpTimer = setTimeout(() => { _lpTimer = null; _copyTable({ preventDefault() {}, stopPropagation() {} }); }, 500);
      }, { passive: true });
      td.addEventListener('touchend', () => { clearTimeout(_lpTimer); _lpTimer = null; }, { passive: true });
      td.addEventListener('touchmove', () => { clearTimeout(_lpTimer); _lpTimer = null; }, { passive: true });
    });
  });
}

function _tableCopyGlow(table) {
  const el = table;
  if (!el) return;
  el.classList.remove('copy-float');
  void el.offsetWidth;
  el.classList.add('copy-float');
  el.addEventListener('animationend', () => el.classList.remove('copy-float'), { once: true });
}

function _fallbackCopy(text, glowTarget) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    _tableCopyGlow(glowTarget);
    updateStatus('Table copied to clipboard.', true);
  } catch { /* ignore */ }
  document.body.removeChild(ta);
}

// ── Table row autofill suggestion ────────────────────────────────────────
// Shows a faded ghost-text suggestion for the predicted next table row when
// the user types "|" as the first character of a new line immediately below
// a markdown table with ≥ 2 body rows.  Enter accepts; any other key dismisses.
// Ghost text is injected directly into #editor-highlight (the syntax-highlight
// pre) so it appears inline at the exact cursor position with no floating div.
{
  let _trSuggestion  = null; // full predicted row string, e.g. "| 3 | 2024-01-03 |"
  let _ghostInsertPos = null; // char offset in textarea where ghost text starts
  let _ghostText     = '';   // the ghost string currently shown in the pre

  // Remove the ghost span from the pre.  Synchronous — safe to call in input handler.
  function _trHide() {
    if (typeof _highlightPre !== 'undefined' && _highlightPre) {
      _highlightPre.querySelectorAll('.table-ghost-text').forEach(s => {
        while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s);
        s.parentNode.removeChild(s);
      });
    }
    _ghostInsertPos = null;
    _ghostText      = '';
    _trSuggestion   = null;
  }

  // Inject a .table-ghost-text span into the pre at _ghostInsertPos.
  // Called ~15 ms after the input event so the 10 ms syntax-highlight debounce
  // has already updated the pre with the current textarea content.
  function _applyGhostToPre() {
    if (_ghostInsertPos === null || typeof _highlightPre === 'undefined' || !_highlightPre) return;
    // Remove any stale ghost span.
    _highlightPre.querySelectorAll('.table-ghost-text').forEach(s => {
      while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s);
      s.parentNode.removeChild(s);
    });
    // Walk text nodes to find the character offset.
    const walker = document.createTreeWalker(_highlightPre, NodeFilter.SHOW_TEXT);
    let remaining = _ghostInsertPos;
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (remaining <= textNode.length) {
        const span = document.createElement('span');
        span.className = 'table-ghost-text';
        span.textContent = _ghostText;
        if (remaining === 0) {
          textNode.parentNode.insertBefore(span, textNode);
        } else if (remaining === textNode.length) {
          textNode.parentNode.insertBefore(span, textNode.nextSibling);
        } else {
          const after = textNode.splitText(remaining);
          textNode.parentNode.insertBefore(span, after);
        }
        return;
      }
      remaining -= textNode.length;
    }
    // Cursor is past all text nodes (end of document) — append.
    const span = document.createElement('span');
    span.className = 'table-ghost-text';
    span.textContent = _ghostText;
    _highlightPre.appendChild(span);
  }

  // Show a suggestion: schedule injection after 50 ms so the syntax-highlight
  // debounce (10 ms) reliably completes first, avoiding a race where the pre
  // innerHTML is rewritten after the ghost span is already injected.
  function _trShow(pos, suggestion) {
    _trHide();
    _trSuggestion   = suggestion;
    _ghostInsertPos = pos;
    _ghostText      = suggestion.slice(1); // everything after the '|' already typed
    setTimeout(_applyGhostToPre, 50);
  }

  // ── Date / number helpers ────────────────────────────────────────────────

  const _MONTHS_FULL  = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
  const _MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                          'Jul','Aug','Sep','Oct','Nov','Dec'];
  const _DAYS_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const _DAYS_FULL    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function _ordinalSuffix(n) {
    const s = n % 100;
    if (s >= 11 && s <= 13) return 'th';
    return ['th','st','nd','rd','th'][Math.min(n % 10, 4)];
  }

  // Convert unicode subscript digit string → integer
  function _subToNum(s) {
    return parseInt(s.replace(/[\u2080-\u2089]/g, c => c.charCodeAt(0) - 0x2080), 10);
  }
  // Convert integer → unicode subscript digit string
  function _numToSub(n) {
    return String(n).replace(/\d/g, d => String.fromCharCode(0x2080 + +d));
  }

  // Try to parse an ordinal-day-month string like "Mon 1st April", "Wednesday 2nd March 2025".
  // Returns a Date if successful, null otherwise.  Also returns style flags for formatting.
  function _parseOrdinalDate(v) {
    // Optional day-of-week (3-char short or full name), day+ordinal, month, optional year
    const re = /^(?:([A-Za-z]{3,9})\s+)?(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+?)(?:,?\s*(\d{4}))?$/;
    const m = v.match(re);
    if (!m) return null;
    const [, dow, dayStr, monthStr, yearStr] = m;
    const day = parseInt(dayStr, 10);
    const monthFull  = _MONTHS_FULL.findIndex(mo => mo.toLowerCase() === monthStr.toLowerCase());
    const monthShort = _MONTHS_SHORT.findIndex(mo => mo.toLowerCase() === monthStr.toLowerCase());
    const monthIdx   = monthFull >= 0 ? monthFull : monthShort;
    if (monthIdx < 0) return null;
    // Validate day-of-week string if provided (must be a recognised short or full name)
    let shortDow = false;
    if (dow) {
      const dowLower = dow.toLowerCase();
      const isShort = _DAYS_SHORT.some(d => d.toLowerCase() === dowLower);
      const isFull  = _DAYS_FULL.some(d => d.toLowerCase() === dowLower);
      if (!isShort && !isFull) return null;
      shortDow = isShort;
    }
    const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
    const date = new Date(year, monthIdx, day);
    if (isNaN(date.getTime())) return null;
    return {
      date,
      hasDow:     !!dow,
      shortDow,
      shortMonth: monthFull < 0,
      hasYear:    !!yearStr,
    };
  }

  function _formatOrdinalDate(date, style) {
    const day      = date.getDate();
    const monthIdx = date.getMonth();
    const parts    = [];
    if (style.hasDow) parts.push(style.shortDow ? _DAYS_SHORT[date.getDay()] : _DAYS_FULL[date.getDay()]);
    parts.push(day + _ordinalSuffix(day));
    parts.push(style.shortMonth ? _MONTHS_SHORT[monthIdx] : _MONTHS_FULL[monthIdx]);
    if (style.hasYear)  parts.push(String(date.getFullYear()));
    return parts.join(' ');
  }

  // ── Per-cell pattern prediction ──────────────────────────────────────────

  function _predictCell(values) {
    if (values.length < 2) return values[values.length - 1] || '';
    const last = values[values.length - 1];

    // Returns the modal (most common) consecutive difference, or null if no clear trend.
    // With only 1 diff (2 values) always returns that diff.
    // With multiple diffs requires ≥ 2 occurrences to avoid arbitrary guesses.
    function _modalDiff(nums) {
      if (nums.length < 2) return null;
      const diffs = [];
      for (let i = 1; i < nums.length; i++) diffs.push(nums[i] - nums[i - 1]);
      if (diffs.every(d => d === 0)) return null;
      const freq = {};
      let maxFreq = 0, mode = null;
      for (const d of diffs) {
        freq[d] = (freq[d] || 0) + 1;
        if (freq[d] > maxFreq) { maxFreq = freq[d]; mode = d; }
      }
      // Single diff: no ambiguity.  Multiple diffs: require ≥ 2 occurrences of mode.
      if (diffs.length > 1 && maxFreq < 2) return null;
      return mode;
    }

    // Advance a Date past any Saturday/Sunday (for weekday-only sequences).
    function _skipWeekend(d) {
      while (d.getDay() === 0 || d.getDay() === 6) d = new Date(d.getTime() + 86400000);
      return d;
    }
    function _allWeekdays(mss) {
      return mss.every(ms => { const d = new Date(ms).getDay(); return d !== 0 && d !== 6; });
    }

    // 1. ISO date YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(last)) {
      const dates = values.map(v => new Date(v).getTime());
      if (dates.every(d => !isNaN(d))) {
        const diff = _modalDiff(dates);
        if (diff !== null) {
          let next = new Date(dates[dates.length - 1] + diff);
          if (_allWeekdays(dates)) next = _skipWeekend(next);
          return next.toISOString().slice(0, 10);
        }
      }
    }

    // 2. Compact date YYMMDD (6 digits) or YYYYMMDD (8 digits)
    const compactRe = /^(\d{2}|\d{4})(\d{2})(\d{2})$/;
    if (compactRe.test(last) && values.every(v => compactRe.test(v))) {
      const toMs = v => {
        const [, yr, mo, dy] = v.match(compactRe);
        const moNum = parseInt(mo, 10);
        const dyNum = parseInt(dy, 10);
        if (moNum < 1 || moNum > 12 || dyNum < 1 || dyNum > 31) return NaN;
        const fullYear = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
        return new Date(fullYear, moNum - 1, dyNum).getTime();
      };
      const mss = values.map(toMs);
      if (mss.every(ms => !isNaN(ms))) {
        const diff = _modalDiff(mss);
        if (diff !== null) {
          let next = new Date(mss[mss.length - 1] + diff);
          if (_allWeekdays(mss)) next = _skipWeekend(next);
          const yLen = last.length === 6 ? 2 : 4;
          const yr   = yLen === 2 ? String(next.getFullYear()).slice(-2) : String(next.getFullYear());
          const mo   = String(next.getMonth() + 1).padStart(2, '0');
          const dy   = String(next.getDate()).padStart(2, '0');
          return yr + mo + dy;
        }
      }
    }

    // 3. Ordinal day-month: "Mon 1st April", "1st Apr", "Wednesday 2nd March 2025" etc.
    const ordParsed = values.map(_parseOrdinalDate);
    if (ordParsed.every(p => p !== null)) {
      const mss = ordParsed.map(p => p.date.getTime());
      const diff = _modalDiff(mss);
      if (diff !== null) {
        let next = new Date(mss[mss.length - 1] + diff);
        if (_allWeekdays(mss)) next = _skipWeekend(next);
        return _formatOrdinalDate(next, ordParsed[ordParsed.length - 1]);
      }
    }

    // 4. Slash date DD/MM/YYYY or MM/DD/YYYY
    const slashRe = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    if (slashRe.test(last) && values.every(v => slashRe.test(v))) {
      const [, a0] = values[0].match(slashRe);
      const isDMY = parseInt(a0, 10) > 12;
      const toMs = v => {
        const [, a, b, y] = v.match(slashRe);
        return isDMY
          ? new Date(`${y}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`).getTime()
          : new Date(`${y}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`).getTime();
      };
      const mss = values.map(toMs);
      if (mss.every(ms => !isNaN(ms))) {
        const diff = _modalDiff(mss);
        if (diff !== null) {
          let next = new Date(mss[mss.length - 1] + diff);
          if (_allWeekdays(mss)) next = _skipWeekend(next);
          const dd = String(next.getDate()).padStart(2,'0');
          const mm = String(next.getMonth()+1).padStart(2,'0');
          const yy = next.getFullYear();
          return isDMY ? `${dd}/${mm}/${yy}` : `${mm}/${dd}/${yy}`;
        }
      }
    }

    // 5. Pure integer (no leading zeros, no extra characters)
    if (/^-?\d+$/.test(last) && values.every(v => /^-?\d+$/.test(v))) {
      const nums = values.map(Number);
      const diff = _modalDiff(nums);
      if (diff !== null) return String(nums[nums.length - 1] + diff);
    }

    // 6. Float with consistent decimal places
    const floatRe = /^-?\d+\.\d+$/;
    if (floatRe.test(last) && values.every(v => floatRe.test(v))) {
      const nums = values.map(Number);
      const diff = _modalDiff(nums);
      if (diff !== null) {
        const decimals = last.split('.')[1].length;
        return (nums[nums.length - 1] + diff).toFixed(decimals);
      }
    }

    // 7. Unicode subscript digits suffix: "x₁", "α₃", "f₁₂"
    const subRe = /^(.*?)([\u2080-\u2089]+)$/;
    if (subRe.test(last)) {
      const lastM = last.match(subRe);
      const prefix = lastM[1];
      const allMatch = values.every(v => { const m = v.match(subRe); return m && m[1] === prefix; });
      if (allMatch) {
        const nums = values.map(v => _subToNum(v.match(subRe)[2]));
        const diff = _modalDiff(nums);
        if (!nums.some(isNaN) && diff !== null) return prefix + _numToSub(nums[nums.length - 1] + diff);
      }
    }

    // 8. Markdown/LaTeX subscript: "x_1", "x_{12}", "\alpha_{3}", "$f_{240101}$"
    //    Suffix capture handles closing delimiters like trailing "$".
    const latexSubRe = /^(.*?)_(\{?)(\d+)\}?(.*)$/;
    if (latexSubRe.test(last)) {
      const lastM = last.match(latexSubRe);
      const prefix   = lastM[1];
      const hasBrace = lastM[2] === '{';
      const suffix   = lastM[4];
      // Only require matching prefix — suffix may contain a varying cell value
      // (e.g. "$S_{240101} = 5$" has suffix " = 5$" which differs per row).
      // The last row's suffix is used as the output template.
      const allMatch = values.every(v => { const m = v.match(latexSubRe); return m && m[1] === prefix; });
      if (allMatch) {
        const subVals = values.map(v => v.match(latexSubRe)[3]);
        // Check if subscript values are compact dates (YYMMDD / YYYYMMDD)
        const compactSubRe = /^(\d{2}|\d{4})(\d{2})(\d{2})$/;
        if (subVals.every(s => compactSubRe.test(s))) {
          const toMs = s => {
            const [, yr, mo, dy] = s.match(compactSubRe);
            const moNum = parseInt(mo, 10); const dyNum = parseInt(dy, 10);
            if (moNum < 1 || moNum > 12 || dyNum < 1 || dyNum > 31) return NaN;
            const fullYear = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
            return new Date(fullYear, moNum - 1, dyNum).getTime();
          };
          const mss = subVals.map(toMs);
          const dateDiff = _modalDiff(mss);
          if (mss.every(ms => !isNaN(ms)) && dateDiff !== null) {
            let next = new Date(mss[mss.length - 1] + dateDiff);
            if (_allWeekdays(mss)) next = _skipWeekend(next);
            const yLen = subVals[0].length === 6 ? 2 : 4;
            const yr   = yLen === 2 ? String(next.getFullYear()).slice(-2) : String(next.getFullYear());
            const mo   = String(next.getMonth() + 1).padStart(2, '0');
            const dy   = String(next.getDate()).padStart(2, '0');
            const nextSub = yr + mo + dy;
            return hasBrace ? `${prefix}_{${nextSub}}${suffix}` : `${prefix}_${nextSub}${suffix}`;
          }
        }
        const nums = subVals.map(s => parseInt(s, 10));
        const diff = _modalDiff(nums);
        if (!nums.some(isNaN) && diff !== null) {
          const next = nums[nums.length - 1] + diff;
          return hasBrace ? `${prefix}_{${next}}${suffix}` : `${prefix}_${next}${suffix}`;
        }
      }
    }

    // 9. Text + number suffix ("Item 1", "Row 3") with consistent prefix
    const tnRe = /^(.*?)(\d+)$/;
    if (tnRe.test(last)) {
      const prefix = last.match(tnRe)[1];
      const allMatch = values.every(v => { const m = v.match(tnRe); return m && m[1] === prefix; });
      if (allMatch) {
        const nums = values.map(v => parseInt(v.match(tnRe)[2], 10));
        const diff = _modalDiff(nums);
        if (!nums.some(isNaN) && diff !== null) return prefix + (nums[nums.length - 1] + diff);
      }
    }

    // 10. Template: longest-common-prefix + longest-common-suffix, sequential middle.
    // Handles "Q1 2024"→"Q4 2024", "Phase A"→"Phase D", "v2.1.3"→"v2.1.4", etc.
    // Uses the last cell as the baseline and only varies the middle part when it
    // shows a clear sequence, leaving unstable surrounding text unchanged.
    {
      // Longest common prefix length
      let lcpLen = 0;
      while (lcpLen < values[0].length &&
             values.every(v => v[lcpLen] === values[0][lcpLen])) lcpLen++;
      // Longest common suffix length (must not overlap prefix)
      const tails = values.map(v => v.slice(lcpLen));
      let lcsLen = 0;
      if (tails.every(t => t.length > 0)) {
        const revs = tails.map(t => [...t].reverse().join(''));
        while (lcsLen < tails[0].length &&
               revs.every(r => r[lcsLen] === revs[0][lcsLen])) lcsLen++;
        if (lcsLen === tails[0].length) lcsLen = tails[0].length - 1; // keep ≥1 middle char
      }
      const pre  = values[0].slice(0, lcpLen);
      const suf  = lcsLen > 0 ? tails[0].slice(-lcsLen) : '';
      const mids = tails.map(t => lcsLen > 0 ? t.slice(0, -lcsLen) : t);

      // Only proceed if there is a stable wrapper (prefix or suffix) and all middles are non-empty
      if ((pre || suf) && mids.every(m => m.length > 0)) {
        // a. Integer middle
        if (mids.every(m => /^-?\d+$/.test(m))) {
          const nums = mids.map(Number);
          const diff = _modalDiff(nums);
          if (diff !== null) return pre + (nums[nums.length - 1] + diff) + suf;
        }
        // b. Single letter (A→B, a→b, etc.)
        if (mids.every(m => /^[A-Za-z]$/.test(m))) {
          const codes = mids.map(m => m.charCodeAt(0));
          const diff = _modalDiff(codes);
          if (diff !== null) return pre + String.fromCharCode(codes[codes.length - 1] + diff) + suf;
        }
      }
    }

    // Fallback: repeat last value
    return last;
  }

  // ── Table structure helpers ──────────────────────────────────────────────

  function _parseCells(line) {
    const raw = line.trim();
    return raw.slice(1, raw.lastIndexOf('|')).split('|').map(c => c.trim());
  }

  // Returns the body rows of the table immediately preceding lineIndex, or null.
  // Requires ≥ 2 body rows for pattern detection.
  function _getTableBodyRowsAbove(lines, lineIndex) {
    const rows = [];
    let i = lineIndex - 1;
    while (i >= 0 && /^\s*\|/.test(lines[i])) {
      rows.unshift(lines[i]);
      i--;
    }
    if (rows.length < 3) return null; // need header + separator + ≥1 body
    // Find the separator line (cells = :?-+:? only)
    const sepIdx = rows.findIndex(row => {
      const cells = _parseCells(row);
      return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
    });
    // Require at least one header row above the separator — otherwise the
    // "table" has no header and the detected pipe-lines are something else
    // (e.g. a stray fragment or a body row that happens to look like a separator).
    if (sepIdx < 1) return null;
    const bodyRows = rows.slice(sepIdx + 1);
    return bodyRows.length >= 2 ? bodyRows : null;
  }

  function _buildSuggestion(bodyRows) {
    const parsed  = bodyRows.map(_parseCells);
    const numCols = parsed[0].length;
    if (!numCols) return null;
    const cells = [];
    for (let c = 0; c < numCols; c++) {
      cells.push(_predictCell(parsed.map(r => r[c] !== undefined ? r[c] : '')));
    }
    return '| ' + cells.join(' | ') + ' |';
  }

  // ── Event listeners ──────────────────────────────────────────────────────

  textarea.addEventListener('input', () => {
    // Don't compete with wiki-link autocomplete
    const wikidrop = document.getElementById('wikilink-dropdown');
    if (wikidrop && wikidrop.style.display !== 'none') { _trHide(); return; }

    const pos      = textarea.selectionStart;
    const text     = textarea.value;
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const currentLine = text.slice(lineStart, pos);

    // Keep suggestion visible when user types a space after '|' and a suggestion
    // is already active — just shift the ghost insertion point forward by one.
    if (currentLine === '| ' && _trSuggestion !== null) {
      _ghostInsertPos = pos;
      _ghostText = _trSuggestion.slice(2); // show remaining text after '| '
      return; // ghost will be re-injected by _updateHighlight → _tableGhostApply
    }

    // Trigger on '|' or '| ' (pipe with optional space, e.g. after Enter-accepted row)
    if (currentLine !== '|' && currentLine !== '| ') { _trHide(); return; }

    const linesAbove = text.slice(0, lineStart).split('\n');
    // text.slice(0, lineStart) always ends with \n so split always has a trailing
    // empty string — pass length-1 so _getTableBodyRowsAbove starts at the actual
    // last table row, not the empty sentinel.
    const bodyRows = _getTableBodyRowsAbove(linesAbove, linesAbove.length - 1);
    if (!bodyRows) { _trHide(); return; }

    const suggestion = _buildSuggestion(bodyRows);
    if (!suggestion) { _trHide(); return; }

    if (currentLine === '| ') {
      // Fresh suggestion on a '| ' line (e.g., auto-inserted after accepting a row)
      _trHide();
      _trSuggestion   = suggestion;
      _ghostInsertPos = pos;
      _ghostText      = suggestion.slice(2); // skip '| ' already typed
      setTimeout(_applyGhostToPre, 50);
    } else {
      _trShow(pos, suggestion);
    }
  });

  textarea.addEventListener('keydown', e => {
    if (_trSuggestion === null) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const pos        = textarea.selectionStart;
      const text       = textarea.value;
      const lineStart  = text.lastIndexOf('\n', pos - 1) + 1;
      const suggestion = _trSuggestion; // capture before _trHide() nulls it
      _trHide();
      textarea.setSelectionRange(lineStart, pos);
      document.execCommand('insertText', false, suggestion + '\n| ');
      textarea.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      _trHide();
    }
  }, true); // capture phase — same priority as wiki dropdown

  textarea.addEventListener('blur', () => setTimeout(_trHide, 150));

  // Expose ghost-reapply hook so _updateHighlight in syntax-highlight.js can
  // re-inject the ghost span after every innerHTML refresh without a fixed delay.
  window._tableGhostApply = _applyGhostToPre;
}

// ── Tab cell navigation + row/column shortcuts ───────────────────────────
// Registered on `document` at capture phase so these handlers run before the
// textarea-local Tab=insert-tab listener in app-init.js. When the caret is
// inside a table row, Tab/Shift-Tab walk cells, and Ctrl+Shift+Arrow adds or
// removes rows and columns. Outside of tables the events fall through and the
// default editor behaviour applies.
{
  // Returns { line, lineStart, lineEnd, pipes } for the caret's current line,
  // where `pipes` lists absolute textarea offsets of every unescaped '|'.
  // Returns null if the line is not a table row (needs leading '|' and ≥ 2 pipes).
  function _currentTableLine() {
    const pos       = textarea.selectionStart;
    const text      = textarea.value;
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const lineEndRaw = text.indexOf('\n', pos);
    const lineEnd   = lineEndRaw === -1 ? text.length : lineEndRaw;
    const line      = text.slice(lineStart, lineEnd);
    if (!/^\s*\|/.test(line)) return null;
    const pipes = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '|' && line[i - 1] !== '\\') pipes.push(lineStart + i);
    }
    if (pipes.length < 2) return null;
    return { pos, text, line, lineStart, lineEnd, pipes };
  }

  // Number of cells in a row = pipes.length - 1 (one cell between each pair).
  function _cellCount(pipes) {
    return Math.max(0, pipes.length - 1);
  }

  // Build a blank row with `cols` empty cells using the project's '|  |' convention.
  function _blankRow(cols) {
    return '|' + '  |'.repeat(cols);
  }

  // Move caret to the first cell of a newly inserted row (offset 2 past '|').
  function _setCaret(pos) {
    textarea.setSelectionRange(pos, pos);
  }

  // Replace a range of the textarea atomically using execCommand so undo works.
  function _replaceRange(start, end, insert) {
    textarea.setSelectionRange(start, end);
    document.execCommand('insertText', false, insert);
  }

  document.addEventListener('keydown', e => {
    if (document.activeElement !== textarea) return;

    // Only intercept keys we care about.
    const isTab   = e.key === 'Tab';
    const isArrow = (e.ctrlKey || e.metaKey) && e.shiftKey &&
                    (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
                     e.key === 'ArrowLeft' || e.key === 'ArrowRight');
    if (!isTab && !isArrow) return;

    // Defer to the wiki-link autocomplete dropdown when it's visible —
    // its Tab/Enter completes the highlighted entry.
    const wikidrop = document.getElementById('wikilink-dropdown');
    if (wikidrop && wikidrop.style.display !== 'none') return;

    const ctx = _currentTableLine();
    if (!ctx) return;
    const { pos, text, line, lineStart, lineEnd, pipes } = ctx;

    // ── Tab / Shift-Tab: move between cells ────────────────────────────────
    if (isTab) {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.shiftKey) {
        // Previous cell: last pipe strictly before caret.
        let prev = -1;
        for (let i = pipes.length - 1; i >= 0; i--) {
          if (pipes[i] < pos) { prev = pipes[i]; break; }
        }
        if (prev < 0) return; // caret before first pipe — nowhere to go
        // If the previous pipe is the opening pipe of the row, there is no
        // earlier cell on this line — bail without moving.
        if (prev === pipes[0]) return;
        let target = prev + 1;
        if (text[target] === ' ') target++;
        _setCaret(target);
        return;
      }

      // Next cell: first pipe at-or-after caret.
      const next = pipes.find(p => p >= pos);
      const isLast = next === undefined || next === pipes[pipes.length - 1];
      if (isLast) {
        // End-of-row Tab → insert a blank row below with matching column count
        // and park the caret in its first cell.
        const cols = _cellCount(pipes);
        const blank = '\n' + _blankRow(cols);
        _replaceRange(lineEnd, lineEnd, blank);
        _setCaret(lineEnd + 3); // '\n|_' → caret at offset 3 (first cell)
        refreshHighlight();
        return;
      }
      let target = next + 1;
      if (text[target] === ' ') target++;
      _setCaret(target);
      return;
    }

    // ── Ctrl+Shift+Arrow: add/delete rows and columns ──────────────────────
    e.preventDefault();
    e.stopImmediatePropagation();

    if (e.key === 'ArrowDown') {
      // Add blank row below current.
      const cols = _cellCount(pipes);
      _replaceRange(lineEnd, lineEnd, '\n' + _blankRow(cols));
      _setCaret(lineEnd + 3);
      refreshHighlight();
      return;
    }

    if (e.key === 'ArrowUp') {
      // Delete current row (only if it's a body row — never drop header/separator).
      // The table's header is the FIRST line of the contiguous pipe-block we
      // belong to; the separator is the second. Walk up to find them.
      const lines = text.split('\n');
      const curLineIdx = text.slice(0, lineStart).split('\n').length - 1;
      // Walk up while lines start with '|'.
      let topIdx = curLineIdx;
      while (topIdx > 0 && /^\s*\|/.test(lines[topIdx - 1])) topIdx--;
      // topIdx = header, topIdx+1 = separator; refuse to delete those.
      if (curLineIdx <= topIdx + 1) return;
      const delStart = lineStart;
      const delEnd   = lineEnd < text.length ? lineEnd + 1 : lineEnd; // swallow the '\n'
      _replaceRange(delStart, delEnd, '');
      refreshHighlight();
      return;
    }

    if (e.key === 'ArrowRight') {
      // Add an empty column immediately AFTER the one containing the caret.
      // Identify the target pipe: the first pipe at-or-after caret. Every row
      // in the same table gets an extra '  |' inserted after the pipe at that
      // column index. Walk the contiguous pipe-block (header + separator + body).
      let colIdx = pipes.findIndex(p => p >= pos);
      if (colIdx < 0) colIdx = pipes.length - 1;
      const lines = text.split('\n');
      const curLineIdx = text.slice(0, lineStart).split('\n').length - 1;
      let topIdx = curLineIdx;
      while (topIdx > 0 && /^\s*\|/.test(lines[topIdx - 1])) topIdx--;
      let botIdx = curLineIdx;
      while (botIdx < lines.length - 1 && /^\s*\|/.test(lines[botIdx + 1])) botIdx++;
      // Rebuild each row with the extra column inserted.
      for (let i = topIdx; i <= botIdx; i++) {
        const rowPipes = [];
        for (let j = 0; j < lines[i].length; j++) {
          if (lines[i][j] === '|' && lines[i][j - 1] !== '\\') rowPipes.push(j);
        }
        // If this row has fewer pipes, clamp to its last pipe.
        const insertAfter = Math.min(colIdx, rowPipes.length - 1);
        if (insertAfter < 0) continue;
        const cut = rowPipes[insertAfter] + 1;
        const isSep = rowPipes.slice(0, -1).every((p, k) => {
          const cell = lines[i].slice(p + 1, rowPipes[k + 1]).trim();
          return /^:?-+:?$/.test(cell);
        });
        const inject = isSep ? ' - |' : '  |';
        lines[i] = lines[i].slice(0, cut) + inject + lines[i].slice(cut);
      }
      const newText = lines.join('\n');
      const caretTarget = pos; // caret stays in place; user can Tab to new column
      textarea.setSelectionRange(0, text.length);
      document.execCommand('insertText', false, newText);
      _setCaret(caretTarget);
      refreshHighlight();
      return;
    }

    if (e.key === 'ArrowLeft') {
      // Delete the column containing the caret across the whole table.
      let colIdx = pipes.findIndex(p => p >= pos);
      if (colIdx < 0) colIdx = pipes.length - 1;
      if (colIdx === 0) colIdx = 1; // caret before first pipe → target first cell
      const lines = text.split('\n');
      const curLineIdx = text.slice(0, lineStart).split('\n').length - 1;
      let topIdx = curLineIdx;
      while (topIdx > 0 && /^\s*\|/.test(lines[topIdx - 1])) topIdx--;
      let botIdx = curLineIdx;
      while (botIdx < lines.length - 1 && /^\s*\|/.test(lines[botIdx + 1])) botIdx++;
      // Refuse to delete the last remaining column.
      const minCells = Math.min(...Array.from({ length: botIdx - topIdx + 1 }, (_, k) => {
        const rp = [];
        const ln = lines[topIdx + k];
        for (let j = 0; j < ln.length; j++) {
          if (ln[j] === '|' && ln[j - 1] !== '\\') rp.push(j);
        }
        return Math.max(0, rp.length - 1);
      }));
      if (minCells <= 1) return;
      for (let i = topIdx; i <= botIdx; i++) {
        const rowPipes = [];
        for (let j = 0; j < lines[i].length; j++) {
          if (lines[i][j] === '|' && lines[i][j - 1] !== '\\') rowPipes.push(j);
        }
        // Target cell: between rowPipes[colIdx-1] and rowPipes[colIdx].
        const left  = rowPipes[colIdx - 1];
        const right = rowPipes[colIdx];
        if (left === undefined || right === undefined) continue;
        // Cut from `left` (inclusive) to `right` (exclusive) so the trailing
        // pipe remains, closing the row.
        lines[i] = lines[i].slice(0, left) + lines[i].slice(right);
      }
      const newText = lines.join('\n');
      textarea.setSelectionRange(0, text.length);
      document.execCommand('insertText', false, newText);
      // Best-effort: park caret at start of the previous column on the same line.
      _setCaret(Math.max(lineStart, pos - 4));
      refreshHighlight();
      return;
    }
  }, true);
}
