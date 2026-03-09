// schedule.js — Schedule view: cache, rendering, week row, and navigation.
//
// Manages the daily schedule grid showing timed events and tasks parsed
// from note content using the > YYMMDD HHMM HHMM syntax.

// ── Schedule cache ────────────────────────────────────────────────────────
let _scheduleCache = null;

async function _buildScheduleCache() {
  const cache = {};
  const re = />\s*(\d{6})\s+(\d{4})\s+(\d{4})\s*$/;
  const allNotes = await NoteStorage.getAllNotes();
  for (const { name: fileName, content } of allNotes) {
    if (!content) continue;
    content.split(/\n/).forEach((line, idx) => {
      const m = line.match(re);
      if (!m) return;
      const dateStr = m[1];
      if (!cache[dateStr]) cache[dateStr] = [];
      const trimmed = line.trim();
      const isTask = /^- \[[ xX]\]/.test(trimmed);
      const isCompleted = /^- \[[xX]\]/.test(trimmed);
      let text = trimmed.replace(re, '');
      if (isTask) text = text.replace(/^- \[[ xX]\]\s*/, '');
      cache[dateStr].push({ fileName, lineIndex: idx, text: text.trim(), startTime: m[2], endTime: m[3], isTask, isCompleted });
    });
  }
  for (const dateStr of Object.keys(cache)) {
    cache[dateStr].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  return cache;
}

function invalidateScheduleCache() {
  _scheduleCache = null;
}

async function getScheduleCache() {
  if (!_scheduleCache) _scheduleCache = await _buildScheduleCache();
  return _scheduleCache;
}

async function getScheduleItems(dateStr) {
  const cache = await getScheduleCache();
  return cache[dateStr] || [];
}

// ── Now indicator ─────────────────────────────────────────────────────────

function updateNowIndicator() {
  const ROW_H = 40;
  const START_H = 7;
  const END_H = 19;
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = START_H * 60;
  const endMinutes = END_H * 60;

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
  const dayMidnight = new Date(d);
  dayMidnight.setHours(0, 0, 0, 0);
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isPast = dayMidnight < todayMidnight;
  if (isPast && tasks.some(t => !t.isCompleted)) return 'overdue';
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

    const isToday = d.getTime() === today.getTime();
    const isSelected = d.getTime() === selected.getTime();
    if (isToday) cell.classList.add('today');
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
    if (dotStatus) {
      dot.classList.add('dot-' + dotStatus);
    } else {
      dot.classList.add('dot-empty');
    }
    cell.appendChild(dot);

    cell.addEventListener('click', () => {
      scheduleDate = new Date(d);
      renderSchedule();
    });

    weekRowEl.appendChild(cell);
  }
}

// ── Main schedule render ──────────────────────────────────────────────────

async function renderSchedule() {
  if (!scheduleGrid) return;
  if (scheduleNowTimer) { clearInterval(scheduleNowTimer); scheduleNowTimer = null; }
  await renderWeekRow();
  scheduleGrid.innerHTML = '';
  scheduleDateLabel.textContent = formatScheduleDate(scheduleDate);

  const dateStr = toYYMMDD(scheduleDate);
  const items = await getScheduleItems(dateStr);

  const ROW_H = 40;
  const START_H = 7;
  const END_H = 19;
  const SLOTS = (END_H - START_H) * 2;

  scheduleGrid.style.height = (SLOTS * ROW_H) + 'px';

  // Gridlines + time labels
  for (let s = 0; s <= SLOTS; s++) {
    const hour = START_H + Math.floor(s / 2);
    const min = (s % 2) * 30;
    const top = s * ROW_H;

    const gl = document.createElement('div');
    gl.className = 'schedule-gridline' + (min === 0 ? ' schedule-gridline-hour' : '');
    gl.style.top = top + 'px';
    scheduleGrid.appendChild(gl);

    if (min === 0) {
      const lbl = document.createElement('div');
      lbl.className = 'schedule-time-label';
      lbl.textContent = (hour % 12 || 12) + (hour < 12 ? ' AM' : ' PM');
      lbl.style.top = top + 'px';
      scheduleGrid.appendChild(lbl);
    }
  }

  // Place items
  const gridStart = START_H * 60;
  const now = new Date();
  const nowStr = toYYMMDD(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  items.forEach(item => {
    const startMin = parseInt(item.startTime.slice(0, 2)) * 60 + parseInt(item.startTime.slice(2));
    const endMin   = parseInt(item.endTime.slice(0, 2))   * 60 + parseInt(item.endTime.slice(2));
    const clampedStart = Math.max(startMin, gridStart);
    const clampedEnd   = Math.min(endMin, END_H * 60);
    if (clampedStart >= clampedEnd) return;

    const top    = ((clampedStart - gridStart) / 30) * ROW_H + 2;
    const height = Math.max(((clampedEnd - clampedStart) / 30) * ROW_H - 4, ROW_H / 2 - 4);

    const isPastEvent = !item.isTask && (
      dateStr < nowStr ||
      (dateStr === nowStr && endMin <= nowMinutes)
    );

    const block = document.createElement('div');
    block.className = 'schedule-item' + ((item.isCompleted || isPastEvent) ? ' completed' : '');
    block.style.top    = top + 'px';
    block.style.height = height + 'px';

    if (item.isTask) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.isCompleted;
      cb.addEventListener('change', () => toggleScheduleTask(item.fileName, item.lineIndex, cb.checked));
      block.appendChild(cb);
    } else {
      const icon = document.createElement('span');
      icon.className = 'schedule-event-icon';
      icon.textContent = '🗓️';
      block.appendChild(icon);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'schedule-item-name';
    nameSpan.textContent = stripMarkdownText(item.text);
    nameSpan.addEventListener('click', () => {
      loadNote(item.fileName);
      closeMobilePanel('right');
      setTimeout(() => {
        if (isPreview) {
          highlightTextInPreview(stripMarkdownText(item.text));
        } else {
          const lines = textarea.value.split('\n');
          if (item.lineIndex >= 0 && item.lineIndex < lines.length) {
            const startOffset = lines.slice(0, item.lineIndex).reduce((acc, l) => acc + l.length + 1, 0);
            textarea.setSelectionRange(startOffset, startOffset + lines[item.lineIndex].length);
            textarea.focus();
          }
        }
      }, 50);
    });
    block.appendChild(nameSpan);

    scheduleGrid.appendChild(block);
  });

  // Current time indicator (today only)
  if (dateStr === toYYMMDD(new Date())) {
    updateNowIndicator();
    scheduleNowTimer = setInterval(updateNowIndicator, 60000);
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
      if (isPreview || projectsViewActive) renderPreview();
    }
  }
  await updateTodoList();
}
