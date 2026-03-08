// iCloud Storage Bridge for iOS (Capacitor)
//
// This script provides a NoteStorage implementation backed by a native iOS
// Capacitor plugin (ICloudPlugin / CapacitorICloud) that calls
// FileManager.url(forUbiquityContainerIdentifier:) to obtain the real iCloud
// container URL at runtime.
//
// Background: the @capacitor/filesystem plugin does not define
// Directory.ICloudDocuments, so any code that relied on that constant always
// received `undefined`, silently fell back to Directory.Documents (the local
// sandbox), and set isICloudEnabled = false.  This bridge corrects that by
// routing all file I/O through the native ICloudPlugin instead.
//
// Xcode project requirements:
//   1. Enable the "iCloud" capability.
//   2. Enable "iCloud Documents" (not CloudKit).
//   3. Set iCloud container identifier: iCloud.com.notesapp.ios
//
// Files are stored in the app's iCloud container under:
//   <container>/Documents/Notes App/<sanitized-name>.md
// This folder appears in the iOS Files app under "Notes App".

(function () {
  // Only run on native iOS.
  if (!window.Capacitor?.isNativePlatform()) return;

  const NOTES_DIR = 'Notes App';

  // Sanitize note names for use as filenames.
  const UNSAFE_CHARS = /[/\\:*?"<>|]/g;
  function noteNameToFileName(name) {
    return name.replace(UNSAFE_CHARS, '_') + '.md';
  }
  function fileNameToNoteName(fileName) {
    if (!fileName.endsWith('.md')) return null;
    return fileName.slice(0, -3);
  }

  // ─── Path A: native ICloudPlugin (true iCloud Documents support) ───────────
  //
  // ICloudPlugin is a local Capacitor plugin (capacitor-icloud) registered via
  // CocoaPods.  It uses FileManager.url(forUbiquityContainerIdentifier:) to
  // resolve the container and performs all I/O there.

  const ICloudPlugin = window.Capacitor?.Plugins?.ICloudPlugin;

  if (ICloudPlugin) {
    // Cache the availability check so we don't call the native bridge on every
    // operation (FileManager.url(forUbiquityContainerIdentifier:) can block).
    let _availableCache = null;

    async function isAvailable() {
      if (_availableCache === null) {
        try {
          const result = await ICloudPlugin.isAvailable();
          _availableCache = !!result.available;
        } catch {
          _availableCache = false;
        }
      }
      return _availableCache;
    }

    window.CapacitorNoteStorage = {
      // Reflects true iCloud availability (checked on first operation).
      // The main app reads this flag to decide whether to show "Saved to iCloud."
      get isICloudEnabled() { return _availableCache !== false; },

      async getNote(name) {
        if (!await isAvailable()) return null;
        try {
          const result = await ICloudPlugin.readFile({
            path: `${NOTES_DIR}/${noteNameToFileName(name)}`
          });
          return result.data;
        } catch {
          return null;
        }
      },

      async setNote(name, content) {
        if (!await isAvailable()) throw new Error('iCloud not available');
        // mkdir is a no-op if the directory already exists.
        await ICloudPlugin.mkdir({ path: NOTES_DIR });
        await ICloudPlugin.writeFile({
          path: `${NOTES_DIR}/${noteNameToFileName(name)}`,
          data: content
        });
      },

      async removeNote(name) {
        if (!await isAvailable()) return;
        await ICloudPlugin.deleteFile({
          path: `${NOTES_DIR}/${noteNameToFileName(name)}`
        });
      },

      async getAllNoteNames() {
        if (!await isAvailable()) return [];
        try {
          await ICloudPlugin.mkdir({ path: NOTES_DIR });
          const result = await ICloudPlugin.readdir({ path: NOTES_DIR });
          return result.files
            .map(f => (typeof f === 'string' ? f : f.name))
            .filter(f => f.endsWith('.md'))
            .map(f => fileNameToNoteName(f))
            .filter(Boolean);
        } catch {
          return [];
        }
      },

      async getAllNotes() {
        const names = await this.getAllNoteNames();
        const notes = [];
        for (const name of names) {
          const content = await this.getNote(name);
          if (content !== null) notes.push({ name, content });
        }
        return notes;
      },

      async clear() {
        const names = await this.getAllNoteNames();
        for (const name of names) await this.removeNote(name);
        return names.length;
      },

      async openNotesFolder() {
        const App = window.Capacitor?.Plugins?.App;
        if (!App) return;
        // iOS does not allow passing file:// URIs for the app's iCloud container
        // to App.openUrl() — the call silently fails with sandbox errors.
        // shareddocuments:// is the only public scheme that opens the Files app.
        try { await App.openUrl({ url: 'shareddocuments://' }); } catch {}
      }
    };

    return; // Native plugin registered — done.
  }

  // ─── Path B: @capacitor/filesystem fallback (local Documents only) ─────────
  //
  // ICloudPlugin is not available (e.g. the pod was not installed, or the app
  // is running in a simulator without iCloud).  Fall back to the Capacitor
  // Filesystem plugin writing to the local Documents sandbox so that the app
  // remains functional, but flag isICloudEnabled = false so the UI can inform
  // the user that iCloud sync is not active.
  //
  // Note: Directory.ICloudDocuments is NOT defined by @capacitor/filesystem and
  // evaluates to `undefined`.  We therefore use Directory.Documents explicitly
  // rather than relying on a non-existent constant.

  const { Filesystem, Directory, Encoding } = window.Capacitor?.Plugins?.Filesystem || {};
  if (!Filesystem) {
    console.warn('icloud-bridge: neither ICloudPlugin nor @capacitor/filesystem is available');
    return;
  }

  const DIRECTORY = Directory.Documents;

  window.CapacitorNoteStorage = {
    isICloudEnabled: false,

    async getNote(name) {
      try {
        const result = await Filesystem.readFile({
          path: `${NOTES_DIR}/${noteNameToFileName(name)}`,
          directory: DIRECTORY,
          encoding: Encoding.UTF8
        });
        return result.data;
      } catch {
        return null;
      }
    },

    async setNote(name, content) {
      try {
        await Filesystem.mkdir({ path: NOTES_DIR, directory: DIRECTORY, recursive: true });
      } catch {}
      await Filesystem.writeFile({
        path: `${NOTES_DIR}/${noteNameToFileName(name)}`,
        directory: DIRECTORY,
        data: content,
        encoding: Encoding.UTF8,
        recursive: true
      });
    },

    async removeNote(name) {
      try {
        await Filesystem.deleteFile({
          path: `${NOTES_DIR}/${noteNameToFileName(name)}`,
          directory: DIRECTORY
        });
      } catch {}
    },

    async getAllNoteNames() {
      try {
        await Filesystem.mkdir({ path: NOTES_DIR, directory: DIRECTORY, recursive: true });
        const result = await Filesystem.readdir({ path: NOTES_DIR, directory: DIRECTORY });
        return result.files
          .map(f => (typeof f === 'string' ? f : f.name))
          .filter(f => f.endsWith('.md'))
          .map(f => fileNameToNoteName(f))
          .filter(Boolean);
      } catch {
        return [];
      }
    },

    async getAllNotes() {
      const names = await this.getAllNoteNames();
      const notes = [];
      for (const name of names) {
        const content = await this.getNote(name);
        if (content !== null) notes.push({ name, content });
      }
      return notes;
    },

    async clear() {
      const names = await this.getAllNoteNames();
      for (const name of names) await this.removeNote(name);
      return names.length;
    },

    async openNotesFolder() {
      const App = window.Capacitor?.Plugins?.App;
      if (!App) return;
      try { await App.openUrl({ url: 'shareddocuments://' }); } catch {}
    }
  };
})();
