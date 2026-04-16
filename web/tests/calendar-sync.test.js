// calendar-sync.test.js — Unit and integration tests for calendar-sync.js

const {
  yymmddToDate,
  dateToYYMMDD,
  hhmmToTime,
  dailyNoteName,
  parseMarkdownEvents,
  parseCalendarMetadata,
  updateCalendarMetadata,
  loadMetadataStore,
  saveMetadataStore,
  migrateInlineMetadata,
  syncMarkdownToCalendar,
  syncCalendarToMarkdown,
  _resetForTesting,
  getCalendarsByTitle,
} = require('../js/schedule/calendar-sync.js');

// Returns the metadata store object saved to '.calendar_metadata' during the
// most recent sync, or null if no such call was made.
function getSavedStore() {
  const call = NoteStorage.setNote.mock.calls.find(([n]) => n === '.calendar_metadata');
  return call ? JSON.parse(call[1]) : null;
}

// ── Pure function tests ───────────────────────────────────────────────────────

describe('yymmddToDate', () => {
  test('converts YYMMDD string to correct Date', () => {
    const d = yymmddToDate('260315');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March = 2
    expect(d.getDate()).toBe(15);
  });

  test('handles year 2000 boundary', () => {
    const d = yymmddToDate('000101');
    expect(d.getFullYear()).toBe(2000);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

describe('dateToYYMMDD', () => {
  test('converts Date to YYMMDD string', () => {
    const d = new Date(2026, 2, 15); // March 15 2026
    expect(dateToYYMMDD(d)).toBe('260315');
  });

  test('round-trips with yymmddToDate', () => {
    const original = '251231';
    expect(dateToYYMMDD(yymmddToDate(original))).toBe(original);
  });

  test('pads single-digit months and days', () => {
    const d = new Date(2026, 0, 5); // Jan 5 2026
    expect(dateToYYMMDD(d)).toBe('260105');
  });
});

describe('hhmmToTime', () => {
  test('parses HHMM into hours and minutes', () => {
    expect(hhmmToTime('0930')).toEqual({ h: 9, m: 30 });
    expect(hhmmToTime('1400')).toEqual({ h: 14, m: 0 });
    expect(hhmmToTime('0000')).toEqual({ h: 0, m: 0 });
  });
});

describe('dailyNoteName', () => {
  test('appends " Daily Note" suffix', () => {
    expect(dailyNoteName('260315')).toBe('260315 Daily Note');
  });
});

describe('parseMarkdownEvents', () => {
  test('parses an all-day event', () => {
    const content = '# Note\nBoard meeting > 260315\n';
    const events = parseMarkdownEvents(content, '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Board meeting');
    expect(events[0].allDay).toBe(true);
    expect(dateToYYMMDD(events[0].startDate)).toBe('260315');
  });

  test('parses a multi-day event — endDate is exclusive (iOS format)', () => {
    // "Conference > 260315 260317" means March 15–17 inclusive.
    // parseMarkdownEvents must add 1 day so the endDate sent to iOS Calendar
    // is exclusive (March 18), matching the convention for single all-day events.
    const content = 'Conference > 260315 260317\n';
    const events = parseMarkdownEvents(content, '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Conference');
    expect(events[0].allDay).toBe(true);
    expect(dateToYYMMDD(events[0].startDate)).toBe('260315');
    // endDate must be March 18 (exclusive) so iOS shows March 15–17
    expect(dateToYYMMDD(events[0].endDate)).toBe('260318');
  });

  test('parses a timed event', () => {
    const content = 'Standup > 260315 0900 0930\n';
    const events = parseMarkdownEvents(content, '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Standup');
    expect(events[0].allDay).toBe(false);
    expect(events[0].startDate.getHours()).toBe(9);
    expect(events[0].startDate.getMinutes()).toBe(0);
    expect(events[0].endDate.getHours()).toBe(9);
    expect(events[0].endDate.getMinutes()).toBe(30);
  });

  test('skips task lines (- [ ] and - [x])', () => {
    const content = '- [ ] Task > 260315\n- [x] Done > 260315\nReal event > 260315\n';
    const events = parseMarkdownEvents(content, '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Real event');
  });

  test('strips list and heading prefixes from event text', () => {
    const content = '- Board meeting > 260315\n';
    const events = parseMarkdownEvents(content, '260315');
    expect(events[0].text).toBe('Board meeting');
  });

  test('returns empty array for notes with no events', () => {
    const content = '# Just a note\nSome text here\n';
    expect(parseMarkdownEvents(content, '260315')).toHaveLength(0);
  });
});

describe('parseCalendarMetadata', () => {
  test('parses valid metadata comment', () => {
    const content = '# Note\n<!-- calendar_events: {"events":[{"eventId":"abc","title":"Meeting","lineText":"Meeting > 260315"}]} -->\n';
    const meta = parseCalendarMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta.events).toHaveLength(1);
    expect(meta.events[0].eventId).toBe('abc');
  });

  test('returns null when no comment present', () => {
    expect(parseCalendarMetadata('# Note\nNo metadata here\n')).toBeNull();
  });

  test('returns null on malformed JSON', () => {
    const content = '<!-- calendar_events: {broken json -->';
    expect(parseCalendarMetadata(content)).toBeNull();
  });
});

describe('updateCalendarMetadata', () => {
  test('inserts comment after # title line', () => {
    const content = '# My Note\n\nSome content\n';
    const meta = { events: [] };
    const result = updateCalendarMetadata(content, meta);
    const lines = result.split('\n');
    expect(lines[0]).toBe('# My Note');
    expect(lines[1]).toContain('<!-- calendar_events:');
  });

  test('replaces existing comment', () => {
    const content = '# Note\n<!-- calendar_events: {"events":[]} -->\nContent\n';
    const meta = { events: [{ eventId: 'x', title: 'T', lineText: 'T > 260315' }] };
    const result = updateCalendarMetadata(content, meta);
    expect(result.match(/<!-- calendar_events:/g)).toHaveLength(1);
    expect(result).toContain('"eventId":"x"');
  });

  test('inserts at top when no heading present', () => {
    const content = 'No heading here\n';
    const result = updateCalendarMetadata(content, { events: [] });
    expect(result.split('\n')[0]).toContain('<!-- calendar_events:');
  });
});

// ── loadMetadataStore / saveMetadataStore / migrateInlineMetadata tests ───────

describe('loadMetadataStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetForTesting();
  });

  test('returns {} when note does not exist', async () => {
    NoteStorage.getNote.mockResolvedValue(null);
    expect(await loadMetadataStore()).toEqual({});
  });

  test('returns parsed object when valid JSON is stored', async () => {
    const store = { '260315 Daily Note': { events: [{ eventId: 'x' }] } };
    NoteStorage.getNote.mockResolvedValue(JSON.stringify(store));
    expect(await loadMetadataStore()).toEqual(store);
  });

  test('returns {} on malformed JSON', async () => {
    NoteStorage.getNote.mockResolvedValue('{broken json');
    expect(await loadMetadataStore()).toEqual({});
  });
});

describe('saveMetadataStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetForTesting();
  });

  test('calls NoteStorage.setNote with ".calendar_metadata" and JSON content', async () => {
    NoteStorage.setNote.mockResolvedValue();
    const store = { '260315 Daily Note': { events: [] } };
    await saveMetadataStore(store);
    expect(NoteStorage.setNote).toHaveBeenCalledWith('.calendar_metadata', JSON.stringify(store));
  });
});

describe('migrateInlineMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetForTesting();
  });

  test('migrates inline comment into store and strips it from note', async () => {
    const meta = { events: [{ eventId: 'abc', title: 'Meeting', lineText: 'Meeting > 260315', lineIndex: 2 }] };
    const content = `# 260315 Daily Note\n<!-- calendar_events: ${JSON.stringify(meta)} -->\nMeeting > 260315\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content }]);
    NoteStorage.setNote.mockResolvedValue();

    const store = {};
    await migrateInlineMetadata(store);

    // Metadata moved into store with lineIndex decremented by 1
    expect(store['260315 Daily Note'].events[0].eventId).toBe('abc');
    expect(store['260315 Daily Note'].events[0].lineIndex).toBe(1);
    // Note saved without the comment
    expect(NoteStorage.setNote).toHaveBeenCalledWith('260315 Daily Note', expect.not.stringContaining('<!-- calendar_events:'));
  });

  test('does not overwrite existing store entry', async () => {
    const meta = { events: [{ eventId: 'abc', title: 'Meeting', lineText: 'Meeting > 260315', lineIndex: 2 }] };
    const content = `# 260315 Daily Note\n<!-- calendar_events: ${JSON.stringify(meta)} -->\nMeeting > 260315\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content }]);
    NoteStorage.setNote.mockResolvedValue();

    const existingMeta = { events: [{ eventId: 'existing', title: 'Other' }] };
    const store = { '260315 Daily Note': existingMeta };
    await migrateInlineMetadata(store);

    // Existing store entry preserved
    expect(store['260315 Daily Note'].events[0].eventId).toBe('existing');
    // Note still stripped of comment
    expect(NoteStorage.setNote).toHaveBeenCalledWith('260315 Daily Note', expect.not.stringContaining('<!-- calendar_events:'));
  });

  test('skips notes without inline comments', async () => {
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: '# Note\nJust text\n' }]);
    NoteStorage.setNote.mockResolvedValue();

    const store = {};
    await migrateInlineMetadata(store);

    expect(NoteStorage.setNote).not.toHaveBeenCalled();
    expect(store).toEqual({});
  });

  test('skips .calendar_metadata note itself', async () => {
    NoteStorage.getAllNotes.mockResolvedValue([
      { name: '.calendar_metadata', content: '{"some":"json"}' },
    ]);
    NoteStorage.setNote.mockResolvedValue();

    const store = {};
    await migrateInlineMetadata(store);
    expect(NoteStorage.setNote).not.toHaveBeenCalled();
  });
});

// ── syncMarkdownToCalendar integration tests ─────────────────────────────────

// Helper: build a mock plugin
function makePlugin(overrides = {}) {
  return {
    getFirstSyncDate: jest.fn().mockResolvedValue({ date: new Date('2026-01-01').toISOString() }),
    createEvent: jest.fn().mockResolvedValue({ eventId: 'new-id-1' }),
    updateEvent: jest.fn().mockResolvedValue({}),
    deleteEvent: jest.fn().mockResolvedValue({}),
    getOrCreateCalendar: jest.fn().mockResolvedValue({ calendarId: 'notes-cal-id' }),
    listCalendars: jest.fn().mockResolvedValue({
      calendars: [
        { id: 'work-cal-id',     title: 'Work' },
        { id: 'personal-cal-id', title: 'Personal' },
      ]
    }),
    ...overrides,
  };
}

// Reset module-level caches and mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  _resetForTesting();
  global.window.Capacitor = null;
  global.currentFileName = null;
  global.textarea = { value: '' };
  global.isPreview = false;
  // Ensure NoteStorage.getNote returns null by default so that
  // mockImplementation calls in individual tests don't bleed across tests.
  NoteStorage.getNote.mockResolvedValue(null);
});

describe('syncMarkdownToCalendar', () => {
  function setupPlugin(plugin) {
    global.window.Capacitor = { Plugins: { CalendarPlugin: plugin } };
  }

  test('creates a new calendar event for a new markdown line', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    const noteContent = '# 260315 Daily Note\nMeeting > 260315\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.createEvent).toHaveBeenCalledTimes(1);
    expect(plugin.createEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Meeting' }));

    const store = getSavedStore();
    const meta = store['260315 Daily Note'];
    expect(meta.events).toHaveLength(1);
    expect(meta.events[0].eventId).toBe('new-id-1');
    expect(meta.events[0].lineText).toBe('Meeting > 260315');
    expect(meta.events[0].lineIndex).toBeDefined();
  });

  test('skips events already synced (no duplicate creates)', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    const meta = { events: [{ eventId: 'existing-id', title: 'Meeting', lineText: 'Meeting > 260315', lineIndex: 1 }] };
    const noteContent = `# 260315 Daily Note\nMeeting > 260315\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.createEvent).not.toHaveBeenCalled();
    expect(plugin.updateEvent).not.toHaveBeenCalled();
    expect(NoteStorage.setNote).not.toHaveBeenCalled();
  });

  test('Bug 1: updates existing event when line text changes at same lineIndex', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    // Metadata records original text at lineIndex 1 (no inline comment in note)
    const meta = { events: [{ eventId: 'evt-1', title: 'Meeting', lineText: 'Meeting > 260315', lineIndex: 1 }] };
    // Note has updated text at lineIndex 1
    const noteContent = `# 260315 Daily Note\nTeam Meeting > 260315\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.updateEvent).toHaveBeenCalledTimes(1);
    expect(plugin.updateEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'evt-1',
      title: 'Team Meeting',
    }));
    expect(plugin.createEvent).not.toHaveBeenCalled();

    const savedMeta = getSavedStore()['260315 Daily Note'];
    expect(savedMeta.events[0].lineText).toBe('Team Meeting > 260315');
    expect(savedMeta.events[0].eventId).toBe('evt-1');
  });

  test('Bug 3: deletes iOS Calendar event when line is removed from markdown', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    // Metadata has an event, but it's no longer in the note content
    const meta = { events: [{ eventId: 'evt-del', title: 'Old Meeting', lineText: 'Old Meeting > 260315', lineIndex: 1 }] };
    // Note no longer contains the event line
    const noteContent = `# 260315 Daily Note\nJust some text\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.deleteEvent).toHaveBeenCalledTimes(1);
    expect(plugin.deleteEvent).toHaveBeenCalledWith({ eventId: 'evt-del' });

    const savedMeta = getSavedStore()['260315 Daily Note'];
    expect(savedMeta.events).toHaveLength(0);
  });

  test('Bug 2: calls sendNotification when createEvent fails', async () => {
    const plugin = makePlugin({
      createEvent: jest.fn().mockRejectedValue(new Error('Permission denied')),
    });
    setupPlugin(plugin);

    const noteContent = '# 260315 Daily Note\nMeeting > 260315\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);

    await syncMarkdownToCalendar(['cal-1']);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      'Calendar sync failed',
      expect.stringContaining('Meeting'),
      expect.stringMatching(/^cal-sync-fail-/)
    );
  });

  test('Bug 2: calls sendNotification when updateEvent fails', async () => {
    const plugin = makePlugin({
      updateEvent: jest.fn().mockRejectedValue(new Error('Not found')),
    });
    setupPlugin(plugin);

    const meta = { events: [{ eventId: 'evt-1', title: 'Meeting', lineText: 'Meeting > 260315', lineIndex: 1 }] };
    const noteContent = `# 260315 Daily Note\nTeam Meeting > 260315\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    expect(sendNotification).toHaveBeenCalledWith(
      'Calendar sync failed',
      expect.stringContaining('Team Meeting'),
      expect.any(String)
    );
  });

  test('handles edit + delete + create in the same note in one sync pass', async () => {
    const plugin = makePlugin({
      createEvent: jest.fn().mockResolvedValue({ eventId: 'new-id' }),
    });
    setupPlugin(plugin);

    // evt-edit at lineIndex 1 will be edited; evt-del at lineIndex 4 will be deleted
    // (its line is absent in the new content); Brand New at lineIndex 2 is a new line
    const meta = {
      events: [
        { eventId: 'evt-edit', title: 'Old Title', lineText: 'Old Title > 260315', lineIndex: 1 },
        { eventId: 'evt-del',  title: 'Removed',   lineText: 'Removed > 260315',   lineIndex: 4 },
      ]
    };
    const noteContent = [
      '# 260315 Daily Note',
      'New Title > 260315',  // lineIndex 1 — edit of evt-edit
      'Brand New > 260315',  // lineIndex 2 — new event (no prior meta at lineIndex 2)
      // lineIndex 3: (trailing newline — no event at lineIndex 4)
    ].join('\n') + '\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    // evt-edit should be updated (same lineIndex, different text)
    expect(plugin.updateEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-edit', title: 'New Title' }));
    // evt-del should be deleted (lineIndex 4 no longer has an event line)
    expect(plugin.deleteEvent).toHaveBeenCalledWith({ eventId: 'evt-del' });
    // Brand New should be created (new line at lineIndex 2)
    expect(plugin.createEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Brand New' }));

    const savedMeta = getSavedStore()['260315 Daily Note'];
    expect(savedMeta.events).toHaveLength(2);
    const titles = savedMeta.events.map(e => e.title);
    expect(titles).toContain('New Title');
    expect(titles).toContain('Brand New');
    expect(titles).not.toContain('Old Title');
    expect(titles).not.toContain('Removed');
  });

  test('does not call setNote when nothing changed', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    // Note has no event lines and no metadata
    const noteContent = '# 260315 Daily Note\nJust text\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);

    await syncMarkdownToCalendar(['cal-1']);

    expect(NoteStorage.setNote).not.toHaveBeenCalled();
  });

  // ── Multi-day event endDate round-trip regression (Bug 1) ─────────────────
  // "Conference > 260315 260317" should create a 3-day iOS event (March 15–17).
  // The exclusive endDate sent to iOS must be March 18, not March 17, so that
  // iOS Calendar displays March 15, 16, and 17. If March 17 were sent instead,
  // iOS would show only March 15–16 and the next sync would corrupt the line.
  test('multi-day event: createEvent receives exclusive endDate (day after last visible day)', async () => {
    const plugin = makePlugin();
    global.window.Capacitor = { Plugins: { CalendarPlugin: plugin } };

    const noteContent = '# 260315 Daily Note\nConference > 260315 260317\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.createEvent).toHaveBeenCalledTimes(1);
    const call = plugin.createEvent.mock.calls[0][0];
    expect(call.title).toBe('Conference');
    expect(call.allDay).toBe(true);
    // startDate must be March 15
    expect(new Date(call.startDate).toISOString().slice(0, 10)).toBe('2026-03-15');
    // endDate must be March 18 (exclusive) — NOT March 17
    expect(new Date(call.endDate).toISOString().slice(0, 10)).toBe('2026-03-18');
  });

  // ── Recurring events ───────────────────────────────────────────────────────
  // The app has no RRULE support. Each iOS recurring-event instance is treated
  // as an independent, discrete occurrence. This test documents that a
  // recurring event line in markdown creates a single non-recurring iOS event.
  test('recurring events are not supported: each markdown line creates one discrete iOS event', async () => {
    const plugin = makePlugin();
    global.window.Capacitor = { Plugins: { CalendarPlugin: plugin } };

    // Two separate lines for the "same" recurring meeting on different dates
    const noteContent = [
      '# 260315 Daily Note',
      'Weekly Standup > 260315 0900 0930',
      'Weekly Standup > 260322 0900 0930',
    ].join('\n') + '\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();

    await syncMarkdownToCalendar(['cal-1']);

    // Both lines are created as independent iOS events with no recurrence link
    expect(plugin.createEvent).toHaveBeenCalledTimes(2);
    const titles = plugin.createEvent.mock.calls.map(([c]) => c.title);
    expect(titles).toEqual(['Weekly Standup', 'Weekly Standup']);
  });
});

// ── syncCalendarToMarkdown integration tests ─────────────────────────────────

describe('syncCalendarToMarkdown', () => {
  const FUTURE_DATE = new Date(Date.now() + 86400000 * 5); // 5 days from now
  const dateStr = dateToYYMMDD(FUTURE_DATE);
  const noteName = `${dateStr} Daily Note`;

  function makeCalPlugin(events = []) {
    return {
      getFirstSyncDate: jest.fn().mockResolvedValue({ date: new Date('2026-01-01').toISOString() }),
      setFirstSyncDate: jest.fn().mockResolvedValue({}),
      fetchEvents: jest.fn().mockResolvedValue({ events }),
      getOrCreateCalendar: jest.fn().mockResolvedValue({ calendarId: 'notes-cal-id' }),
    };
  }

  function setupCalPlugin(plugin) {
    global.window.Capacitor = { Plugins: { CalendarPlugin: plugin } };
  }

  const makeEvent = (id, title, allDay = true, calendarId = 'notes-cal-id', calendarTitle = 'Notes App Events') => ({
    eventId: id,
    title,
    allDay,
    calendarId,
    calendarTitle,
    startDate: new Date(FUTURE_DATE.getFullYear(), FUTURE_DATE.getMonth(), FUTURE_DATE.getDate()).toISOString(),
    endDate: new Date(FUTURE_DATE.getFullYear(), FUTURE_DATE.getMonth(), FUTURE_DATE.getDate() + 1).toISOString(),
  });

  test('appends event line to existing daily note', async () => {
    const plugin = makeCalPlugin([makeEvent('e1', 'Doctor Appointment')]);
    setupCalPlugin(plugin);

    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return null;
      return `# ${noteName}\n\nSome existing text\n`;
    });
    NoteStorage.setNote.mockResolvedValue();

    await syncCalendarToMarkdown(['cal-1']);

    const noteCall = NoteStorage.setNote.mock.calls.find(([n]) => n === noteName);
    expect(noteCall).toBeDefined();
    expect(noteCall[1]).toContain('Doctor Appointment');
  });

  test('creates a new daily note when none exists', async () => {
    const plugin = makeCalPlugin([makeEvent('e2', 'New Event')]);
    setupCalPlugin(plugin);

    NoteStorage.setNote.mockResolvedValue();

    await syncCalendarToMarkdown(['cal-1']);

    const noteCall = NoteStorage.setNote.mock.calls.find(([n]) => n === noteName);
    expect(noteCall).toBeDefined();
    expect(noteCall[1]).toContain(`# ${noteName}`);
    expect(noteCall[1]).toContain('New Event');
  });

  test('does not duplicate an event already in metadata', async () => {
    const plugin = makeCalPlugin([makeEvent('e3', 'Recurring Meeting')]);
    setupCalPlugin(plugin);

    const meta = { events: [{ eventId: 'e3', title: 'Recurring Meeting', lineText: `Recurring Meeting > ${dateStr}` }] };
    const existingContent = `# ${noteName}\nRecurring Meeting > ${dateStr}\n`;
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ [noteName]: meta });
      return existingContent;
    });

    await syncCalendarToMarkdown(['cal-1']);

    expect(NoteStorage.setNote).not.toHaveBeenCalled();
  });

  test('does nothing when no calendars are selected', async () => {
    const plugin = makeCalPlugin([makeEvent('e4', 'Event')]);
    setupCalPlugin(plugin);

    await syncCalendarToMarkdown([]);

    expect(plugin.fetchEvents).not.toHaveBeenCalled();
    expect(NoteStorage.setNote).not.toHaveBeenCalled();
  });

  test('@tag: event from non-Notes-App-Events calendar gets @CalendarTitle appended', async () => {
    const plugin = makeCalPlugin([
      makeEvent('e5', 'Yoga Class', true, 'work-cal-id', 'Work'),
    ]);
    setupCalPlugin(plugin);

    NoteStorage.getNote.mockResolvedValue(null);
    NoteStorage.setNote.mockResolvedValue();

    await syncCalendarToMarkdown(['work-cal-id']);

    const noteCall = NoteStorage.setNote.mock.calls.find(([n]) => n === noteName);
    expect(noteCall[1]).toContain('@Work');
    const store = getSavedStore();
    expect(store[noteName].events[0].calendarTag).toBe('Work');
  });

  test('@tag: event from Notes App Events calendar does NOT get @tag', async () => {
    const plugin = makeCalPlugin([
      makeEvent('e6', 'My Meeting', true, 'notes-cal-id', 'Notes App Events'),
    ]);
    setupCalPlugin(plugin);

    NoteStorage.getNote.mockResolvedValue(null);
    NoteStorage.setNote.mockResolvedValue();

    await syncCalendarToMarkdown(['notes-cal-id']);

    const noteCall = NoteStorage.setNote.mock.calls.find(([n]) => n === noteName);
    expect(noteCall[1]).not.toContain('@');
    const store = getSavedStore();
    expect(store[noteName].events[0].calendarTag).toBeNull();
  });

  test('@tag: calendar title with spaces has spaces stripped in tag', async () => {
    const plugin = makeCalPlugin([
      makeEvent('e7', 'Sprint Review', true, 'team-cal-id', 'Team Calendar'),
    ]);
    setupCalPlugin(plugin);

    NoteStorage.getNote.mockResolvedValue(null);
    NoteStorage.setNote.mockResolvedValue();

    await syncCalendarToMarkdown(['team-cal-id']);

    const savedContent = NoteStorage.setNote.mock.calls[0][1];
    expect(savedContent).toContain('@TeamCalendar');
    expect(savedContent).not.toContain('@ ');
  });

  // ── All-day duplicate detection — date comparison (Bug 4) ──────────────────
  // Two iOS all-day events with identical titles but different dates must NOT
  // be collapsed into a single markdown line. The duplicate check must compare
  // start dates, not just titles.
  test('two all-day events with the same title on different dates are both inserted', async () => {
    const FUTURE_DATE2 = new Date(FUTURE_DATE.getTime() + 86400000 * 3); // 3 days later
    const dateStr2 = dateToYYMMDD(FUTURE_DATE2);
    const noteName2 = `${dateStr2} Daily Note`;

    const makeEventOnDate = (id, title, d) => ({
      eventId: id,
      title,
      allDay: true,
      calendarId: 'notes-cal-id',
      calendarTitle: 'Notes App Events',
      startDate: new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString(),
      endDate:   new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString(),
    });

    const plugin = makeCalPlugin([
      makeEventOnDate('same-1', 'Standup', FUTURE_DATE),
      makeEventOnDate('same-2', 'Standup', FUTURE_DATE2),
    ]);
    const calPlugin = plugin;
    global.window.Capacitor = { Plugins: { CalendarPlugin: calPlugin } };

    NoteStorage.getNote.mockResolvedValue(null);
    NoteStorage.setNote.mockResolvedValue();

    await syncCalendarToMarkdown(['cal-1']);

    // Both notes should be written with the Standup event
    const noteCall1 = NoteStorage.setNote.mock.calls.find(([n]) => n === noteName);
    const noteCall2 = NoteStorage.setNote.mock.calls.find(([n]) => n === noteName2);
    expect(noteCall1).toBeDefined();
    expect(noteCall2).toBeDefined();
    expect(noteCall1[1]).toContain('Standup');
    expect(noteCall2[1]).toContain('Standup');

    // Both events tracked in metadata with their own IDs
    const store = getSavedStore();
    const ids = [
      ...(store[noteName]?.events || []),
      ...(store[noteName2]?.events || []),
    ].map(e => e.eventId);
    expect(ids).toContain('same-1');
    expect(ids).toContain('same-2');
  });
});

// ── @CalendarName tag — parseMarkdownEvents tests ────────────────────────────

describe('parseMarkdownEvents — @CalendarName tag', () => {
  test('all-day event with @tag: captures calendarTag, text unaffected', () => {
    const events = parseMarkdownEvents('Meeting > 260315 @Work\n', '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Meeting');
    expect(events[0].calendarTag).toBe('Work');
    expect(events[0].allDay).toBe(true);
  });

  test('timed event with @tag: captures calendarTag, text unaffected', () => {
    const events = parseMarkdownEvents('Standup > 260315 0900 0930 @Work\n', '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Standup');
    expect(events[0].calendarTag).toBe('Work');
    expect(events[0].allDay).toBe(false);
  });

  test('multi-day event with @tag: captures calendarTag', () => {
    const events = parseMarkdownEvents('Conference > 260315 260317 @Personal\n', '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Conference');
    expect(events[0].calendarTag).toBe('Personal');
  });

  test('no tag: calendarTag is null', () => {
    const events = parseMarkdownEvents('Meeting > 260315\n', '260315');
    expect(events).toHaveLength(1);
    expect(events[0].calendarTag).toBeNull();
  });

  test('@tag in event title (before >) is not parsed as calendarTag', () => {
    const events = parseMarkdownEvents('@Work Meeting > 260315\n', '260315');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('@Work Meeting');
    expect(events[0].calendarTag).toBeNull();
  });
});

// ── @CalendarName tag — syncMarkdownToCalendar routing tests ─────────────────

describe('syncMarkdownToCalendar — @CalendarName routing', () => {
  function setupPlugin(plugin) {
    global.window.Capacitor = { Plugins: { CalendarPlugin: plugin } };
  }

  test('@Work tag routes createEvent to Work calendar ID', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    const noteContent = '# 260315 Daily Note\nStandup > 260315 @Work\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Standup', calendarId: 'work-cal-id' })
    );
  });

  test('unknown @tag falls back to Notes App Events calendar', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    const noteContent = '# 260315 Daily Note\nMeeting > 260315 @UnknownCalendar\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Meeting', calendarId: 'notes-cal-id' })
    );
  });

  test('@tag stored in metadata calendarTag field', async () => {
    const plugin = makePlugin();
    setupPlugin(plugin);

    const noteContent = '# 260315 Daily Note\nStandup > 260315 @Work\n';
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();

    await syncMarkdownToCalendar(['cal-1']);

    const store = getSavedStore();
    expect(store['260315 Daily Note'].events[0].calendarTag).toBe('Work');
  });

  test('calendar tag change triggers delete + create in new calendar', async () => {
    const plugin = makePlugin({
      createEvent: jest.fn().mockResolvedValue({ eventId: 'new-personal-id' }),
    });
    setupPlugin(plugin);

    // Metadata shows event was in Work calendar (lineIndex 1, no inline comment)
    const meta = {
      events: [{
        eventId: 'old-work-id',
        title: 'Standup',
        lineText: 'Standup > 260315 @Work',
        lineIndex: 1,
        calendarTag: 'Work',
      }]
    };
    // Note now has @Personal instead of @Work
    const noteContent = `# 260315 Daily Note\nStandup > 260315 @Personal\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    // Old Work event should be deleted
    expect(plugin.deleteEvent).toHaveBeenCalledWith({ eventId: 'old-work-id' });
    // New event should be created in Personal calendar
    expect(plugin.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Standup', calendarId: 'personal-cal-id' })
    );
    // updateEvent must NOT have been called
    expect(plugin.updateEvent).not.toHaveBeenCalled();

    const savedMeta = getSavedStore()['260315 Daily Note'];
    expect(savedMeta.events[0].calendarTag).toBe('Personal');
    expect(savedMeta.events[0].eventId).toBe('new-personal-id');
  });

  test('removing @tag moves event back to Notes App Events', async () => {
    const plugin = makePlugin({
      createEvent: jest.fn().mockResolvedValue({ eventId: 'notes-app-id' }),
    });
    setupPlugin(plugin);

    const meta = {
      events: [{
        eventId: 'work-id',
        title: 'Standup',
        lineText: 'Standup > 260315 @Work',
        lineIndex: 1,
        calendarTag: 'Work',
      }]
    };
    // Tag removed — no @tag on line
    const noteContent = `# 260315 Daily Note\nStandup > 260315\n`;
    NoteStorage.getAllNotes.mockResolvedValue([{ name: '260315 Daily Note', content: noteContent }]);
    NoteStorage.setNote.mockResolvedValue();
    NoteStorage.getNote.mockImplementation(async (name) => {
      if (name === '.calendar_metadata') return JSON.stringify({ '260315 Daily Note': meta });
      return null;
    });

    await syncMarkdownToCalendar(['cal-1']);

    expect(plugin.deleteEvent).toHaveBeenCalledWith({ eventId: 'work-id' });
    expect(plugin.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Standup', calendarId: 'notes-cal-id' })
    );
    expect(plugin.updateEvent).not.toHaveBeenCalled();
  });
});
