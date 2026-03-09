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

  const NOTES_DIR = '000_Notes';
  const BACKUPS_DIR = '001_Backups';
  const EXPORTS_DIR = '002_Exports';
  const DELETED_DIR = '003_Deleted';
  // Sanitize note names for use as filenames.
  const UNSAFE_CHARS = /[/\\:*?"<>|]/g;
  function noteNameToFileName(name) {
    return name.replace(UNSAFE_CHARS, '_') + '.md';
  }
  function fileNameToNoteName(fileName) {
    if (!fileName.endsWith('.md')) return null;
    return fileName.slice(0, -3);
  }
  function noteNameToAttachmentDir(name) {
    return name.replace(UNSAFE_CHARS, '_') + '.attachments';
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
    // If the check failed (false), retry periodically in case iCloud became
    // available after app launch (e.g. delayed sign-in or connectivity).
    let _availableCache = null;
    let _availableLastCheck = 0;
    const RECHECK_INTERVAL = 30000; // retry every 30s if unavailable
    let _notesDirCreated = false; // skip redundant mkdir after first call

    async function isAvailable() {
      const now = Date.now();
      if (_availableCache === null || (_availableCache === false && now - _availableLastCheck > RECHECK_INTERVAL)) {
        _availableLastCheck = now;
        try {
          const result = await ICloudPlugin.isAvailable();
          _availableCache = !!result.available;
          // Log the actual container path once so sync issues can be diagnosed.
          if (_availableCache && ICloudPlugin.getContainerPath) {
            ICloudPlugin.getContainerPath()
              .then(r => console.log('[icloud-bridge] container path:', r.path))
              .catch(() => {});
          }
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
        try {
          await ICloudPlugin.deleteFile({
            path: `${NOTES_DIR}/${noteNameToFileName(name)}`
          });
        } catch {}
      },

      async trashNote(name) {
        if (!await isAvailable()) return;
        const filename = noteNameToFileName(name);
        const attDirName = noteNameToAttachmentDir(name);
        try {
          await ICloudPlugin.mkdir({ path: DELETED_DIR });
          // Move .md file: read → write to deleted → delete from notes
          if (ICloudPlugin.rename) {
            await ICloudPlugin.rename({
              oldPath: `${NOTES_DIR}/${filename}`,
              newPath: `${DELETED_DIR}/${filename}`
            });
          } else {
            const result = await ICloudPlugin.readFile({ path: `${NOTES_DIR}/${filename}` });
            await ICloudPlugin.writeFile({ path: `${DELETED_DIR}/${filename}`, data: result.data });
            await ICloudPlugin.deleteFile({ path: `${NOTES_DIR}/${filename}` });
          }
        } catch {}
        // Move attachments dir
        try {
          const oldAttDir = `${NOTES_DIR}/${attDirName}`;
          const newAttDir = `${DELETED_DIR}/${attDirName}`;
          if (ICloudPlugin.rename) {
            await ICloudPlugin.rename({ oldPath: oldAttDir, newPath: newAttDir });
          } else {
            const result = await ICloudPlugin.readdir({ path: oldAttDir });
            await ICloudPlugin.mkdir({ path: newAttDir });
            const files = result.files.map(f => (typeof f === 'string' ? f : f.name));
            for (const f of files) {
              try {
                const readFn = ICloudPlugin.readBinaryFile || ICloudPlugin.readFile;
                const data = await readFn.call(ICloudPlugin, { path: `${oldAttDir}/${f}` });
                const writeFn = ICloudPlugin.writeBinaryFile || ICloudPlugin.writeFile;
                await writeFn.call(ICloudPlugin, { path: `${newAttDir}/${f}`, data: data.data });
                await ICloudPlugin.deleteFile({ path: `${oldAttDir}/${f}` });
              } catch {}
            }
          }
        } catch { /* no attachments — skip */ }
      },

      async getAllNoteNames() {
        if (!await isAvailable()) return [];
        try {
          if (!_notesDirCreated) {
            await ICloudPlugin.mkdir({ path: NOTES_DIR });
            _notesDirCreated = true;
          }
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
        // Read all notes in parallel to avoid sequential native bridge
        // round-trips which cause noticeable delays on iOS.
        const results = await Promise.all(
          names.map(async name => {
            const content = await this.getNote(name);
            return content !== null ? { name, content } : null;
          })
        );
        return results.filter(Boolean);
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
      },

      async writeAttachment(noteName, filename, base64data) {
        if (!await isAvailable()) return false;
        const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
        try {
          await ICloudPlugin.mkdir({ path: attDir });
          const writeFn = ICloudPlugin.writeBinaryFile || ICloudPlugin.writeFile;
          await writeFn.call(ICloudPlugin, { path: `${attDir}/${filename}`, data: base64data });
          return true;
        } catch { return false; }
      },

      async readAttachment(noteName, filename) {
        if (!await isAvailable()) return null;
        const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
        try {
          const readFn = ICloudPlugin.readBinaryFile || ICloudPlugin.readFile;
          const result = await readFn.call(ICloudPlugin, { path: `${attDir}/${filename}` });
          return result.data;
        } catch { return null; }
      },

      async renameAttachment(noteName, oldFilename, newFilename) {
        if (!await isAvailable()) return false;
        const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
        try {
          if (ICloudPlugin.rename) {
            await ICloudPlugin.rename({ oldPath: `${attDir}/${oldFilename}`, newPath: `${attDir}/${newFilename}` });
          } else {
            const result = await ICloudPlugin.readFile({ path: `${attDir}/${oldFilename}` });
            const writeFn = ICloudPlugin.writeBinaryFile || ICloudPlugin.writeFile;
            await writeFn.call(ICloudPlugin, { path: `${attDir}/${newFilename}`, data: result.data });
            await ICloudPlugin.deleteFile({ path: `${attDir}/${oldFilename}` });
          }
          return true;
        } catch { return false; }
      },

      async listAttachments(noteName) {
        if (!await isAvailable()) return [];
        const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
        try {
          const result = await ICloudPlugin.readdir({ path: attDir });
          return result.files.map(f => (typeof f === 'string' ? f : f.name)).filter(f => !f.startsWith('.'));
        } catch { return []; }
      },

      async removeAttachmentDir(noteName) {
        if (!await isAvailable()) return;
        const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
        try {
          if (ICloudPlugin.rmdir) {
            await ICloudPlugin.rmdir({ path: attDir, recursive: true });
          } else {
            try {
              const result = await ICloudPlugin.readdir({ path: attDir });
              const files = result.files.map(f => (typeof f === 'string' ? f : f.name));
              for (const f of files) {
                try { await ICloudPlugin.deleteFile({ path: `${attDir}/${f}` }); } catch {}
              }
            } catch {}
          }
        } catch {}
      },

      async renameAttachmentDir(oldNoteName, newNoteName) {
        if (!await isAvailable()) return;
        const oldDir = `${NOTES_DIR}/${noteNameToAttachmentDir(oldNoteName)}`;
        const newDir = `${NOTES_DIR}/${noteNameToAttachmentDir(newNoteName)}`;
        try {
          if (ICloudPlugin.rename) {
            await ICloudPlugin.rename({ oldPath: oldDir, newPath: newDir });
          } else {
            const result = await ICloudPlugin.readdir({ path: oldDir });
            await ICloudPlugin.mkdir({ path: newDir });
            const files = result.files.map(f => (typeof f === 'string' ? f : f.name));
            for (const f of files) {
              try {
                const readFn = ICloudPlugin.readBinaryFile || ICloudPlugin.readFile;
                const data = await readFn.call(ICloudPlugin, { path: `${oldDir}/${f}` });
                const writeFn = ICloudPlugin.writeBinaryFile || ICloudPlugin.writeFile;
                await writeFn.call(ICloudPlugin, { path: `${newDir}/${f}`, data: data.data });
                await ICloudPlugin.deleteFile({ path: `${oldDir}/${f}` });
              } catch {}
            }
          }
        } catch {}
      },

      async writeBackup(filename, data) {
        if (!await isAvailable()) return;
        await ICloudPlugin.mkdir({ path: BACKUPS_DIR });
        // Backup data is base64-encoded zip — write as binary
        if (ICloudPlugin.writeBinaryFile) {
          await ICloudPlugin.writeBinaryFile({ path: `${BACKUPS_DIR}/${filename}`, data });
        } else {
          await ICloudPlugin.writeFile({ path: `${BACKUPS_DIR}/${filename}`, data });
        }
      },

      async writeExport(filename, data) {
        if (!await isAvailable()) return;
        await ICloudPlugin.mkdir({ path: EXPORTS_DIR });
        await ICloudPlugin.writeFile({ path: `${EXPORTS_DIR}/${filename}`, data });
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

    async trashNote(name) {
      const filename = noteNameToFileName(name);
      const attDirName = noteNameToAttachmentDir(name);
      try {
        await Filesystem.mkdir({ path: DELETED_DIR, directory: DIRECTORY, recursive: true });
        // Move .md file
        try {
          await Filesystem.rename({
            from: `${NOTES_DIR}/${filename}`,
            to: `${DELETED_DIR}/${filename}`,
            directory: DIRECTORY
          });
        } catch {}
      } catch {}
      // Move attachments dir
      try {
        await Filesystem.rename({
          from: `${NOTES_DIR}/${attDirName}`,
          to: `${DELETED_DIR}/${attDirName}`,
          directory: DIRECTORY
        });
      } catch { /* no attachments — skip */ }
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
      const results = await Promise.all(
        names.map(async name => {
          const content = await this.getNote(name);
          return content !== null ? { name, content } : null;
        })
      );
      return results.filter(Boolean);
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
    },

    async writeAttachment(noteName, filename, base64data) {
      const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
      try {
        await Filesystem.mkdir({ path: attDir, directory: DIRECTORY, recursive: true });
        await Filesystem.writeFile({ path: `${attDir}/${filename}`, directory: DIRECTORY, data: base64data });
        return true;
      } catch { return false; }
    },

    async readAttachment(noteName, filename) {
      const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
      try {
        const result = await Filesystem.readFile({ path: `${attDir}/${filename}`, directory: DIRECTORY });
        return result.data;
      } catch { return null; }
    },

    async renameAttachment(noteName, oldFilename, newFilename) {
      const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
      try {
        await Filesystem.rename({
          from: `${attDir}/${oldFilename}`,
          to: `${attDir}/${newFilename}`,
          directory: DIRECTORY
        });
        return true;
      } catch { return false; }
    },

    async listAttachments(noteName) {
      const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
      try {
        const result = await Filesystem.readdir({ path: attDir, directory: DIRECTORY });
        return result.files.map(f => (typeof f === 'string' ? f : f.name)).filter(f => !f.startsWith('.'));
      } catch { return []; }
    },

    async removeAttachmentDir(noteName) {
      const attDir = `${NOTES_DIR}/${noteNameToAttachmentDir(noteName)}`;
      try { await Filesystem.rmdir({ path: attDir, directory: DIRECTORY, recursive: true }); } catch {}
    },

    async renameAttachmentDir(oldNoteName, newNoteName) {
      const oldDir = `${NOTES_DIR}/${noteNameToAttachmentDir(oldNoteName)}`;
      const newDir = `${NOTES_DIR}/${noteNameToAttachmentDir(newNoteName)}`;
      try {
        await Filesystem.rename({ from: oldDir, to: newDir, directory: DIRECTORY });
      } catch {}
    },

    async writeBackup(filename, data) {
      try {
        await Filesystem.mkdir({ path: BACKUPS_DIR, directory: DIRECTORY, recursive: true });
        // Backup data is base64-encoded zip — write without encoding for binary
        await Filesystem.writeFile({
          path: `${BACKUPS_DIR}/${filename}`,
          directory: DIRECTORY,
          data
        });
      } catch {}
    },

    async writeExport(filename, data) {
      try {
        await Filesystem.mkdir({ path: EXPORTS_DIR, directory: DIRECTORY, recursive: true });
        await Filesystem.writeFile({
          path: `${EXPORTS_DIR}/${filename}`,
          directory: DIRECTORY,
          data,
          encoding: Encoding.UTF8
        });
      } catch {}
    }
  };
})();
