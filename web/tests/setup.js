// Global mocks for the browser environment expected by calendar-sync.js

global.CALENDARS_NOTE = 'Settings';
global.currentFileName = null;
global.textarea = { value: '' };
global.isPreview = false;
global.renderPreview = jest.fn();
global.invalidateScheduleCache = jest.fn();

global.NoteStorage = {
  getNote: jest.fn(),
  setNote: jest.fn(),
  getAllNotes: jest.fn(),
  removeNote: jest.fn(),
};

global.sendNotification = jest.fn();

// Capacitor not present by default; individual tests can override
Object.defineProperty(global, 'window', { value: global, writable: true });
global.window.Capacitor = null;
