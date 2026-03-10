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
  await NoteStorage.removeNote(noteName);
  await NoteStorage.renameAttachmentDir(noteName, newTitle);
  await NoteStorage.setNote(newTitle, newContent);
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

  function isYearPast(yy) {
    return (2000 + parseInt(yy, 10)) < currentFullYear;
  }

  function isSeasonPast(yy, season) {
    const fullYear = 2000 + parseInt(yy, 10);
    if (fullYear < currentFullYear) return true;
    if (fullYear > currentFullYear) return false;
    return SEASON_END_MONTH[season] < currentMonth;
  }

  const active = {}, completed = {};
  const allNames = await NoteStorage.getAllNoteNames();
  for (const name of allNames) {
    if (name === PROJECTS_NOTE) continue;
    const match = name.match(/^(\d{2})(\d{2})(\d{2}) Project .+$/);
    if (!match) continue;
    const yy = match[1], mm = match[2], dd = match[3];
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
        lines.push(`## 20${yy}${yCollapse}`, '');
        for (const season of SEASON_ORDER) {
          const notes = active[yy][season];
          if (!notes || !notes.length) continue;
          const sCollapse = isSeasonPast(yy, season) ? ' >' : '';
          lines.push(`### ${season}${sCollapse}`, '');
          for (const name of notes) lines.push(`- [[${name}]]`);
          lines.push('');
        }
      }
    }
    if (hasCompleted) {
      lines.push('## Completed >', '');
      const completedYears = Object.keys(completed).sort((a, b) => b.localeCompare(a));
      for (const yy of completedYears) {
        const yCollapse = isYearPast(yy) ? ' >' : '';
        lines.push(`### 20${yy}${yCollapse}`, '');
        for (const season of SEASON_ORDER) {
          const notes = completed[yy][season];
          if (!notes || !notes.length) continue;
          const sCollapse = isSeasonPast(yy, season) ? ' >' : '';
          lines.push(`#### ${season}${sCollapse}`, '');
          for (const name of notes) lines.push(`- [[${name}]]`);
          lines.push('');
        }
      }
    }
  }
  return lines.join('\n');
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
  }
}

// ── Auto-save ─────────────────────────────────────────────────────────────

async function autoSaveNote() {
  if (currentFileName === PROJECTS_NOTE) return;
  const prevContent = _lastSavedContent;
  const name = getNoteTitle();
  if (!name) {
    updateStatus('File Not Saved. Please Add A Title Starting With "#".', false);
    return;
  }
  if (currentFileName && currentFileName !== name) {
    await NoteStorage.removeNote(currentFileName);
    await NoteStorage.renameAttachmentDir(currentFileName, name);
  }

  if (await NoteStorage.getNote(name) !== null && currentFileName !== name) {
    if (isNoteBodyEmpty()) {
      await loadNote(name);
      updateStatus(`Opened Existing Note "${name}".`, true);
    } else {
      updateStatus(`File Not Saved. A File Named "${name}" Already Exists. Please Rename.`, false);
    }
    return;
  }

  try {
    await NoteStorage.setNote(name, textarea.value);
  } catch (e) {
    updateStatus('Save Failed — Storage Quota Exceeded. Delete Old Notes Or Export A Backup.', false);
    return;
  }
  const nameChanged = currentFileName !== name;
  _lastSavedContent = textarea.value;
  currentFileName = name;
  localStorage.setItem('current_file', name);
  if (nameChanged) {
    await updateFileList();
  } else {
    await updateTodoList();
  }
  const useICloud = !!(window.electronAPI?.notes ||
    (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage?.isICloudEnabled !== false && window.CapacitorNoteStorage));
  updateStatus(useICloud ? 'Saved to iCloud.' : 'File Saved Successfully.', true);
  await checkAttachmentRenames(prevContent, textarea.value, currentFileName);
}

// ── Load / New / Delete ───────────────────────────────────────────────────

async function loadNote(name, fromLink = false) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (!fromLink) {
    linkedNoteChain = [];
    saveChain();
  }
  const content = await NoteStorage.getNote(name);
  if (content === null) {
    alert('File not found.');
    return;
  }
  textarea.value = content;
  _lastSavedContent = content;
  currentFileName = name;
  localStorage.setItem('current_file', name);

  if (name === PROJECTS_NOTE) {
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
  const today = getFormattedDate();
  const defaultTitle = today + ' Daily Note';
  const existsInList = Array.from(fileList.querySelectorAll('span'))
    .some(s => s.textContent === defaultTitle);
  if (!existsInList) {
    textarea.value = '# ' + defaultTitle + '\n\n';
  } else {
    textarea.value = '';
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
  const activeItem = fileList.querySelector('.active-file');
  if (activeItem) activeItem.classList.remove('active-file');
  updateStatus('', true);
  if (!existsInList) {
    const pos = ('# ' + defaultTitle).length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
  } else {
    textarea.focus();
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

  await NoteStorage.trashNote(name);
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
  const names = await NoteStorage.getAllNoteNames();
  await Promise.all(names.map(name => NoteStorage.trashNote(name)));
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
  await Promise.all(notes.map(async name => {
    await NoteStorage.trashNote(name);
    if (currentFileName === name) {
      textarea.value = '';
      currentFileName = null;
      localStorage.removeItem('current_file');
    }
  }));
  updateStatus(`Moved ${notes.length} Note${notes.length === 1 ? '' : 's'} to Deleted folder.`, true);
  updateFileList();
}
