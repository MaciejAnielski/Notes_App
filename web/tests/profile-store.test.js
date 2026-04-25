// Smoke tests for ProfileStore — the pure registry layer.
// Verifies create / list / setActive / update / remove behaviours and the
// guard that prevents removing the last or active profile.

require('./setup');

beforeEach(() => {
  localStorage.clear();
  // Ensure no stale module is cached between tests.
  jest.resetModules();
  // Stub crypto.randomUUID so generated IDs are deterministic in node/jsdom.
  if (!global.crypto) global.crypto = {};
  let n = 0;
  global.crypto.randomUUID = () => `id-${++n}`;
  require('../js/profiles/profile-store.js');
});

afterEach(() => {
  delete global.window.ProfileStore;
});

describe('ProfileStore', () => {
  test('exists() is false when nothing has been written', () => {
    expect(window.ProfileStore.exists()).toBe(false);
  });

  test('ensureDefault creates a single Default profile and persists', () => {
    const p = window.ProfileStore.ensureDefault();
    expect(p.name).toBe('Default');
    expect(p.initial).toBe('D');
    expect(window.ProfileStore.list()).toHaveLength(1);
    expect(window.ProfileStore.getActiveId()).toBe(p.id);
  });

  test('ensureDefault is idempotent — does not duplicate', () => {
    const a = window.ProfileStore.ensureDefault();
    const b = window.ProfileStore.ensureDefault();
    expect(a.id).toBe(b.id);
    expect(window.ProfileStore.list()).toHaveLength(1);
  });

  test('create adds a new profile and assigns a unique color', () => {
    window.ProfileStore.ensureDefault();
    const p = window.ProfileStore.create({ name: 'Work' });
    expect(p.name).toBe('Work');
    expect(p.initial).toBe('W');
    const all = window.ProfileStore.list();
    expect(all).toHaveLength(2);
    expect(all[0].color).not.toBe(all[1].color);
  });

  test('update merges patches and keeps initial in sync with name', () => {
    const p = window.ProfileStore.ensureDefault();
    const updated = window.ProfileStore.update(p.id, { name: 'Personal' });
    expect(updated.name).toBe('Personal');
    expect(updated.initial).toBe('P');
  });

  test('setActive switches the active profile', () => {
    const a = window.ProfileStore.ensureDefault();
    const b = window.ProfileStore.create({ name: 'Work' });
    expect(window.ProfileStore.setActive(b.id)).toBe(true);
    expect(window.ProfileStore.getActiveId()).toBe(b.id);
  });

  test('remove rejects the last profile', () => {
    const a = window.ProfileStore.ensureDefault();
    expect(window.ProfileStore.remove(a.id)).toBe(false);
    expect(window.ProfileStore.list()).toHaveLength(1);
  });

  test('remove rejects the active profile', () => {
    const a = window.ProfileStore.ensureDefault();
    const b = window.ProfileStore.create({ name: 'Work' });
    // a is still active
    expect(window.ProfileStore.remove(a.id)).toBe(false);
    expect(window.ProfileStore.list()).toHaveLength(2);
    // remove the inactive one — succeeds
    expect(window.ProfileStore.remove(b.id)).toBe(true);
    expect(window.ProfileStore.list()).toHaveLength(1);
  });

  test('remove returns false for unknown id', () => {
    window.ProfileStore.ensureDefault();
    window.ProfileStore.create({ name: 'B' });
    expect(window.ProfileStore.remove('nonexistent')).toBe(false);
  });
});
