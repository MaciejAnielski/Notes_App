// app-init.js — Event listeners, toolbar, panels, mobile, sync, and initialization.
//
// This module is loaded last and wires up all event handlers, sets up the
// toolbar overflow menu, panel cycling, mobile swipe navigation,
// cross-window/iCloud sync, and the async startup sequence.

// ── Button event registrations ────────────────────────────────────────────

function setupMobileButtonGroup(button, action) {
  const group = button.parentElement;
  const sub = group ? group.querySelector('.sub-button') : null;
  if (!group || !sub) {
    button.addEventListener('click', action);
    return;
  }

  let expanded = false;

  button.addEventListener('click', e => {
    const isMobileTouch = mobileTouchQuery.matches;
    if (isMobileTouch) {
      if (!expanded) {
        e.preventDefault();
        expanded = true;
        group.classList.add('active');
        const hide = evt => {
          if (!group.contains(evt.target)) {
            group.classList.remove('active');
            expanded = false;
            document.removeEventListener('click', hide);
          }
        };
        document.addEventListener('click', hide);
        return;
      }
      group.classList.remove('active');
      expanded = false;
    }
    action(e);
  });
}

setupMobileButtonGroup(newNoteBtn, withBusyGuard(newNote));
downloadAllBtn.addEventListener('click', withBusyGuard(downloadAllNotes));
setupMobileButtonGroup(exportNoteBtn, withBusyGuard(exportNote));
exportAllHtmlBtn.addEventListener('click', withBusyGuard(exportAllNotes));
setupMobileButtonGroup(deleteBtn, withBusyGuard(deleteNote));
deleteAllBtn.addEventListener('click', withBusyGuard(deleteAllNotes));
deleteSelectedBtn.addEventListener('click', withBusyGuard(deleteSelectedNotes));
exportSelectedBtn.addEventListener('click', withBusyGuard(exportSelectedNotes));
importZipBtn.addEventListener('click', () => importZipInput.click());
findBtn.addEventListener('click', openGlobalSearch);
importZipInput.addEventListener('change', withBusyGuard(async (e) => {
  if (e.target.files.length > 0) {
    await importNotesFromZip(e.target.files[0]);
  }
}));

toggleViewBtn.addEventListener('click', toggleView);

// ── Tools overflow menu ────────────────────────────────────────────────────
const toolsToggleGroup = document.getElementById('tools-toggle-group');
const toolsToggleBtn   = document.getElementById('tools-toggle');
const toolsOverflowRow = document.getElementById('tools-overflow-row');
const buttonContainer  = document.getElementById('button-container');

function checkToolbarOverflow() {
  const collapsibles = Array.from(
    document.querySelectorAll('.tools-collapsible')
  );

  const needsReturn = collapsibles.some(el => el.parentElement !== buttonContainer);
  if (needsReturn) {
    collapsibles.forEach(el => buttonContainer.insertBefore(el, toolsToggleGroup));
    toolsToggleGroup.style.display = 'none';
    toolsToggleGroup.classList.remove('active');
    toolsOverflowRow.classList.remove('open');
  }

  void buttonContainer.offsetWidth;

  const containerRight = buttonContainer.getBoundingClientRect().right;
  const visibleChildren = Array.from(buttonContainer.children).filter(
    el => el !== toolsToggleGroup && getComputedStyle(el).display !== 'none'
  );
  const lastChild = visibleChildren[visibleChildren.length - 1];
  const overflows = lastChild
    ? lastChild.getBoundingClientRect().right > containerRight + 1
    : false;

  if (overflows) {
    collapsibles.forEach(el => toolsOverflowRow.appendChild(el));
    toolsToggleGroup.style.display = 'inline-block';
  }
}

let toolsCloseTimer = null;

function openToolsOverflow() {
  clearTimeout(toolsCloseTimer);
  toolsOverflowRow.classList.add('open');
  toolsToggleGroup.classList.add('active');
}

function closeToolsOverflow() {
  toolsOverflowRow.classList.remove('open');
  toolsToggleGroup.classList.remove('active');
}

toolsToggleGroup.addEventListener('mouseenter', openToolsOverflow);
toolsToggleGroup.addEventListener('mouseleave', () => {
  toolsCloseTimer = setTimeout(closeToolsOverflow, 80);
});

toolsOverflowRow.addEventListener('mouseenter', () => {
  clearTimeout(toolsCloseTimer);
});
toolsOverflowRow.addEventListener('mouseleave', closeToolsOverflow);

const toolbarResizeObserver = new ResizeObserver(() => checkToolbarOverflow());
toolbarResizeObserver.observe(buttonContainer);
checkToolbarOverflow();

// ── Search and textarea listeners ─────────────────────────────────────────

searchBox.addEventListener('input', updateFileList);
searchTasksBox.addEventListener('input', () => updateTodoList());
textarea.addEventListener('input', () => {
  clearTimeout(autoSaveTimer);
  if (currentFileName === null) {
    const firstNewlineIdx = textarea.value.indexOf('\n');
    if (firstNewlineIdx === -1 || textarea.selectionStart <= firstNewlineIdx) return;
  }
  autoSaveTimer = setTimeout(autoSaveNote, 1000);
});

// ── Panel management ──────────────────────────────────────────────────────

function applyPinState() {
  if (isPanelPinned) {
    panelLists.classList.add('pinned', 'visible');
    panelPin.classList.add('active');
    document.body.classList.add('panel-pinned');
  } else {
    panelLists.classList.remove('pinned', 'visible');
    panelPin.classList.remove('active');
    document.body.classList.remove('panel-pinned');
  }
}

panelPin.addEventListener('click', () => {
  isPanelPinned = !isPanelPinned;
  localStorage.setItem('panel_pinned', isPanelPinned);
  applyPinState();
});

function cyclePanel() {
  if (filesContainer.classList.contains('active')) {
    filesContainer.classList.remove('active');
    todosContainer.classList.add('active');
    localStorage.setItem('active_panel', 'tasks');
  } else if (todosContainer.classList.contains('active')) {
    todosContainer.classList.remove('active');
    scheduleContainer.classList.add('active');
    localStorage.setItem('active_panel', 'schedule');
  } else {
    scheduleContainer.classList.remove('active');
    filesContainer.classList.add('active');
    localStorage.setItem('active_panel', 'files');
  }
}

panelArrow.addEventListener('click', cyclePanel);

filesContainer.querySelector('h2').addEventListener('click', () => {
  if (mobileMediaQuery.matches) return;
  cyclePanel();
});
todosContainer.querySelector('h2').addEventListener('click', () => {
  if (mobileMediaQuery.matches) {
    todosContainer.classList.remove('active');
    scheduleContainer.classList.add('active');
    localStorage.setItem('active_panel', 'schedule');
    return;
  }
  cyclePanel();
});
scheduleContainer.querySelector('h2').addEventListener('click', () => {
  if (mobileMediaQuery.matches) {
    scheduleContainer.classList.remove('active');
    todosContainer.classList.add('active');
    localStorage.setItem('active_panel', 'tasks');
    return;
  }
  cyclePanel();
});

schedulePrevBtn.addEventListener('click', () => {
  scheduleDate.setDate(scheduleDate.getDate() - 7);
  renderSchedule();
});
scheduleNextBtn.addEventListener('click', () => {
  scheduleDate.setDate(scheduleDate.getDate() + 7);
  renderSchedule();
});
scheduleDateLabel.addEventListener('click', () => {
  scheduleDate = new Date();
  renderSchedule();
});

function showPanel() {
  if (isPanelPinned) return;
  clearTimeout(peekHideTimer);
  panelLists.classList.add('visible');
  document.body.classList.add('panel-visible');
  updateBackupStatus();
}

function scheduleHidePanel() {
  if (isPanelPinned) return;
  clearTimeout(peekHideTimer);
  peekHideTimer = setTimeout(() => {
    panelLists.classList.remove('visible');
    document.body.classList.remove('panel-visible');
  }, 100);
}

panelArrow.addEventListener('mouseenter', showPanel);
panelArrow.addEventListener('mouseleave', scheduleHidePanel);
panelLists.addEventListener('mouseenter', showPanel);
panelLists.addEventListener('mouseleave', scheduleHidePanel);

applyPinState();
updateBackupStatus();

setInterval(updateBackupStatus, 3600000);

// Restore the last active panel
{
  const savedPanel = localStorage.getItem('active_panel');
  if (savedPanel === 'tasks') {
    filesContainer.classList.remove('active');
    todosContainer.classList.add('active');
  } else if (savedPanel === 'schedule') {
    filesContainer.classList.remove('active');
    scheduleContainer.classList.add('active');
  }
}

// ── Keyboard handlers ─────────────────────────────────────────────────────

textarea.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + '\t' + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
  }
});

// ── Attachment paste ──────────────────────────────────────────────────────

textarea.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const fileItems = Array.from(items).filter(it => it.kind === 'file');
  if (fileItems.length === 0) return;
  e.preventDefault();
  for (const item of fileItems) {
    const file = item.getAsFile();
    if (file) await handleAttachmentPaste(file);
  }
});

async function handleAttachmentPaste(file) {
  if (!currentFileName) {
    updateStatus('Open or create a note before attaching files.', false);
    return;
  }
  const rawName  = file.name || `attachment_${Date.now()}`;
  const dotIdx   = rawName.lastIndexOf('.');
  const ext      = dotIdx >= 0 ? rawName.slice(dotIdx + 1).toLowerCase() : '';
  const base     = dotIdx >= 0 ? rawName.slice(0, dotIdx) : rawName;
  const safeFilename = sanitizeAttachmentName(base) + (ext ? '.' + ext : '');

  updateStatus(`Attaching ${safeFilename}\u2026`, true);
  try {
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    const saved  = await NoteStorage.writeAttachment(currentFileName, safeFilename, base64);
    if (!saved) {
      updateStatus('Attachments require the desktop or iOS app.', false);
      return;
    }
    const isImage = file.type.startsWith('image/');
    const md = isImage
      ? `![${safeFilename}](attachment:${safeFilename})`
      : `[${safeFilename}](attachment:${safeFilename})`;
    insertAtCursor(md);
    updateStatus(`Attached ${safeFilename}.`, true);
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(autoSaveNote, 1000);
  } catch (err) {
    console.error('Attachment error:', err);
    updateStatus('Failed to attach file.', false);
  }
}

// ── Global keyboard shortcuts ─────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    newNote();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
    e.preventDefault();
    toggleView();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape' && !globalSearchPanel.classList.contains('gs-hidden')) {
    closeGlobalSearch();
  }
});

// ── Mobile Swipe Navigation ──────────────────────────────────────────────
{
  const mobileRightPanel = document.getElementById('mobile-right-panel');
  const mobileOverlay = document.getElementById('mobile-overlay');
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  const SWIPE_THRESHOLD = 50;
  const SWIPE_MAX_Y = 80;

  function isMobileView() {
    return mobileMediaQuery.matches;
  }

  function setupMobilePanels() {
    if (!isMobileView()) {
      if (mobileRightPanel.contains(todosContainer)) {
        panelLists.appendChild(todosContainer);
        panelLists.appendChild(scheduleContainer);
      }
      return;
    }
    if (!mobileRightPanel.contains(todosContainer)) {
      mobileRightPanel.appendChild(todosContainer);
      mobileRightPanel.appendChild(scheduleContainer);
    }
  }

  function activateNotesInLeftPanel() {
    filesContainer.classList.add('active');
    todosContainer.classList.remove('active');
    scheduleContainer.classList.remove('active');
  }

  function activateRightPanelTab() {
    const saved = localStorage.getItem('active_panel');
    if (saved === 'schedule') {
      todosContainer.classList.remove('active');
      scheduleContainer.classList.add('active');
    } else {
      todosContainer.classList.add('active');
      scheduleContainer.classList.remove('active');
    }
  }

  function openLeftPanel() {
    if (!isMobileView()) return;
    setupMobilePanels();
    activateNotesInLeftPanel();
    panelLists.classList.add('mobile-open-left');
    mobileOverlay.classList.add('active');
    updateBackupStatus();
  }

  function openRightPanel() {
    if (!isMobileView()) return;
    setupMobilePanels();
    activateRightPanelTab();
    mobileRightPanel.classList.add('mobile-open-right');
    mobileOverlay.classList.add('active');
  }

  function closeMobilePanels() {
    panelLists.classList.remove('mobile-open-left');
    mobileRightPanel.classList.remove('mobile-open-right');
    mobileOverlay.classList.remove('active');
  }

  mobileOverlay.addEventListener('click', closeMobilePanels);

  const EDGE_WIDTH = 30;

  document.addEventListener('touchstart', e => {
    if (!isMobileView()) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!isMobileView()) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    const elapsed = Date.now() - touchStartTime;
    const screenWidth = window.innerWidth;

    if (elapsed > 500 || dy > SWIPE_MAX_Y) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;

    const leftOpen = panelLists.classList.contains('mobile-open-left');
    const rightOpen = mobileRightPanel.classList.contains('mobile-open-right');

    if (dx > 0) {
      if (rightOpen) {
        closeMobilePanels();
      } else if (!leftOpen && touchStartX <= EDGE_WIDTH) {
        openLeftPanel();
      }
    } else {
      if (leftOpen) {
        closeMobilePanels();
      } else if (!rightOpen && touchStartX >= screenWidth - EDGE_WIDTH) {
        openRightPanel();
      }
    }
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (isMobileView()) {
      setupMobilePanels();
    } else {
      closeMobilePanels();
      if (mobileRightPanel.contains(todosContainer)) {
        panelLists.appendChild(todosContainer);
        panelLists.appendChild(scheduleContainer);
      }
    }
  });

  if (isMobileView()) {
    setupMobilePanels();
  }
}

// ── Cross-window sync via storage events ──────────────────────────────────
window.addEventListener('storage', e => {
  if (e.key === 'last_backup_time') {
    updateBackupStatus();
    return;
  }
  if (e.key && e.key.startsWith('md_')) {
    const changedNote = e.key.slice(3);
    if (changedNote === currentFileName) {
      const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
      if (e.newValue === null) {
        if (textarea.value.trim()) {
          updateStatus('Note deleted in another window — keeping your content. Save to restore.', false);
        } else {
          textarea.value = '';
          currentFileName = null;
          localStorage.removeItem('current_file');
          if (isPreview) previewDiv.innerHTML = '';
          updateStatus('Note Deleted In Another Window.', false);
        }
      } else if (hasUnsavedEdits) {
        updateStatus('Note updated in another window — keeping your edits.', true);
      } else {
        textarea.value = e.newValue;
        _lastSavedContent = e.newValue;
        if (isPreview) renderPreview(); else refreshHighlight();
        updateStatus('Note Updated From Another Window.', true);
      }
    }
    // Only rebuild the file list for structural changes (note added or deleted).
    // Content-only changes just invalidate the schedule cache so the next render is fresh.
    const isStructural = e.oldValue === null || e.newValue === null;
    if (isStructural) {
      updateFileList();
    } else {
      invalidateScheduleCache();
    }
    return;
  }
});

// ── External file change sync (Desktop/iOS) ──────────────────────────────
if (window.electronAPI?.notes?.onExternalChange) {
  let _desktopKnownNames = null;
  window.electronAPI.notes.onExternalChange(async (data) => {
    // Skip processing sync events while desktop is inactive (paused)
    if (window._desktopSyncPaused?.()) return;
    let contentChanged = false;
    const changedNote = data?.filename?.endsWith('.md')
      ? data.filename.slice(0, -3)
      : null;
    if (currentFileName) {
      const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
      const content = await NoteStorage.getNote(currentFileName);
      if (content === null) {
        if (textarea.value.trim()) {
          try {
            await NoteStorage.setNote(currentFileName, textarea.value);
            _lastSavedContent = textarea.value;
            updateStatus('iCloud: Note restored after sync conflict.', true);
          } catch {
            updateStatus('iCloud: Note may have been deleted on another device.', false);
          }
        } else {
          currentFileName = null;
          localStorage.removeItem('current_file');
          if (isPreview) previewDiv.innerHTML = '';
          updateStatus('iCloud: Current note deleted from another device.', false);
        }
      } else if (content !== textarea.value) {
        if (hasUnsavedEdits) {
          updateStatus('iCloud: Remote change detected — keeping your edits.', true);
        } else if (content.trim() === '' && textarea.value.trim() !== '') {
          try {
            await NoteStorage.setNote(currentFileName, textarea.value);
            _lastSavedContent = textarea.value;
            updateStatus('iCloud: Rejected blank sync — keeping your content.', true);
          } catch {}
        } else {
          textarea.value = content;
          _lastSavedContent = content;
          if (isPreview) renderPreview(); else refreshHighlight();
          updateStatus('iCloud: Note updated from another device.', true);
          contentChanged = true;
        }
      } else if (changedNote && changedNote !== currentFileName) {
        updateStatus(`iCloud: "${changedNote}" synced.`, true);
      } else if (!changedNote) {
        // Wildcard event (from force sync): current note is already up to date.
        updateStatus('iCloud: Up to date.', true);
      }
    } else if (changedNote) {
      updateStatus(`iCloud: "${changedNote}" synced.`, true);
    } else {
      // Wildcard force sync with no note open and nothing changed.
      updateStatus('iCloud: Up to date.', true);
    }
    const names = await NoteStorage.getAllNoteNames();
    const nameStr = names.slice().sort().join('\n');
    let structuralChanged = false;
    if (_desktopKnownNames !== null && _desktopKnownNames !== nameStr) {
      structuralChanged = true;
    }
    _desktopKnownNames = nameStr;
    if (structuralChanged) {
      invalidateScheduleCache();
      await updateFileList();
    } else if (contentChanged) {
      invalidateScheduleCache();
    }
  });
}

// On iOS (Capacitor), check for file changes when app resumes from background
if (window.Capacitor?.isNativePlatform()) {
  let _iCloudPollKnownNames = null;
  async function checkICloudChanges(showStatus) {
    if (showStatus) updateStatus('Syncing\u2026', true, true);
    let structuralChanged = false;
    let contentChanged = false;
    if (currentFileName) {
      const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
      const content = await NoteStorage.getNote(currentFileName);
      if (content === null && NoteStorage._lastGetNoteTimedOut) {
        // Download timed out (slow network) — do not treat as deletion.
        if (showStatus) updateStatus('iCloud: Sync timed out — check your connection.', false);
        return;
      }
      if (content === null) {
        if (textarea.value.trim()) {
          try {
            await NoteStorage.setNote(currentFileName, textarea.value);
            _lastSavedContent = textarea.value;
            updateStatus('iCloud: Note restored after sync conflict.', true);
          } catch {
            updateStatus('iCloud: Note may have been deleted on another device.', false);
          }
        } else {
          currentFileName = null;
          localStorage.removeItem('current_file');
          if (isPreview) previewDiv.innerHTML = '';
          updateStatus('iCloud: Current note deleted from another device.', false);
        }
      } else if (content !== textarea.value) {
        if (hasUnsavedEdits) {
          if (showStatus) updateStatus('iCloud: Remote change detected — keeping your edits.', true);
        } else if (content.trim() === '' && textarea.value.trim() !== '') {
          try {
            await NoteStorage.setNote(currentFileName, textarea.value);
            _lastSavedContent = textarea.value;
            if (showStatus) updateStatus('iCloud: Rejected blank sync — keeping your content.', true);
          } catch {}
        } else {
          textarea.value = content;
          _lastSavedContent = content;
          if (isPreview) renderPreview(); else refreshHighlight();
          updateStatus('iCloud: Note updated from another device.', true);
          contentChanged = true;
        }
      } else if (showStatus) {
        updateStatus('iCloud: Up to date.', true);
      }
    } else if (showStatus) {
      updateStatus('iCloud: Up to date.', true);
    }
    const names = await NoteStorage.getAllNoteNames();
    const nameStr = names.slice().sort().join('\n');
    if (_iCloudPollKnownNames !== null && _iCloudPollKnownNames !== nameStr) {
      structuralChanged = true;
    }
    _iCloudPollKnownNames = nameStr;
    if (structuralChanged) {
      invalidateScheduleCache();
      await updateFileList();
    } else if (contentChanged) {
      invalidateScheduleCache();
    }
  }

  document.addEventListener('resume', () => checkICloudChanges(true));

  const IOS_POLL_MS = 15000;
  let _iosPollTimer = null;
  function startIOSPoll() {
    if (_iosPollTimer) return;
    _iosPollTimer = setInterval(() => checkICloudChanges(false), IOS_POLL_MS);
  }
  function stopIOSPoll() {
    if (_iosPollTimer) { clearInterval(_iosPollTimer); _iosPollTimer = null; }
  }
  startIOSPoll();
  document.addEventListener('resume', startIOSPoll);
  document.addEventListener('pause', stopIOSPoll);

  _forceSyncCallback = (showStatus) => checkICloudChanges(showStatus);

  // ── iOS inactivity pause: stop polling after 30 min of no user interaction ─
  {
    const INACTIVITY_MS = 30 * 60 * 1000;
    let _inactivityTimer = null;
    let _iosInactivePaused = false;

    function onIOSActivity() {
      if (_inactivityTimer) clearTimeout(_inactivityTimer);
      if (_iosInactivePaused) {
        _iosInactivePaused = false;
        startIOSPoll();
        checkICloudChanges(false);
      }
      _inactivityTimer = setTimeout(() => {
        _iosInactivePaused = true;
        stopIOSPoll();
      }, INACTIVITY_MS);
    }

    document.addEventListener('keydown', onIOSActivity, { passive: true });
    document.addEventListener('touchstart', onIOSActivity, { passive: true });
    document.addEventListener('click', onIOSActivity, { passive: true });
    onIOSActivity();
  }
}

// ── Desktop inactivity pause: skip sync processing after 30 min idle ─────────
if (window.electronAPI?.notes && !window.Capacitor?.isNativePlatform()) {
  const INACTIVITY_MS = 30 * 60 * 1000;
  let _desktopInactivityTimer = null;
  let _desktopInactivePaused = false;

  function onDesktopActivity() {
    if (_desktopInactivityTimer) clearTimeout(_desktopInactivityTimer);
    if (_desktopInactivePaused) {
      _desktopInactivePaused = false;
      // Trigger a sync check to catch any changes missed while paused
      if (window.electronAPI?.notes?.forceSync) {
        window.electronAPI.notes.forceSync();
      }
    }
    _desktopInactivityTimer = setTimeout(() => {
      _desktopInactivePaused = true;
    }, INACTIVITY_MS);
  }

  // Expose paused state so the external change handler can respect it
  window._desktopSyncPaused = () => _desktopInactivePaused;

  document.addEventListener('mousemove', onDesktopActivity, { passive: true });
  document.addEventListener('keydown', onDesktopActivity, { passive: true });
  document.addEventListener('touchstart', onDesktopActivity, { passive: true });
  document.addEventListener('click', onDesktopActivity, { passive: true });
  onDesktopActivity();
}

// ── Clickable status area — force iCloud sync ──────────────────────────────
(function setupStatusAreaClick() {
  const bottomArea = document.getElementById('bottom-status-area');
  if (!bottomArea) return;

  const isDesktop = !!window.electronAPI?.notes?.forceSync;
  const isIOS = !!(window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage);

  if (!isDesktop && !isIOS) return;

  bottomArea.style.cursor = 'pointer';
  bottomArea.title = 'Tap to sync';

  bottomArea.addEventListener('click', async () => {
    // Flush any pending auto-save before syncing so that hasUnsavedEdits is
    // false when the sync handler runs.  autoSaveNote is a no-op if the note
    // has no # title, preserving the "must have title to save" invariant.
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await autoSaveNote();
    }
    if (isDesktop) {
      updateStatus('Syncing\u2026', true, true);
      await window.electronAPI.notes.forceSync();
      // Do not overwrite status here — onExternalChange sets the final message.
    } else if (isIOS && _forceSyncCallback) {
      await _forceSyncCallback(true);
      // Also trigger calendar sync so it runs alongside the iCloud sync
      if (typeof runCalendarSync === 'function') {
        await runCalendarSync();
      }
    }
  });
})();

// ── Async initialization ──────────────────────────────────────────────────

const savedChain = localStorage.getItem('linked_chain');
if (savedChain) {
  try { linkedNoteChain = JSON.parse(savedChain); } catch(e) { linkedNoteChain = []; localStorage.removeItem('linked_chain'); }
}

(async () => {
  // Migrate localStorage notes to iCloud on first launch (desktop/iOS only).
  // Only runs once — uses a flag to prevent re-running if iCloud is transiently
  // empty (e.g. slow sync on cold start), which would destroy localStorage data.
  if (window.electronAPI?.notes || (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage)) {
    const migrationDone = localStorage.getItem('icloud_migration_done');
    if (!migrationDone) {
      const lsNotes = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('md_')) {
          lsNotes.push({ name: key.slice(3), content: localStorage.getItem(key) });
        }
      }
      if (lsNotes.length > 0) {
        const iCloudNames = await NoteStorage.getAllNoteNames();
        if (iCloudNames.length === 0) {
          for (const { name, content } of lsNotes) {
            await NoteStorage.setNote(name, content);
          }
          lsNotes.forEach(({ name }) => localStorage.removeItem('md_' + name));
          updateStatus(`Migrated ${lsNotes.length} note${lsNotes.length === 1 ? '' : 's'} to iCloud.`, true);
        }
      }
      localStorage.setItem('icloud_migration_done', '1');
    }
  }

  if (lastFile && await NoteStorage.getNote(lastFile) !== null) {
    await loadNote(lastFile, true);
  } else {
    await newNote();
  }

  if (savedPreview && !isPreview) {
    toggleView();
  }

  // ── iOS keyboard / visual viewport handling ──────────────────────────────
  if (window.visualViewport) {
    const fullViewportHeight = window.innerHeight;
    let _keyboardScrollTimer = null;

    const scrollCursorIntoView = () => {
      if (document.activeElement !== textarea || isPreview) return;
      const vv = window.visualViewport;
      const style = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
      // getLineScrollY returns Y within the text content area (excludes paddingTop),
      // so we need paddingTop to convert that offset to a position within the element.
      const paddingTop = parseFloat(style.paddingTop) || 0;

      // Measure the true cursor Y offset, accounting for wrapped lines.
      const cursorY = getLineScrollY(textarea, textarea.selectionStart);

      // Cursor's current position on screen (viewport coordinates).
      // Add paddingTop because cursorY is relative to the content area, not the
      // element's top edge.
      const taRect = textarea.getBoundingClientRect();
      const cursorScreenY = taRect.top + paddingTop + cursorY - textarea.scrollTop;

      // If cursor is outside the visible area above the keyboard, scroll it into view.
      // Use vv.height (the settled visual viewport height) as the reference so the
      // calculation is not thrown off by mid-animation values of the textarea's rect.
      const padding = lineHeight * 2;
      if (cursorScreenY > vv.height - padding || cursorScreenY < Math.max(taRect.top, 0)) {
        // Target: place cursor at 1/4 of the way down the visible area above the keyboard.
        // textarea.scrollTop = taRect.top + paddingTop + cursorY - targetScreenY
        textarea.scrollTop = Math.max(0, taRect.top + paddingTop + cursorY - vv.height / 4);
      }
    };

    const adjustForKeyboard = () => {
      const vv = window.visualViewport;
      document.body.style.height = vv.height + 'px';
      window.scrollTo(0, 0);
      gsKeyboardOffset = Math.max(0, fullViewportHeight - vv.height);
      globalSearchPanel.style.bottom = gsKeyboardOffset > 0 ? gsKeyboardOffset + 'px' : '';

      // Debounce cursor scroll — the viewport fires multiple resize events
      // when the iOS keyboard animates open; wait for it to fully settle.
      clearTimeout(_keyboardScrollTimer);
      _keyboardScrollTimer = setTimeout(scrollCursorIntoView, 250);
    };

    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', () => {
      window.scrollTo(0, 0);
    });

    // Also scroll cursor into view on selection changes (e.g. tap to reposition)
    textarea.addEventListener('input', () => {
      if (gsKeyboardOffset > 0) {
        clearTimeout(_keyboardScrollTimer);
        _keyboardScrollTimer = setTimeout(scrollCursorIntoView, 50);
      }
    });
    textarea.addEventListener('click', () => {
      if (gsKeyboardOffset > 0) {
        clearTimeout(_keyboardScrollTimer);
        _keyboardScrollTimer = setTimeout(scrollCursorIntoView, 50);
      }
    });
  }
})();
