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
{
  const _trDiv = document.createElement('div');
  _trDiv.id = 'table-row-suggestion';
  _trDiv.style.display = 'none';
  document.body.appendChild(_trDiv);

  let _trSuggestion = null; // full predicted row string, e.g. "| 3 | 2024-01-03 |"

  function _trHide() {
    _trDiv.style.display = 'none';
    _trSuggestion = null;
  }

  // Position the ghost div at the cursor using the same mirror technique as the
  // wiki-link dropdown so metrics match the textarea font exactly.
  function _trPosition(cursorOffset) {
    const cs = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    mirror.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;visibility:hidden;' +
      'white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;pointer-events:none;' +
      'font:' + cs.font + ';padding:' + cs.padding + ';border:' + cs.border + ';' +
      'width:' + textarea.offsetWidth + 'px;line-height:' + cs.lineHeight + ';';
    mirror.appendChild(document.createTextNode(textarea.value.slice(0, cursorOffset)));
    const anchor = document.createElement('span');
    anchor.textContent = '\u200b';
    mirror.appendChild(anchor);
    document.body.appendChild(mirror);
    const anchorTop  = anchor.offsetTop;
    const anchorLeft = anchor.offsetLeft;
    document.body.removeChild(mirror);

    const taRect = textarea.getBoundingClientRect();
    _trDiv.style.font       = cs.font;
    _trDiv.style.lineHeight = cs.lineHeight;
    _trDiv.style.top        = (taRect.top  + anchorTop  - textarea.scrollTop)  + 'px';
    _trDiv.style.left       = (taRect.left + anchorLeft - textarea.scrollLeft) + 'px';
    _trDiv.style.maxWidth   = (taRect.right - taRect.left - anchorLeft - 4) + 'px';
  }

  // Position the ghost div using the Range API on the syntax-highlight <pre>.
  // The pre uses CSS transform for scrolling so getBoundingClientRect() on Range
  // objects already returns scroll-adjusted viewport coordinates — no manual
  // scroll offset needed.  Falls back to _trPosition() if the pre isn't ready.
  function _trPositionFromPre(cursorOffset) {
    if (typeof _highlightPre === 'undefined' || !_highlightPre) return false;
    try {
      let remaining = cursorOffset;
      let node = null;
      let nodeOffset = 0;
      const walker = document.createTreeWalker(_highlightPre, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (remaining <= textNode.length) {
          node = textNode;
          nodeOffset = remaining;
          break;
        }
        remaining -= textNode.length;
      }
      if (!node) return false;
      const range = document.createRange();
      range.setStart(node, nodeOffset);
      range.setEnd(node, nodeOffset);
      const rects = range.getClientRects();
      if (!rects || rects.length === 0) return false;
      const rect = rects[0];
      const cs = window.getComputedStyle(textarea);
      _trDiv.style.font       = cs.font;
      _trDiv.style.lineHeight = cs.lineHeight;
      _trDiv.style.top        = rect.top + 'px';
      _trDiv.style.left       = rect.left + 'px';
      const taRect = textarea.getBoundingClientRect();
      _trDiv.style.maxWidth   = (taRect.right - rect.left - 4) + 'px';
      return true;
    } catch (e) {
      return false;
    }
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

    // Helper: check all consecutive differences in an array of numbers are equal
    function _allDiffsEqual(nums) {
      if (nums.length < 2) return false;
      const d = nums[1] - nums[0];
      for (let i = 2; i < nums.length; i++) if (nums[i] - nums[i-1] !== d) return false;
      return d !== 0;
    }

    // 1. ISO date YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(last)) {
      const dates = values.map(v => new Date(v).getTime());
      if (dates.every(d => !isNaN(d)) && _allDiffsEqual(dates)) {
        const next = new Date(dates[dates.length - 1] + (dates[1] - dates[0]));
        return next.toISOString().slice(0, 10);
      }
    }

    // 2. Compact date YYMMDD (6 digits) or YYYYMMDD (8 digits)
    const compactRe = /^(\d{2}|\d{4})(\d{2})(\d{2})$/;
    if (compactRe.test(last) && values.every(v => compactRe.test(v))) {
      const toMs = v => {
        const [, yr, mo, dy] = v.match(compactRe);
        const moNum = parseInt(mo, 10);
        const dyNum = parseInt(dy, 10);
        // Reject values that aren't valid calendar month/day to avoid
        // false-positives on plain 6-digit integers.
        if (moNum < 1 || moNum > 12 || dyNum < 1 || dyNum > 31) return NaN;
        const fullYear = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
        return new Date(fullYear, moNum - 1, dyNum).getTime();
      };
      const mss = values.map(toMs);
      if (mss.every(ms => !isNaN(ms)) && _allDiffsEqual(mss)) {
        const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
        const yLen = last.length === 6 ? 2 : 4;
        const yr   = yLen === 2
          ? String(next.getFullYear()).slice(-2)
          : String(next.getFullYear());
        const mo   = String(next.getMonth() + 1).padStart(2, '0');
        const dy   = String(next.getDate()).padStart(2, '0');
        return yr + mo + dy;
      }
    }

    // 3. Ordinal day-month: "Mon 1st April", "1st Apr", "2nd January 2024" etc.
    const ordParsed = values.map(_parseOrdinalDate);
    if (ordParsed.every(p => p !== null)) {
      const mss = ordParsed.map(p => p.date.getTime());
      if (_allDiffsEqual(mss)) {
        const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
        return _formatOrdinalDate(next, ordParsed[ordParsed.length - 1]);
      }
    }

    // 4. Slash date DD/MM/YYYY or MM/DD/YYYY
    const slashRe = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    if (slashRe.test(last) && values.every(v => slashRe.test(v))) {
      const [, a0, b0] = values[0].match(slashRe);
      const isDMY = parseInt(a0, 10) > 12;
      const toMs = v => {
        const [, a, b, y] = v.match(slashRe);
        return isDMY
          ? new Date(`${y}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`).getTime()
          : new Date(`${y}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`).getTime();
      };
      const mss = values.map(toMs);
      if (mss.every(ms => !isNaN(ms)) && _allDiffsEqual(mss)) {
        const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
        const dd = String(next.getDate()).padStart(2,'0');
        const mm = String(next.getMonth()+1).padStart(2,'0');
        const yy = next.getFullYear();
        return isDMY ? `${dd}/${mm}/${yy}` : `${mm}/${dd}/${yy}`;
      }
    }

    // 5. Pure integer (no leading zeros, no extra characters)
    if (/^-?\d+$/.test(last) && values.every(v => /^-?\d+$/.test(v))) {
      const nums = values.map(Number);
      if (_allDiffsEqual(nums)) return String(nums[nums.length - 1] + (nums[1] - nums[0]));
    }

    // 6. Float with consistent decimal places
    const floatRe = /^-?\d+\.\d+$/;
    if (floatRe.test(last) && values.every(v => floatRe.test(v))) {
      const nums = values.map(Number);
      if (_allDiffsEqual(nums)) {
        const decimals = last.split('.')[1].length;
        return (nums[nums.length - 1] + (nums[1] - nums[0])).toFixed(decimals);
      }
    }

    // 7. Unicode subscript digits suffix: "x₁", "α₃", "f₁₂"
    const subRe = /^(.*?)([\u2080-\u2089]+)$/;
    if (subRe.test(last)) {
      const lastM = last.match(subRe);
      const prefix = lastM[1];
      const allMatch = values.every(v => {
        const m = v.match(subRe);
        return m && m[1] === prefix;
      });
      if (allMatch) {
        const nums = values.map(v => _subToNum(v.match(subRe)[2]));
        if (!nums.some(isNaN) && _allDiffsEqual(nums)) {
          return prefix + _numToSub(nums[nums.length - 1] + (nums[1] - nums[0]));
        }
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
      const allMatch = values.every(v => {
        const m = v.match(latexSubRe);
        return m && m[1] === prefix && m[4] === suffix;
      });
      if (allMatch) {
        const subVals = values.map(v => v.match(latexSubRe)[3]);
        // Check if subscript values are compact dates (YYMMDD / YYYYMMDD)
        const compactSubRe = /^(\d{2}|\d{4})(\d{2})(\d{2})$/;
        if (subVals.every(s => compactSubRe.test(s))) {
          const toMs = s => {
            const [, yr, mo, dy] = s.match(compactSubRe);
            const moNum = parseInt(mo, 10);
            const dyNum = parseInt(dy, 10);
            if (moNum < 1 || moNum > 12 || dyNum < 1 || dyNum > 31) return NaN;
            const fullYear = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
            return new Date(fullYear, moNum - 1, dyNum).getTime();
          };
          const mss = subVals.map(toMs);
          if (mss.every(ms => !isNaN(ms)) && _allDiffsEqual(mss)) {
            const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
            const yLen = subVals[0].length === 6 ? 2 : 4;
            const yr   = yLen === 2 ? String(next.getFullYear()).slice(-2) : String(next.getFullYear());
            const mo   = String(next.getMonth() + 1).padStart(2, '0');
            const dy   = String(next.getDate()).padStart(2, '0');
            const nextSub = yr + mo + dy;
            return hasBrace ? `${prefix}_{${nextSub}}${suffix}` : `${prefix}_${nextSub}${suffix}`;
          }
        }
        const nums = subVals.map(s => parseInt(s, 10));
        if (!nums.some(isNaN) && _allDiffsEqual(nums)) {
          const next = nums[nums.length - 1] + (nums[1] - nums[0]);
          return hasBrace ? `${prefix}_{${next}}${suffix}` : `${prefix}_${next}${suffix}`;
        }
      }
    }

    // 9. Text + number suffix ("Item 1", "Row 3") with consistent prefix
    const tnRe = /^(.*?)(\d+)$/;
    if (tnRe.test(last)) {
      const lastM = last.match(tnRe);
      const prefix = lastM[1];
      const allMatch = values.every(v => {
        const m = v.match(tnRe);
        return m && m[1] === prefix;
      });
      if (allMatch) {
        const nums = values.map(v => parseInt(v.match(tnRe)[2], 10));
        if (!nums.some(isNaN) && _allDiffsEqual(nums)) {
          return prefix + (nums[nums.length - 1] + (nums[1] - nums[0]));
        }
      }
    }

    // 10. Fallback: repeat last value
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
    const bodyRows   = _getTableBodyRowsAbove(linesAbove, linesAbove.length - 1);
    if (!bodyRows) { _trHide(); return; }

    const suggestion = _buildSuggestion(bodyRows);
    if (!suggestion) { _trHide(); return; }

    _trSuggestion = suggestion;
    // Ghost shows everything after the '|' the user already typed
    _trDiv.textContent = suggestion.slice(1);
    // Defer display by one animation frame so the 10ms syntax-highlight debounce
    // has fired and the <pre> reflects the current text.  The Range API then gives
    // pixel-perfect viewport coordinates without needing a mirror div.
    requestAnimationFrame(() => {
      if (_trSuggestion === null) return; // dismissed during the rAF delay
      if (!_trPositionFromPre(pos)) _trPosition(pos);
      _trDiv.style.display = 'block';
    });
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

  textarea.addEventListener('blur',   () => setTimeout(_trHide, 150));
  textarea.addEventListener('scroll', () => {
    if (_trSuggestion !== null) {
      const pos = textarea.selectionStart;
      if (!_trPositionFromPre(pos)) _trPosition(pos);
    }
  });
}

