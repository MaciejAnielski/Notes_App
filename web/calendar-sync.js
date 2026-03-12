// calendar-sync.js — Bidirectional iOS Calendar ↔ Markdown sync.
//
// Stores event metadata as JSON within HTML comments immediately after the
// "# Title" line in daily notes named "YYMMDD Daily Notes.md".
//
// Event syntax in markdown:
//   Event Text > YYMMDD              — all-day event
//   Event Text > YYMMDD YYMMDD       — multi-day event
//   Event Text > YYMMDD HHMM HHMM   — timed event
//
// Calendar selection is stored in a note called "Calendars" using plain
// checkbox syntax: [x] CalendarName or [ ] CalendarName.

const CALENDARS_NOTE = 'Calendars';
const DAILY_NOTE_SUFFIX = ' Daily Note';
const CALENDAR_META_RE = /<!-- calendar_events: ({.*?}) -->/;
const CALENDAR_SYNC_INTERVAL = 300000; // 5 minutes
const NOTES_APP_CALENDAR_NAME = 'Notes App Events';

let _calendarPlugin = null;
let _calendarSyncTimer = null;
let _calendarSyncing = false;
let _notesAppCalendarId = null;

// ── Plugin access ────────────────────────────────────────────────────────────

function getCalendarPlugin() {
  if (_calendarPlugin) return _calendarPlugin;
  if (window.Capacitor?.Plugins?.CalendarPlugin) {
    _calendarPlugin = window.Capacitor.Plugins.CalendarPlugin;
    return _calendarPlugin;
  }
  return null;
}

// ── Notes App Events calendar ────────────────────────────────────────────────

async function getOrCreateNotesAppCalendarId() {
  if (_notesAppCalendarId) return _notesAppCalendarId;
  const plugin = getCalendarPlugin();
  if (!plugin) return null;
  try {
    const result = await plugin.getOrCreateCalendar({ title: NOTES_APP_CALENDAR_NAME });
    _notesAppCalendarId = result.calendarId || null;
  } catch {
    _notesAppCalendarId = null;
  }
  return _notesAppCalendarId;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function yymmddToDate(yymmdd) {
  const yy = parseInt(yymmdd.slice(0, 2));
  const mm = parseInt(yymmdd.slice(2, 4)) - 1;
  const dd = parseInt(yymmdd.slice(4, 6));
  return new Date(2000 + yy, mm, dd);
}

function dateToYYMMDD(d) {
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

function hhmmToTime(hhmm) {
  return { h: parseInt(hhmm.slice(0, 2)), m: parseInt(hhmm.slice(2)) };
}

function dailyNoteName(yymmdd) {
  return yymmdd + DAILY_NOTE_SUFFIX;
}

// ── Calendar selection management ────────────────────────────────────────────

async function getSelectedCalendarIds() {
  const content = await NoteStorage.getNote(CALENDARS_NOTE);
  if (!content) return [];
  const ids = [];
  const lines = content.split('\n');
  // Lines format: [x] CalendarTitle {calendarId}
  const re = /^\[([xX])\]\s+(.+?)\s*\{([^}]+)\}\s*$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      ids.push(m[3]);
    }
  }
  return ids;
}

async function updateCalendarsNote() {
  const plugin = getCalendarPlugin();
  if (!plugin) return;

  let result;
  try {
    result = await plugin.listCalendars();
  } catch { return; }

  const calendars = result.calendars || [];
  if (calendars.length === 0) return;

  // Read existing note to preserve user selections
  const existing = await NoteStorage.getNote(CALENDARS_NOTE);
  const selectedIds = new Set();
  if (existing) {
    const re = /^\[([xX])\]\s+(.+?)\s*\{([^}]+)\}\s*$/;
    for (const line of existing.split('\n')) {
      const m = line.match(re);
      if (m) selectedIds.add(m[3]);
    }
  }

  // Build new note content
  const lines = ['# Calendars', '', 'Select calendars to sync with your daily notes:', ''];
  calendars
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach(cal => {
      const checked = selectedIds.has(cal.id) ? 'x' : ' ';
      lines.push(`[${checked}] ${cal.title} {${cal.id}}`);
    });

  const newContent = lines.join('\n') + '\n';
  await NoteStorage.setNote(CALENDARS_NOTE, newContent);

  // Update editor if this note is currently open
  if (currentFileName === CALENDARS_NOTE) {
    textarea.value = newContent;
    if (isPreview) renderPreview();
  }
}

// ── Parse markdown events from daily note ────────────────────────────────────

function parseMarkdownEvents(content, noteDate) {
  const events = [];
  const lines = content.split('\n');
  // Timed: Text > YYMMDD HHMM HHMM
  const reT = /^(.+?)\s*>\s*(\d{6})\s+(\d{4})\s+(\d{4})\s*$/;
  // Multi-day: Text > YYMMDD YYMMDD
  const reM = /^(.+?)\s*>\s*(\d{6})\s+(\d{6})\s*$/;
  // All-day: Text > YYMMDD
  const reA = /^(.+?)\s*>\s*(\d{6})\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip tasks — only process non-task events
    if (/^- \[[ xX]\]/.test(line)) continue;

    let m;
    if ((m = line.match(reT))) {
      const text = m[1].replace(/^[-*+]\s+/, '').replace(/^#+\s*/, '').trim();
      if (!text) continue;
      const date = yymmddToDate(m[2]);
      const start = hhmmToTime(m[3]);
      const end = hhmmToTime(m[4]);
      const startDate = new Date(date);
      startDate.setHours(start.h, start.m, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(end.h, end.m, 0, 0);
      events.push({ text, startDate, endDate, allDay: false, lineIndex: i });
    } else if ((m = line.match(reM))) {
      const text = m[1].replace(/^[-*+]\s+/, '').replace(/^#+\s*/, '').trim();
      if (!text) continue;
      events.push({
        text,
        startDate: yymmddToDate(m[2]),
        endDate: yymmddToDate(m[3]),
        allDay: true,
        lineIndex: i
      });
    } else if ((m = line.match(reA))) {
      const text = m[1].replace(/^[-*+]\s+/, '').replace(/^#+\s*/, '').trim();
      if (!text) continue;
      const date = yymmddToDate(m[2]);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      events.push({ text, startDate: date, endDate, allDay: true, lineIndex: i });
    }
  }
  return events;
}

// ── Parse calendar metadata from HTML comment ────────────────────────────────

function parseCalendarMetadata(content) {
  const m = content.match(CALENDAR_META_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function updateCalendarMetadata(content, metadata) {
  const json = JSON.stringify(metadata);
  const comment = `<!-- calendar_events: ${json} -->`;

  if (CALENDAR_META_RE.test(content)) {
    return content.replace(CALENDAR_META_RE, comment);
  }

  // Insert after the first "# Title" line
  const lines = content.split('\n');
  let insertIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) {
      insertIdx = i + 1;
      break;
    }
  }
  lines.splice(insertIdx, 0, comment);
  return lines.join('\n');
}

// ── Sync: Calendar → Markdown ────────────────────────────────────────────────
// Fetches events from iOS calendar and appends missing ones to daily notes.

async function syncCalendarToMarkdown(calendarIds) {
  const plugin = getCalendarPlugin();
  if (!plugin || calendarIds.length === 0) return;

  // Determine sync range: from first sync date to 30 days in future
  let firstSyncDateStr;
  try {
    const result = await plugin.getFirstSyncDate();
    firstSyncDateStr = result.date;
  } catch { return; }

  const today = new Date();
  const startDate = firstSyncDateStr
    ? new Date(firstSyncDateStr)
    : today;

  // Don't sync events from before the first sync
  if (!firstSyncDateStr) {
    try {
      await plugin.setFirstSyncDate({ date: today.toISOString() });
    } catch {}
  }

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 30);

  let calendarEvents;
  try {
    const result = await plugin.fetchEvents({
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      calendarIds
    });
    calendarEvents = result.events || [];
  } catch { return; }

  // Group events by date (YYMMDD)
  const eventsByDate = {};
  for (const evt of calendarEvents) {
    const evtStart = new Date(evt.startDate);
    const evtEnd = new Date(evt.endDate);
    const dateStr = dateToYYMMDD(evtStart);

    if (!eventsByDate[dateStr]) eventsByDate[dateStr] = [];
    eventsByDate[dateStr].push(evt);
  }

  // Process each date
  for (const [dateStr, events] of Object.entries(eventsByDate)) {
    const noteName = dailyNoteName(dateStr);
    let content = await NoteStorage.getNote(noteName);
    let isNew = false;

    if (content === null) {
      // Create daily note — heading matches the file name
      content = `# ${noteName}\n\n`;
      isNew = true;
    }

    // Parse existing metadata to avoid duplicates
    const meta = parseCalendarMetadata(content) || { events: [] };
    const existingIds = new Set(meta.events.map(e => e.eventId));
    let modified = false;

    for (const evt of events) {
      if (existingIds.has(evt.eventId)) continue;

      // Format the event as markdown
      const evtStart = new Date(evt.startDate);
      const evtEnd = new Date(evt.endDate);
      let mdLine;

      if (evt.allDay) {
        // Check if multi-day
        const startStr = dateToYYMMDD(evtStart);
        const endDateAdj = new Date(evtEnd);
        endDateAdj.setDate(endDateAdj.getDate() - 1);
        const endStr = dateToYYMMDD(endDateAdj);

        if (startStr !== endStr && endStr > startStr) {
          mdLine = `${evt.title} > ${startStr} ${endStr}`;
        } else {
          mdLine = `${evt.title} > ${startStr}`;
        }
      } else {
        const hh1 = String(evtStart.getHours()).padStart(2, '0');
        const mm1 = String(evtStart.getMinutes()).padStart(2, '0');
        const hh2 = String(evtEnd.getHours()).padStart(2, '0');
        const mm2 = String(evtEnd.getMinutes()).padStart(2, '0');
        mdLine = `${evt.title} > ${dateStr} ${hh1}${mm1} ${hh2}${mm2}`;
      }

      content += mdLine + '\n';
      meta.events.push({
        eventId: evt.eventId,
        title: evt.title,
        lineText: mdLine
      });
      modified = true;
    }

    if (modified) {
      content = updateCalendarMetadata(content, meta);
      await NoteStorage.setNote(noteName, content);

      // Update editor if this note is open
      if (currentFileName === noteName) {
        textarea.value = content;
        if (isPreview) renderPreview();
      }
    }
  }
}

// ── Sync: Markdown → Calendar ────────────────────────────────────────────────
// Parses event syntax from daily notes and creates calendar events.

async function syncMarkdownToCalendar(calendarIds) {
  const plugin = getCalendarPlugin();
  if (!plugin || calendarIds.length === 0) return;

  // Always write new events into the dedicated "Notes App Events" iCloud calendar.
  const notesAppCalendarId = await getOrCreateNotesAppCalendarId();

  // Get the first sync date to limit scope
  let firstSyncDateStr;
  try {
    const result = await plugin.getFirstSyncDate();
    firstSyncDateStr = result.date;
  } catch { return; }

  if (!firstSyncDateStr) return;
  const firstSync = new Date(firstSyncDateStr);
  const firstSyncYYMMDD = dateToYYMMDD(firstSync);

  // Find all daily notes from first sync date onwards
  const allNotes = await NoteStorage.getAllNotes();
  const dailyNoteRe = /^(\d{6}) Daily Note$/;

  for (const { name, content } of allNotes) {
    const m = name.match(dailyNoteRe);
    if (!m) continue;
    const noteDate = m[1];

    // Skip notes before first sync
    if (noteDate < firstSyncYYMMDD) continue;

    const mdEvents = parseMarkdownEvents(content, noteDate);
    if (mdEvents.length === 0) continue;

    const meta = parseCalendarMetadata(content) || { events: [] };
    const existingTexts = new Set(meta.events.map(e => e.lineText));
    let modified = false;

    for (const evt of mdEvents) {
      // Build the line text for matching
      const lines = content.split('\n');
      const lineText = (evt.lineIndex < lines.length) ? lines[evt.lineIndex].trim() : '';

      // Skip if already synced
      if (existingTexts.has(lineText)) continue;

      // Validate event syntax before creating
      if (!evt.text || !evt.startDate) continue;

      try {
        const result = await plugin.createEvent({
          title: evt.text,
          startDate: evt.startDate.toISOString(),
          endDate: evt.endDate.toISOString(),
          allDay: evt.allDay,
          calendarId: notesAppCalendarId ?? calendarIds[0]
        });

        meta.events.push({
          eventId: result.eventId,
          title: evt.text,
          lineText
        });
        modified = true;
      } catch {
        // Skip events that fail to create
      }
    }

    if (modified) {
      let updatedContent = updateCalendarMetadata(content, meta);
      await NoteStorage.setNote(name, updatedContent);

      if (currentFileName === name) {
        textarea.value = updatedContent;
        if (isPreview) renderPreview();
      }
    }
  }
}

// ── One-time migration: "YYMMDD Daily Notes" → "YYMMDD Daily Note" ──────────
// Also fixes the "# Title" heading inside each note to match the new name.

const MIGRATION_KEY = 'calendar_daily_notes_migrated';

async function migrateDailyNoteNames() {
  if (localStorage.getItem(MIGRATION_KEY)) return;

  const allNotes = await NoteStorage.getAllNotes();
  const oldRe = /^(\d{6}) Daily Notes$/;

  for (const { name, content } of allNotes) {
    const m = name.match(oldRe);
    if (!m) continue;

    const dateStr = m[1];
    const newName = dateStr + ' Daily Note';

    // Check whether the new name already exists
    const existing = await NoteStorage.getNote(newName);

    let finalContent;
    if (existing) {
      // Merge: append old content (minus its heading) into the existing note
      const oldBody = content.replace(/^#\s+.*\n?/, '');
      finalContent = existing.trimEnd() + '\n' + oldBody;
    } else {
      finalContent = content;
    }

    // Fix the heading to match the new filename
    if (/^#\s/.test(finalContent)) {
      finalContent = finalContent.replace(/^#\s+.*/, `# ${newName}`);
    } else {
      finalContent = `# ${newName}\n` + finalContent;
    }

    await NoteStorage.setNote(newName, finalContent);
    await NoteStorage.removeNote(name);

    // If the user currently has the old note open, switch to the new one
    if (currentFileName === name) {
      currentFileName = newName;
      localStorage.setItem('current_file', newName);
      textarea.value = finalContent;
      if (isPreview) renderPreview();
    }
  }

  localStorage.setItem(MIGRATION_KEY, '1');
}

// ── Main sync orchestrator ───────────────────────────────────────────────────

async function runCalendarSync() {
  if (_calendarSyncing) return;
  _calendarSyncing = true;

  try {
    const plugin = getCalendarPlugin();
    if (!plugin) return;

    // Request access
    let access;
    try {
      access = await plugin.requestAccess();
    } catch { return; }
    if (!access.granted) return;

    // One-time rename: "YYMMDD Daily Notes" → "YYMMDD Daily Note"
    await migrateDailyNoteNames();

    // Ensure Calendars note exists
    await updateCalendarsNote();

    // Get selected calendars
    const calendarIds = await getSelectedCalendarIds();
    if (calendarIds.length === 0) return;

    // Bidirectional sync
    await syncCalendarToMarkdown(calendarIds);
    await syncMarkdownToCalendar(calendarIds);

    invalidateScheduleCache();
  } catch (err) {
    console.error('Calendar sync error:', err);
  } finally {
    _calendarSyncing = false;
  }
}

// ── Start / stop calendar sync ───────────────────────────────────────────────

async function startCalendarSync() {
  const plugin = getCalendarPlugin();
  if (!plugin) return;

  // Run initial sync
  await runCalendarSync();

  // Set up periodic sync
  if (_calendarSyncTimer) clearInterval(_calendarSyncTimer);
  _calendarSyncTimer = setInterval(runCalendarSync, CALENDAR_SYNC_INTERVAL);

  // Watch for calendar changes
  try {
    await plugin.startWatching();
    // The plugin fires 'calendarChanged' events
    if (window.Capacitor?.Plugins?.CalendarPlugin) {
      window.Capacitor.Plugins.CalendarPlugin.addListener('calendarChanged', () => {
        // Debounce — wait a bit for batch changes to settle
        setTimeout(runCalendarSync, 2000);
      });
    }
  } catch {}
}

function stopCalendarSync() {
  if (_calendarSyncTimer) {
    clearInterval(_calendarSyncTimer);
    _calendarSyncTimer = null;
  }
  const plugin = getCalendarPlugin();
  if (plugin) {
    try { plugin.stopWatching(); } catch {}
  }
}

// ── Auto-start on iOS ────────────────────────────────────────────────────────

if (window.Capacitor?.isNativePlatform()) {
  // Wait for app init to complete, then start calendar sync
  window.addEventListener('load', () => {
    setTimeout(startCalendarSync, 3000);
  });

  document.addEventListener('resume', () => {
    setTimeout(runCalendarSync, 1000);
  });
  document.addEventListener('pause', stopCalendarSync);
}
