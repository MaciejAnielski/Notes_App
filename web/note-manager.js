// note-manager.js — Note CRUD operations, auto-save, and projects note.
//
// Handles creating, loading, saving, deleting, and renaming notes,
// the Projects virtual note, and attachment rename tracking.

const SYNTAX_REFERENCE_TABLE = `| Feature | Syntax |
|---|---|
| **Name a note** | \`# Title\` (first line) |
| **Bold** / *Italic* | \`**text**\` / \`*text*\` |
| ==Highlight== | \`==text==\` |
| Link notes | \`[[Note Name]]\` |
| Task | \`- [ ] text\` |
| Complete task | \`- [x] text\` |
| Schedule (all day) | \`> YYMMDD\` |
| Schedule (timed) | \`> YYMMDD HHMM HHMM\` |
| Schedule (multi-day) | \`> YYMMDD YYMMDD\` |
| Calendar tag | \`> YYMMDD @CalName\` |
| Collapse heading | \`## Title >\` |
| Math (inline) | \`$E = mc^2$\` |
| Footnote | \`text[^1]\` / \`[^1]: note\` |
| New note | Ctrl+N |
| Preview | Ctrl+P |
| Search & Replace | Ctrl+F |`;

function _titleFromLine(line) {
  return line.replace(/^#+\s*/, '').replace(/\s*>\s*$/, '').trim();
}

function _cacheNoteContent(name, content) {
  _perNoteSavedContent.set(name, content);
  _perNoteRemoteContent.set(name, content);
}

function _forgetNote(name) {
  _perNoteSavedContent.delete(name);
  _perNoteRemoteContent.delete(name);
}

function getNoteTitle() {
  const firstLine = textarea.value.split(/\n/)[0].trim();
  if (firstLine.startsWith('#')) {
    return _titleFromLine(firstLine);
  }
  return null;
}

function isNoteBodyEmpty() {
  const lines = textarea.value.split(/\n/);
  return lines.slice(1).join('\n').trim() === '';
}

async function handleRenameAfterReplace(noteName, newContent) {
  const firstLine = newContent.split(/\n/)[0].trim();
  if (!firstLine.startsWith('#')) return;
  const newTitle = _titleFromLine(firstLine);
  if (!newTitle || newTitle === noteName) return;
  if (await NoteStorage.getNote(newTitle) !== null) return;
  // Use renameNote (in-place UPDATE) so the name change reaches Supabase as a
  // single PATCH op, avoiding the sync-stream race of the delete-then-insert pattern.
  if (typeof NoteStorage.renameNote === 'function') {
    await NoteStorage.renameNote(noteName, newTitle, newContent);
  } else {
    await NoteStorage.setNote(newTitle, newContent);
    await NoteStorage.removeNote(noteName);
  }
  _cacheNoteContent(newTitle, newContent);
  _forgetNote(noteName);
  await NoteStorage.renameAttachmentDir(noteName, newTitle);
  if (currentFileName === noteName) {
    currentFileName = newTitle;
    localStorage.setItem('current_file', newTitle);
  }
  const chainIdx = linkedNoteChain.indexOf(noteName);
  if (chainIdx !== -1) {
    linkedNoteChain[chainIdx] = newTitle;
    saveChain();
  }
}

// ── Welcome note ("The Thread") ───────────────────────────────────────────

async function createWelcomeNote() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const today = yy + mm + dd;

  const content = `# The Thread

In the myth, Ariadne gave Theseus a ball of thread before he entered the labyrinth — not a map, not instructions, just a way to find his way back.

This is your thread. As you write, link, and explore, you'll leave a trail through your own labyrinth of ideas. There's no wrong way to wander.


## Pick up the thread

A few things to try. You'll notice these appear in the ==Tasks== panel →

- [ ] Tap **New** to create your first note
- [ ] Open [[Settings]] to make this place yours
- [ ] Explore the **Note Graph** to see your labyrinth take shape

*Tip — type \`[[\` in any note to link to another. These links are your thread.*


## Mark your path

Any line can be placed on the calendar. This one is already there →

- [ ] Find your way > ${today}

*(Look at the ==Schedule== panel to see it.)*

The format is \`> YYMMDD\` for an all-day event, or \`> YYMMDD HHMM HHMM\` for a timed one.


## Hidden passages >

You opened this. Some paths are tucked away.

Add \`>\` after any heading to make it start folded — a passage waiting to be discovered.


## Deeper into the labyrinth >

There's more to find as you explore:

| What | How |
|---|---|
| **Bold** / *Italic* | \`**text**\` / \`*text*\` |
| ==Highlight== | \`==text==\` |
| Link notes | \`[[Note Name]]\` |
| Task | \`- [ ] thing to face\` |
| Schedule | \`> YYMMDD\` after any line |
| Fold a heading | \`## Title >\` |
| Math | \`$E = mc^2$\` |
| New note | Ctrl+N |
| Preview / Edit | Ctrl+P |
| Search | Ctrl+F |

*You can always find this reference in [[Settings]].*


## Go

Every labyrinth is different. Yours starts here.

Delete this note whenever you're ready — you won't need it. The thread is already in your hands.
`;

  await NoteStorage.setNote('The Thread', content);
  return content;
}

// ── Projects note ─────────────────────────────────────────────────────────

async function generateProjectsNoteContent(cachedNotes) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentFullYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  // Projects are sorted chronologically within each year. December ("WinterLate")
  // comes after Autumn rather than being grouped with January–February ("WinterEarly"),
  // so a single calendar year can have two Winter subheadings.
  const CHRONO_SEASON_ORDER = ['WinterEarly', 'Spring', 'Summer', 'Autumn', 'WinterLate'];
  const SEASON_DISPLAY = {
    WinterEarly: 'Winter', Spring: 'Spring', Summer: 'Summer', Autumn: 'Autumn', WinterLate: 'Winter',
  };
  // Last month of each season key — used to determine whether a season is past.
  const SEASON_END_MONTH = { WinterEarly: 2, Spring: 5, Summer: 8, Autumn: 11, WinterLate: 12 };

  const emojis = getProjectEmojis();

  function getSeasonKey(mm) {
    const m = parseInt(mm, 10);
    if (m >= 3 && m <= 5)  return 'Spring';
    if (m >= 6 && m <= 8)  return 'Summer';
    if (m >= 9 && m <= 11) return 'Autumn';
    if (m === 12)          return 'WinterLate';
    return 'WinterEarly'; // months 1–2
  }

  function isYearPast(yy) {
    return (2000 + parseInt(yy, 10)) < currentFullYear;
  }

  function isSeasonPast(yy, seasonKey) {
    const fullYear = 2000 + parseInt(yy, 10);
    if (fullYear < currentFullYear) return true;
    if (fullYear > currentFullYear) return false;
    // December (WinterLate) of the current year cannot be past until the year ends.
    if (seasonKey === 'WinterLate') return false;
    return SEASON_END_MONTH[seasonKey] < currentMonth;
  }

  function isValidYYMMDD(yy, mm, dd) {
    const monthNum = parseInt(mm, 10);
    const dayNum = parseInt(dd, 10);
    if (monthNum < 1 || monthNum > 12) return false;
    if (dayNum < 1 || dayNum > 31) return false;
    return true;
  }

  const active = {}, completed = {};
  const allNames = cachedNotes
    ? cachedNotes.map(n => n.name)
    : await NoteStorage.getAllNoteNames();
  for (const name of allNames) {
    if (name === PROJECTS_NOTE) continue;
    const match = name.match(/^(\d{2})(\d{2})(\d{2}) Project .+$/);
    if (!match) continue;
    const yy = match[1], mm = match[2], dd = match[3];
    if (!isValidYYMMDD(yy, mm, dd)) continue;
    const seasonKey = getSeasonKey(mm);
    const projectDate = new Date(2000 + parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
    const isCompleted = projectDate < today;
    const target = isCompleted ? completed : active;
    if (!target[yy]) target[yy] = {};
    if (!target[yy][seasonKey]) target[yy][seasonKey] = [];
    target[yy][seasonKey].push(name);
  }

  for (const grp of [active, completed])
    for (const yy of Object.keys(grp))
      for (const s of Object.keys(grp[yy]))
        grp[yy][s].sort();

  const hasActive = Object.keys(active).length > 0;
  const hasCompleted = Object.keys(completed).length > 0;

  const lines = ['# Projects', ''];
  if (!hasActive && !hasCompleted) {
    lines.push('*No project notes found. Create a note titled `YYMMDD Project Name`.*', '');
  } else {
    if (hasActive) {
      lines.push(`## ${emojis.active} Ongoing`, '');
      const activeYears = Object.keys(active).sort((a, b) => a.localeCompare(b));
      for (const yy of activeYears) {
        const yCollapse = isYearPast(yy) ? ' >' : '';
        lines.push(`### 20${yy}${yCollapse}`, '');
        for (const seasonKey of CHRONO_SEASON_ORDER) {
          const notes = active[yy][seasonKey];
          if (!notes || !notes.length) continue;
          const sCollapse = isSeasonPast(yy, seasonKey) ? ' >' : '';
          const displayName = SEASON_DISPLAY[seasonKey];
          const seasonEmoji = emojis[displayName];
          lines.push(`#### ${seasonEmoji} ${displayName}${sCollapse}`, '');
          for (const name of notes) lines.push(`- [[${name}]]`);
          lines.push('');
        }
      }
    }
    if (hasCompleted) {
      lines.push(`## ${emojis.completed} Completed >`, '');
      const completedYears = Object.keys(completed).sort((a, b) => a.localeCompare(b));
      for (const yy of completedYears) {
        const yCollapse = isYearPast(yy) ? ' >' : '';
        lines.push(`### 20${yy}${yCollapse}`, '');
        for (const seasonKey of CHRONO_SEASON_ORDER) {
          const notes = completed[yy][seasonKey];
          if (!notes || !notes.length) continue;
          const sCollapse = isSeasonPast(yy, seasonKey) ? ' >' : '';
          const displayName = SEASON_DISPLAY[seasonKey];
          const seasonEmoji = emojis[displayName];
          lines.push(`#### ${seasonEmoji} ${displayName}${sCollapse}`, '');
          for (const name of notes) lines.push(`- [[${name}]]`);
          lines.push('');
        }
      }
    }
  }
  return lines.join('\n');
}

async function refreshGraphNote() {
  const existing = await NoteStorage.getNote(GRAPH_NOTE);
  if (existing !== null) return;
  await NoteStorage.setNote(GRAPH_NOTE, '# Note Graph\n');
}

async function refreshProjectsNote(cachedNotes) {
  const newContent = await generateProjectsNoteContent(cachedNotes);
  // Store locally only — the Projects note is generated from local note names and
  // preferences, so syncing its full rendered content wastes bandwidth and can
  // cause conflicts. On Desktop/iOS, localStorage bypasses PowerSync directly.
  // On web, NoteStorage (IndexedDB) is used since there is no sync to bypass.
  if (window.PowerSyncNoteStorage) {
    const localKey = 'md_' + PROJECTS_NOTE;
    const existing = localStorage.getItem(localKey);
    if (existing === newContent) return;
    localStorage.setItem(localKey, newContent);
  } else {
    const existing = await NoteStorage.getNote(PROJECTS_NOTE);
    if (existing === newContent) return;
    await NoteStorage.setNote(PROJECTS_NOTE, newContent);
  }
  if (currentFileName === PROJECTS_NOTE) {
    textarea.value = newContent;
    await renderPreview();
  }
}

// ── Attachment rename tracking ────────────────────────────────────────────

const _pendingAttachmentDeletions = new Map(); // key: "noteName:filename"

async function checkAttachmentRenames(prevContent, newContent, noteName) {
  if (!noteName || !prevContent || !newContent) return;
  if (!NoteStorage.renameAttachment) return;

  const oldRefs = parseAttachmentRefs(prevContent);
  const newRefs = parseAttachmentRefs(newContent);

  let updatedContent = newContent;
  let changed = false;

  for (const [filename, newAlt] of newRefs) {
    const oldAlt = oldRefs.get(filename);
    if (oldAlt === undefined || oldAlt === newAlt) continue;

    const dotIdx  = filename.lastIndexOf('.');
    const ext     = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';
    const altBase = newAlt.replace(/\.\w{1,5}$/, '');
    const newFilename = sanitizeAttachmentName(altBase) + (ext ? '.' + ext : '');
    if (!newFilename || newFilename === filename) continue;

    const ok = await NoteStorage.renameAttachment(noteName, filename, newFilename);
    if (ok) {
      updatedContent = updatedContent.split(`attachment:${filename}`).join(`attachment:${newFilename}`);
      changed = true;
    }
  }

  // Detect removed attachment refs and schedule delayed deletion (30 s undo window).
  if (NoteStorage.deleteAttachment) {
    for (const [filename] of oldRefs) {
      const key = `${noteName}:${filename}`;
      if (newRefs.has(filename)) {
        // Ref reappeared (e.g. user pressed Ctrl+Z) — cancel pending deletion.
        if (_pendingAttachmentDeletions.has(key)) {
          clearTimeout(_pendingAttachmentDeletions.get(key));
          _pendingAttachmentDeletions.delete(key);
        }
      } else if (!_pendingAttachmentDeletions.has(key)) {
        // Ref was removed — schedule deletion. Only schedule once so the 30 s
        // countdown isn't reset by subsequent saves while the ref is still absent.
        const timer = setTimeout(async () => {
          _pendingAttachmentDeletions.delete(key);
          await NoteStorage.deleteAttachment(noteName, filename);
        }, 30000);
        _pendingAttachmentDeletions.set(key, timer);
      }
    }
  }

  if (changed) {
    textarea.value = updatedContent;
    await NoteStorage.setNote(noteName, updatedContent);
    _lastSavedContent = updatedContent;
    if (isPreview) renderPreview(); else refreshHighlight();
  }
}

// ── Auto-save ─────────────────────────────────────────────────────────────

async function autoSaveNote() {
  if (currentFileName === PROJECTS_NOTE) return;

  // Block saving if this device needs an encryption key — writing plaintext
  // over encrypted notes on the server would cause data loss.
  if (window._encryption?.needsKey && !window._encryption?.active) {
    updateStatus('Cannot save \u2014 encryption key required. Open Settings to pair this device.', false);
    return;
  }

  // Capture mutable globals at the start to avoid race conditions while
  // async operations yield to other event handlers.
  const capturedFileName = currentFileName;
  const capturedContent = textarea.value;
  const prevContent = _lastSavedContent;

  const name = getNoteTitle();
  if (!name) {
    updateStatus('File Not Saved. Please Add A Title Starting With "#".', false);
    return;
  }

  const useSyncStorage = !!window.PowerSyncNoteStorage;

  // ── New note (no current file) ─────────────────────────────────────────
  // Create the note using the title as the filename.
  if (!capturedFileName) {
    if (await NoteStorage.getNote(name) !== null) {
      if (isNoteBodyEmpty()) {
        await loadNote(name);
        updateStatus(`Opened Existing Note "${name}".`, true);
      } else {
        updateStatus(`File Not Saved. A File Named "${name}" Already Exists. Please Rename.`, false);
      }
      return;
    }
    try {
      await NoteStorage.setNote(name, capturedContent);
    } catch (e) {
      updateStatus('Save Failed — Storage Quota Exceeded. Delete Old Notes Or Export A Backup.', false);
      return;
    }
    _lastSavedContent = capturedContent;
    _perNoteSavedContent.set(name, capturedContent);
    currentFileName = name;
    localStorage.setItem('current_file', name);
    invalidateScheduleCache();
    if (scheduleContainer.classList.contains('active')) renderSchedule();
    await updateFileList();
    updateStatus(useSyncStorage ? 'Saved.' : 'File Saved Successfully.', true);
    await checkAttachmentRenames(prevContent, capturedContent, currentFileName);
    return;
  }

  // ── Existing note ──────────────────────────────────────────────────────
  if (name !== capturedFileName) {
    // Title changed — rename immediately so the note list updates right away.
    if (await NoteStorage.getNote(name) !== null) {
      updateStatus(`File Not Saved. A File Named "${name}" Already Exists. Please Rename.`, false);
      return;
    }
    try {
      await NoteStorage.renameNote(capturedFileName, name, capturedContent);
    } catch (e) {
      updateStatus('Save Failed — Storage Quota Exceeded. Delete Old Notes Or Export A Backup.', false);
      return;
    }
    _lastSavedContent = capturedContent;
    _forgetNote(capturedFileName);
    _cacheNoteContent(name, capturedContent);
    _pendingRename = null;
    try {
      await NoteStorage.renameAttachmentDir(capturedFileName, name);
    } catch (e) {
      console.error('Attachment dir rename failed:', e);
    }
    currentFileName = name;
    localStorage.setItem('current_file', name);
    invalidateScheduleCache();
    if (scheduleContainer.classList.contains('active')) renderSchedule();
    await updateTodoList();
    await updateFileList();
    updateStatus(useSyncStorage ? 'Saved.' : 'File Saved Successfully.', true);
    await checkAttachmentRenames(prevContent, capturedContent, currentFileName);
    return;
  }

  _pendingRename = null;
  try {
    await NoteStorage.setNote(capturedFileName, capturedContent);
  } catch (e) {
    updateStatus('Save Failed — Storage Quota Exceeded. Delete Old Notes Or Export A Backup.', false);
    return;
  }
  _lastSavedContent = capturedContent;
  _perNoteSavedContent.set(capturedFileName, capturedContent);
  invalidateScheduleCache();
  if (scheduleContainer.classList.contains('active')) renderSchedule();
  await updateTodoList();
  updateStatus(useSyncStorage ? 'Saved.' : 'File Saved Successfully.', true);
  await checkAttachmentRenames(prevContent, capturedContent, capturedFileName);
}

// ── Apply pending rename ───────────────────────────────────────────────────
// Renames the current note from currentFileName to _pendingRename.
// Called when the user commits a title change: pressing View, switching to
// another note, or creating a new note.
async function applyPendingRename() {
  if (!_pendingRename || !currentFileName || currentFileName === PROJECTS_NOTE) {
    _pendingRename = null;
    return;
  }
  const oldName = currentFileName;
  const newName = _pendingRename;
  _pendingRename = null;

  if (oldName === newName) return;

  // Abort if a note with the target name already exists.
  if (await NoteStorage.getNote(newName) !== null) {
    updateStatus(`A Note Named "${newName}" Already Exists. Please Choose A Different Title.`, false);
    return;
  }

  const content = textarea.value;
  const useSyncStorage = !!window.PowerSyncNoteStorage;
  try {
    // Use renameNote (in-place UPDATE) when available so that the name change
    // reaches Supabase as a single PATCH op rather than a DELETE + INSERT pair.
    // The two-step approach can race against the PowerSync sync stream: the
    // stream may re-deliver the old note before the DELETE is uploaded,
    // silently undoing the rename on the server.
    if (typeof NoteStorage.renameNote === 'function') {
      await NoteStorage.renameNote(oldName, newName, content);
    } else {
      // Fallback (should not be reached — both storage implementations have renameNote).
      await NoteStorage.setNote(newName, content);
      await NoteStorage.removeNote(oldName);
    }
  } catch (e) {
    updateStatus('Save Failed — Storage Quota Exceeded. Delete Old Notes Or Export A Backup.', false);
    return;
  }
  _lastSavedContent = content;
  _forgetNote(oldName);
  _cacheNoteContent(newName, content);
  try {
    await NoteStorage.renameAttachmentDir(oldName, newName);
  } catch (e) {
    console.error('Attachment dir rename failed:', e);
    updateStatus('Note renamed but attachments may need manual recovery.', false);
  }
  currentFileName = newName;
  localStorage.setItem('current_file', newName);
  const chainIdx = linkedNoteChain.indexOf(oldName);
  if (chainIdx !== -1) {
    linkedNoteChain[chainIdx] = newName;
    saveChain();
  }
  await updateFileList();
  updateStatus(useSyncStorage ? 'Saved.' : 'File Saved Successfully.', true);
}

// ── Load / New / Delete ───────────────────────────────────────────────────

async function loadNote(name, fromLink = false, prefetchedContent = null) {
  // Increment generation counter so any in-flight loadNote() can detect it
  // has been superseded and bail out, preventing the "back and forth" flicker.
  const gen = ++_loadNoteGeneration;

  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;

  // Switching to a different note: flush any unsaved edits under the current
  // filename and apply any pending title rename before navigating away.
  if (currentFileName && currentFileName !== name) {
    // If in preview mode, commit any active table sort into textarea.value so
    // the save-on-navigate block below picks it up and writes it to storage.
    if (isPreview) _saveAllTableSorts(previewDiv);
    if (textarea.value !== _lastSavedContent) {
      try {
        await NoteStorage.setNote(currentFileName, textarea.value);
        _lastSavedContent = textarea.value;
        _perNoteSavedContent.set(currentFileName, textarea.value);
      } catch (_) { /* ignore — content is still in textarea */ }
      // The debounce timer may not have fired yet, so _pendingRename may not
      // reflect the latest header. Recompute it now so the rename is not lost.
      if (!_pendingRename) {
        const title = getNoteTitle();
        if (title && title !== currentFileName) _pendingRename = title;
      }
    }
    await applyPendingRename();
  }

  // A newer loadNote() was called while we were flushing — abort this one.
  if (gen !== _loadNoteGeneration) return;

  // If reloading the same note that is already open, flush any pending edits
  // to storage first so that changes (e.g. adding/removing ">" on a heading)
  // are not lost when the content is read back from storage below.
  if (currentFileName === name && textarea.value !== _lastSavedContent) {
    try {
      await NoteStorage.setNote(name, textarea.value);
      _lastSavedContent = textarea.value;
      _perNoteSavedContent.set(name, textarea.value);
    } catch (_) { /* ignore — content is still in textarea */ }
  }

  if (!fromLink) {
    if (name === currentFileName) {
      // Re-opening the current note: don't touch the trail.
    } else if (!linkedNoteChain.includes(name)) {
      // Target is not in the trail and is not the current note: opening it
      // starts a fresh trail.
      linkedNoteChain = [];
      saveChain();
    }
    // else: note is already in the trail — navigate without changing it.
  }
  let content = prefetchedContent !== null ? prefetchedContent : await NoteStorage.getNote(name);

  // Abort if superseded while fetching content.
  if (gen !== _loadNoteGeneration) return;

  // Projects note: always regenerate from the current note list so the view
  // is never stale (e.g. after notes were added/removed since the last visit).
  // It is stored in localStorage only — not in the sync database.
  if (name === PROJECTS_NOTE) {
    content = await generateProjectsNoteContent();
    if (window.PowerSyncNoteStorage) {
      localStorage.setItem('md_' + PROJECTS_NOTE, content);
    } else {
      await NoteStorage.setNote(PROJECTS_NOTE, content);
    }
  }
  // Settings note: create it if it doesn't exist yet (e.g. first run on desktop/web)
  if (content === null && name === CALENDARS_NOTE) {
    content = '# Settings\n\n\n## ☁️ Sync\n\nSync notes across devices using your email address.\n\n\n## 🎨 Theme\n\nCustomise the app\'s background and accent colours.\n\n\n## 🧶 Syntax & Shortcuts >\n\n' + SYNTAX_REFERENCE_TABLE + '\n';
    await NoteStorage.setNote(name, content);
  } else if (content === null) {
    alert('File not found.');
    return;
  }

  // Final staleness check before touching the DOM.
  if (gen !== _loadNoteGeneration) return;

  textarea.value = content;
  _lastSavedContent = content;
  _lastRemoteContent = content;
  _cacheNoteContent(name, content);
  currentFileName = name;
  refreshHighlight();
  localStorage.setItem('current_file', name);

  const isReadOnlyNote = name === PROJECTS_NOTE || name === CALENDARS_NOTE || name === GRAPH_NOTE;

  if (isReadOnlyNote) {
    textarea.readOnly = true;
    toggleViewBtn.disabled = true;
    await renderPreview();
    if (!isPreview) {
      previewDiv.style.display = 'block';
      textarea.style.display = 'none';
      projectsViewActive = true;
    }
  } else {
    if (projectsViewActive) {
      projectsViewActive = false;
      if (!isPreview) {
        previewDiv.style.display = 'none';
        textarea.style.display = 'block';
      }
    }
    textarea.readOnly = false;
    toggleViewBtn.disabled = false;
    if (isPreview) await renderPreview();
  }

  // Skip file list rebuild if another loadNote() has started during rendering.
  if (gen !== _loadNoteGeneration) return;

  // If the stored note's first-line header doesn't match its stored name
  // (e.g. after an import or a sync mismatch), rename it immediately so the
  // note list always shows the correct name right away.
  if (!isReadOnlyNote) {
    const headerTitle = getNoteTitle();
    if (headerTitle && headerTitle !== currentFileName) {
      const targetExists = await NoteStorage.getNote(headerTitle) !== null;
      if (gen !== _loadNoteGeneration) return;
      if (!targetExists) {
        const capturedName = currentFileName;
        await NoteStorage.renameNote(capturedName, headerTitle, content);
        if (gen !== _loadNoteGeneration) return;
        _forgetNote(capturedName);
        _cacheNoteContent(headerTitle, content);
        currentFileName = headerTitle;
        localStorage.setItem('current_file', headerTitle);
        const chainIdx = linkedNoteChain.indexOf(capturedName);
        if (chainIdx !== -1) {
          linkedNoteChain[chainIdx] = headerTitle;
          saveChain();
        }
        await updateFileList();
        return;
      }
    }
  }

  // Instead of a full file-list rebuild (which re-fetches all notes and
  // rebuilds the entire DOM), just update which item is highlighted.
  // A full rebuild only happens on structural changes (add/delete/rename)
  // via sync handlers or explicit calls.
  _refreshFileListActiveState();
}

async function newNote() {
  // Flush unsaved content and apply any pending rename before leaving the
  // current note, so the title change is not silently discarded.
  if (currentFileName) {
    // Commit any active table sort into textarea.value before the save check.
    if (isPreview) _saveAllTableSorts(previewDiv);
    if (textarea.value !== _lastSavedContent) {
      try {
        await NoteStorage.setNote(currentFileName, textarea.value);
        _lastSavedContent = textarea.value;
        _perNoteSavedContent.set(currentFileName, textarea.value);
      } catch (_) { /* ignore */ }
      // The debounce timer may not have fired yet, so _pendingRename may not
      // reflect the latest header. Recompute it now so the rename is not lost.
      if (!_pendingRename) {
        const title = getNoteTitle();
        if (title && title !== currentFileName) _pendingRename = title;
      }
    }
    await applyPendingRename();
  }

  const today = getFormattedDate();
  const defaultTitle = today + ' Daily Note';
  const allNames = await NoteStorage.getAllNoteNames();
  const existsInList = allNames.includes(defaultTitle);
  if (!existsInList) {
    textarea.value = '# ' + defaultTitle + '\n\n';
  } else {
    textarea.value = '# ';
  }
  if (isPreview) {
    toggleView();
  } else if (projectsViewActive) {
    projectsViewActive = false;
    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
  }
  textarea.readOnly = false;
  toggleViewBtn.disabled = false;
  clearTimeout(autoSaveTimer);
  linkedNoteChain = [];
  saveChain();
  currentFileName = null;
  localStorage.removeItem('current_file');
  _lastSavedContent = textarea.value;
  _lastRemoteContent = null;
  refreshHighlight();
  const activeItem = fileList.querySelector('.active-file');
  if (activeItem) activeItem.classList.remove('active-file');
  updateStatus('', true);
  if (!existsInList) {
    const pos = ('# ' + defaultTitle).length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
  } else {
    textarea.focus();
    textarea.setSelectionRange('# '.length, '# '.length);
  }
  updateFileList();
}

async function deleteNote() {
  const name = currentFileName || getNoteTitle();
  if (!name) {
    alert('No note selected.');
    return;
  }
  if (await NoteStorage.getNote(name) === null) {
    alert('File not found.');
    return;
  }
  if (!confirm(`Delete "${name}"?`)) return;

  _pendingRename = null;
  await NoteStorage.trashNote(name);
  _forgetNote(name);
  textarea.value = '';
  refreshHighlight();
  if (isPreview) toggleView();
  else previewDiv.innerHTML = '';
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateStatus(`Deleted "${name}".`, true);
  updateFileList();
}

async function deleteAllNotes() {
  if (!confirm('Delete all notes?')) return;
  _pendingRename = null;
  const names = await NoteStorage.getAllNoteNames();
  await Promise.all(names.map(name => NoteStorage.trashNote(name)));
  _perNoteSavedContent.clear();
  _perNoteRemoteContent.clear();
  textarea.value = '';
  refreshHighlight();
  if (isPreview) toggleView();
  else previewDiv.innerHTML = '';
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateStatus(`Deleted ${names.length} Note${names.length === 1 ? '' : 's'}.`, true);
  updateFileList();
}

async function deleteSelectedNotes() {
  const notes = await getVisibleNotes();
  if (notes.length === 0) {
    alert('No notes match the filter.');
    return;
  }
  if (!confirm('Delete visible notes?')) return;
  _pendingRename = null;
  await Promise.all(notes.map(async name => {
    await NoteStorage.trashNote(name);
    _forgetNote(name);
    if (currentFileName === name) {
      textarea.value = '';
      refreshHighlight();
      currentFileName = null;
      localStorage.removeItem('current_file');
    }
  }));
  updateStatus(`Deleted ${notes.length} Note${notes.length === 1 ? '' : 's'}.`, true);
  updateFileList();
}
