// calendar-sync.js — Bidirectional iOS Calendar ↔ Markdown sync.
//
// Stores event metadata as JSON within HTML comments immediately after the
// "# Title" line in daily notes named "YYMMDD Daily Notes.md".
//
// Event syntax in markdown:
//   Event Text > YYMMDD                        — all-day event
//   Event Text > YYMMDD YYMMDD                 — multi-day event
//   Event Text > YYMMDD HHMM HHMM              — timed event
//   Event Text > YYMMDD @CalendarName          — routed to a specific calendar
//   Event Text > YYMMDD HHMM HHMM @CalendarName
//
// The optional @CalendarName tag (no spaces; case-insensitive) routes new
// events to a named iOS calendar.  If omitted, events go to "Notes App Events".
//
// Calendar selection is stored in the "Settings" note under the "## 📅 Calendars"
// subheading using plain checkbox syntax: [x] CalendarName or [ ] CalendarName.

const DAILY_NOTE_SUFFIX = ' Daily Note';
const CALENDAR_META_RE = /<!-- calendar_events: ({.*?}) -->/;
const CALENDAR_METADATA_NOTE = '.calendar_metadata';
const CALENDAR_SYNC_INTERVAL = 300000; // 5 minutes
const NOTES_APP_CALENDAR_NAME = 'Notes App Events';

let _calendarPlugin = null;
let _calendarSyncTimer = null;
let _calendarSyncing = false;
let _notesAppCalendarId = null;
let _calendarsByTitle = null; // Map<lowerCaseTitle, calendarId>, built on demand

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

// ── Calendar title → ID lookup ───────────────────────────────────────────────

async function getCalendarsByTitle() {
  if (_calendarsByTitle) return _calendarsByTitle;
  const plugin = getCalendarPlugin();
  if (!plugin) return new Map();
  try {
    const result = await plugin.listCalendars();
    _calendarsByTitle = new Map(
      (result.calendars || []).map(c => [c.title.toLowerCase(), c.id])
    );
  } catch {
    _calendarsByTitle = new Map();
  }
  return _calendarsByTitle;
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

  // Read existing note to preserve user selections and Theme section content.
  const existing = await NoteStorage.getNote(CALENDARS_NOTE);
  const selectedIds = new Set();
  if (existing) {
    const re = /^\[([xX])\]\s+(.+?)\s*\{([^}]+)\}\s*$/;
    for (const line of existing.split('\n')) {
      const m = line.match(re);
      if (m) selectedIds.add(m[3]);
    }
  }

  // Extract existing Sync section body to preserve it across rebuilds.
  let syncBody = '\nSync notes across devices using your email address.\n';
  if (existing) {
    const syncMatch = existing.match(/## ☁️ Sync([\s\S]*?)(?=\n##|$)/);
    if (syncMatch) syncBody = syncMatch[1];
  }

  // Extract existing Theme section content to preserve it across rebuilds.
  let themeBody = '\nCustomise the app\'s background and accent colours.\n';
  if (existing) {
    const themeMatch = existing.match(/## 🎨 Theme([\s\S]*?)(?=\n##|$)/);
    if (themeMatch) themeBody = themeMatch[1];
  }

  // Extract existing Projects Note Emojis section to preserve it across rebuilds.
  let emojiBody = '\nCustomise the emojis used in the Projects note.\n';
  if (existing) {
    const emojiMatch = existing.match(/### Projects Note Emojis([\s\S]*?)(?=\n##|$)/);
    if (emojiMatch) emojiBody = emojiMatch[1];
  }

  // Build new note content — Sync, Theme, and Projects Note Emojis sections always present;
  // Calendars section only when the iOS calendar plugin returned at least one calendar.
  const lines = [
    '# Settings', '',
    '## ☁️ Sync' + syncBody.trimEnd(), '',
    '## 🎨 Theme' + themeBody.trimEnd(), '',
    '### Projects Note Emojis' + emojiBody.trimEnd(), ''
  ];
  if (calendars.length > 0) {
    lines.push('## 📅 Calendars', '', 'Select calendars to sync with your daily notes:', '');
    calendars
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach(cal => {
        const checked = selectedIds.has(cal.id) ? 'x' : ' ';
        lines.push(`[${checked}] ${cal.title} {${cal.id}}`);
      });
  }

  // Seed native iOS calendar colors into localStorage for calendars that don't
  // already have a user-customized color. This ensures each calendar displays
  // its native iOS color in the Settings note and schedule view on first use.
  if (calendars.length > 0) {
    try {
      const existingColors = JSON.parse(localStorage.getItem('calendar_colors') || '{}');
      let colorsUpdated = false;
      for (const cal of calendars) {
        if (cal.color && cal.color !== '#888888' && !existingColors[cal.title]) {
          existingColors[cal.title] = cal.color;
          colorsUpdated = true;
        }
      }
      if (colorsUpdated) {
        localStorage.setItem('calendar_colors', JSON.stringify(existingColors));
      }
    } catch { /* non-fatal */ }
  }

  const newContent = lines.join('\n') + '\n';
  // Only write if content has actually changed to avoid unnecessary sync
  if (newContent === (existing || '')) return;
  await NoteStorage.setNote(CALENDARS_NOTE, newContent);

  // Update editor if this note is currently open
  if (currentFileName === CALENDARS_NOTE) {
    textarea.value = newContent;
    if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
  }
}

// ── Parse markdown events from daily note ────────────────────────────────────

function parseMarkdownEvents(content, noteDate) {
  const events = [];
  const lines = content.split('\n');
  // Timed: Text > YYMMDD HHMM HHMM [@CalendarName]
  const reT = /^(.+?)\s*>\s*(\d{6})\s+(\d{4})\s+(\d{4})(?:\s+@(\S+))?\s*$/;
  // Multi-day: Text > YYMMDD YYMMDD [@CalendarName]
  const reM = /^(.+?)\s*>\s*(\d{6})\s+(\d{6})(?:\s+@(\S+))?\s*$/;
  // All-day: Text > YYMMDD [@CalendarName]
  const reA = /^(.+?)\s*>\s*(\d{6})(?:\s+@(\S+))?\s*$/;

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
      events.push({ text, startDate, endDate, allDay: false, lineIndex: i, calendarTag: m[5] || null });
    } else if ((m = line.match(reM))) {
      const text = m[1].replace(/^[-*+]\s+/, '').replace(/^#+\s*/, '').trim();
      if (!text) continue;
      events.push({
        text,
        startDate: yymmddToDate(m[2]),
        endDate: yymmddToDate(m[3]),
        allDay: true,
        lineIndex: i,
        calendarTag: m[4] || null
      });
    } else if ((m = line.match(reA))) {
      const text = m[1].replace(/^[-*+]\s+/, '').replace(/^#+\s*/, '').trim();
      if (!text) continue;
      const date = yymmddToDate(m[2]);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      events.push({ text, startDate: date, endDate, allDay: true, lineIndex: i, calendarTag: m[3] || null });
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

// ── Centralised metadata store ───────────────────────────────────────────────
// All per-note event metadata is stored in a single hidden note so that daily
// notes remain free of machine-generated HTML comments.

async function loadMetadataStore() {
  const content = await NoteStorage.getNote(CALENDAR_METADATA_NOTE);
  if (!content) return {};
  try { return JSON.parse(content); } catch { return {}; }
}

async function saveMetadataStore(store) {
  await NoteStorage.setNote(CALENDAR_METADATA_NOTE, JSON.stringify(store));
}

// ── Sync: Calendar → Markdown ────────────────────────────────────────────────
// Fetches events from iOS calendar and appends missing ones to daily notes.

async function syncCalendarToMarkdown(calendarIds) {
  const plugin = getCalendarPlugin();
  if (!plugin || calendarIds.length === 0) return;

  const notesAppCalendarId = await getOrCreateNotesAppCalendarId();
  const store = await loadMetadataStore();
  let storeModified = false;

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
    if (!evt.startDate || !evt.endDate) continue;
    const evtStart = new Date(evt.startDate);
    const evtEnd = new Date(evt.endDate);
    if (isNaN(evtStart.getTime()) || isNaN(evtEnd.getTime())) continue;
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

    // Load existing metadata from store to avoid duplicates
    const meta = store[noteName] || { events: [] };
    const existingIds = new Set(meta.events.map(e => e.eventId));
    let modified = false;

    for (const evt of events) {
      if (existingIds.has(evt.eventId)) continue;

      // Format the event as markdown
      const evtStart = new Date(evt.startDate);
      const evtEnd = new Date(evt.endDate);
      let mdLine;

      // Append @CalendarName tag for events not in Notes App Events
      const isNotesAppEvent = evt.calendarId === notesAppCalendarId;
      const calendarTag = isNotesAppEvent
        ? null
        : (evt.calendarTitle || '').replace(/\s+/g, '') || null;
      const tagSuffix = calendarTag ? ` @${calendarTag}` : '';

      if (evt.allDay) {
        // Check if multi-day
        const startStr = dateToYYMMDD(evtStart);
        const endDateAdj = new Date(evtEnd);
        endDateAdj.setDate(endDateAdj.getDate() - 1);
        const endStr = dateToYYMMDD(endDateAdj);

        if (startStr !== endStr && endStr > startStr) {
          mdLine = `${evt.title} > ${startStr} ${endStr}${tagSuffix}`;
        } else {
          mdLine = `${evt.title} > ${startStr}${tagSuffix}`;
        }
      } else {
        const hh1 = String(evtStart.getHours()).padStart(2, '0');
        const mm1 = String(evtStart.getMinutes()).padStart(2, '0');
        const hh2 = String(evtEnd.getHours()).padStart(2, '0');
        const mm2 = String(evtEnd.getMinutes()).padStart(2, '0');
        mdLine = `${evt.title} > ${dateStr} ${hh1}${mm1} ${hh2}${mm2}${tagSuffix}`;
      }

      content += mdLine + '\n';
      meta.events.push({
        eventId: evt.eventId,
        title: evt.title,
        lineText: mdLine,
        calendarTag
      });
      modified = true;
    }

    if (modified) {
      store[noteName] = meta;
      storeModified = true;
      await NoteStorage.setNote(noteName, content);

      // Update editor if this note is open
      if (currentFileName === noteName) {
        textarea.value = content;
        if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
      }
    }
  }

  if (storeModified) await saveMetadataStore(store);
}

// ── Sync: Markdown → Calendar ────────────────────────────────────────────────
// Parses event syntax from daily notes and creates/updates/deletes calendar
// events to match the current markdown state.
//
// Four-step matching algorithm per note:
//   1. Exact lineText match  → unchanged, skip
//   2. Same lineIndex, text changed → update existing event (Bug 1 fix)
//   3. Unmatched current event → create new event
//   4. Unmatched metadata entry → line was removed, delete event (Bug 3 fix)
//
// Failed creates/updates surface a notification to the user (Bug 2 fix).

async function syncMarkdownToCalendar(calendarIds) {
  const plugin = getCalendarPlugin();
  if (!plugin || calendarIds.length === 0) return;

  // Always write new events into the dedicated "Notes App Events" calendar.
  const notesAppCalendarId = await getOrCreateNotesAppCalendarId();

  // Build calendar title → ID lookup for @CalendarName routing
  const calendarsByTitle = await getCalendarsByTitle();
  const defaultCalendarId = notesAppCalendarId ?? calendarIds[0];

  const store = await loadMetadataStore();
  let storeModified = false;

  function resolveCalendarId(tag) {
    if (!tag) return defaultCalendarId;
    return calendarsByTitle.get(tag.toLowerCase()) ?? defaultCalendarId;
  }

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
    const meta = store[name] || { events: [] };

    // Skip notes with no current events and no previously synced events
    if (mdEvents.length === 0 && meta.events.length === 0) continue;

    const lines = content.split('\n');
    let modified = false;
    const failedEvents = [];

    // Sets to track which current events / metadata entries have been matched
    const matchedMetaIndices = new Set();
    const matchedCurrentIndices = new Set();

    // ── Step 1: Exact lineText matches (unchanged events) ──────────────────
    for (let ci = 0; ci < mdEvents.length; ci++) {
      const evt = mdEvents[ci];
      const lineText = (evt.lineIndex < lines.length) ? lines[evt.lineIndex].trim() : '';
      const metaIdx = meta.events.findIndex(e => e.lineText === lineText);
      if (metaIdx !== -1) {
        matchedMetaIndices.add(metaIdx);
        matchedCurrentIndices.add(ci);
        // Backfill lineIndex into legacy metadata entries that predate this field
        if (meta.events[metaIdx].lineIndex == null) {
          meta.events[metaIdx].lineIndex = evt.lineIndex;
          modified = true;
        }
      }
    }

    // ── Step 2: Same lineIndex, text changed (edits → updateEvent) ─────────
    for (let ci = 0; ci < mdEvents.length; ci++) {
      if (matchedCurrentIndices.has(ci)) continue;
      const evt = mdEvents[ci];
      const lineText = (evt.lineIndex < lines.length) ? lines[evt.lineIndex].trim() : '';
      if (!evt.text || !evt.startDate || !evt.endDate) continue;
      if (isNaN(evt.startDate.getTime()) || isNaN(evt.endDate.getTime())) continue;

      const metaIdx = meta.events.findIndex(
        (e, i) => !matchedMetaIndices.has(i) && e.lineIndex === evt.lineIndex
      );
      if (metaIdx === -1) continue;

      const existing = meta.events[metaIdx];

      // If the @CalendarName tag changed, skip Step 2: Step 4 will delete the
      // old event and Step 3 will create a new one in the correct calendar.
      const existingTag = existing.calendarTag ?? null;
      if (existingTag !== evt.calendarTag) {
        // Do NOT match — let delete+create handle the calendar change
        continue;
      }

      try {
        await plugin.updateEvent({
          eventId: existing.eventId,
          title: evt.text,
          startDate: evt.startDate.toISOString(),
          endDate: evt.endDate.toISOString(),
          allDay: evt.allDay
        });
        meta.events[metaIdx] = {
          eventId: existing.eventId,
          title: evt.text,
          lineText,
          lineIndex: evt.lineIndex,
          calendarTag: evt.calendarTag
        };
        modified = true;
      } catch {
        console.warn(`Calendar sync: failed to update event "${evt.text}" in ${name}`);
        failedEvents.push(evt.text);
      }
      matchedMetaIndices.add(metaIdx);
      matchedCurrentIndices.add(ci);
    }

    // ── Step 4: Unmatched metadata entries (removed lines → deleteEvent) ────
    // Runs before Step 3 so newly-created entries are never accidentally deleted.
    const indicesToDelete = [];
    for (let i = 0; i < meta.events.length; i++) {
      if (!matchedMetaIndices.has(i)) indicesToDelete.push(i);
    }
    for (const i of indicesToDelete) {
      try {
        await plugin.deleteEvent({ eventId: meta.events[i].eventId });
      } catch {
        // If the event is already gone from iOS Calendar, that's fine
      }
      modified = true;
    }
    // Splice in reverse order to preserve earlier indices
    for (let i = indicesToDelete.length - 1; i >= 0; i--) {
      meta.events.splice(indicesToDelete[i], 1);
    }

    // ── Step 3: Unmatched current events (new lines → createEvent) ──────────
    for (let ci = 0; ci < mdEvents.length; ci++) {
      if (matchedCurrentIndices.has(ci)) continue;
      const evt = mdEvents[ci];
      const lineText = (evt.lineIndex < lines.length) ? lines[evt.lineIndex].trim() : '';
      if (!evt.text || !evt.startDate || !evt.endDate) continue;
      if (isNaN(evt.startDate.getTime()) || isNaN(evt.endDate.getTime())) continue;

      try {
        const result = await plugin.createEvent({
          title: evt.text,
          startDate: evt.startDate.toISOString(),
          endDate: evt.endDate.toISOString(),
          allDay: evt.allDay,
          calendarId: resolveCalendarId(evt.calendarTag)
        });
        meta.events.push({
          eventId: result.eventId,
          title: evt.text,
          lineText,
          lineIndex: evt.lineIndex,
          calendarTag: evt.calendarTag
        });
        modified = true;
      } catch {
        console.warn(`Calendar sync: failed to create event "${evt.text}" in ${name}`);
        failedEvents.push(evt.text);
      }
    }

    // ── Bug 2: Surface failures to the user ─────────────────────────────────
    if (failedEvents.length > 0) {
      const names = failedEvents.slice(0, 2).join(', ') +
        (failedEvents.length > 2 ? '…' : '');
      sendNotification(
        'Calendar sync failed',
        `Could not sync ${failedEvents.length} event${failedEvents.length > 1 ? 's' : ''}: ${names}`,
        `cal-sync-fail-${Date.now()}`
      );
    }

    if (modified) {
      store[name] = meta;
      storeModified = true;
    }
  }

  if (storeModified) await saveMetadataStore(store);
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

    // Ensure Settings note exists and calendar list is up to date
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

// ── Export for unit testing (Node/Jest only) ─────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    yymmddToDate, dateToYYMMDD, hhmmToTime, dailyNoteName,
    parseMarkdownEvents, parseCalendarMetadata, updateCalendarMetadata,
    loadMetadataStore, saveMetadataStore,
    syncMarkdownToCalendar, syncCalendarToMarkdown,
    getCalendarsByTitle,
    // Resets module-level caches; call in beforeEach to isolate tests
    _resetForTesting() {
      _calendarPlugin = null;
      _notesAppCalendarId = null;
      _calendarsByTitle = null;
    }
  };
}
