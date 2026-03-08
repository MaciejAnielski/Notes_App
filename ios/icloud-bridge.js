// iCloud Storage Bridge for iOS (Capacitor)
//
// This script provides a NoteStorage implementation backed by the Capacitor
// Filesystem plugin, writing .md files to the iCloud Documents directory.
// It must be loaded before storage.js so that window.CapacitorNoteStorage is
// available when storage.js checks for it.
//
// Xcode project requirements:
//   1. Enable the "iCloud" capability
//   2. Enable "iCloud Documents" (not CloudKit)
//   3. Set iCloud container identifier: iCloud.com.notesapp.ios
//
// Files are stored in the app's iCloud container Documents folder, which
// appears in the iOS Files app under "Notes App".

(function () {
  // Only run on native iOS
  if (!window.Capacitor?.isNativePlatform()) return;

  // Capacitor Filesystem plugin — imported via Capacitor's module system
  const { Filesystem, Directory, Encoding } = window.Capacitor.Plugins.Filesystem || {};
  if (!Filesystem) {
    console.warn('icloud-bridge: @capacitor/filesystem plugin not available');
    return;
  }

  // Notes are stored in the iCloud Documents directory under a "Notes App" subfolder.
  // On iOS with iCloud Documents enabled, Directory.ICloudDocuments maps to the
  // app's iCloud container (requires the iCloud Documents capability in Xcode with
  // container identifier iCloud.com.notesapp.ios).
  const NOTES_DIR = 'Notes App';
  const iCloudAvailable = !!Directory.ICloudDocuments;
  const DIRECTORY = Directory.ICloudDocuments || Directory.Documents;

  // Sanitize note names for use as filenames
  const UNSAFE_CHARS = /[/\\:*?"<>|]/g;
  function noteNameToFileName(name) {
    return name.replace(UNSAFE_CHARS, '_') + '.md';
  }
  function fileNameToNoteName(fileName) {
    if (!fileName.endsWith('.md')) return null;
    return fileName.slice(0, -3);
  }

  async function ensureDir() {
    try {
      await Filesystem.mkdir({
        path: NOTES_DIR,
        directory: DIRECTORY,
        recursive: true
      });
    } catch {
      // Directory may already exist
    }
  }

  window.CapacitorNoteStorage = {
    // true when the app has the iCloud Documents entitlement and files go to iCloud;
    // false when falling back to the local Documents sandbox.
    isICloudEnabled: iCloudAvailable,

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
      await ensureDir();
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
      } catch {
        // File may not exist
      }
    },

    async getAllNoteNames() {
      try {
        await ensureDir();
        const result = await Filesystem.readdir({
          path: NOTES_DIR,
          directory: DIRECTORY
        });
        return result.files
          .map(f => typeof f === 'string' ? f : f.name)
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
      for (const name of names) {
        await this.removeNote(name);
      }
      return names.length;
    },

    async openNotesFolder() {
      const App = window.Capacitor?.Plugins?.App;
      if (!App) return;
      // iOS does not allow passing file:// URIs for the app's iCloud container to
      // App.openUrl() — doing so triggers "Could not create a sandbox extension"
      // errors in the system log and the call silently fails.  The shareddocuments://
      // scheme is the only reliable way to bring the Files app to the foreground
      // from a sandboxed app; there is no public URL scheme for a specific folder.
      try {
        await App.openUrl({ url: 'shareddocuments://' });
      } catch {}
    }
  };
})();
