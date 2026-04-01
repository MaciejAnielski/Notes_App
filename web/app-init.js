// app-init.js — Event listeners, toolbar, panels, mobile, sync, and initialization.
//
// This module is loaded last and wires up all event handlers, sets up the
// toolbar overflow menu, panel cycling, mobile swipe navigation,
// cross-device sync, and the async startup sequence.

// ── Platform class ────────────────────────────────────────────────────────
// Applied before any layout so macOS-specific CSS (drag regions, padding-left)
// takes effect immediately without a flash of wrong layout.
if (window.electronAPI) {
  document.body.classList.add('platform-' + window.electronAPI.platform, 'electron');
}

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
    const isMobileTouch = mobileMediaQuery.matches;
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

// ── macOS: drag the window by pressing on a toolbar button and moving > 5 px ──
// Empty toolbar space is handled natively via -webkit-app-region:drag on
// #button-container (styles.css).  This covers the case where the user starts
// a drag gesture on an interactive button, which has app-region:no-drag.
//
// A single shared mousemove listener on document avoids per-button listeners
// and correctly handles the pointer leaving the button mid-drag.
if (window.electronAPI?.platform === 'darwin') {
  const DRAG_THRESHOLD = 5;
  let _dragAnchorX = 0, _dragAnchorY = 0;
  let _watchingDrag = false; // true while mousedown is held on a toolbar button
  let _btnDragging  = false; // true after threshold exceeded

  document.querySelectorAll('#button-container button').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      _dragAnchorX  = e.clientX;
      _dragAnchorY  = e.clientY;
      _watchingDrag = true;
      _btnDragging  = false;
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!_watchingDrag || _btnDragging) return;
    if (Math.abs(e.clientX - _dragAnchorX) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - _dragAnchorY) > DRAG_THRESHOLD) {
      _watchingDrag = false;
      _btnDragging  = true;
      window.electronAPI.windowDragStart();
    }
  });

  document.addEventListener('mouseup', () => {
    _watchingDrag = false;
    if (_btnDragging) {
      window.electronAPI.windowDragStop();
      // Leave _btnDragging = true so the click capture below can suppress the
      // click event that fires immediately after mouseup.
    }
  });

  // Capture-phase click handler: suppress the button's action if the mouseup
  // ended a drag rather than a tap.
  document.addEventListener('click', (e) => {
    if (_btnDragging) {
      e.stopImmediatePropagation();
      _btnDragging = false;
    }
  }, true);

  // If the user releases the mouse outside the window the renderer never sees
  // mouseup.  Clear state on blur so subsequent clicks behave normally.
  window.addEventListener('blur', () => {
    _watchingDrag = false;
    if (_btnDragging) {
      window.electronAPI.windowDragStop();
      _btnDragging = false;
    }
  });
}

// ── Toolbar overflow — floating "…" popup ─────────────────────────────────
// Only buttons that genuinely don't fit on the first row overflow.  A "…"
// button appears between the last fitting collapsible and View; hovering it
// reveals a fixed, centred floating popup containing only the buttons that
// couldn't fit.  The popup does not shift any other layout.
const toolsOverflowRow = document.getElementById('tools-overflow-row');
const buttonContainer  = document.getElementById('button-container');
const viewGroup        = document.getElementById('toggle-view').parentElement;

// Create the "…" trigger and insert it between the collapsibles and View.
const overflowGroup = document.createElement('div');
overflowGroup.className = 'button-group';
overflowGroup.id = 'overflow-group';
const overflowBtn = document.createElement('button');
overflowBtn.id = 'overflow-btn';
overflowBtn.textContent = '\u2026';
overflowBtn.title = 'More tools';
overflowGroup.appendChild(overflowBtn);
buttonContainer.insertBefore(overflowGroup, viewGroup);
overflowGroup.style.display = 'none';

function _barOverflows() {
  let right = buttonContainer.getBoundingClientRect().right;
  // Shrink the available right boundary to avoid overlapping #panel-open-btn
  // when it is visible as a fixed element to the right of the toolbar.
  const panelOpenBtn = document.getElementById('panel-open-btn');
  if (panelOpenBtn && getComputedStyle(panelOpenBtn).display !== 'none') {
    right = Math.min(right, panelOpenBtn.getBoundingClientRect().left - 4);
  }
  const visible = Array.from(buttonContainer.children).filter(
    el => getComputedStyle(el).display !== 'none'
  );
  const last = visible[visible.length - 1];
  return last ? last.getBoundingClientRect().right > right + 1 : false;
}

function checkToolbarOverflow() {
  const collapsibles = Array.from(document.querySelectorAll('.tools-collapsible'));

  // Return every collapsible to the main bar (before the … button).
  collapsibles.forEach(el => buttonContainer.insertBefore(el, overflowGroup));
  // Also return any that ended up in the popup from a previous run.
  Array.from(toolsOverflowRow.children).forEach(el =>
    buttonContainer.insertBefore(el, overflowGroup)
  );
  overflowGroup.style.display = 'none';
  toolsOverflowRow.classList.remove('has-overflow', 'visible');

  if (!_barOverflows()) return; // everything fits

  // Show the … button and move rightmost collapsibles into the popup one by
  // one until the bar no longer overflows (or all collapsibles are moved).
  overflowGroup.style.display = '';
  const inBar = [...collapsibles];
  const overflowed = [];
  while (inBar.length > 0 && _barOverflows()) {
    const rightmost = inBar.pop();
    rightmost.remove();
    overflowed.unshift(rightmost); // preserve original left→right order
  }
  overflowed.forEach(el => toolsOverflowRow.appendChild(el));
  toolsOverflowRow.classList.add('has-overflow');
}

// ── Hover: show / hide the floating popup ─────────────────────────────────
let _overflowTimer = null;

function _showOverflow() {
  clearTimeout(_overflowTimer);
  toolsOverflowRow.style.top = buttonContainer.getBoundingClientRect().bottom + 'px';
  toolsOverflowRow.classList.add('visible');
  // Center popup on the "…" button, clamped so it stays within the viewport.
  requestAnimationFrame(() => {
    const btnRect = overflowGroup.getBoundingClientRect();
    const centerX = btnRect.left + btnRect.width / 2;
    const w = toolsOverflowRow.offsetWidth;
    const left = Math.max(8, Math.min(centerX - w / 2, window.innerWidth - w - 8));
    toolsOverflowRow.style.left = left + 'px';
  });
}

function _hideOverflow() {
  _overflowTimer = setTimeout(() => toolsOverflowRow.classList.remove('visible'), 80);
}

overflowGroup.addEventListener('mouseenter', _showOverflow);
overflowGroup.addEventListener('mouseleave', _hideOverflow);
toolsOverflowRow.addEventListener('mouseenter', () => clearTimeout(_overflowTimer));
toolsOverflowRow.addEventListener('mouseleave', _hideOverflow);

const toolbarResizeObserver = new ResizeObserver(checkToolbarOverflow);
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
  const wasUnpinning = isPanelPinned;
  isPanelPinned = !isPanelPinned;
  localStorage.setItem('panel_pinned', isPanelPinned);
  applyPinState();
  if (wasUnpinning) {
    // Suppress hover re-open until the mouse leaves the button area.
    panelOpenBtn.style.pointerEvents = 'none';
    const onMouseMove = (e) => {
      const rect = panelOpenBtn.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top  || e.clientY > rect.bottom) {
        panelOpenBtn.style.pointerEvents = '';
        document.removeEventListener('mousemove', onMouseMove);
      }
    };
    document.addEventListener('mousemove', onMouseMove);
  }
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
    scheduleNeedsScrollToNow = true;
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
    scheduleNeedsScrollToNow = true;
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
  scheduleNeedsScrollToNow = true;
  renderSchedule();
});

function showPanel() {
  if (isPanelPinned) return;
  clearTimeout(peekHideTimer);
  panelLists.classList.add('visible');
  document.body.classList.add('panel-visible');
  checkToolbarOverflow();
  updateBackupStatus();
}

function scheduleHidePanel() {
  if (isPanelPinned) return;
  clearTimeout(peekHideTimer);
  peekHideTimer = setTimeout(() => {
    panelLists.classList.remove('visible');
    document.body.classList.remove('panel-visible');
    checkToolbarOverflow();
  }, 100);
}

panelOpenBtn.addEventListener('mouseenter', showPanel);
panelOpenBtn.addEventListener('mouseleave', scheduleHidePanel);
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
    scheduleNeedsScrollToNow = true;
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
  // Check Shift+N first — on macOS, Cmd+Shift+N can report e.key === 'n' (lowercase),
  // so we must handle the new-window shortcut before the new-note shortcut.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    if (window.electronAPI?.newWindow) {
      window.electronAPI.newWindow();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
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

// ── Wiki-link autocomplete ────────────────────────────────────────────────
// Shows a floating dropdown of note names when the user types [[ or [ in the editor.
// Regex constants hoisted out of the per-keystroke input handler.
const _RE_AC_WIKI = /\[\[([^\]\n]*)$/;
const _RE_AC_MD   = /\[[^\[\]\n]*\]\(([^)\n]*)$/;

{
  const dropdown = document.getElementById('wikilink-dropdown');
  let _acItems = [];
  let _acIdx = -1;
  let _acStart = -1; // char offset of the opening [[ or [ in textarea
  let _acMode = 'wiki'; // 'wiki' for [[...]] syntax, 'md' for [...](url) syntax
  let _acWantedSet = new Set(); // names in _acItems that don't yet exist as notes

  // Cache of [[linked]] note names that don't exist yet, built by scanning all
  // notes. Refreshed periodically so newly created notes are reflected.
  let _wantedNotesCache = null;
  let _wantedNotesCacheTime = 0;
  const _WANTED_CACHE_TTL = 30000; // 30 s

  async function _getWantedNoteNames() {
    const now = Date.now();
    if (_wantedNotesCache && now - _wantedNotesCacheTime < _WANTED_CACHE_TTL) {
      return _wantedNotesCache;
    }
    const [allNotes, allNames] = await Promise.all([
      NoteStorage.getAllNotes(),
      NoteStorage.getAllNoteNames(),
    ]);
    const existingSet = new Set(allNames);
    const wikiRe = /\[\[([^\]]+)\]\]/g;
    const wanted = new Set();
    for (const { content } of allNotes) {
      let m;
      wikiRe.lastIndex = 0;
      while ((m = wikiRe.exec(content)) !== null) {
        const name = m[1].trim();
        if (!existingSet.has(name) && !name.startsWith('.')) wanted.add(name);
      }
    }
    _wantedNotesCache = [...wanted];
    _wantedNotesCacheTime = now;
    return _wantedNotesCache;
  }

  // Invalidate the wanted-notes cache whenever a note is created so the new
  // note no longer appears as a suggestion for notes not yet created.
  const _origSetNote = NoteStorage.setNote?.bind(NoteStorage);
  if (_origSetNote) {
    NoteStorage.setNote = async function(name, content) {
      _wantedNotesCache = null;
      return _origSetNote(name, content);
    };
  }

  function _renderDropdown(names, wantedSet) {
    dropdown.innerHTML = '';
    names.forEach((name, i) => {
      const item = document.createElement('div');
      const isWanted = wantedSet && wantedSet.has(name);
      item.className = 'wikilink-item' +
        (isWanted ? ' wikilink-item-new' : '') +
        (i === _acIdx ? ' wikilink-item-active' : '');
      item.setAttribute('role', 'option');
      // For []() md links, show and insert with underscores instead of spaces
      item.textContent = _acMode === 'md' ? name.replace(/ /g, '_') : name;
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
    // Measure right after the opening trigger — stays fixed while typing.
    const anchorOffset = _acMode === 'wiki' ? _acStart + 2 : _acStart + 1;
    mirror.appendChild(document.createTextNode(textarea.value.slice(0, anchorOffset)));
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
    const insert = _acMode === 'wiki'
      ? '[[' + name + ']]'
      : '(' + name.replace(/ /g, '_') + ')';
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
    _acMode = 'wiki';
    _acWantedSet = new Set();
  }

  function _handleMatch(partial, newStart, mode) {
    const isNewTrigger = newStart !== _acStart || _acMode !== mode;
    _acStart = newStart;
    _acMode = mode;

    Promise.all([
      NoteStorage.getAllNoteNames(),
      _getWantedNoteNames(),
    ]).then(([names, wantedNames]) => {
      // For md mode, the user may type underscores; normalise to spaces for matching
      const normPartial = mode === 'md' ? partial.replace(/_/g, ' ') : partial;

      const existingSet = new Set(names);
      const filtered = names
        .filter(n => !n.startsWith('.') && n.toLowerCase().includes(normPartial))
        .sort((a, b) => {
          const as = a.toLowerCase().startsWith(normPartial);
          const bs = b.toLowerCase().startsWith(normPartial);
          return (bs - as) || a.localeCompare(b);
        })
        .slice(0, 10);

      // Include wanted notes (referenced but not yet created) after existing ones.
      const filteredWanted = wantedNames
        .filter(n => !existingSet.has(n) && n.toLowerCase().includes(normPartial))
        .sort((a, b) => {
          const as = a.toLowerCase().startsWith(normPartial);
          const bs = b.toLowerCase().startsWith(normPartial);
          return (bs - as) || a.localeCompare(b);
        })
        .slice(0, 5);

      const combined = [...filtered, ...filteredWanted].slice(0, 10);
      if (combined.length === 0) { _hide(); return; }

      _acItems = combined;
      _acWantedSet = new Set(filteredWanted);
      _acIdx = 0;
      _renderDropdown(combined, _acWantedSet);
      // Only reposition when trigger is first typed; anchor stays fixed after that.
      if (isNewTrigger) _positionDropdown();
    });
  }

  textarea.addEventListener('input', () => {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);

    // Priority 1: unclosed [[ before cursor (wiki-link syntax [[Note Name]])
    const wikiM = before.match(_RE_AC_WIKI);
    if (wikiM) {
      _handleMatch(wikiM[1].toLowerCase(), before.length - wikiM[0].length, 'wiki');
      return;
    }

    // Priority 2: [Text]( before cursor (markdown link syntax [Text](Note Name))
    const mdM = before.match(_RE_AC_MD);
    if (mdM) {
      // _acStart points at the '(' so completion replaces only (partial → (name)
      const acStart = before.length - mdM[1].length - 1;
      _handleMatch(mdM[1].toLowerCase(), acStart, 'md');
      return;
    }

    _hide();
  });

  // Capture keydown so we intercept arrow keys before the textarea moves the cursor.
  textarea.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _acIdx = (_acIdx + 1) % _acItems.length;
      _renderDropdown(_acItems, _acWantedSet);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _acIdx = (_acIdx - 1 + _acItems.length) % _acItems.length;
      _renderDropdown(_acItems, _acWantedSet);
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

// ── Table row autofill suggestion ────────────────────────────────────────
// Shows a faded ghost-text suggestion for the predicted next table row when
// the user types "|" as the first character of a new line immediately below
// a markdown table with ≥ 2 body rows.  Enter accepts; any other key dismisses.
{
  const _trDiv = document.createElement('div');
  _trDiv.id = 'table-row-suggestion';
  _trDiv.style.display = 'none';
  document.body.appendChild(_trDiv);

  let _trSuggestion = null; // full predicted row string, e.g. "| 3 | 2024-01-03 |"

  function _trHide() {
    _trDiv.style.display = 'none';
    _trSuggestion = null;
  }

  // Position the ghost div at the cursor using the same mirror technique as the
  // wiki-link dropdown so metrics match the textarea font exactly.
  function _trPosition(cursorOffset) {
    const cs = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    mirror.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;visibility:hidden;' +
      'white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;pointer-events:none;' +
      'font:' + cs.font + ';padding:' + cs.padding + ';border:' + cs.border + ';' +
      'width:' + textarea.offsetWidth + 'px;line-height:' + cs.lineHeight + ';';
    mirror.appendChild(document.createTextNode(textarea.value.slice(0, cursorOffset)));
    const anchor = document.createElement('span');
    anchor.textContent = '\u200b';
    mirror.appendChild(anchor);
    document.body.appendChild(mirror);
    const anchorTop  = anchor.offsetTop;
    const anchorLeft = anchor.offsetLeft;
    document.body.removeChild(mirror);

    const taRect = textarea.getBoundingClientRect();
    _trDiv.style.font       = cs.font;
    _trDiv.style.lineHeight = cs.lineHeight;
    _trDiv.style.top        = (taRect.top  + anchorTop  - textarea.scrollTop)  + 'px';
    _trDiv.style.left       = (taRect.left + anchorLeft - textarea.scrollLeft) + 'px';
    _trDiv.style.maxWidth   = (taRect.right - taRect.left - anchorLeft - 4) + 'px';
  }

  // Position the ghost div using the Range API on the syntax-highlight <pre>.
  // The pre uses CSS transform for scrolling so getBoundingClientRect() on Range
  // objects already returns scroll-adjusted viewport coordinates — no manual
  // scroll offset needed.  Falls back to _trPosition() if the pre isn't ready.
  function _trPositionFromPre(cursorOffset) {
    if (typeof _highlightPre === 'undefined' || !_highlightPre) return false;
    try {
      let remaining = cursorOffset;
      let node = null;
      let nodeOffset = 0;
      const walker = document.createTreeWalker(_highlightPre, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (remaining <= textNode.length) {
          node = textNode;
          nodeOffset = remaining;
          break;
        }
        remaining -= textNode.length;
      }
      if (!node) return false;
      const range = document.createRange();
      range.setStart(node, nodeOffset);
      range.setEnd(node, nodeOffset);
      const rects = range.getClientRects();
      if (!rects || rects.length === 0) return false;
      const rect = rects[0];
      const cs = window.getComputedStyle(textarea);
      _trDiv.style.font       = cs.font;
      _trDiv.style.lineHeight = cs.lineHeight;
      _trDiv.style.top        = rect.top + 'px';
      _trDiv.style.left       = rect.left + 'px';
      const taRect = textarea.getBoundingClientRect();
      _trDiv.style.maxWidth   = (taRect.right - rect.left - 4) + 'px';
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── Date / number helpers ────────────────────────────────────────────────

  const _MONTHS_FULL  = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
  const _MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                          'Jul','Aug','Sep','Oct','Nov','Dec'];
  const _DAYS_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const _DAYS_FULL    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function _ordinalSuffix(n) {
    const s = n % 100;
    if (s >= 11 && s <= 13) return 'th';
    return ['th','st','nd','rd','th'][Math.min(n % 10, 4)];
  }

  // Convert unicode subscript digit string → integer
  function _subToNum(s) {
    return parseInt(s.replace(/[\u2080-\u2089]/g, c => c.charCodeAt(0) - 0x2080), 10);
  }
  // Convert integer → unicode subscript digit string
  function _numToSub(n) {
    return String(n).replace(/\d/g, d => String.fromCharCode(0x2080 + +d));
  }

  // Try to parse an ordinal-day-month string like "Mon 1st April", "Wednesday 2nd March 2025".
  // Returns a Date if successful, null otherwise.  Also returns style flags for formatting.
  function _parseOrdinalDate(v) {
    // Optional day-of-week (3-char short or full name), day+ordinal, month, optional year
    const re = /^(?:([A-Za-z]{3,9})\s+)?(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+?)(?:,?\s*(\d{4}))?$/;
    const m = v.match(re);
    if (!m) return null;
    const [, dow, dayStr, monthStr, yearStr] = m;
    const day = parseInt(dayStr, 10);
    const monthFull  = _MONTHS_FULL.findIndex(mo => mo.toLowerCase() === monthStr.toLowerCase());
    const monthShort = _MONTHS_SHORT.findIndex(mo => mo.toLowerCase() === monthStr.toLowerCase());
    const monthIdx   = monthFull >= 0 ? monthFull : monthShort;
    if (monthIdx < 0) return null;
    // Validate day-of-week string if provided (must be a recognised short or full name)
    let shortDow = false;
    if (dow) {
      const dowLower = dow.toLowerCase();
      const isShort = _DAYS_SHORT.some(d => d.toLowerCase() === dowLower);
      const isFull  = _DAYS_FULL.some(d => d.toLowerCase() === dowLower);
      if (!isShort && !isFull) return null;
      shortDow = isShort;
    }
    const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();
    const date = new Date(year, monthIdx, day);
    if (isNaN(date.getTime())) return null;
    return {
      date,
      hasDow:     !!dow,
      shortDow,
      shortMonth: monthFull < 0,
      hasYear:    !!yearStr,
    };
  }

  function _formatOrdinalDate(date, style) {
    const day      = date.getDate();
    const monthIdx = date.getMonth();
    const parts    = [];
    if (style.hasDow) parts.push(style.shortDow ? _DAYS_SHORT[date.getDay()] : _DAYS_FULL[date.getDay()]);
    parts.push(day + _ordinalSuffix(day));
    parts.push(style.shortMonth ? _MONTHS_SHORT[monthIdx] : _MONTHS_FULL[monthIdx]);
    if (style.hasYear)  parts.push(String(date.getFullYear()));
    return parts.join(' ');
  }

  // ── Per-cell pattern prediction ──────────────────────────────────────────

  function _predictCell(values) {
    if (values.length < 2) return values[values.length - 1] || '';
    const last = values[values.length - 1];

    // Helper: check all consecutive differences in an array of numbers are equal
    function _allDiffsEqual(nums) {
      if (nums.length < 2) return false;
      const d = nums[1] - nums[0];
      for (let i = 2; i < nums.length; i++) if (nums[i] - nums[i-1] !== d) return false;
      return d !== 0;
    }

    // 1. ISO date YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(last)) {
      const dates = values.map(v => new Date(v).getTime());
      if (dates.every(d => !isNaN(d)) && _allDiffsEqual(dates)) {
        const next = new Date(dates[dates.length - 1] + (dates[1] - dates[0]));
        return next.toISOString().slice(0, 10);
      }
    }

    // 2. Compact date YYMMDD (6 digits) or YYYYMMDD (8 digits)
    const compactRe = /^(\d{2}|\d{4})(\d{2})(\d{2})$/;
    if (compactRe.test(last) && values.every(v => compactRe.test(v))) {
      const toMs = v => {
        const [, yr, mo, dy] = v.match(compactRe);
        const moNum = parseInt(mo, 10);
        const dyNum = parseInt(dy, 10);
        // Reject values that aren't valid calendar month/day to avoid
        // false-positives on plain 6-digit integers.
        if (moNum < 1 || moNum > 12 || dyNum < 1 || dyNum > 31) return NaN;
        const fullYear = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
        return new Date(fullYear, moNum - 1, dyNum).getTime();
      };
      const mss = values.map(toMs);
      if (mss.every(ms => !isNaN(ms)) && _allDiffsEqual(mss)) {
        const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
        const yLen = last.length === 6 ? 2 : 4;
        const yr   = yLen === 2
          ? String(next.getFullYear()).slice(-2)
          : String(next.getFullYear());
        const mo   = String(next.getMonth() + 1).padStart(2, '0');
        const dy   = String(next.getDate()).padStart(2, '0');
        return yr + mo + dy;
      }
    }

    // 3. Ordinal day-month: "Mon 1st April", "1st Apr", "2nd January 2024" etc.
    const ordParsed = values.map(_parseOrdinalDate);
    if (ordParsed.every(p => p !== null)) {
      const mss = ordParsed.map(p => p.date.getTime());
      if (_allDiffsEqual(mss)) {
        const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
        return _formatOrdinalDate(next, ordParsed[ordParsed.length - 1]);
      }
    }

    // 4. Slash date DD/MM/YYYY or MM/DD/YYYY
    const slashRe = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    if (slashRe.test(last) && values.every(v => slashRe.test(v))) {
      const [, a0, b0] = values[0].match(slashRe);
      const isDMY = parseInt(a0, 10) > 12;
      const toMs = v => {
        const [, a, b, y] = v.match(slashRe);
        return isDMY
          ? new Date(`${y}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`).getTime()
          : new Date(`${y}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`).getTime();
      };
      const mss = values.map(toMs);
      if (mss.every(ms => !isNaN(ms)) && _allDiffsEqual(mss)) {
        const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
        const dd = String(next.getDate()).padStart(2,'0');
        const mm = String(next.getMonth()+1).padStart(2,'0');
        const yy = next.getFullYear();
        return isDMY ? `${dd}/${mm}/${yy}` : `${mm}/${dd}/${yy}`;
      }
    }

    // 5. Pure integer (no leading zeros, no extra characters)
    if (/^-?\d+$/.test(last) && values.every(v => /^-?\d+$/.test(v))) {
      const nums = values.map(Number);
      if (_allDiffsEqual(nums)) return String(nums[nums.length - 1] + (nums[1] - nums[0]));
    }

    // 6. Float with consistent decimal places
    const floatRe = /^-?\d+\.\d+$/;
    if (floatRe.test(last) && values.every(v => floatRe.test(v))) {
      const nums = values.map(Number);
      if (_allDiffsEqual(nums)) {
        const decimals = last.split('.')[1].length;
        return (nums[nums.length - 1] + (nums[1] - nums[0])).toFixed(decimals);
      }
    }

    // 7. Unicode subscript digits suffix: "x₁", "α₃", "f₁₂"
    const subRe = /^(.*?)([\u2080-\u2089]+)$/;
    if (subRe.test(last)) {
      const lastM = last.match(subRe);
      const prefix = lastM[1];
      const allMatch = values.every(v => {
        const m = v.match(subRe);
        return m && m[1] === prefix;
      });
      if (allMatch) {
        const nums = values.map(v => _subToNum(v.match(subRe)[2]));
        if (!nums.some(isNaN) && _allDiffsEqual(nums)) {
          return prefix + _numToSub(nums[nums.length - 1] + (nums[1] - nums[0]));
        }
      }
    }

    // 8. Markdown/LaTeX subscript: "x_1", "x_{12}", "\alpha_{3}", "$f_{240101}$"
    //    Suffix capture handles closing delimiters like trailing "$".
    const latexSubRe = /^(.*?)_(\{?)(\d+)\}?(.*)$/;
    if (latexSubRe.test(last)) {
      const lastM = last.match(latexSubRe);
      const prefix   = lastM[1];
      const hasBrace = lastM[2] === '{';
      const suffix   = lastM[4];
      const allMatch = values.every(v => {
        const m = v.match(latexSubRe);
        return m && m[1] === prefix && m[4] === suffix;
      });
      if (allMatch) {
        const subVals = values.map(v => v.match(latexSubRe)[3]);
        // Check if subscript values are compact dates (YYMMDD / YYYYMMDD)
        const compactSubRe = /^(\d{2}|\d{4})(\d{2})(\d{2})$/;
        if (subVals.every(s => compactSubRe.test(s))) {
          const toMs = s => {
            const [, yr, mo, dy] = s.match(compactSubRe);
            const moNum = parseInt(mo, 10);
            const dyNum = parseInt(dy, 10);
            if (moNum < 1 || moNum > 12 || dyNum < 1 || dyNum > 31) return NaN;
            const fullYear = yr.length === 2 ? 2000 + parseInt(yr, 10) : parseInt(yr, 10);
            return new Date(fullYear, moNum - 1, dyNum).getTime();
          };
          const mss = subVals.map(toMs);
          if (mss.every(ms => !isNaN(ms)) && _allDiffsEqual(mss)) {
            const next = new Date(mss[mss.length - 1] + (mss[1] - mss[0]));
            const yLen = subVals[0].length === 6 ? 2 : 4;
            const yr   = yLen === 2 ? String(next.getFullYear()).slice(-2) : String(next.getFullYear());
            const mo   = String(next.getMonth() + 1).padStart(2, '0');
            const dy   = String(next.getDate()).padStart(2, '0');
            const nextSub = yr + mo + dy;
            return hasBrace ? `${prefix}_{${nextSub}}${suffix}` : `${prefix}_${nextSub}${suffix}`;
          }
        }
        const nums = subVals.map(s => parseInt(s, 10));
        if (!nums.some(isNaN) && _allDiffsEqual(nums)) {
          const next = nums[nums.length - 1] + (nums[1] - nums[0]);
          return hasBrace ? `${prefix}_{${next}}${suffix}` : `${prefix}_${next}${suffix}`;
        }
      }
    }

    // 9. Text + number suffix ("Item 1", "Row 3") with consistent prefix
    const tnRe = /^(.*?)(\d+)$/;
    if (tnRe.test(last)) {
      const lastM = last.match(tnRe);
      const prefix = lastM[1];
      const allMatch = values.every(v => {
        const m = v.match(tnRe);
        return m && m[1] === prefix;
      });
      if (allMatch) {
        const nums = values.map(v => parseInt(v.match(tnRe)[2], 10));
        if (!nums.some(isNaN) && _allDiffsEqual(nums)) {
          return prefix + (nums[nums.length - 1] + (nums[1] - nums[0]));
        }
      }
    }

    // 10. Fallback: repeat last value
    return last;
  }

  // ── Table structure helpers ──────────────────────────────────────────────

  function _parseCells(line) {
    const raw = line.trim();
    return raw.slice(1, raw.lastIndexOf('|')).split('|').map(c => c.trim());
  }

  // Returns the body rows of the table immediately preceding lineIndex, or null.
  // Requires ≥ 2 body rows for pattern detection.
  function _getTableBodyRowsAbove(lines, lineIndex) {
    const rows = [];
    let i = lineIndex - 1;
    while (i >= 0 && /^\s*\|/.test(lines[i])) {
      rows.unshift(lines[i]);
      i--;
    }
    if (rows.length < 2) return null;
    // Find the separator line (cells = :?-+:? only)
    const sepIdx = rows.findIndex(row => {
      const cells = _parseCells(row);
      return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
    });
    if (sepIdx < 0) return null; // no separator → not a real table
    const bodyRows = rows.slice(sepIdx + 1);
    return bodyRows.length >= 2 ? bodyRows : null;
  }

  function _buildSuggestion(bodyRows) {
    const parsed  = bodyRows.map(_parseCells);
    const numCols = parsed[0].length;
    if (!numCols) return null;
    const cells = [];
    for (let c = 0; c < numCols; c++) {
      cells.push(_predictCell(parsed.map(r => r[c] !== undefined ? r[c] : '')));
    }
    return '| ' + cells.join(' | ') + ' |';
  }

  // ── Event listeners ──────────────────────────────────────────────────────

  textarea.addEventListener('input', () => {
    // Don't compete with wiki-link autocomplete
    const wikidrop = document.getElementById('wikilink-dropdown');
    if (wikidrop && wikidrop.style.display !== 'none') { _trHide(); return; }

    const pos      = textarea.selectionStart;
    const text     = textarea.value;
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const currentLine = text.slice(lineStart, pos);

    // Only trigger when the current line is exactly '|'
    if (currentLine !== '|') { _trHide(); return; }

    const linesAbove = text.slice(0, lineStart).split('\n');
    // text.slice(0, lineStart) always ends with \n so split always has a trailing
    // empty string — pass length-1 so _getTableBodyRowsAbove starts at the actual
    // last table row, not the empty sentinel.
    const bodyRows   = _getTableBodyRowsAbove(linesAbove, linesAbove.length - 1);
    if (!bodyRows) { _trHide(); return; }

    const suggestion = _buildSuggestion(bodyRows);
    if (!suggestion) { _trHide(); return; }

    _trSuggestion = suggestion;
    // Ghost shows everything after the '|' the user already typed
    _trDiv.textContent = suggestion.slice(1);
    // Defer display by one animation frame so the 10ms syntax-highlight debounce
    // has fired and the <pre> reflects the current text.  The Range API then gives
    // pixel-perfect viewport coordinates without needing a mirror div.
    requestAnimationFrame(() => {
      if (_trSuggestion === null) return; // dismissed during the rAF delay
      if (!_trPositionFromPre(pos)) _trPosition(pos);
      _trDiv.style.display = 'block';
    });
  });

  textarea.addEventListener('keydown', e => {
    if (_trSuggestion === null) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const pos       = textarea.selectionStart;
      const text      = textarea.value;
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      const before    = text.slice(0, lineStart);
      const after     = text.slice(pos);
      // Replace the lone '|' with the full suggestion then add a newline
      textarea.value  = before + _trSuggestion + '\n' + after;
      const newPos    = before.length + _trSuggestion.length + 1;
      textarea.selectionStart = textarea.selectionEnd = newPos;
      _trHide();
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      _trHide();
    }
  }, true); // capture phase — same priority as wiki dropdown

  textarea.addEventListener('blur',   () => setTimeout(_trHide, 150));
  textarea.addEventListener('scroll', () => {
    if (_trSuggestion !== null) {
      const pos = textarea.selectionStart;
      if (!_trPositionFromPre(pos)) _trPosition(pos);
    }
  });
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
      scheduleNeedsScrollToNow = true;
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

  // ── Encryption guard: if this device needs a key but doesn't have one,
  // detect newly-arrived encrypted content and warn the user.
  // Do NOT process content changes — we risk corrupting data by saving
  // decrypted-as-ciphertext or overwriting remote encrypted notes.
  if (window._encryption.needsKey && !window._encryption.active) {
    // Refresh cache to pick up latest note names
    if (typeof NoteStorage.refreshCache === 'function') {
      await NoteStorage.refreshCache();
    }
    // Check if encrypted content has arrived
    try {
      const names = await NoteStorage.getAllNoteNames();
      for (const name of names.slice(0, 5)) { // sample a few
        const raw = await (window.NoteStorage._unwrapped || window.NoteStorage).getNote(name);
        if (raw && typeof raw === 'string' && raw.startsWith('enc:v1:')) {
          updateStatus('Encrypted notes detected. Open Settings to pair this device.', false);
          // Mark textarea as read-only to prevent edits being saved as plaintext
          if (textarea && !textarea.readOnly) {
            textarea.readOnly = true;
            window._encryption._madeReadOnly = true;
          }
          await updateFileList();
          return; // Do not process content changes
        }
      }
    } catch { /* continue normally if check fails */ }
  }

  // Capture the current loadNote generation so we can detect if the user
  // navigates to a different note while this handler is running.  If they
  // do, we bail out early to avoid overwriting the newly-loaded note.
  const gen = _loadNoteGeneration;

  let structuralChanged = false;
  let contentChanged = false;

  // Refresh the in-memory cache first so that applySyncedPreferences()
  // reads the latest .app_preferences written by the remote device rather
  // than stale cached data.
  if (typeof NoteStorage.refreshCache === 'function') {
    await NoteStorage.refreshCache();
  }

  if (gen !== _loadNoteGeneration) return;

  // Re-apply synced preferences now that the cache is fresh.
  if (typeof applySyncedPreferences === 'function') {
    await applySyncedPreferences();
  }

  // Abort if the user navigated away during the async preference apply.
  if (gen !== _loadNoteGeneration) return;

  // Update colour picker circles and emoji buttons in the Settings note
  // preview so they reflect the newly-synced values.
  if (typeof window._refreshSettingsPickerUI === 'function') {
    window._refreshSettingsPickerUI();
  }

  if (currentFileName) {
    const hasUnsavedEdits = _lastSavedContent !== null && textarea.value !== _lastSavedContent;
    const content = await NoteStorage.getNote(currentFileName);

    // Abort if navigated away while we were fetching the note content.
    if (gen !== _loadNoteGeneration) return;

    if (content === null) {
      // Only restore the note if the user has actually made local edits that
      // haven't been saved yet. Checking textarea.value.trim() was wrong: it
      // caused any open note (even one just being read) to be resurrected
      // whenever it was deleted on another device, because the textarea still
      // held the note's content.
      if (hasUnsavedEdits) {
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
    } else if (content !== textarea.value && content !== _lastSavedContent) {
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

  if (gen !== _loadNoteGeneration) return;

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
        // to avoid heavy work during initial load).
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
// Both Electron and Capacitor (iOS/Android) now use the same PowerSync flow.
if (window.PowerSyncNoteStorage) {
  _setupPowerSyncHandlers();
} else if (window.electronAPI || window.Capacitor?.isNativePlatform()) {
  window.addEventListener('powersync:ready', _setupPowerSyncHandlers, { once: true });
}

// iOS/Android (Capacitor): add a tap-to-sync button on the status bar.
// With the PowerSync Capacitor SDK using native SQLite, sync is automatic,
// but tap-to-sync forces an immediate reconnect for responsiveness.
if (window.Capacitor?.isNativePlatform()) {
  const _setupCapacitorTapToSync = () => {
    const bottomArea = document.getElementById('bottom-status-area');
    if (!bottomArea) return;
    bottomArea.style.cursor = 'pointer';
    bottomArea.title = 'Tap to sync';
    updateBackupStatus();
    bottomArea.addEventListener('click', async () => {
      if (autoSaveTimer !== null) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        await autoSaveNote();
      }
      updateStatus('Syncing\u2026', true, true);
      try {
        if (typeof NoteStorage.triggerSync === 'function') {
          await NoteStorage.triggerSync();
        }
        // Refresh in-memory cache after sync so all getNote() calls are instant
        if (typeof NoteStorage.refreshCache === 'function') {
          await NoteStorage.refreshCache();
        }
        // Refresh UI with any newly-pulled notes
        await updateFileList();
        // Reload the current note if it was updated
        if (currentFileName) {
          const fresh = await NoteStorage.getNote(currentFileName);
          if (fresh !== null && fresh !== textarea.value) {
            textarea.value = fresh;
            _lastSavedContent = fresh;
            _lastRemoteContent = fresh;
            if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
          }
        }
        invalidateScheduleCache();
        // Start calendar sync for the first time if not yet running, then
        // always trigger an immediate sync pass so manual presses re-sync.
        if (typeof window._startCalendarSyncIfNeeded === 'function') {
          window._startCalendarSyncIfNeeded();
        }
        if (typeof window._runCalendarSync === 'function') {
          window._runCalendarSync();
        }
        updateStatus('Sync Complete.', true);
      } catch (e) {
        console.error('[sync] Sync failed:', e);
        updateStatus('Sync failed.', false);
      }
    });
  };
  // Set up after PowerSync is ready, or immediately if sync is disabled
  window.addEventListener('powersync:ready', _setupCapacitorTapToSync, { once: true });
  window.addEventListener('powersync:disabled', _setupCapacitorTapToSync, { once: true });
  window.addEventListener('powersync:auth-required', _setupCapacitorTapToSync, { once: true });
}

// ── Async initialization ──────────────────────────────────────────────────

const savedChain = localStorage.getItem('linked_chain');
if (savedChain) {
  try { linkedNoteChain = JSON.parse(savedChain); } catch(e) { linkedNoteChain = []; localStorage.removeItem('linked_chain'); }
}

// Secondary windows mirror the primary window's trail via storage events
// until the secondary severs sync by clearing its own trail.
if (_isSecondary) {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'linked_chain' || _chainSevered) return;
    try {
      linkedNoteChain = e.newValue ? JSON.parse(e.newValue) : [];
    } catch (_) {
      linkedNoteChain = [];
    }
    updateFileList();
  });
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
    // Only insert notes that have never been synced (no row at all, active or
    // deleted). Using getNote() alone is insufficient because it filters out
    // soft-deleted rows (deleted = 1), which would cause previously-deleted
    // notes to be re-created on every launch.
    const alreadySynced = typeof NoteStorage.noteExistsInSync === 'function'
      ? await NoteStorage.noteExistsInSync(noteName)
      : await NoteStorage.getNote(noteName) !== null;
    if (!alreadySynced) {
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
    // powersync-storage.js is an async module that may dispatch powersync:ready
    // before this listener is set up (race condition on iOS where native bridge
    // calls resolve quickly). Guard against this by also polling for the global.
    if ((window.electronAPI || window.Capacitor?.isNativePlatform()) && !window.PowerSyncNoteStorage) {
      setLoadingProgress(10, 'Connecting\u2026');
      await new Promise(resolve => {
        // Resolve on any of the three PowerSync lifecycle events
        const done = () => {
          clearInterval(poll);
          resolve();
        };
        window.addEventListener('powersync:ready', done, { once: true });
        window.addEventListener('powersync:disabled', done, { once: true });
        window.addEventListener('powersync:auth-required', done, { once: true });
        // Poll for the global in case the event fired before we registered
        const poll = setInterval(() => {
          if (window.PowerSyncNoteStorage) done();
        }, 50);
        setTimeout(done, 5000);
      });
      if (window.PowerSyncNoteStorage) {
        window.NoteStorage = window.PowerSyncNoteStorage;
        await migrateLocalNotesToSync();
      }
    }

    // ── E2E Encryption: load master key and wrap NoteStorage ──────────────
    // Must happen AFTER NoteStorage is assigned (IndexedDB or PowerSync) and
    // BEFORE any note content is read. The wrapper transparently encrypts on
    // write and decrypts on read so all downstream code works with plaintext.
    if (window._syncHelpers?.authenticated && window._supabaseClient) {
      try {
        const session = await window._supabaseClient.auth.getSession();
        const userId = session?.data?.session?.user?.id;
        if (userId) {
          window._encryption.userId = userId;

          // Check if this user has encryption enabled (server record)
          const encEnabled = await DevicePairing.isEncryptionEnabled(userId);
          window._encryption.enabled = encEnabled;

          if (encEnabled) {
            // Try to load the master key from local secure storage
            const rawKey = await KeyStorage.loadMasterKey(userId);
            if (rawKey) {
              const masterKey = await CryptoEngine.importKey(rawKey);
              window._encryption.key = masterKey;
              window._encryption.active = true;

              // Wrap NoteStorage with encryption
              window.NoteStorage = CryptoStorage.wrap(window.NoteStorage, masterKey);
              console.log('[encryption] E2E encryption active.');

              // Signal that encryption is ready so calendar sync and other
              // modules that read note content can start safely.
              window.dispatchEvent(new CustomEvent('encryption:ready'));
            } else {
              // Encryption is enabled on the account but this device has no key.
              // Flag this so the UI can show pairing prompts and the sync handler
              // can avoid writing encrypted content back as plaintext.
              window._encryption.needsKey = true;
              console.log('[encryption] Encryption enabled but no local key. Device pairing required.');
            }
          } else {
            // Encryption not enabled on server — but check if synced notes
            // contain encrypted content (other device enabled it but the
            // user_encryption table hasn't synced yet or was just created).
            // We'll do a quick sample check after notes are loaded.
            window._encryption._checkForEncryptedContent = true;
          }
        }
      } catch (e) {
        console.error('[encryption] Key loading failed:', e);
      }
    }

    // Fire encryption:ready even when encryption is not in use, so modules
    // waiting for this event (e.g. calendar sync) don't stall on the timeout.
    if (!window._encryption.active && !window._encryption.needsKey) {
      console.log('[encryption] encryption:ready dispatched (encryption not active)');
      window.dispatchEvent(new CustomEvent('encryption:ready'));
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
        // Wait for sync changes to arrive. Keep waiting (up to 12s) as long
        // as new batches keep arriving — this handles large vaults where
        // multiple sync pages stream in over several seconds.
        await new Promise(resolve => {
          let timer = setTimeout(resolve, 12000);
          let settleTimer = null;
          const handler = () => {
            // A batch arrived — reset the settle timer so we keep waiting
            // if more batches are expected (300ms settle window).
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
              window.removeEventListener('powersync:change', handler);
              clearTimeout(timer);
              resolve();
            }, 300);
          };
          window.addEventListener('powersync:change', handler);
        });
      }
    }

    // ── Pre-warm in-memory cache ──────────────────────────────────────────
    // Load ALL note contents into memory before dismissing the loading screen.
    // This eliminates SQLite round-trips when the user clicks between notes.
    setLoadingProgress(45, 'Caching notes\u2026');
    const allNotesCached = await NoteStorage.getAllNotes();

    // ── E2E Encryption: detect encrypted content on an unpaired device ────
    // If this device has no key but synced notes contain encrypted content,
    // flag it so the UI warns the user and the sync handler doesn't corrupt data.
    if (window._encryption._checkForEncryptedContent || window._encryption.needsKey) {
      const hasEncContent = allNotesCached.some(n =>
        n.content && typeof n.content === 'string' && n.content.startsWith('enc:v1:')
      );
      if (hasEncContent && !window._encryption.active) {
        window._encryption.needsKey = true;
        window._encryption.enabled = true;
        console.warn('[encryption] Encrypted notes detected but no key available. Pairing required.');
      }
      delete window._encryption._checkForEncryptedContent;
    }

    // If this device needs an encryption key, show a persistent warning and
    // make notes read-only to prevent saving ciphertext as plaintext.
    if (window._encryption.needsKey && !window._encryption.active) {
      updateStatus('Your notes are encrypted. Open Settings \u2192 Encryption to pair this device.', false);
      textarea.readOnly = true;
      window._encryption._madeReadOnly = true;
    }

    setLoadingProgress(55, 'Loading note\u2026');

    // ── First-launch welcome note ──────────────────────────────────────────
    // On first launch, create the "The Thread" welcome note and open it in
    // preview mode so new users see rendered links, tasks, and schedule items.
    const isFirstLaunch = !localStorage.getItem('has_launched');
    if (isFirstLaunch) {
      setLoadingProgress(60, 'Preparing your thread\u2026');
      await createWelcomeNote();
      localStorage.setItem('has_launched', '1');
      setLoadingProgress(65, 'Opening note\u2026');
      await loadNote('The Thread');
    } else {
      const initialContent = lastFile
        ? (allNotesCached.find(n => n.name === lastFile)?.content ?? null)
        : null;
      if (initialContent !== null) {
        setLoadingProgress(65, 'Opening note\u2026');
        await loadNote(lastFile, true, initialContent);
      } else {
        setLoadingProgress(65, 'Creating note\u2026');
        await newNote();
      }
    }

    // Build the file list and sidebar while still on the loading screen so
    // the UI is fully populated before the user can interact.
    setLoadingProgress(80, 'Building file list\u2026');
    await updateFileList();

    setLoadingProgress(90, 'Almost ready\u2026');
    if (isFirstLaunch) {
      // Force preview mode for the welcome note so users see rendered content
      if (!isPreview) await toggleView();
    } else if (savedPreview && !isPreview) {
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
