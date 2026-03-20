// app-init.js — Event listeners, toolbar, panels, mobile, sync, and initialization.
//
// This module is loaded last and wires up all event handlers, sets up the
// toolbar overflow menu, panel cycling, mobile swipe navigation,
// cross-device sync, and the async startup sequence.

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
  const files = Array.from(e.target.files);
  if (files.length === 0) return;
  const mdFiles = files.filter(f => f.name.endsWith('.md'));
  const zipFiles = files.filter(f => f.name.endsWith('.zip'));
  if (mdFiles.length > 0) await importNotesFromMd(mdFiles);
  if (zipFiles.length > 0) {
    for (const zf of zipFiles) await importNotesFromZip(zf);
  }
}));

toggleViewBtn.addEventListener('click', withBusyGuard(toggleView));

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

let _searchDebounce = null;
searchBox.addEventListener('input', () => {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(updateFileList, 200);
});
let _taskSearchDebounce = null;
searchTasksBox.addEventListener('input', () => {
  clearTimeout(_taskSearchDebounce);
  _taskSearchDebounce = setTimeout(() => updateTodoList(), 200);
});
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
    renderSchedule();
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
    renderSchedule();
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
    renderSchedule();
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
    refreshHighlight();
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
    await autoSaveNote();
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
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    if (window.electronAPI?.newWindow) {
      window.electronAPI.newWindow();
    }
    return; // don't fall through to regular new note
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

// ── Wiki-link autocomplete ────────────────────────────────────────────────
// Shows a floating dropdown of note names when the user types [[ in the editor.

{
  const dropdown = document.getElementById('wikilink-dropdown');
  let _acItems = [];
  let _acIdx = -1;
  let _acStart = -1; // char offset of the opening [[ in textarea

  function _renderDropdown(names) {
    dropdown.innerHTML = '';
    names.forEach((name, i) => {
      const item = document.createElement('div');
      item.className = 'wikilink-item' + (i === _acIdx ? ' wikilink-item-active' : '');
      item.setAttribute('role', 'option');
      item.textContent = name;
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // keep textarea focus
        _complete(name);
      });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  }

  function _positionDropdown() {
    // Place the mirror off-screen with position:absolute so that offsetTop/Left
    // give the character's position within the text layout. Then translate to
    // viewport coords using the textarea's bounding rect and scrollTop/Left.
    // This correctly handles a scrolled textarea, unlike a fixed-positioned mirror.
    const cs = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    mirror.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;visibility:hidden;' +
      'white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;pointer-events:none;' +
      'font:' + cs.font + ';padding:' + cs.padding + ';border:' + cs.border + ';' +
      'width:' + textarea.offsetWidth + 'px;line-height:' + cs.lineHeight + ';';
    // Measure at _acStart + 2 (right after [[) — stays fixed while typing.
    mirror.appendChild(document.createTextNode(textarea.value.slice(0, _acStart + 2)));
    const anchor = document.createElement('span');
    anchor.textContent = '\u200b';
    mirror.appendChild(anchor);
    document.body.appendChild(mirror);
    const anchorTop  = anchor.offsetTop;
    const anchorLeft = anchor.offsetLeft;
    const lineH = anchor.offsetHeight || parseFloat(cs.lineHeight) || 18;
    document.body.removeChild(mirror);

    const taRect = textarea.getBoundingClientRect();
    // Convert layout offset → viewport position by subtracting textarea scroll.
    let top  = taRect.top  + anchorTop  - textarea.scrollTop  + lineH + 4;
    let left = taRect.left + anchorLeft - textarea.scrollLeft;

    const dropW = Math.min(320, window.innerWidth - 16);
    if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;
    if (left < 8) left = 8;
    // If clipped by the bottom of the viewport, flip above the line instead.
    if (top + 200 > window.innerHeight - 8) {
      top = taRect.top + anchorTop - textarea.scrollTop - 4;
      dropdown.style.transform = 'translateY(-100%)';
    } else {
      dropdown.style.transform = '';
    }

    dropdown.style.top = top + 'px';
    dropdown.style.left = left + 'px';
  }

  function _complete(name) {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, _acStart);
    const after  = textarea.value.slice(pos);
    const insert = '[[' + name + ']]';
    textarea.value = before + insert + after;
    const newPos = before.length + insert.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    _hide();
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function _hide() {
    dropdown.style.display = 'none';
    _acItems = [];
    _acIdx = -1;
    _acStart = -1;
  }

  textarea.addEventListener('input', () => {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    // Look for an unclosed [[ before the cursor (no closing ]] yet on this line)
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (!m) { _hide(); return; }

    const partial = m[1].toLowerCase();
    const newStart = before.length - m[0].length;
    const isNewTrigger = newStart !== _acStart;
    _acStart = newStart;

    NoteStorage.getAllNoteNames().then(names => {
      const filtered = names
        .filter(n => !n.startsWith('.') && n.toLowerCase().includes(partial))
        .sort((a, b) => {
          const as = a.toLowerCase().startsWith(partial);
          const bs = b.toLowerCase().startsWith(partial);
          return (bs - as) || a.localeCompare(b);
        })
        .slice(0, 10);

      if (filtered.length === 0) { _hide(); return; }
      _acItems = filtered;
      _acIdx = 0;
      _renderDropdown(filtered);
      // Only reposition when [[ is first typed; anchor stays fixed after that.
      if (isNewTrigger) _positionDropdown();
    });
  });

  // Capture keydown so we intercept arrow keys before the textarea moves the cursor.
  textarea.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _acIdx = (_acIdx + 1) % _acItems.length;
      _renderDropdown(_acItems);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _acIdx = (_acIdx - 1 + _acItems.length) % _acItems.length;
      _renderDropdown(_acItems);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (_acIdx >= 0 && _acItems[_acIdx]) {
        e.preventDefault();
        e.stopPropagation();
        _complete(_acItems[_acIdx]);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      _hide();
    }
  }, true); // capture phase so we beat the Tab handler

  // Dismiss when the textarea loses focus (slight delay lets mousedown fire first).
  textarea.addEventListener('blur', () => setTimeout(_hide, 150));
}

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
      renderSchedule();
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
  // Re-apply theme/calendar colours when changed in another tab
  if (e.key === 'app_theme' || e.key === 'calendar_colors' || e.key === 'project_emojis') {
    if (e.key === 'app_theme') {
      const theme = getCurrentTheme();
      applyTheme(theme.background, theme.accent);
    }
    if (e.key === 'calendar_colors') invalidateScheduleCache();
    if (e.key === 'project_emojis' && typeof refreshProjectsNote === 'function') {
      refreshProjectsNote();
    }
    return;
  }
  if (e.key && e.key.startsWith('md_')) {
    const changedNote = e.key.slice(3);
    if (changedNote === currentFileName) {
      const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
      if (e.newValue === null) {
        if (textarea.value.trim()) {
          updateStatus('Note deleted in another window \u2014 keeping your content. Save to restore.', false);
        } else {
          textarea.value = '';
          currentFileName = null;
          localStorage.removeItem('current_file');
          if (isPreview) previewDiv.innerHTML = ''; else refreshHighlight();
          updateStatus('Note deleted in another window.', false);
        }
      } else if (hasUnsavedEdits) {
        updateStatus('Note updated in another window \u2014 keeping your unsaved edits.', true);
      } else {
        textarea.value = e.newValue;
        _lastSavedContent = e.newValue;
        if (isPreview) renderPreview(); else refreshHighlight();
        updateStatus('Note updated from another window.', true);
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

// ── PowerSync reactive sync (Desktop + iOS) ──────────────────────────────
// PowerSync handles all sync automatically. We just listen for changes
// and refresh the UI when the local SQLite database is updated.
//
// IMPORTANT: powersync-storage.js is a type="module" script whose async IIFE
// sets window.PowerSyncNoteStorage *after* several awaits (db.init, db.connect).
// By the time the synchronous body of this deferred script runs, that value is
// not yet set.  We therefore wrap the setup in a function and call it either
// immediately (when already ready, e.g. Electron fast path) or via the
// powersync:ready event (iOS, where the async init finishes later).

let _syncKnownNames = null;

async function handlePowerSyncChange() {
  if (!window.PowerSyncNoteStorage) return;
  let structuralChanged = false;
  let contentChanged = false;

  // Re-apply synced preferences if the preferences note changed
  if (typeof applySyncedPreferences === 'function') {
    await applySyncedPreferences();
  }

  if (currentFileName) {
    const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
    const content = await NoteStorage.getNote(currentFileName);
    if (content === null) {
      if (textarea.value.trim()) {
        try {
          await NoteStorage.setNote(currentFileName, textarea.value);
          _lastSavedContent = textarea.value;
          updateStatus('Note restored after sync conflict.', true);
        } catch {
          updateStatus('Note may have been deleted on another device.', false);
        }
      } else {
        currentFileName = null;
        localStorage.removeItem('current_file');
        if (isPreview || projectsViewActive) previewDiv.innerHTML = '';
        updateStatus('Current note was deleted on another device.', false);
      }
    } else if (content !== textarea.value) {
      if (hasUnsavedEdits) {
        updateStatus('Remote change detected \u2014 keeping your unsaved edits.', true);
      } else {
        textarea.value = content;
        _lastSavedContent = content;
        _lastRemoteContent = content;
        // projectsViewActive means a read-only note is shown in preview even
        // when isPreview is false — always re-render in that case too.
        if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
        updateStatus('Note updated from another device.', true);
        contentChanged = true;
      }
    }
  }

  const names = await NoteStorage.getAllNoteNames();
  const nameStr = names.slice().sort().join('\n');
  if (_syncKnownNames !== null && _syncKnownNames !== nameStr) {
    structuralChanged = true;
  }
  _syncKnownNames = nameStr;
  if (structuralChanged) {
    invalidateScheduleCache();
    await updateFileList();
  } else if (contentChanged) {
    invalidateScheduleCache();
  }
}

function _setupPowerSyncHandlers() {
  if (!window.PowerSyncNoteStorage) return;

  window.addEventListener('powersync:change', handlePowerSyncChange);

  // On iOS, also refresh on app resume
  if (window.Capacitor?.isNativePlatform()) {
    document.addEventListener('resume', () => handlePowerSyncChange());
  }

  _forceSyncCallback = async (showStatus) => {
    if (showStatus) updateStatus('Syncing With Cloud\u2026', true, true);
    if (window.PowerSyncNoteStorage.triggerSync) {
      await window.PowerSyncNoteStorage.triggerSync();
    }
    await handlePowerSyncChange();
    if (showStatus) updateStatus('Sync Complete.', true);
  };

  // Enable the status-area tap-to-sync button
  const bottomArea = document.getElementById('bottom-status-area');
  if (bottomArea) {
    bottomArea.style.cursor = 'pointer';
    bottomArea.title = 'Tap to sync';
    updateBackupStatus(); // Refresh to show "· Tap to Sync" hint on iOS
    bottomArea.addEventListener('click', async () => {
      if (autoSaveTimer !== null) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        await autoSaveNote();
      }
      if (_forceSyncCallback) {
        await _forceSyncCallback(true);
        // Lazy-start calendar sync on first manual sync (iOS defers startup
        // to avoid crashing the WebContent process).
        if (typeof window._startCalendarSyncIfNeeded === 'function') {
          window._startCalendarSyncIfNeeded();
        } else if (typeof runCalendarSync === 'function') {
          await runCalendarSync();
        }
      }
    });
  }
}

// Call immediately if PowerSync is already ready (e.g. Electron where the
// module finishes synchronously), otherwise wait for the ready event.
if (window.PowerSyncNoteStorage) {
  _setupPowerSyncHandlers();
} else if (window.electronAPI) {
  // Electron: wait for powersync:ready then set up handlers.
  window.addEventListener('powersync:ready', _setupPowerSyncHandlers, { once: true });
}

// iOS: PowerSync WASM is deferred (not loaded on startup). Set up a
// tap-to-sync handler that lazy-inits PowerSync on first tap.
if (window.Capacitor?.isNativePlatform() && window._lazyPowerSyncInit) {
  const bottomArea = document.getElementById('bottom-status-area');
  if (bottomArea) {
    bottomArea.style.cursor = 'pointer';
    bottomArea.title = 'Tap to sync';
    updateBackupStatus();
    bottomArea.addEventListener('click', async () => {
      if (autoSaveTimer !== null) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        await autoSaveNote();
      }
      updateStatus('Initializing sync\u2026', true, true);
      try {
        // Lazy-init: loads WASM, creates DB, switches NoteStorage.
        await window._lazyPowerSyncInit();
        // Now PowerSyncNoteStorage exists — set up change handlers.
        _setupPowerSyncHandlers();
        // Migrate any localStorage notes into PowerSync.
        await migrateLocalNotesToSync();
        // Trigger the actual sync.
        if (window.PowerSyncNoteStorage?.triggerSync) {
          updateStatus('Syncing With Cloud\u2026', true, true);
          await window.PowerSyncNoteStorage.triggerSync();
        }
        await handlePowerSyncChange();
        // Start calendar sync now that PowerSync is ready.
        if (typeof window._startCalendarSyncIfNeeded === 'function') {
          window._startCalendarSyncIfNeeded();
        }
        updateStatus('Sync Complete.', true);
      } catch (e) {
        console.error('[sync] iOS lazy init + sync failed:', e);
        updateStatus('Sync failed.', true);
      }
    });
  }
}

// ── Async initialization ──────────────────────────────────────────────────

const savedChain = localStorage.getItem('linked_chain');
if (savedChain) {
  try { linkedNoteChain = JSON.parse(savedChain); } catch(e) { linkedNoteChain = []; localStorage.removeItem('linked_chain'); }
}

function setLoadingProgress(pct, label) {
  const bar = document.getElementById('loading-progress-bar');
  const lbl = document.getElementById('loading-progress-label');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = label;
}

/**
 * Migrate notes from localStorage to PowerSync when sync is first activated.
 * Reads all 'md_*' keys from localStorage and writes any that don't already
 * exist in the sync database. This prevents data loss when a user enables
 * sync after having created notes locally.
 */
async function migrateLocalNotesToSync() {
  const localKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('md_')) localKeys.push(key);
  }
  if (localKeys.length === 0) return;

  let migrated = 0;
  for (const key of localKeys) {
    const noteName = key.slice(3);
    // Skip virtual notes — they are generated locally from synced note names
    // and preferences, and should never be written to the sync database.
    if (noteName === PROJECTS_NOTE || noteName === GRAPH_NOTE) continue;
    const localContent = localStorage.getItem(key);
    if (!localContent) continue;
    // Only insert notes that don't already exist in the sync database so
    // that remote notes (synced from other devices) are never overwritten.
    const existing = await NoteStorage.getNote(noteName);
    if (existing === null) {
      await NoteStorage.setNote(noteName, localContent);
      migrated++;
    }
  }

  if (migrated > 0) {
    console.log(`[sync] Migrated ${migrated} local note(s) to sync storage.`);
  }
}

(async () => {
  try {
    setLoadingProgress(5, 'Starting\u2026');

    // Wait for PowerSync to finish initializing before any NoteStorage operations.
    // powersync-storage.js is an async IIFE that may still be running when this
    // script executes. Resolves immediately when:
    //   • powersync:ready   — fully initialized (sync enabled + authenticated)
    //   • powersync:disabled — sync turned off by user; use localStorage
    //   • powersync:auth-required — sync enabled but not signed in; use localStorage
    // A 5-second timeout also falls back to localStorage gracefully.
    if ((window.electronAPI || window.Capacitor?.isNativePlatform()) && !window.PowerSyncNoteStorage) {
      setLoadingProgress(10, 'Connecting\u2026');
      await new Promise(resolve => {
        window.addEventListener('powersync:ready', resolve, { once: true });
        window.addEventListener('powersync:disabled', resolve, { once: true });
        window.addEventListener('powersync:auth-required', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
      if (window.PowerSyncNoteStorage) {
        window.NoteStorage = window.PowerSyncNoteStorage;
        await migrateLocalNotesToSync();
      }
    }

    // Load synced preferences (theme, calendar colours, project emojis)
    setLoadingProgress(25, 'Loading preferences\u2026');
    if (typeof applySyncedPreferences === 'function') {
      await applySyncedPreferences();
    }

    // If sync is active but no notes exist locally yet, the initial sync is still
    // downloading notes from the remote. Show a status message so the user knows
    // why notes aren't visible yet, and wait briefly for the first batch.
    if (window.PowerSyncNoteStorage) {
      const existingNames = await NoteStorage.getAllNoteNames();
      if (existingNames.length === 0) {
        setLoadingProgress(35, 'Downloading notes\u2026');
        updateStatus('Downloading notes\u2026 This may take a moment on first sync.', true, true);
        await new Promise(resolve => {
          const handler = () => {
            window.removeEventListener('powersync:change', handler);
            resolve();
          };
          window.addEventListener('powersync:change', handler);
          // Don't block startup longer than 8 seconds
          setTimeout(resolve, 8000);
        });
      }
    }

    setLoadingProgress(50, 'Loading note\u2026');
    const initialContent = lastFile ? await NoteStorage.getNote(lastFile) : null;
    if (initialContent !== null) {
      setLoadingProgress(65, 'Opening note\u2026');
      await loadNote(lastFile, true, initialContent);
    } else {
      setLoadingProgress(65, 'Creating note\u2026');
      await newNote();
    }

    setLoadingProgress(90, 'Almost ready\u2026');
    if (savedPreview && !isPreview) {
      await toggleView();
    }

    setLoadingProgress(100, 'Ready');
    // Brief pause so the filled bar is visible before fading out
    await new Promise(resolve => setTimeout(resolve, 150));
  } finally {
    // Always dismiss loading screen, even if initialisation threw an error
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
      loadingScreen.classList.add('fade-out');
      setTimeout(() => loadingScreen.remove(), 200);
    }
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
