# Sync Investigation: iOS & Desktop Bug Report

Investigating the reported issue: *"I can't force sync for ages and it takes me typing in a new line or something to get it to finally register."*

---

## How Sync Works (Summary)

### iOS
- **Storage**: Native `ICloudPlugin` (Swift/Capacitor) reads/writes directly to the iCloud container (`iCloud.com.notesapp.ios/Documents/000_Notes/`)
- **Change detection**: 15-second polling timer calling `checkICloudChanges()`, paused after 30 min of inactivity
- **Force sync**: Tapping the status bar calls `checkICloudChanges(true)` directly
- **How it reads**: Calls `NoteStorage.getNote(currentFileName)` which goes to `ICloudPlugin.readFile` → `waitForDownload` → `NSFileCoordinator.coordinate(readingItemAt:)`

### Desktop
- **Storage**: Files in `~/Library/Mobile Documents/com~apple~CloudDocs/Notes App/000_Notes/` (CloudDocs), mirrored to `~/Library/Mobile Documents/iCloud~com~notesapp~ios/Documents/000_Notes/` (iOS container)
- **Change detection**: `fs.watch` file watcher (300ms debounce) + 15-second iCloud poll
- **Force sync**: Clicking status bar calls `window.electronAPI.notes.forceSync()` → IPC → `fullSync()` in main process → sends `notes:changed` to renderer → `onExternalChange` handler
- **Inactivity pause**: After 30 min idle, `_desktopInactivePaused = true`; sync events from `onExternalChange` are silently dropped

---

## Bugs Found

### Bug 1 (Primary — iOS): Force sync reads stale local iCloud cache, never triggering download of newer cloud versions

**File**: `ios/plugins/capacitor-icloud/ios/Plugin/ICloudPlugin.swift:128-141`

```swift
private func waitForDownload(at url: URL, timeout: TimeInterval = 10.0) -> Bool {
    if FileManager.default.fileExists(atPath: url.path) { return true }  // ← BUG HERE
    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
    // ... poll ...
}
```

**Problem**: If the note file exists locally (already downloaded), `waitForDownload` returns `true` immediately *without checking whether a newer version exists in the cloud*. `startDownloadingUbiquitousItem` is never called for already-cached files. So `readFile` always returns the stale local version.

**Effect**: When the user edits a note on desktop and iCloud propagates the change, the iOS iCloud container may have a cloud-side update pending. But because the old file still exists locally as a regular file (not yet replaced by the cloud version), `waitForDownload` returns the stale cached copy. Force sync reads this stale copy, finds `content === textarea.value`, and reports **"iCloud: Up to date."** — even though there ARE changes waiting in the cloud.

**Why typing fixes it**: When the user types something and auto-save fires, `NoteStorage.setNote` does a coordinated write to the iCloud container. This write "pokes" the iCloud daemon (bird/cloudd), which then delivers the pending remote changes. The next force sync or poll finds the updated content.

**Fix direction**: Call `startDownloadingUbiquitousItem` unconditionally before reading (even for locally present files), then wait briefly for iCloud to replace the local copy with the newer cloud version. Alternatively, use `NSMetadataQuery` to check `NSMetadataUbiquitousItemDownloadingStatusKey` and `NSMetadataUbiquitousItemIsDownloadingKey` before reading.

---

### Bug 2 (Secondary — Both platforms): `hasUnsavedEdits` blocks remote changes during force sync, with no visible recovery path

**File**: `web/app-init.js:547`, `web/app-init.js:497`

```javascript
const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
// ...
if (hasUnsavedEdits) {
  if (showStatus) updateStatus('iCloud: Remote change detected — keeping your edits.', true);
  // ← sync is silently blocked; remote change is NOT applied
}
```

**Problem**: `hasUnsavedEdits` is `true` the instant the user types anything, and stays `true` for up to 1 second (until the auto-save debounce fires at `autoSaveNote`). If the user taps force sync during this 1-second window, remote changes are blocked. The status shows "Remote change detected — keeping your edits." but there is no automatic retry after the auto-save completes. The user must manually tap force sync again.

**Compound problem**: If auto-save fails (e.g. no `#` title yet — `autoSaveNote` returns early without setting `_lastSavedContent`), `hasUnsavedEdits` remains `true` indefinitely. Force sync will always be blocked for that note until the note gets a proper title.

**Why typing fixes it**: Typing a newline (or any character after a pause) re-triggers the auto-save timer. After 1 second, auto-save fires (assuming a title exists), `_lastSavedContent = textarea.value`, `hasUnsavedEdits` becomes `false`, and the next force sync can apply remote changes.

**Fix direction**: When force sync is explicitly triggered by the user, flush the pending auto-save immediately (cancel the timer, save synchronously) *before* checking for remote changes. This way, `hasUnsavedEdits` is always `false` at the point of force sync.

---

### Bug 3 (Desktop): `onExternalChange` can drop the `notes:changed` event from force sync due to inactivity pause timing

**File**: `web/app-init.js:489-491`, `web/app-init.js:683-691`

```javascript
// Force sync click handler (fires at element level, before bubbling):
bottomArea.addEventListener('click', async () => {
  if (isDesktop) {
    updateStatus('Syncing\u2026', true, true);
    await window.electronAPI.notes.forceSync();  // ← awaits IPC response
    updateStatus('Synced.', true);               // ← status overwritten AFTER sync
  }
});

// onExternalChange (receives notes:changed from main process):
window.electronAPI.notes.onExternalChange(async (data) => {
  if (window._desktopSyncPaused?.()) return;  // ← silently drops if paused
  // ...
});
```

**Problem flow** (desktop, inactivity paused):
1. User clicks status bar
2. The click bubbles to `document` **before** the `async` handler's `await` completes (JS event propagation is synchronous; `await` yields to the event loop, allowing bubbling to proceed concurrently with the IPC call)
3. `onDesktopActivity()` on `document` fires and clears `_desktopInactivePaused = false`
4. IPC `notes:changed` arrives → `onExternalChange` runs → pause is already cleared → **sync works**
5. `forceSync()` IPC resolves → `updateStatus('Synced.', true)` **overwrites** the status message from `onExternalChange` (e.g. "iCloud: Note updated from another device.")

**Effect**: The sync itself works, but the final status is always "Synced." regardless of what `onExternalChange` found (could have been "Remote change detected — keeping your edits" or "Note updated"). The user loses the informative status message. In edge cases where event ordering differs (e.g. very slow IPC), the `notes:changed` event could arrive while still paused and be dropped.

**Fix direction**: Move `updateStatus('Synced.', true)` before `await window.electronAPI.notes.forceSync()`, or have `forceSync` return a result indicating what changed. Better: pass the pause-clearing into the force sync handler rather than relying on event bubbling order.

---

### Bug 4 (Desktop): `fullSync` uses mtime with 1-second tolerance, which can fail to sync nearly-simultaneous edits

**File**: `desktop/main.js:123`

```javascript
needsCopy = srcStat.mtimeMs > dstStat.mtimeMs + 1000; // 1s tolerance
```

**Problem**: `syncFile` (used by both `fullSync` and `writeThrough`) only copies the source to destination if the source is more than 1 second newer. If both the iOS file and CloudDocs file have mtimes within 1 second of each other (common when iCloud propagates a change and the desktop writes at nearly the same time), `fullSync` will skip both copy directions. Neither file "wins."

**Effect**: A race between two devices editing the same note within 1 second can result in `fullSync` leaving the files out of sync. The content hash check in the file watcher would eventually catch this, but `fullSync` itself (called by force sync) won't.

**Fix direction**: In `fullSync`, after the mtime check, also compare content hashes. If content differs and one file is newer (even within 1s), copy it. Or reduce/remove the tolerance.

---

### Bug 5 (iOS): `waitForDownload` timeout can cause `getNote` to return `null`, triggering incorrect "note deleted" behavior

**File**: `ios/plugins/capacitor-icloud/ios/Plugin/ICloudPlugin.swift:161-163`

```swift
if !self.waitForDownload(at: fileURL) {
    call.reject("File not found: \(path)")  // ← timeout treated same as deletion
    return
}
```

**File**: `web/app-init.js:558-563`

```javascript
} else {
  currentFileName = null;
  localStorage.removeItem('current_file');
  if (isPreview) previewDiv.innerHTML = '';
  updateStatus('iCloud: Current note deleted from another device.', false);
}
```

**Problem**: If `waitForDownload` times out (10s, on slow network), it returns `false` and `readFile` rejects with "File not found." The JS layer receives `null` from `getNote`. If `textarea.value` is empty at this point (e.g. user has a blank note open), `checkICloudChanges` treats this as "note deleted" and clears `currentFileName`. The note disappears from the editor even though it exists in iCloud — it just couldn't be downloaded in time.

**Fix direction**: Return a distinct error code for download timeout vs. genuine file-not-found. In `checkICloudChanges`, treat download timeouts as a transient error (show "sync failed, try again") rather than a deletion.

---

### Bug 6 (iOS): Inactivity pause uses `mousemove` which never fires on touchscreen

**File**: `web/app-init.js:632`

```javascript
document.addEventListener('mousemove', onIOSActivity, { passive: true });
```

**Problem**: On an iOS device (touchscreen only), `mousemove` never fires. This is dead code. It's not harmful (other events — `touchstart`, `keydown`, `click` — cover touch interaction), but it's misleading and wastes an event listener.

---

## Reproduction Scenario for Primary Bug (Bug 1)

1. Open a note on iOS that you've previously opened (cached locally)
2. Edit the same note on desktop, wait for iCloud to sync (watch for green dot in Finder)
3. On iOS, tap the status bar (force sync)
4. Expected: "iCloud: Note updated from another device."
5. Actual: "iCloud: Up to date." — the iOS device doesn't know there's a newer version
6. Type any character in the note on iOS, wait 1 second for auto-save
7. Tap force sync again (or wait 15s for poll)
8. Now sync works

This is exactly the pattern described: force sync does nothing, typing something fixes it.
