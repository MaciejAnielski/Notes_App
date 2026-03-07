// iCloud Storage Bridge for iOS (Capacitor)
//
// This script provides a NoteStorage implementation backed by the custom
// ICloudStorage native plugin, which uses NSFileManager's ubiquity container
// API to read/write .md files in the app's iCloud Drive container.
//
// It must be loaded before storage.js so that window.CapacitorNoteStorage is
// available when storage.js checks for it.
//
// Xcode project requirements:
//   1. Enable the "iCloud" capability (Signing & Capabilities → + Capability → iCloud)
//   2. Check "iCloud Documents" (not CloudKit)
//   3. Add container: iCloud.com.notesapp.ios
//
// Native plugin files (must be added to the Xcode project):
//   - ios/plugins/ICloudStoragePlugin.swift
//   - ios/plugins/ICloudStoragePlugin.m

(function () {
  // Only run on native iOS
  if (!window.Capacitor?.isNativePlatform()) return;

  // Access the custom native ICloudStorage plugin via Capacitor's plugin registry
  const ICloudStorage = window.Capacitor.Plugins.ICloudStorage;
  if (!ICloudStorage) {
    console.warn('icloud-bridge: ICloudStorage native plugin not available');
    return;
  }

  window.CapacitorNoteStorage = {
    async getNote(name) {
      try {
        const result = await ICloudStorage.get({ name });
        // Native plugin returns { content: string | null }
        return result.content ?? null;
      } catch {
        return null;
      }
    },

    async setNote(name, content) {
      await ICloudStorage.set({ name, content });
    },

    async removeNote(name) {
      try {
        await ICloudStorage.remove({ name });
      } catch {
        // File may not exist
      }
    },

    async getAllNoteNames() {
      try {
        const result = await ICloudStorage.list();
        return result.names || [];
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
      try {
        const result = await ICloudStorage.clear();
        return result.count || 0;
      } catch {
        return 0;
      }
    }
  };
})();
