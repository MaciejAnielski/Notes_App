// note-manager.js — Note CRUD operations, auto-save, and projects note.
//
// Handles creating, loading, saving, deleting, and renaming notes,
// the Projects virtual note, and attachment rename tracking.

function getNoteTitle() {
  const firstLine = textarea.value.split(/\n/)[0].trim();
  if (firstLine.startsWith('#')) {
    return firstLine.replace(/^#+\s*/, '').replace(/\s*>\s*$/, '').trim();
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
  const newTitle = firstLine.replace(/^#+\s*/, '').replace(/\s*>\s*$/, '').trim();
  if (!newTitle || newTitle === noteName) return;
  if (await NoteStorage.getNote(newTitle) !== null) return;
  // Write the new note before removing the old one so a storage failure
  // cannot result in data loss.
  await NoteStorage.setNote(newTitle, newContent);
  _perNoteSavedContent.set(newTitle, newContent);
  _perNoteRemoteContent.set(newTitle, newContent);
  await NoteStorage.removeNote(noteName);
  _perNoteSavedContent.delete(noteName);
  _perNoteRemoteContent.delete(noteName);
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

// ── Projects note ─────────────────────────────────────────────────────────

async function generateProjectsNoteContent() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentFullYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  const SEASON_END_MONTH = { Winter: 2, Spring: 5, Summer: 8, Autumn: 11 };
  const emojis = getProjectEmojis();

  function isYearPast(yy) {
    return (2000 + parseInt(yy, 10)) < currentFullYear;
  }

  function isSeasonPast(yy, season) {
    const fullYear = 2000 + parseInt(yy, 10);
    if (fullYear < currentFullYear) return true;
    if (fullYear > currentFullYear) return false;
    // Winter spans months 1, 2, and 12 of the same year.
    // December of the current year is never past within the same year,
    // so Winter is not "entirely past" until the year itself is past.
    if (season === 'Winter') return false;
    return SEASON_END_MONTH[season] < currentMonth;
  }

  function isValidYYMMDD(yy, mm, dd) {
    const monthNum = parseInt(mm, 10);
    const dayNum = parseInt(dd, 10);
    if (monthNum < 1 || monthNum > 12) return false;
    if (dayNum < 1 || dayNum > 31) return false;
    return true;
  }

  const active = {}, completed = {};
  const allNames = await NoteStorage.getAllNoteNames();
  for (const name of allNames) {
    if (name === PROJECTS_NOTE) continue;
    const match = name.match(/^(\d{2})(\d{2})(\d{2}) Project .+$/);
    if (!match) continue;
    const yy = match[1], mm = match[2], dd = match[3];
    if (!isValidYYMMDD(yy, mm, dd)) continue;
    const season = getSeason(mm);
    const projectDate = new Date(2000 + parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
    const isCompleted = projectDate < today;
    const target = isCompleted ? completed : active;
    if (!target[yy]) target[yy] = {};
    if (!target[yy][season]) target[yy][season] = [];
    target[yy][season].push(name);
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
      const activeYears = Object.keys(active).sort((a, b) => b.localeCompare(a));
      for (const yy of activeYears) {
        const yCollapse = isYearPast(yy) ? ' >' : '';
        lines.push(`## ${emojis.active} 20${yy}${yCollapse}`, '');
        for (const season of SEASON_ORDER) {
          const notes = active[yy][season];
          if (!notes || !notes.length) continue;
          const sCollapse = isSeasonPast(yy, season) ? ' >' : '';
          const seasonEmoji = emojis[season];
          lines.push(`### ${seasonEmoji} ${season}${sCollapse}`, '');
          for (const name of notes) lines.push(`- [[${name}]]`);
          lines.push('');
        }
      }
    }
    if (hasCompleted) {
      lines.push(`## ${emojis.completed} Completed >`, '');
      const completedYears = Object.keys(completed).sort((a, b) => b.localeCompare(a));
      for (const yy of completedYears) {
        const yCollapse = isYearPast(yy) ? ' >' : '';
        lines.push(`### 20${yy}${yCollapse}`, '');
        for (const season of SEASON_ORDER) {
          const notes = completed[yy][season];
          if (!notes || !notes.length) continue;
          const sCollapse = isSeasonPast(yy, season) ? ' >' : '';
          const seasonEmoji = emojis[season];
          lines.push(`#### ${seasonEmoji} ${season}${sCollapse}`, '');
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

async function refreshProjectsNote() {
  const newContent = await generateProjectsNoteContent();
  const existing = await NoteStorage.getNote(PROJECTS_NOTE);
  if (existing === newContent) return;
  await NoteStorage.setNote(PROJECTS_NOTE, newContent);
  if (currentFileName === PROJECTS_NOTE) {
    textarea.value = newContent;
    renderPreview();
  }
}

// ── Attachment rename tracking ────────────────────────────────────────────

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

  const useICloud = !!(window.electronAPI?.notes ||
    (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage?.isICloudEnabled !== false && window.CapacitorNoteStorage));

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
    updateStatus(useICloud ? 'Saved to iCloud.' : 'File Saved Successfully.', true);
    await checkAttachmentRenames(prevContent, capturedContent, currentFileName);
    return;
  }

  // ── Existing note ──────────────────────────────────────────────────────
  // Save content under the CURRENT filename — do not rename while the user
  // is mid-typing.  If the title has changed, record the desired new name in
  // _pendingRename so the actual filesystem rename happens only when the user
  // commits by pressing View or switching to another note.
  if (name !== capturedFileName) {
    _pendingRename = name;
  } else {
    _pendingRename = null;
  }

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
  updateStatus(useICloud ? 'Saved to iCloud.' : 'File Saved Successfully.', true);
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

  // Write the new note BEFORE removing the old one so a storage failure
  // cannot result in data loss.
  const content = textarea.value;
  const useICloud = !!(window.electronAPI?.notes ||
    (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage?.isICloudEnabled !== false && window.CapacitorNoteStorage));
  try {
    await NoteStorage.setNote(newName, content);
  } catch (e) {
    updateStatus('Save Failed — Storage Quota Exceeded. Delete Old Notes Or Export A Backup.', false);
    return;
  }
  _lastSavedContent = content;
  _perNoteSavedContent.delete(oldName);
  _perNoteRemoteContent.delete(oldName);
  _perNoteSavedContent.set(newName, content);
  _perNoteRemoteContent.set(newName, content);
  await NoteStorage.removeNote(oldName);
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
  updateStatus(useICloud ? 'Saved to iCloud.' : 'File Saved Successfully.', true);
}

// ── Load / New / Delete ───────────────────────────────────────────────────

async function loadNote(name, fromLink = false, prefetchedContent = null) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;

  // Switching to a different note: flush any unsaved edits under the current
  // filename and apply any pending title rename before navigating away.
  if (currentFileName && currentFileName !== name) {
    if (textarea.value !== _lastSavedContent) {
      try {
        await NoteStorage.setNote(currentFileName, textarea.value);
        _lastSavedContent = textarea.value;
        _perNoteSavedContent.set(currentFileName, textarea.value);
      } catch (_) { /* ignore — content is still in textarea */ }
    }
    await applyPendingRename();
  }

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
    linkedNoteChain = [];
    saveChain();
  }
  let content = prefetchedContent !== null ? prefetchedContent : await NoteStorage.getNote(name);
  // Settings note: create it if it doesn't exist yet (e.g. first run on desktop/web)
  if (content === null && name === CALENDARS_NOTE) {
    content = '# Settings\n\n## 🎨 Theme\n\nCustomise the app\'s background and accent colours.\n';
    await NoteStorage.setNote(name, content);
  } else if (content === null) {
    alert('File not found.');
    return;
  }
  // Ensure Settings note has the Theme section (migration / cross-device sync)
  if (name === CALENDARS_NOTE && !content.includes('## 🎨 Theme')) {
    const insertPos = content.indexOf('\n## ');
    if (insertPos !== -1) {
      content = content.slice(0, insertPos) +
        '\n\n## 🎨 Theme\n\nCustomise the app\'s background and accent colours.\n' +
        content.slice(insertPos);
    } else {
      content += '\n\n## 🎨 Theme\n\nCustomise the app\'s background and accent colours.\n';
    }
    await NoteStorage.setNote(name, content);
  }
  textarea.value = content;
  _lastSavedContent = content;
  _lastRemoteContent = content;
  _perNoteSavedContent.set(name, content);
  _perNoteRemoteContent.set(name, content);
  currentFileName = name;
  refreshHighlight();
  localStorage.setItem('current_file', name);

  const isReadOnlyNote = name === PROJECTS_NOTE || name === CALENDARS_NOTE || name === GRAPH_NOTE;

  if (isReadOnlyNote) {
    textarea.readOnly = true;
    toggleViewBtn.disabled = true;
    renderPreview();
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
    if (isPreview) renderPreview();
  }

  await updateFileList();
}

async function newNote() {
  // Flush unsaved content and apply any pending rename before leaving the
  // current note, so the title change is not silently discarded.
  if (currentFileName) {
    if (textarea.value !== _lastSavedContent) {
      try {
        await NoteStorage.setNote(currentFileName, textarea.value);
        _lastSavedContent = textarea.value;
        _perNoteSavedContent.set(currentFileName, textarea.value);
      } catch (_) { /* ignore */ }
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
  if (!confirm(`Move "${name}" to the Deleted folder?`)) return;

  _pendingRename = null;
  await NoteStorage.trashNote(name);
  _perNoteSavedContent.delete(name);
  _perNoteRemoteContent.delete(name);
  textarea.value = '';
  if (isPreview) toggleView();
  else previewDiv.innerHTML = '';
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateStatus(`Moved "${name}" to Deleted folder.`, true);
  updateFileList();
}

async function deleteAllNotes() {
  if (!confirm('Move all notes to the Deleted folder?')) return;
  _pendingRename = null;
  const names = await NoteStorage.getAllNoteNames();
  await Promise.all(names.map(name => NoteStorage.trashNote(name)));
  _perNoteSavedContent.clear();
  _perNoteRemoteContent.clear();
  textarea.value = '';
  if (isPreview) toggleView();
  else previewDiv.innerHTML = '';
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateStatus(`Moved ${names.length} Note${names.length === 1 ? '' : 's'} to Deleted folder.`, true);
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
    _perNoteSavedContent.delete(name);
    _perNoteRemoteContent.delete(name);
    if (currentFileName === name) {
      textarea.value = '';
      currentFileName = null;
      localStorage.removeItem('current_file');
    }
  }));
  updateStatus(`Moved ${notes.length} Note${notes.length === 1 ? '' : 's'} to Deleted folder.`, true);
  updateFileList();
}
