// schedule.js — Schedule view: cache, rendering, week row, and navigation.
//
// Manages the daily schedule grid showing timed events and tasks parsed
// from note content using the schedule syntax variants:
//   > YYMMDD HHMM HHMM   — timed event/task
//   > YYMMDD YYMMDD       — multi-day all-day event/task (start date end date)
//   > YYMMDD              — single all-day event/task

// ── Schedule cache ────────────────────────────────────────────────────────
let _scheduleCache = null;

async function _buildScheduleCache(cachedNotes) {
  const cache = {};
  cache._multiday = [];

  const reTimed    = />\s*(\d{6})\s+(\d{4})\s+(\d{4})(?:\s+@(\S+))?\s*$/;
  const reMultiDay = />\s*(\d{6})\s+(\d{6})(?:\s+@(\S+))?\s*$/;
  const reAllDay   = />\s*(\d{6})(?:\s+@(\S+))?\s*$/;

  const allNotes = cachedNotes || await NoteStorage.getAllNotes();
  for (const { name: fileName, content } of allNotes) {
    if (fileName.startsWith('.')) continue;
    if (!content) continue;
    content.split(/\n/).forEach((line, idx) => {
      const trimmed = line.trim();
      const isTask      = /^- \[[ xX]\]/.test(trimmed);
      const isCompleted = /^- \[[xX]\]/.test(trimmed);

      let m;
      if ((m = line.match(reTimed))) {
        // Timed: > YYMMDD HHMM HHMM — validate that hours/minutes are in range
        const startH = parseInt(m[2].slice(0, 2), 10), startM = parseInt(m[2].slice(2), 10);
        const endH   = parseInt(m[3].slice(0, 2), 10), endM   = parseInt(m[3].slice(2), 10);
        if (startH <= 23 && startM <= 59 && endH <= 23 && endM <= 59) {
          const dateStr = m[1];
          if (!cache[dateStr]) cache[dateStr] = [];
          let text = trimmed.replace(reTimed, '');
          if (isTask) text = text.replace(/^- \[[ xX]\]\s*/, '');
          cache[dateStr].push({
            fileName, lineIndex: idx, text: text.trim(),
            startTime: m[2], endTime: m[3],
            isTask, isCompleted, isAllDay: false,
            calendarTag: m[4] || null
          });
        }
      } else if ((m = line.match(reMultiDay))) {
        // Multi-day: > YYMMDD YYMMDD
        const startDate = m[1], endDate = m[2];
        let text = trimmed.replace(reMultiDay, '');
        if (isTask) text = text.replace(/^- \[[ xX]\]\s*/, '');
        cache._multiday.push({
          fileName, lineIndex: idx, text: text.trim(),
          startDate, endDate,
          isTask, isCompleted, isAllDay: true,
          calendarTag: m[3] || null
        });
      } else if ((m = line.match(reAllDay))) {
        // Single all-day: > YYMMDD
        const dateStr = m[1];
        if (!cache[dateStr]) cache[dateStr] = [];
        let text = trimmed.replace(reAllDay, '');
        if (isTask) text = text.replace(/^- \[[ xX]\]\s*/, '');
        cache[dateStr].push({
          fileName, lineIndex: idx, text: text.trim(),
          isTask, isCompleted, isAllDay: true,
          calendarTag: m[2] || null
        });
      }
    });
  }

  // Sort timed entries by start time; all-day items sort events before tasks
  for (const key of Object.keys(cache)) {
    if (key === '_multiday') continue;
    cache[key].sort((a, b) => {
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      if (a.isAllDay && b.isAllDay) {
        if (!a.isTask && b.isTask) return -1;
        if (a.isTask && !b.isTask) return 1;
        return 0;
      }
      return a.startTime.localeCompare(b.startTime);
    });
  }
  return cache;
}

function invalidateScheduleCache() {
  _scheduleCache = null;
}

async function getScheduleCache(cachedNotes) {
  if (!_scheduleCache) _scheduleCache = await _buildScheduleCache(cachedNotes);
  return _scheduleCache;
}

async function getScheduleItems(dateStr) {
  const cache = await getScheduleCache();
  const timedAndAllDay = cache[dateStr] || [];
  // Include multi-day items that span this date
  const multiday = (cache._multiday || [])
    .filter(item => item.startDate <= dateStr && dateStr <= item.endDate)
    .sort((a, b) => {
      if (!a.isTask && b.isTask) return -1;
      if (a.isTask && !b.isTask) return 1;
      return 0;
    });
  return [...timedAndAllDay, ...multiday];
}

// ── Calendar colour helpers ───────────────────────────────────────────────

function getCalendarColors() {
  try {
    return JSON.parse(localStorage.getItem('calendar_colors') || '{}');
  } catch {
    return {};
  }
}

function setCalendarColor(name, color) {
  const colors = getCalendarColors();
  colors[name] = color;
  localStorage.setItem('calendar_colors', JSON.stringify(colors));
  localStorage.setItem('calendar_colors_ts', Date.now().toString());
  // Sync calendar colours for cross-device consistency
  if (typeof syncCalendarColorsToNote === 'function') syncCalendarColorsToNote();
}

function getCalendarColor(name) {
  if (!name) return null;
  const custom = getCalendarColors()[name] || null;
  if (custom) return custom;
  // Fall back to theme-generated colour for calendars without a custom colour
  if (typeof getThemeCalendarColorByHash === 'function') {
    return getThemeCalendarColorByHash(name);
  }
  return null;
}

// ── Scroll schedule to current time ──────────────────────────────────────

function scrollScheduleToNow(smooth = false) {
  const wrapper = document.getElementById('schedule-timeline-wrapper');
  if (!wrapper) return;
  const ROW_H = 40;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const top = (nowMinutes / 30) * ROW_H;
  const target = Math.max(0, top - wrapper.clientHeight / 2);
  if (smooth) {
    wrapper.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    wrapper.scrollTop = target;
  }
}

// ── Now indicator ─────────────────────────────────────────────────────────

function updateNowIndicator() {
  const ROW_H   = 40;
  const START_H = 0;
  const END_H   = 24;
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = START_H * 60;
  const endMinutes   = END_H   * 60;

  let indicator = scheduleGrid.querySelector('.schedule-now-indicator');

  if (totalMinutes < startMinutes || totalMinutes > endMinutes) {
    if (indicator) indicator.remove();
    return;
  }

  const top = ((totalMinutes - startMinutes) / 30) * ROW_H;

  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'schedule-now-indicator';
    scheduleGrid.appendChild(indicator);
  }

  indicator.style.top = top + 'px';
}

// ── Week helpers ──────────────────────────────────────────────────────────

function getWeekStart(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getWeekDotStatus(dateStr, d) {
  const items = await getScheduleItems(dateStr);
  if (items.length === 0) return null;
  const tasks = items.filter(it => it.isTask);
  if (tasks.length === 0) return 'event';
  const todayStr = toYYMMDD(new Date());
  const dayMidnight = new Date(d);
  dayMidnight.setHours(0, 0, 0, 0);
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isPast = dayMidnight < todayMidnight;
  // For multi-day tasks: overdue only if end date has passed; otherwise still active
  const hasOverdue = isPast && tasks.some(t => {
    if (t.isCompleted) return false;
    if (t.endDate) return t.endDate < todayStr;
    return true;
  });
  if (hasOverdue) return 'overdue';
  if (tasks.every(t => t.isCompleted)) return 'done';
  return 'pending';
}

async function renderWeekRow() {
  const weekRowEl = document.getElementById('schedule-week-row');
  if (!weekRowEl) return;
  weekRowEl.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const selected = new Date(scheduleDate);
  selected.setHours(0, 0, 0, 0);
  const weekStart = getWeekStart(scheduleDate);
  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);

    const cell = document.createElement('div');
    cell.className = 'schedule-week-cell';
    if (i >= 5) cell.classList.add('weekend');

    const isToday    = d.getTime() === today.getTime();
    const isSelected = d.getTime() === selected.getTime();
    if (isToday)    cell.classList.add('today');
    if (isSelected) cell.classList.add('selected');

    const letterEl = document.createElement('span');
    letterEl.className = 'schedule-week-day-letter';
    letterEl.textContent = DAY_LETTERS[i];

    const numEl = document.createElement('span');
    numEl.className = 'schedule-week-day-num';
    numEl.textContent = d.getDate();

    cell.appendChild(letterEl);
    cell.appendChild(numEl);

    const dot = document.createElement('span');
    dot.className = 'schedule-week-dot';
    const dotStatus = await getWeekDotStatus(toYYMMDD(d), d);
    dot.classList.add(dotStatus ? 'dot-' + dotStatus : 'dot-empty');
    cell.appendChild(dot);

    cell.addEventListener('click', () => {
      scheduleDate = new Date(d);
      renderSchedule();
    });

    weekRowEl.appendChild(cell);
  }
}

// ── Build a clickable schedule item block ─────────────────────────────────

function _makeScheduleBlock(item, extraClass) {
  const block = document.createElement('div');
  block.className = 'schedule-item' + (extraClass ? ' ' + extraClass : '');

  // Apply calendar colour if set
  if (item.calendarTag) {
    const color = getCalendarColor(item.calendarTag);
    if (color) {
      block.style.borderLeftColor = color;
      // Tint background very lightly with the calendar colour
      const hex = color.replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      block.style.backgroundColor = `rgba(${r},${g},${b},0.15)`;
    }
  }

  if (item.isTask) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.isCompleted;
    cb.addEventListener('change', () => {
      // Optimistically update visual state immediately for instant feedback,
      // without waiting for the async re-render to complete.
      block.classList.toggle('completed', cb.checked);
      toggleScheduleTask(item.fileName, item.lineIndex, cb.checked);
    });
    block.appendChild(cb);
  } else {
    const icon = document.createElement('span');
    icon.className = 'schedule-event-icon';
    icon.textContent = '🗓️';
    block.appendChild(icon);
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'schedule-item-name';
  {
    let displayText = item.text;
    displayText = displayText.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => inner.replace(/_/g, ' ').trim());
    displayText = displayText.replace(/^#+\s*/, '');
    displayText = displayText.replace(/\s*>\s*\d{6}.*$/, '');
    displayText = displayText.replace(/^\s*[-*+]\s+/, '');
    displayText = displayText.replace(/^\s*\d+[.)]\s+/, '');
    displayText = displayText.replace(/^\s*- \[[ xX]\]\s+/, '');
    displayText = displayText.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Extract plain text only — strip all remaining inline markdown syntax
    // (bold, italic, code, etc.) by parsing and discarding the HTML markup.
    const _tmp = document.createElement('span');
    _tmp.innerHTML = marked.parseInline(displayText);
    nameSpan.textContent = _tmp.textContent;
  }
  nameSpan.addEventListener('click', () => {
    loadNote(item.fileName);
    closeMobilePanel('right');
    setTimeout(() => {
      if (isPreview) {
        highlightTextInPreview(stripMarkdownText(item.text));
      } else {
        const lines = textarea.value.split('\n');
        if (item.lineIndex >= 0 && item.lineIndex < lines.length) {
          const startOffset = lines.slice(0, item.lineIndex)
            .reduce((acc, l) => acc + l.length + 1, 0);
          textarea.setSelectionRange(startOffset,
            startOffset + lines[item.lineIndex].length);
          textarea.focus();
          // Scroll so the selected line is vertically centred in the textarea.
          textarea.scrollTop = Math.max(0, getLineScrollY(textarea, startOffset) - textarea.clientHeight / 2);
        }
      }
    }, 50);
  });
  block.appendChild(nameSpan);
  return block;
}

// ── Main schedule render ──────────────────────────────────────────────────

let _renderScheduleRunning = false;
let _renderScheduleQueued = false;

async function renderSchedule(cachedNotes) {
  // Serialize concurrent calls to prevent timer interleaving
  if (_renderScheduleRunning) {
    _renderScheduleQueued = true;
    return;
  }
  _renderScheduleRunning = true;
  try {
    await _doRenderSchedule(cachedNotes);
  } finally {
    _renderScheduleRunning = false;
    if (_renderScheduleQueued) {
      _renderScheduleQueued = false;
      renderSchedule();
    }
  }
}

async function _doRenderSchedule(cachedNotes) {
  if (!scheduleGrid) return;
  if (scheduleNowTimer) { clearInterval(scheduleNowTimer); scheduleNowTimer = null; }
  // Seed the schedule cache from pre-fetched notes if provided, so that
  // renderWeekRow and getScheduleItems below share the same data without
  // issuing additional getAllNotes() calls.
  await getScheduleCache(cachedNotes);
  await renderWeekRow();
  scheduleGrid.innerHTML = '';
  scheduleDateLabel.textContent = formatScheduleDate(scheduleDate);

  // Remove any previous all-day section
  const wrapper = scheduleGrid.parentElement;
  if (wrapper) {
    wrapper.querySelectorAll('.schedule-allday-section').forEach(el => el.remove());
  }

  const dateStr = toYYMMDD(scheduleDate);
  const allItems = await getScheduleItems(dateStr);

  const allDayItems = allItems.filter(it => it.isAllDay);
  const timedItems  = allItems.filter(it => !it.isAllDay);

  // ── Conflict detection: timed items whose starts are < 15 min apart ─────
  timedItems.forEach((item, i) => {
    const startMin = parseInt(item.startTime.slice(0, 2)) * 60 +
                     parseInt(item.startTime.slice(2));
    item._conflict = timedItems.some((other, j) => {
      if (i === j) return false;
      const otherMin = parseInt(other.startTime.slice(0, 2)) * 60 +
                       parseInt(other.startTime.slice(2));
      return Math.abs(startMin - otherMin) < 15;
    });
  });

  const ROW_H   = 40;
  const START_H = 0;
  const END_H   = 24;
  const SLOTS   = (END_H - START_H) * 2;   // 48 half-hour slots
  const ALLDAY_ITEM_H = 28;                 // height per all-day block (px)

  // ── All-day section ───────────────────────────────────────────────────────
  if (allDayItems.length > 0) {
    const section = document.createElement('div');
    section.className = 'schedule-allday-section';

    // Sort: events (non-task) above tasks
    const sorted = [
      ...allDayItems.filter(it => !it.isTask),
      ...allDayItems.filter(it =>  it.isTask)
    ];

    sorted.forEach(item => {
      const isPastEvent = !item.isTask && dateStr < toYYMMDD(new Date());
      const cls = (item.isCompleted || isPastEvent) ? 'completed' : '';
      const block = _makeScheduleBlock(item, cls);
      block.style.height = ALLDAY_ITEM_H + 'px';
      section.appendChild(block);
    });

    // Insert section above the grid
    if (wrapper) {
      wrapper.insertBefore(section, scheduleGrid);
    }
  }

  // ── Timed grid ────────────────────────────────────────────────────────────
  scheduleGrid.style.height = (SLOTS * ROW_H) + 'px';

  // Gridlines + time labels — batch via DocumentFragment to avoid layout thrashing
  const gridFrag = document.createDocumentFragment();
  for (let s = 0; s <= SLOTS; s++) {
    const hour = START_H + Math.floor(s / 2);
    const min  = (s % 2) * 30;
    const top  = s * ROW_H;

    const gl = document.createElement('div');
    gl.className = 'schedule-gridline' + (min === 0 ? ' schedule-gridline-hour' : '');
    gl.style.top = top + 'px';
    gridFrag.appendChild(gl);

    if (min === 0 && hour < 24) {
      const lbl = document.createElement('div');
      lbl.className = 'schedule-time-label';
      lbl.textContent = hour === 0 ? '12 AM'
        : hour < 12 ? hour + ' AM'
        : hour === 12 ? '12 PM'
        : (hour - 12) + ' PM';
      lbl.style.top = top + 'px';
      gridFrag.appendChild(lbl);
    }
  }
  scheduleGrid.appendChild(gridFrag);

  // Place timed items
  const gridStart  = START_H * 60;
  const now        = new Date();
  const nowStr     = toYYMMDD(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  timedItems.forEach(item => {
    const startMin = parseInt(item.startTime.slice(0, 2)) * 60 +
                     parseInt(item.startTime.slice(2));
    const endMin   = parseInt(item.endTime.slice(0, 2))   * 60 +
                     parseInt(item.endTime.slice(2));
    const clampedStart = Math.max(startMin, gridStart);
    const clampedEnd   = Math.min(endMin, END_H * 60);
    if (clampedStart >= clampedEnd) return;

    const top    = ((clampedStart - gridStart) / 30) * ROW_H + 2;
    const height = Math.max(((clampedEnd - clampedStart) / 30) * ROW_H - 4, ROW_H / 2 - 4);

    const isPastEvent = !item.isTask && (
      dateStr < nowStr ||
      (dateStr === nowStr && endMin <= nowMinutes)
    );

    const classes = [
      (item.isCompleted || isPastEvent) ? 'completed' : '',
      item._conflict ? 'conflict' : ''
    ].filter(Boolean).join(' ');

    const block = _makeScheduleBlock(item, classes);
    block.style.top    = top + 'px';
    block.style.height = height + 'px';

    scheduleGrid.appendChild(block);
  });

  // Empty-state hint when there are no items for the selected day
  if (allItems.length === 0 && wrapper) {
    const existing = wrapper.querySelector('.schedule-panel-hint');
    if (!existing) {
      const hint = document.createElement('div');
      hint.className = 'panel-hint schedule-panel-hint';
      hint.innerHTML = 'Add <code>> YYMMDD</code> after any line<br>to place it on the calendar.';
      wrapper.insertBefore(hint, scheduleGrid);
    }
  } else if (wrapper) {
    const existing = wrapper.querySelector('.schedule-panel-hint');
    if (existing) existing.remove();
  }

  // Current time indicator + auto-scroll to now (today only)
  if (dateStr === toYYMMDD(new Date())) {
    updateNowIndicator();
    clearInterval(scheduleNowTimer);
    scheduleNowTimer = setInterval(updateNowIndicator, 60000);
    // Only scroll to current time when the schedule view is first opened,
    // not on every background refresh while it is already visible.
    if (scheduleNeedsScrollToNow) {
      scheduleNeedsScrollToNow = false;
      // Wait for layout to settle, then smooth-scroll to now
      requestAnimationFrame(() => scrollScheduleToNow(true));
    }
  }

  // Typeset math in schedule items. Lazy-load MathJax if needed and there is
  // math content in any of the current items.
  const scheduleContainer = wrapper || scheduleGrid;
  if (scheduleContainer) {
    const hasMath = allItems.some(it =>
      /\$\$[\s\S]+?\$\$|\$[^\n$]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(it.text || '')
    );
    if (hasMath && window.MathJax?.typesetPromise) {
      MathJax.typesetPromise([scheduleContainer]).catch(() => {});
    }
  }
}

async function toggleScheduleTask(fileName, lineIndex, checked) {
  invalidateScheduleCache();
  const content = await NoteStorage.getNote(fileName);
  if (!content) return;
  const lines = content.split(/\n/);
  if (lineIndex >= 0 && lineIndex < lines.length) {
    lines[lineIndex] = lines[lineIndex].replace(/- \[[ xX]\]/, checked ? '- [x]' : '- [ ]');
    await NoteStorage.setNote(fileName, lines.join('\n'));
    if (currentFileName === fileName) {
      textarea.value = lines.join('\n');
      if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
    }
  }
  await updateTodoList();
  await renderSchedule();
}
