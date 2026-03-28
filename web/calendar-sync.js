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
    // Match either ## or ### to handle notes written by older app versions.
    const emojiMatch = existing.match(/###? Projects Note Emojis([\s\S]*?)(?=\n##|$)/);
    if (emojiMatch) emojiBody = emojiMatch[1];
  }

  // Extract existing Encryption section to preserve it across rebuilds.
  // If it doesn't exist yet but sync is available, create the default section.
  // This section is managed by the encryption UI in markdown-renderer.js.
  let encryptionBody = '';
  if (existing) {
    const encMatch = existing.match(/## 🔒 Encryption([\s\S]*?)(?=\n##|$)/);
    if (encMatch) encryptionBody = encMatch[1];
  }
  if (!encryptionBody && window._syncHelpers?.available) {
    encryptionBody = '\nEnd-to-end encryption protects your notes so only your devices can read them.\n';
  }

  // Build new note content — Sync, Theme, and Projects Note Emojis sections always present;
  // Encryption section preserved if it existed; Calendars section only when the iOS calendar
  // plugin returned at least one calendar. Projects Note Emojis is a top-level ## section
  // (not nested under Theme) so it is always rendered as an independent <details> and is
  // never hidden inside a closed parent.
  const lines = [
    '# Settings', '',
    '## ☁️ Sync' + syncBody.trimEnd(), '',
  ];
  // Insert Encryption section (always present when sync is available)
  if (encryptionBody) {
    lines.push('## 🔒 Encryption' + encryptionBody.trimEnd(), '');
  }
  lines.push(
    '## 🎨 Theme' + themeBody.trimEnd(), '',
    '## Projects Note Emojis' + emojiBody.trimEnd(), ''
  );
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
        // Record when these colours were seeded and sync them to the preferences
        // note so the desktop picks up the native iOS calendar colours.
        localStorage.setItem('calendar_colors_ts', Date.now().toString());
        if (typeof syncCalendarColorsToNote === 'function') {
          syncCalendarColorsToNote();
        }
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

// ── Markdown event line builder ───────────────────────────────────────────────

function buildMdLine(evt, evtStart, evtEnd, dateStr, calendarTag) {
  const tagSuffix = calendarTag ? ` @${calendarTag}` : '';
  if (evt.allDay) {
    const startStr = dateToYYMMDD(evtStart);
    const endDateAdj = new Date(evtEnd);
    endDateAdj.setDate(endDateAdj.getDate() - 1);
    const endStr = dateToYYMMDD(endDateAdj);
    if (startStr !== endStr && endStr > startStr) {
      return `${evt.title} > ${startStr} ${endStr}${tagSuffix}`;
    } else {
      return `${evt.title} > ${startStr}${tagSuffix}`;
    }
  } else {
    const hh1 = String(evtStart.getHours()).padStart(2, '0');
    const mm1 = String(evtStart.getMinutes()).padStart(2, '0');
    const hh2 = String(evtEnd.getHours()).padStart(2, '0');
    const mm2 = String(evtEnd.getMinutes()).padStart(2, '0');
    return `${evt.title} > ${dateStr} ${hh1}${mm1} ${hh2}${mm2}${tagSuffix}`;
  }
}

// ── Find event line in note ───────────────────────────────────────────────────
// Returns the line index of a synced event, searching first by exact lineText
// then falling back to the stored lineIndex.

function findEventLine(lines, metaEvent) {
  if (metaEvent.lineText) {
    const idx = lines.findIndex(l => l.trim() === metaEvent.lineText.trim());
    if (idx !== -1) return idx;
  }
  if (metaEvent.lineIndex != null && metaEvent.lineIndex < lines.length) {
    return metaEvent.lineIndex;
  }
  return -1;
}

// ── Insert events under ## Events heading ────────────────────────────────────
// Inserts newLines under the "## Events" subheading that sits just after the
// "# Title" line. Creates the heading (and a surrounding blank line) if absent.
// Returns { content, startLineIdx } where startLineIdx is the index of the
// first newly inserted line.

function insertEventsUnderHeading(content, newLines) {
  const EVENTS_HEADING = '## Events';
  const lines = content.split('\n');

  // Find # Title line
  let titleIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s/.test(lines[i])) { titleIdx = i; break; }
  }

  // Find ## Events heading anywhere in the note
  let eventsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === EVENTS_HEADING) { eventsIdx = i; break; }
  }

  let insertIdx;
  if (eventsIdx !== -1) {
    // Heading exists — find end of its section (before next ## or # heading)
    let pos = eventsIdx + 1;
    while (pos < lines.length && !/^##?\s/.test(lines[pos])) pos++;
    // Back up over trailing blank lines within the section
    while (pos > eventsIdx + 1 && lines[pos - 1].trim() === '') pos--;
    insertIdx = pos;
  } else {
    // Create ## Events section right after # Title
    const sectionLines = ['', EVENTS_HEADING, ''];
    lines.splice(titleIdx + 1, 0, ...sectionLines);
    insertIdx = titleIdx + 1 + sectionLines.length; // after the trailing blank
  }

  lines.splice(insertIdx, 0, ...newLines);
  return { content: lines.join('\n'), startLineIdx: insertIdx };
}

// ── Migrate inline metadata to centralised store ──────────────────────────────
// Scans daily notes for the legacy <!-- calendar_events: {...} --> inline
// comment, moves the data into the centralised store, and strips the comment
// from each note. Skips notes that already have an entry in the store.

async function migrateInlineMetadata(store) {
  const allNotes = await NoteStorage.getAllNotes();
  const dailyNoteRe = /^(\d{6}) Daily Note$/;

  for (const { name, content } of allNotes) {
    if (name === CALENDAR_METADATA_NOTE) continue;
    if (!dailyNoteRe.test(name)) continue;

    const m = content.match(CALENDAR_META_RE);
    if (!m) continue;

    // Strip the inline comment from the note
    const stripped = content.replace(CALENDAR_META_RE + '\n?', '').replace(/<!-- calendar_events:.*?-->\n?/, '');
    await NoteStorage.setNote(name, stripped);

    // Don't overwrite an existing store entry
    if (store[name]) continue;

    let meta;
    try { meta = JSON.parse(m[1]); } catch { continue; }
    if (!meta || !Array.isArray(meta.events)) continue;

    // The comment was inserted after the # Title line, so all lineIndex values
    // stored in the old inline metadata are 1 higher than in the stripped note.
    for (const e of meta.events) {
      if (e.lineIndex != null) e.lineIndex = Math.max(0, e.lineIndex - 1);
    }
    store[name] = meta;
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
// Full bidirectional iCloud → Notes sync:
//   Phase 0 — build a map of all current iCloud events in the sync window.
//   Phase 1 — for events already tracked in metadata, reflect any iCloud
//             changes (title, time, calendar) into the note, and remove lines
//             whose events were deleted from iCloud.
//   Phase 2 — import brand-new iCloud events into daily notes.  New events
//             are placed under the "## Events" subheading (created when absent)
//             that sits just after the "# Title" line.  Content-based duplicate
//             detection merges an existing manually-typed event line with the
//             iCloud event rather than inserting a second copy.

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
  const startDate = firstSyncDateStr ? new Date(firstSyncDateStr) : today;

  if (!firstSyncDateStr) {
    try { await plugin.setFirstSyncDate({ date: today.toISOString() }); } catch {}
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

  // ── Phase 0: Build event map ─────────────────────────────────────────────
  const icloudEventMap = new Map();
  for (const evt of calendarEvents) {
    if (evt.eventId) icloudEventMap.set(evt.eventId, evt);
  }

  const startYYMMDD = dateToYYMMDD(startDate);
  const endYYMMDD   = dateToYYMMDD(endDate);

  // ── Phase 1: Update / delete existing synced events ─────────────────────
  // Process notes whose dates fall within the current sync window.
  const noteNames = Object.keys(store);
  for (const noteName of noteNames) {
    const nm = noteName.match(/^(\d{6}) Daily Note$/);
    if (!nm) continue;
    const noteDate = nm[1];
    if (noteDate < startYYMMDD || noteDate > endYYMMDD) continue;

    const meta = store[noteName];
    if (!meta || !Array.isArray(meta.events) || meta.events.length === 0) continue;

    let content = await NoteStorage.getNote(noteName);
    if (!content) continue;

    let lines = content.split('\n');
    let noteModified = false;
    const lineIndicesToRemove = [];

    for (let i = meta.events.length - 1; i >= 0; i--) {
      const me = meta.events[i];
      if (!me.eventId) continue; // user-created, skip

      const icloudEvt = icloudEventMap.get(me.eventId);

      if (!icloudEvt) {
        // Event deleted from iCloud → remove the line from the note
        const lineIdx = findEventLine(lines, me);
        if (lineIdx !== -1) lineIndicesToRemove.push(lineIdx);
        meta.events.splice(i, 1);
        noteModified = true;
      } else {
        // Check for changes (title, time, all-day flag, calendar, or date)
        const evtStart = new Date(icloudEvt.startDate);
        const evtEnd   = new Date(icloudEvt.endDate);
        if (isNaN(evtStart.getTime()) || isNaN(evtEnd.getTime())) continue;
        const newDateStr = dateToYYMMDD(evtStart);
        const isNotesApp = icloudEvt.calendarId === notesAppCalendarId;
        const newCalTag = isNotesApp
          ? null
          : (icloudEvt.calendarTitle || '').replace(/\s+/g, '') || null;
        const newMdLine = buildMdLine(icloudEvt, evtStart, evtEnd, newDateStr, newCalTag);

        if (newMdLine !== me.lineText) {
          if (newDateStr !== noteDate) {
            // Event moved to a different date — remove the line from this note
            // and let Phase 2 insert it in the correct daily note.
            const lineIdx = findEventLine(lines, me);
            if (lineIdx !== -1) lineIndicesToRemove.push(lineIdx);
            meta.events.splice(i, 1);
            noteModified = true;
          } else {
            // Same date — update the line in-place (title, time, all-day, or calendar changed)
            const lineIdx = findEventLine(lines, me);
            if (lineIdx !== -1) {
              lines[lineIdx] = newMdLine;
              noteModified = true;
            }
            me.lineText    = newMdLine;
            me.title       = icloudEvt.title;
            me.calendarTag = newCalTag;
            noteModified = true;
          }
        }
      }
    }

    // Remove deleted lines in reverse order to keep indices valid
    for (const idx of lineIndicesToRemove.sort((a, b) => b - a)) {
      lines.splice(idx, 1);
    }

    if (noteModified) {
      store[noteName] = meta;
      storeModified = true;
      const newContent = lines.join('\n');
      await NoteStorage.setNote(noteName, newContent);
      if (currentFileName === noteName) {
        textarea.value = newContent;
        if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
      }
    }
  }

  // ── Phase 2: Import new iCloud events ───────────────────────────────────
  // Group events by date (YYMMDD)
  const eventsByDate = {};
  for (const evt of calendarEvents) {
    if (!evt.startDate || !evt.endDate) continue;
    const evtStart = new Date(evt.startDate);
    const evtEnd   = new Date(evt.endDate);
    if (isNaN(evtStart.getTime()) || isNaN(evtEnd.getTime())) continue;
    const dateStr = dateToYYMMDD(evtStart);
    if (!eventsByDate[dateStr]) eventsByDate[dateStr] = [];
    eventsByDate[dateStr].push(evt);
  }

  for (const [dateStr, events] of Object.entries(eventsByDate)) {
    const noteName = dailyNoteName(dateStr);
    let content = await NoteStorage.getNote(noteName);
    if (content === null) content = `# ${noteName}\n`;

    const meta = store[noteName] || { events: [] };
    const existingIds = new Set(meta.events.map(e => e.eventId));
    let modified = false;

    // Collect events that need a new line in the note
    const toInsert = [];

    for (const evt of events) {
      if (existingIds.has(evt.eventId)) continue;

      const evtStart = new Date(evt.startDate);
      const evtEnd   = new Date(evt.endDate);
      const isNotesApp = evt.calendarId === notesAppCalendarId;
      const calendarTag = isNotesApp
        ? null
        : (evt.calendarTitle || '').replace(/\s+/g, '') || null;
      const mdLine = buildMdLine(evt, evtStart, evtEnd, dateStr, calendarTag);

      // Content-based duplicate detection: look for a line with the same
      // title and time already present in the note (possibly without @calendar).
      const existingMdEvents = parseMarkdownEvents(content, dateStr);
      const duplicate = existingMdEvents.find(e => {
        if (e.text !== evt.title) return false;
        if (evt.allDay) return e.allDay;
        return !e.allDay &&
          Math.abs(e.startDate.getTime() - evtStart.getTime()) < 60000 &&
          Math.abs(e.endDate.getTime() - evtEnd.getTime()) < 60000;
      });

      if (duplicate) {
        // Merge: add @calendar tag to existing line if it's missing
        const curLines = content.split('\n');
        if (!duplicate.calendarTag && calendarTag) {
          curLines[duplicate.lineIndex] = curLines[duplicate.lineIndex].trimEnd() + ` @${calendarTag}`;
          content = curLines.join('\n');
        }
        meta.events.push({
          eventId: evt.eventId,
          title: evt.title,
          lineText: curLines[duplicate.lineIndex].trim(),
          lineIndex: duplicate.lineIndex,
          calendarTag: duplicate.calendarTag || calendarTag
        });
        existingIds.add(evt.eventId);
        modified = true;
      } else {
        toInsert.push({ mdLine, evt, calendarTag });
      }
    }

    // Insert all new event lines at once under ## Events heading
    if (toInsert.length > 0) {
      const result = insertEventsUnderHeading(content, toInsert.map(e => e.mdLine));
      content = result.content;
      for (let i = 0; i < toInsert.length; i++) {
        const { mdLine, evt, calendarTag } = toInsert[i];
        meta.events.push({
          eventId: evt.eventId,
          title: evt.title,
          lineText: mdLine,
          lineIndex: result.startLineIdx + i,
          calendarTag
        });
        existingIds.add(evt.eventId);
      }
      modified = true;
    }

    if (modified) {
      store[noteName] = meta;
      storeModified = true;
      await NoteStorage.setNote(noteName, content);
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
        // Keep lineIndex current — events may have been moved to a different line
        if (meta.events[metaIdx].lineIndex !== evt.lineIndex) {
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
  let _calendarStarted = false;

  // Start calendar sync exactly once.  Exposed on window so app-init.js can
  // still call it explicitly (e.g. from the tap-to-sync button), but it now
  // also fires automatically as soon as storage AND encryption are ready.
  window._startCalendarSyncIfNeeded = () => {
    if (_calendarStarted) return;
    // Wait for encryption wrapper to be active before reading notes.
    // If encryption is enabled but the key isn't loaded yet, reading notes
    // would return ciphertext, causing calendar sync to miss events and
    // later create duplicates when decrypted content becomes available.
    if (window._encryption?.needsKey && !window._encryption?.active) {
      console.log('[calendar-sync] Waiting for encryption key before starting...');
      return;
    }
    _calendarStarted = true;
    startCalendarSync();
  };

  window._runCalendarSync = runCalendarSync;

  // Auto-start: wait for encryption:ready, which app-init.js dispatches after
  // the CryptoStorage wrapper has been applied (or immediately when encryption
  // is not in use). Starting on powersync:ready instead would be too early —
  // the wrapper is applied ~200 ms later, so NoteStorage.getNote() would
  // return raw ciphertext and the sync would silently read nothing.
  window.addEventListener('encryption:ready', () => window._startCalendarSyncIfNeeded(), { once: true });
  // Longer fallback (8s) to give encryption init time to complete.
  setTimeout(() => window._startCalendarSyncIfNeeded(), 8000);

  document.addEventListener('resume', () => {
    if (_calendarStarted) setTimeout(runCalendarSync, 1000);
    else window._startCalendarSyncIfNeeded();
  });
  document.addEventListener('pause', stopCalendarSync);
}

// ── Export for unit testing (Node/Jest only) ─────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    yymmddToDate, dateToYYMMDD, hhmmToTime, dailyNoteName,
    buildMdLine, findEventLine, insertEventsUnderHeading,
    parseMarkdownEvents, parseCalendarMetadata, updateCalendarMetadata,
    loadMetadataStore, saveMetadataStore, migrateInlineMetadata,
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
