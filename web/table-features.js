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

    firstCells.forEach((cell, colIndex) => {
      const text = cell.textContent.trim();
      const cleaned = text.replace(/[,$€£¥%+ ]/g, '');
      const numeric = cleaned !== '' && !isNaN(Number(cleaned));
      const align = numeric ? 'right' : 'left';

      bodyRows.forEach(row => {
        const td = row.querySelectorAll('td')[colIndex];
        if (td) td.style.textAlign = align;
      });

      const th = table.querySelectorAll('thead tr th')[colIndex];
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
  return '|' + cells.map(() => ' - ').join('|') + '|';
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
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          updateStatus('Table copied to clipboard.', true);
        }).catch(() => {
          _fallbackCopy(text);
        });
      } else {
        _fallbackCopy(text);
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

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); updateStatus('Table copied to clipboard.', true); } catch { /* ignore */ }
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

  // Show a suggestion: schedule injection after 15 ms.
  function _trShow(pos, suggestion) {
    _trHide();
    _trSuggestion   = suggestion;
    _ghostInsertPos = pos;
    _ghostText      = suggestion.slice(1); // everything after the '|' already typed
    setTimeout(_applyGhostToPre, 15);
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

    // 1. ISO date YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(last)) {
      const dates = values.map(v => new Date(v).getTime());
      if (dates.every(d => !isNaN(d))) {
        const diff = _modalDiff(dates);
        if (diff !== null) return new Date(dates[dates.length - 1] + diff).toISOString().slice(0, 10);
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
          const next = new Date(mss[mss.length - 1] + diff);
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
        const next = new Date(mss[mss.length - 1] + diff);
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
          const next = new Date(mss[mss.length - 1] + diff);
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
      const allMatch = values.every(v => { const m = v.match(latexSubRe); return m && m[1] === prefix && m[4] === suffix; });
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
            const next = new Date(mss[mss.length - 1] + dateDiff);
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
    if (rows.length < 2) return null;
    // Find the separator line (cells = :?-+:? only)
    const sepIdx = rows.findIndex(row => {
      const cells = _parseCells(row);
      return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
    });
    if (sepIdx < 0) return null; // no separator → not a real table
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

    // Only trigger when the current line is exactly '|'
    if (currentLine !== '|') { _trHide(); return; }

    const linesAbove = text.slice(0, lineStart).split('\n');
    // text.slice(0, lineStart) always ends with \n so split always has a trailing
    // empty string — pass length-1 so _getTableBodyRowsAbove starts at the actual
    // last table row, not the empty sentinel.
    const bodyRows = _getTableBodyRowsAbove(linesAbove, linesAbove.length - 1);
    if (!bodyRows) { _trHide(); return; }

    const suggestion = _buildSuggestion(bodyRows);
    if (!suggestion) { _trHide(); return; }

    _trShow(pos, suggestion);
  });

  textarea.addEventListener('keydown', e => {
    if (_trSuggestion === null) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const pos       = textarea.selectionStart;
      const text      = textarea.value;
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      const before    = text.slice(0, lineStart);
      const after     = text.slice(pos);
      // Replace the lone '|' with the full suggestion then add a newline
      textarea.value  = before + _trSuggestion + '\n' + after;
      const newPos    = before.length + _trSuggestion.length + 1;
      textarea.selectionStart = textarea.selectionEnd = newPos;
      _trHide();
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      _trHide();
    }
  }, true); // capture phase — same priority as wiki dropdown

  textarea.addEventListener('blur', () => setTimeout(_trHide, 150));
}
