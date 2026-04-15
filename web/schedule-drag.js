// schedule-drag.js — Drag-to-move and drag-to-resize for the schedule view.
//
// Provides two interactions on timed and all-day schedule blocks:
//   1. Drag-to-move: mousedown/touchstart on the block body lifts the item
//      so it can be dropped at a new time (or onto the timed grid for all-day items).
//   2. Drag-to-resize: mousedown/touchstart on the 8px resize handle at the
//      bottom of each timed block changes the end time in 15-min increments.
//
// Depends on globals from:
//   app-state.js  — NoteStorage, currentFileName, textarea, isPreview,
//                   projectsViewActive, scheduleDate, scheduleGrid
//   schedule.js   — invalidateScheduleCache, renderSchedule
//   note-manager.js / markdown-renderer.js — renderPreview, refreshHighlight

// ── Constants ──────────────────────────────────────────────────────────────
const _SD_ROW_H         = 40;   // px per 30-min slot — must match schedule.js
const _SD_SNAP          = 15;   // snap granularity in minutes
const _SD_MIN_DUR       = 15;   // minimum event duration (minutes)
const _SD_ALLDAY_DUR    = 30;   // default duration (min) for all-day → timed drops
const _SD_DRAG_THRESH   = 4;    // px movement before mousedown becomes a drag
const _SD_SCROLL_ZONE   = 60;   // px from wrapper edge to trigger auto-scroll
const _SD_SCROLL_SPEED  = 6;    // max px per RAF frame for auto-scroll
const _SD_TOUCH_DELAY   = 300;  // ms long-press required before touch drag activates

// ── Module state ───────────────────────────────────────────────────────────
let _sd_drag   = null;   // active drag descriptor, or null when idle
let _sd_clone  = null;   // floating DOM clone during drag-to-move
let _sd_outline = null;  // drop-target outline element inside scheduleGrid
let _sd_rafId  = null;   // requestAnimationFrame id for auto-scroll
let _sd_lastClientY = 0; // updated each pointermove for the RAF loop

// ── Time utilities ─────────────────────────────────────────────────────────

function _sdMinsToHHMM(totalMins) {
  totalMins = Math.max(0, Math.min(Math.round(totalMins), 23 * 60 + 59));
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return String(h).padStart(2, '0') + String(m).padStart(2, '0');
}

function _sdHHMMtoMins(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
}

function _sdSnap(mins) {
  return Math.round(mins / _SD_SNAP) * _SD_SNAP;
}

function _sdPxToMins(px) {
  return (px / _SD_ROW_H) * 30;
}

function _sdMinsToTopPx(mins) {
  return (mins / 30) * _SD_ROW_H;
}

// Returns the minutes-from-midnight value for a given viewport clientY.
// getBoundingClientRect() already returns viewport-relative coordinates that
// fully account for any ancestor scroll, so no manual scrollTop correction
// is needed — adding it would double-count the offset.
function _sdClientYToGridMins(clientY) {
  const grid = document.getElementById('scheduleGrid');
  if (!grid) return 0;
  const gridRect = grid.getBoundingClientRect();
  const relY = clientY - gridRect.top;
  return _sdPxToMins(relY);
}

// Extract {clientX, clientY} from either a MouseEvent or a TouchEvent.
function _sdClient(e) {
  if (e.touches && e.touches.length) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length) {
    return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
  }
  return { clientX: e.clientX, clientY: e.clientY };
}

// ── Markdown write-back ────────────────────────────────────────────────────

// Removes the HHMM HHMM tokens from a timed line, converting it to an
// all-day line (> YYMMDD). Preserves the task prefix and @calendar-tag.
// Returns the updated line, or null if the pattern isn't found.
function _sdTimedToAlldayLine(line) {
  const re = /(>\s*\d{6})\s+\d{4}\s+\d{4}((?:\s+@\S+)*)\s*$/;
  if (!re.test(line)) return null;
  return line.replace(re, (_, datePart, tags) => `${datePart}${tags}`);
}

// Replaces the HHMM HHMM portion of a timed schedule line, preserving
// everything else (task prefix, date, @calendar-tag).
// Returns the updated line string, or null if the line doesn't match.
function _sdReplaceTimedLine(line, newStart, newEnd) {
  const re = /(>\s*\d{6}\s+)\d{4}(\s+)\d{4}/;
  if (!re.test(line)) return null;
  return line.replace(re, (_, pre, sep) => `${pre}${newStart}${sep}${newEnd}`);
}

// Converts an all-day line (> YYMMDD) to a timed line (> YYMMDD HHMM HHMM).
// Preserves prefix and optional @tag(s).
// Returns the updated line, or null if the pattern isn't found.
// Must only be called on lines that do NOT already have HHMM tokens (i.e. isAllDay items).
function _sdAlldayToTimedLine(line, newStart, newEnd) {
  const re = /(>\s*\d{6})((?:\s+@\S+)*)\s*$/;
  if (!re.test(line)) return null;
  return line.replace(re, (_, datepart, tags) => `${datepart} ${newStart} ${newEnd}${tags}`);
}

// Commits a time change to the markdown source file and refreshes the view.
async function _sdCommit(item, newStart, newEnd) {
  const content = await NoteStorage.getNote(item.fileName);
  if (!content) return;
  const lines = content.split('\n');
  if (item.lineIndex < 0 || item.lineIndex >= lines.length) return;

  let updated;
  if (item.isAllDay) {
    updated = _sdAlldayToTimedLine(lines[item.lineIndex], newStart, newEnd);
  } else {
    updated = _sdReplaceTimedLine(lines[item.lineIndex], newStart, newEnd);
  }
  if (!updated || updated === lines[item.lineIndex]) return;

  lines[item.lineIndex] = updated;
  const newContent = lines.join('\n');
  await NoteStorage.setNote(item.fileName, newContent);

  if (currentFileName === item.fileName) {
    textarea.value = newContent;
    if (isPreview || projectsViewActive) {
      if (typeof renderPreview === 'function') renderPreview();
    } else {
      if (typeof refreshHighlight === 'function') refreshHighlight();
    }
  }

  invalidateScheduleCache();
  await renderSchedule();
}

// Converts a timed item back to an all-day item by stripping HHMM tokens.
async function _sdCommitToAllday(item) {
  if (item.isAllDay) return; // already all-day; nothing to do
  const content = await NoteStorage.getNote(item.fileName);
  if (!content) return;
  const lines = content.split('\n');
  if (item.lineIndex < 0 || item.lineIndex >= lines.length) return;

  const updated = _sdTimedToAlldayLine(lines[item.lineIndex]);
  if (!updated || updated === lines[item.lineIndex]) return;

  lines[item.lineIndex] = updated;
  const newContent = lines.join('\n');
  await NoteStorage.setNote(item.fileName, newContent);

  if (currentFileName === item.fileName) {
    textarea.value = newContent;
    if (isPreview || projectsViewActive) {
      if (typeof renderPreview === 'function') renderPreview();
    } else {
      if (typeof refreshHighlight === 'function') refreshHighlight();
    }
  }

  invalidateScheduleCache();
  await renderSchedule();
}

// ── Drop outline ───────────────────────────────────────────────────────────

function _sdShowOutline(startMins, durationMins) {
  const grid = document.getElementById('scheduleGrid');
  if (!grid) return;
  if (!_sd_outline) {
    _sd_outline = document.createElement('div');
    _sd_outline.className = 'schedule-drop-outline';
    grid.appendChild(_sd_outline);
  }
  const topPx    = _sdMinsToTopPx(startMins) + 2;
  const heightPx = Math.max(_sdMinsToTopPx(durationMins) - 4, _SD_ROW_H / 2 - 4);
  _sd_outline.style.top     = topPx + 'px';
  _sd_outline.style.height  = heightPx + 'px';
  _sd_outline.style.display = 'block';
}

function _sdHideOutline() {
  if (_sd_outline) {
    _sd_outline.style.display = 'none';
  }
}

function _sdRemoveOutline() {
  if (_sd_outline) {
    _sd_outline.remove();
    _sd_outline = null;
  }
}

// ── Auto-scroll RAF loop ───────────────────────────────────────────────────

function _sdStartScrollLoop() {
  if (_sd_rafId) return;
  function tick() {
    _sd_rafId = null;
    if (!_sd_drag) return;
    const wrapper = document.getElementById('schedule-timeline-wrapper');
    if (!wrapper) return;
    const rect     = wrapper.getBoundingClientRect();
    const relY     = _sd_lastClientY - rect.top;
    const fromTop  = relY;
    const fromBot  = rect.height - relY;
    let delta = 0;
    if (fromTop < _SD_SCROLL_ZONE && fromTop > 0) {
      delta = -_SD_SCROLL_SPEED * (1 - fromTop / _SD_SCROLL_ZONE);
    } else if (fromBot < _SD_SCROLL_ZONE && fromBot > 0) {
      delta = _SD_SCROLL_SPEED * (1 - fromBot / _SD_SCROLL_ZONE);
    }
    if (delta !== 0) {
      wrapper.scrollTop = Math.max(0, wrapper.scrollTop + delta);
      // Refresh the drop outline so it stays in sync as the grid scrolls.
      if (_sd_drag && _sd_drag.active && _sd_drag.type === 'move' &&
          _sdInTimedArea(_sd_lastClientY)) {
        const { startMins, endMins } = _sdCalcMove(_sd_lastClientY);
        _sdShowOutline(startMins, endMins - startMins);
        _sd_drag.pendingStart = _sdMinsToHHMM(startMins);
        _sd_drag.pendingEnd   = _sdMinsToHHMM(endMins);
      }
    }
    _sd_rafId = requestAnimationFrame(tick);
  }
  _sd_rafId = requestAnimationFrame(tick);
}

function _sdStopScrollLoop() {
  if (_sd_rafId) { cancelAnimationFrame(_sd_rafId); _sd_rafId = null; }
}

// ── Drag-to-move helpers ───────────────────────────────────────────────────

// Computes snapped start/end minutes from current clientY, clamping to day.
function _sdCalcMove(clientY) {
  const d = _sd_drag;
  const rawMins   = _sdClientYToGridMins(clientY) - d.offsetMins;
  const snapped   = _sdSnap(rawMins);
  const startMins = Math.max(0, Math.min(snapped, 24 * 60 - d.durationMins));
  const endMins   = Math.min(startMins + d.durationMins, 23 * 60 + 59);
  return { startMins, endMins };
}

// True when clientY is within the scrollable timed grid wrapper.
function _sdInTimedArea(clientY) {
  const wrapper = document.getElementById('schedule-timeline-wrapper');
  if (!wrapper) return false;
  const r = wrapper.getBoundingClientRect();
  return clientY >= r.top && clientY <= r.bottom;
}

// True when clientY is within the all-day section.
function _sdInAlldayArea(clientY) {
  const section = document.querySelector('.schedule-allday-section');
  if (!section) return false;
  const r = section.getBoundingClientRect();
  return clientY >= r.top && clientY <= r.bottom;
}

// Add/remove the visual drop-target highlight on the all-day section.
function _sdHighlightAllday(on) {
  const section = document.querySelector('.schedule-allday-section');
  if (section) section.classList.toggle('schedule-allday-drop-target', on);
}

// ── Drag-to-resize helpers ─────────────────────────────────────────────────

function _sdCalcResize(clientY) {
  const d       = _sd_drag;
  const rawMins = _sdClientYToGridMins(clientY);
  const snapped = _sdSnap(rawMins);
  const endMins = Math.max(d.startMins + _SD_MIN_DUR, Math.min(snapped, 23 * 60 + 59));
  return endMins;
}

// ── Shared cleanup ─────────────────────────────────────────────────────────

function _sdCleanup(block) {
  _sdStopScrollLoop();
  _sdRemoveOutline();
  _sdHighlightAllday(false);
  document.body.classList.remove('schedule-dragging');
  if (_sd_clone) { _sd_clone.remove(); _sd_clone = null; }
  if (block)     { block.classList.remove('schedule-item-drag-source'); }
}

// ── Global pointer-move handler ────────────────────────────────────────────

function _sdOnMove(e) {
  if (!_sd_drag) return;
  const { clientX, clientY } = _sdClient(e);
  _sd_lastClientY = clientY;

  // Upgrade 'pending' → active once threshold is crossed
  if (!_sd_drag.active) {
    // On touch: wait for the long-press timer to fire before activating drag.
    // This prevents scroll gestures from accidentally hijacking touch events.
    if (!_sd_drag.touchReady) return;

    const dx = Math.abs(clientX - _sd_drag.startX);
    const dy = Math.abs(clientY - _sd_drag.startY);
    if (dx < _SD_DRAG_THRESH && dy < _SD_DRAG_THRESH) return;

    // If the gesture is more horizontal than vertical it is likely a swipe or
    // page-scroll attempt — cancel the drag entirely rather than activating it.
    if (dx > dy) {
      if (_sd_drag.touchTimer) clearTimeout(_sd_drag.touchTimer);
      _sd_drag = null;
      return;
    }

    // Threshold crossed — activate
    _sd_drag.active = true;
    document.body.classList.add('schedule-dragging');
    _sdStartScrollLoop();

    if (_sd_drag.type === 'move') {
      // Dim the source block
      _sd_drag.block.classList.add('schedule-item-drag-source');
      // Build a floating clone that follows the cursor
      const src  = _sd_drag.block;
      const rect = src.getBoundingClientRect();
      const clone = src.cloneNode(true);
      clone.className = 'schedule-drag-clone';
      clone.style.width  = src.offsetWidth  + 'px';
      clone.style.height = src.offsetHeight + 'px';
      clone.style.top    = rect.top  + 'px';
      clone.style.left   = rect.left + 'px';
      document.body.appendChild(clone);
      _sd_clone = clone;
    }
  }

  e.preventDefault();

  if (_sd_drag.type === 'move') {
    // Update clone position
    if (_sd_clone) {
      _sd_clone.style.top = (clientY - _sd_drag.cloneOffsetY) + 'px';
    }

    if (_sdInTimedArea(clientY)) {
      const { startMins, endMins } = _sdCalcMove(clientY);
      _sdShowOutline(startMins, endMins - startMins);
      _sd_drag.pendingStart    = _sdMinsToHHMM(startMins);
      _sd_drag.pendingEnd      = _sdMinsToHHMM(endMins);
      _sd_drag.pendingToAllday = false;
      _sdHighlightAllday(false);
    } else if (!_sd_drag.item.isAllDay && _sdInAlldayArea(clientY)) {
      // Timed item dragged over the all-day section — offer to convert it
      _sdHideOutline();
      _sd_drag.pendingStart    = null;
      _sd_drag.pendingEnd      = null;
      _sd_drag.pendingToAllday = true;
      _sdHighlightAllday(true);
    } else {
      _sdHideOutline();
      _sdHighlightAllday(false);
      _sd_drag.pendingStart    = null;
      _sd_drag.pendingEnd      = null;
      _sd_drag.pendingToAllday = false;
    }
  } else if (_sd_drag.type === 'resize') {
    const endMins   = _sdCalcResize(clientY);
    const startMins = _sd_drag.startMins;
    // Stretch the block live
    const h = Math.max(_sdMinsToTopPx(endMins - startMins) - 4, _SD_ROW_H / 2 - 4);
    _sd_drag.block.style.height = h + 'px';
    // Show outline shadowing the new size
    _sdShowOutline(startMins, endMins - startMins);
    _sd_drag.pendingEnd = _sdMinsToHHMM(endMins);
  }
}

// ── Global pointer-up handler ──────────────────────────────────────────────

async function _sdOnUp(e) {
  if (!_sd_drag) return;
  const d = _sd_drag;
  if (d.touchTimer) clearTimeout(d.touchTimer);
  _sd_drag = null;  // clear first so isScheduleDragActive() returns false

  _sdCleanup(d.block);

  if (!d.active) return;  // was just a click — nameSpan.click will fire normally

  if (d.type === 'move' && d.pendingToAllday) {
    await _sdCommitToAllday(d.item);
  } else if (d.type === 'move' && d.pendingStart && d.pendingEnd) {
    await _sdCommit(d.item, d.pendingStart, d.pendingEnd);
  } else if (d.type === 'resize' && d.pendingEnd) {
    await _sdCommit(d.item, d.item.startTime, d.pendingEnd);
  }
}

// ── Pointer-down handlers (attached per block) ─────────────────────────────

function _sdStartMove(e, block, item) {
  if (e.type === 'mousedown' && e.button !== 0) return;

  const { clientX, clientY } = _sdClient(e);

  const durationMins = item.isAllDay
    ? _SD_ALLDAY_DUR
    : _sdHHMMtoMins(item.endTime) - _sdHHMMtoMins(item.startTime);

  // How far down the block the user grabbed (so the block doesn't jump)
  const blockRect    = block.getBoundingClientRect();
  const cloneOffsetY = clientY - blockRect.top;
  // Convert that pixel offset to minutes for grid calculation
  const offsetMins   = item.isAllDay ? 0 : _sdPxToMins(cloneOffsetY);

  _sd_drag = {
    type: 'move',
    item, block,
    startX: clientX, startY: clientY,
    active: false,
    durationMins, offsetMins,
    cloneOffsetY,
    pendingStart: null, pendingEnd: null,
    pendingToAllday: false,
    touchTimer: null, touchReady: false,
  };

  // On touch devices require a long-press before drag can activate, so that
  // normal vertical scroll gestures are not accidentally hijacked.
  if (e.type === 'touchstart') {
    _sd_drag.touchTimer = setTimeout(() => {
      if (_sd_drag) {
        _sd_drag.touchTimer  = null;
        _sd_drag.touchReady  = true;
        if (navigator.vibrate) navigator.vibrate(10);
      }
    }, _SD_TOUCH_DELAY);
  } else {
    // Mouse: always ready immediately.
    _sd_drag.touchReady = true;
  }
  // Don't preventDefault here — that would kill the nameSpan click event.
  // It is called in _sdOnMove once DRAG_THRESHOLD is confirmed.
}

function _sdStartResize(e, block, item) {
  if (e.type === 'mousedown' && e.button !== 0) return;
  e.stopPropagation(); // don't also trigger _sdStartMove

  const { clientX, clientY } = _sdClient(e);
  const startMins = _sdHHMMtoMins(item.startTime);

  _sd_drag = {
    type: 'resize',
    item, block,
    startX: clientX, startY: clientY,
    active: false,
    startMins,
    pendingEnd: null,
    touchTimer: null, touchReady: false,
  };

  if (e.type === 'touchstart') {
    _sd_drag.touchTimer = setTimeout(() => {
      if (_sd_drag) {
        _sd_drag.touchTimer  = null;
        _sd_drag.touchReady  = true;
        if (navigator.vibrate) navigator.vibrate(10);
      }
    }, _SD_TOUCH_DELAY);
  } else {
    _sd_drag.touchReady = true;
  }
  // Don't preventDefault here for the same reason.
}

// ── Public API ─────────────────────────────────────────────────────────────

// Called from schedule.js _makeScheduleBlock for every schedule block.
// `item` is the parsed item descriptor.
// Timed items get both move and resize handlers; all-day items get move only.
// Drag-to-move is only initiated from the note title (nameSpan) so that
// accidental moves are avoided — especially on mobile where fat-finger
// misses are common.  Clicking the title without dragging still navigates.
function attachScheduleDragHandlers(block, item) {
  // ── Drag-to-move (title span only) ────────────────────────────────────
  const nameSpan = block.querySelector('.schedule-item-name');
  if (nameSpan) {
    nameSpan.addEventListener('mousedown', e => _sdStartMove(e, block, item));
    nameSpan.addEventListener('touchstart', e => _sdStartMove(e, block, item), { passive: true });
  }

  // ── Drag-to-resize (timed items only, via resize handle) ──────────────
  if (!item.isAllDay) {
    const handle = block.querySelector('.schedule-resize-handle');
    if (handle) {
      handle.addEventListener('mousedown', e => _sdStartResize(e, block, item));
      handle.addEventListener('touchstart', e => _sdStartResize(e, block, item), { passive: true });
    }
  }
}

// Returns true while a drag or resize is in progress.
// Called by schedule.js renderSchedule() to defer re-renders.
function isScheduleDragActive() {
  return _sd_drag !== null;
}

// ── Global document listeners (registered once) ────────────────────────────
// Using document-level listeners so the drag continues even when the mouse
// leaves the schedule panel, and is cleaned up properly on mouseup anywhere.

document.addEventListener('mousemove', _sdOnMove);
document.addEventListener('mouseup',   _sdOnUp);

document.addEventListener('touchmove', e => {
  // Only call preventDefault once the drag is confirmed active,
  // otherwise we block normal page scroll on touch devices.
  if (_sd_drag && _sd_drag.active) e.preventDefault();
  _sdOnMove(e);
}, { passive: false });

document.addEventListener('touchend', _sdOnUp, { passive: true });

// touchcancel fires when the system interrupts the touch (incoming call,
// multi-finger gesture, etc.).  The drag must be silently discarded — NOT
// committed — so we use a dedicated handler rather than reusing _sdOnUp.
function _sdOnCancel() {
  if (!_sd_drag) return;
  const d = _sd_drag;
  if (d.touchTimer) clearTimeout(d.touchTimer);
  _sd_drag = null;
  _sdCleanup(d.block);
}
document.addEventListener('touchcancel', _sdOnCancel, { passive: true });
