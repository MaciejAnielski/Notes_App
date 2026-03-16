// file-list.js — File list, todo list, and task checkbox management.
//
// Manages the notes sidebar list with search filtering, the tasks panel
// with checkbox toggling, and preview task checkbox interaction.

async function getVisibleNotes() {
  const raw = searchBox.value.trim().toLowerCase();
  const matches = createSearchPredicate(raw, makeNoteTermPredicate);
  const notes = [];
  const allNotes = await NoteStorage.getAllNotes();
  for (const { name, content } of allNotes) {
    if (name.startsWith('.')) continue;
    if (matches(name.toLowerCase(), content.toLowerCase())) {
      notes.push(name);
    }
  }
  return notes;
}

// Serialize updateFileList calls to prevent duplicate entries when multiple
// sync events fire in quick succession.
let _updateFileListRunning = false;
let _updateFileListQueued = false;

async function updateFileList() {
  if (_updateFileListRunning) {
    _updateFileListQueued = true;
    return;
  }
  _updateFileListRunning = true;
  try {
    await _doUpdateFileList();
  } finally {
    _updateFileListRunning = false;
    if (_updateFileListQueued) {
      _updateFileListQueued = false;
      updateFileList();
    }
  }
}

async function _doUpdateFileList() {
  invalidateScheduleCache();
  await refreshProjectsNote();
  await refreshGraphNote();
  fileList.innerHTML = '';
  const raw = searchBox.value.trim().toLowerCase();
  const matches = createSearchPredicate(raw, makeNoteTermPredicate);

  const noteMap = {};
  const allNotes = await NoteStorage.getAllNotes();

  const todayNote = getFormattedDate() + ' Daily Note';
  for (const { name: fileName, content } of allNotes) {
    if (fileName.startsWith('.')) continue;
    if (fileName === PROJECTS_NOTE || fileName === GRAPH_NOTE || fileName === CALENDARS_NOTE) continue;
    if (matches(fileName.toLowerCase(), content.toLowerCase())) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = fileName;
      span.style.cursor = 'pointer';
      span.onclick = () => {
        loadNote(fileName);
        closeMobilePanel('left');
      };
      li.appendChild(span);
      if (fileName === todayNote) li.classList.add('today-note');
      noteMap[fileName] = li;
    }
  }

  const items = [];

  if (currentFileName && noteMap[currentFileName]) {
    noteMap[currentFileName].classList.add('active-file');
    items.push(noteMap[currentFileName]);
    delete noteMap[currentFileName];
  }

  linkedNoteChain.forEach((name, idx) => {
    if (noteMap[name]) {
      noteMap[name].classList.add('linked-file');
      noteMap[name].dataset.chainIndex = idx + 1;
      noteMap[name].querySelector('span').onclick = () => {
        linkedNoteChain = linkedNoteChain.slice(idx + 1);
        saveChain();
        loadNote(name, true);
      };
      items.push(noteMap[name]);
      delete noteMap[name];
    }
  });

  Object.keys(noteMap)
    .sort((a, b) => b.localeCompare(a))
    .forEach(name => {
      items.push(noteMap[name]);
    });

  items.forEach(li => fileList.appendChild(li));

  // ── Nav section: Projects / Note Graph / Settings ──────────────────────
  const navList = document.getElementById('nav-list');
  navList.innerHTML = '';
  const NAV_ITEMS = [
    { name: PROJECTS_NOTE, label: 'Projects' },
    { name: GRAPH_NOTE,    label: 'Note Graph' },
    { name: CALENDARS_NOTE, label: 'Settings' },
  ];
  for (const { name, label } of NAV_ITEMS) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = label;
    span.style.cursor = 'pointer';
    const chainIdx = linkedNoteChain.indexOf(name);
    if (currentFileName === name) {
      li.classList.add('active-file');
      span.onclick = () => { loadNote(name); closeMobilePanel('left'); };
    } else if (chainIdx !== -1) {
      li.classList.add('linked-file');
      li.dataset.chainIndex = chainIdx + 1;
      span.onclick = () => {
        linkedNoteChain = linkedNoteChain.slice(chainIdx + 1);
        saveChain();
        loadNote(name, true);
      };
    } else {
      span.onclick = () => { loadNote(name); closeMobilePanel('left'); };
    }
    li.appendChild(span);
    navList.appendChild(li);
  }

  // Detect @CalendarName tags in notes and update Settings note on web
  await updateWebCalendarSettings(allNotes);

  // Pass the already-fetched notes to updateTodoList to avoid a second
  // round-trip through the native bridge on iOS.
  await updateTodoList(allNotes);
}

// ── Settings note maintenance (web + desktop) ─────────────────────────────
// Ensures the Settings note always exists with at least the Theme section.
// On web, also scans notes for @CalendarName tags and adds a Calendars section
// only when such tags are present. iOS manages its own Settings note via
// calendar-sync.js. This function is a no-op on iOS.
async function updateWebCalendarSettings(allNotes) {
  if (window.Capacitor?.isNativePlatform()) return;

  // Scan for @CalendarName tags used in schedule syntax across all notes.
  // Skip system notes (.calendar_metadata, .app_preferences) to prevent
  // JSON content from being misinterpreted as calendar names.
  const calendarNames = new Set();
  for (const { name: noteName, content } of allNotes) {
    if (!content) continue;
    if (noteName.startsWith('.')) continue;
    const tagRe = />\s*\d{6}(?:\s+\d{4}\s+\d{4}|\s+\d{6})?(?:\s+@(\S+))?\s*$/gm;
    let m;
    while ((m = tagRe.exec(content)) !== null) {
      if (m[1]) calendarNames.add(m[1]);
    }
  }

  const existing = await NoteStorage.getNote(CALENDARS_NOTE) || '';

  // --- Web path ---
  // Always ensure the Settings note exists with a Theme section.
  // Only add a Calendars section if @CalendarName tags are in use.

  let content = existing || '# Settings\n';

  // Ensure Theme section
  if (!content.includes('## 🎨 Theme')) {
    // Insert before any existing ## heading, or append
    const firstSecIdx = content.indexOf('\n## ');
    if (firstSecIdx !== -1) {
      content = content.slice(0, firstSecIdx) +
        '\n\n## 🎨 Theme\n\nCustomise the app\'s background and accent colours.\n' +
        content.slice(firstSecIdx);
    } else {
      content += '\n\n## 🎨 Theme\n\nCustomise the app\'s background and accent colours.\n';
    }
  }

  // Clean up any corrupted lines in the Calendars section (e.g. JSON fragments
  // from .calendar_metadata that were erroneously appended in older versions).
  const corruptRe = /^- .+[{}"\[\]].{10,}$/gm;
  content = content.replace(corruptRe, '');
  // Remove resulting blank line runs
  content = content.replace(/\n{3,}/g, '\n\n');

  // If no calendar tags, save (Theme section only) and stop
  if (calendarNames.size === 0) {
    if (content !== existing) {
      await NoteStorage.setNote(CALENDARS_NOTE, content);
      if (currentFileName === CALENDARS_NOTE) {
        textarea.value = content;
        if (isPreview) renderPreview(); else refreshHighlight();
      }
    }
    return;
  }

  // Extract existing calendar names to avoid duplicates.
  // Normalise names (lowercase, no spaces) for comparison so that
  // "UK Holidays" (from iOS) matches "UKHolidays" (from @CalendarName tags).
  const existingNames = new Set();
  const existingNamesNorm = new Set();
  const calSection = content.match(/## 📅 Calendars([\s\S]*?)(?=\n##|$)/);
  if (calSection) {
    const nameRe = /^- (.+?)\s*$/gm;
    let nm;
    while ((nm = nameRe.exec(calSection[1])) !== null) {
      existingNames.add(nm[1]);
      existingNamesNorm.add(nm[1].toLowerCase().replace(/\s+/g, ''));
    }
    const cbRe = /^\[[ xX]\]\s+(.+?)\s*\{[^}]+\}\s*$/gm;
    while ((nm = cbRe.exec(calSection[1])) !== null) {
      existingNames.add(nm[1]);
      existingNamesNorm.add(nm[1].toLowerCase().replace(/\s+/g, ''));
    }
  }

  const newNames = [...calendarNames].filter(
    n => !existingNamesNorm.has(n.toLowerCase().replace(/\s+/g, ''))
  );

  // Ensure Calendars section exists
  if (!content.includes('## 📅 Calendars')) {
    content += '\n\n## 📅 Calendars\n';
  }

  // Append new calendar names
  for (const name of newNames.sort()) {
    const secIdx = content.indexOf('\n## 📅 Calendars');
    if (secIdx !== -1) {
      const afterHeading = secIdx + '\n## 📅 Calendars'.length;
      const nextSecIdx = content.indexOf('\n## ', afterHeading);
      const insertAt = nextSecIdx !== -1 ? nextSecIdx : content.length;
      content = content.slice(0, insertAt) + '\n- ' + name + content.slice(insertAt);
    } else {
      content += '\n- ' + name;
    }
  }

  if (content === existing) return;
  await NoteStorage.setNote(CALENDARS_NOTE, content);
  if (currentFileName === CALENDARS_NOTE) {
    textarea.value = content;
    if (isPreview) renderPreview(); else refreshHighlight();
  }
}

async function updateTodoList(cachedNotes) {
  invalidateScheduleCache();
  todoList.innerHTML = '';

  const query = searchTasksBox.value.trim().toLowerCase();
  const matches = createSearchPredicate(query, makeTaskTermPredicate);

  const allNotes = cachedNotes || await NoteStorage.getAllNotes();
  for (const { name: fileName, content: noteContent } of allNotes) {
    if (fileName.startsWith('.')) continue;
    {
      const lines = noteContent.split(/\n/);
      const todos = lines
        .map((line, idx) => ({ line, idx }))
        .filter(obj => obj.line.trim().startsWith('- [ ]'))
        .filter(obj => {
          const status = getTaskScheduleStatus(obj.line);
          return matches(fileName.toLowerCase(), obj.line.toLowerCase(), status);
        });

      if (todos.length > 0) {
        const noteLi = document.createElement('li');
        const title = document.createElement('strong');
        title.classList.add('todo-note-title');
        title.textContent = fileName;
        noteLi.appendChild(title);

        const innerUl = document.createElement('ul');
        todos.forEach(t => {
          const todoLi = document.createElement('li');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          const rawText = t.line.trim().replace(/^- \[[ xX]\]\s*/, '').replace(SCHEDULE_RE, '').trim();
          const text = rawText.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
            const display = inner.replace(/_/g, ' ').trim();
            const href = encodeURIComponent(inner.trim());
            return `[${display}](${href})`;
          });
          checkbox.addEventListener('change', () => {
            toggleTaskStatus(fileName, t.idx);
          });
          todoLi.appendChild(checkbox);
          todoLi.appendChild(document.createTextNode(' '));
          const span = document.createElement('span');
          span.innerHTML = marked.parseInline(text);
          span.style.cursor = 'pointer';
          span.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            loadNote(fileName);
            closeMobilePanel('right');
            setTimeout(() => {
              if (isPreview) {
                highlightTextInPreview(stripMarkdownText(rawText));
              } else {
                const lines = textarea.value.split('\n');
                if (t.idx >= 0 && t.idx < lines.length) {
                  const startOffset = lines.slice(0, t.idx).reduce((acc, l) => acc + l.length + 1, 0);
                  textarea.setSelectionRange(startOffset, startOffset + lines[t.idx].length);
                  textarea.focus();
                  // Scroll so the selected line is vertically centred in the textarea.
                  textarea.scrollTop = Math.max(0, getLineScrollY(textarea, startOffset) - textarea.clientHeight / 2);
                }
              }
            }, 50);
          });
          todoLi.appendChild(span);

          // Extract primary date from any schedule format for dot coloring
          const schedDateMatch = t.line.match(/>\s*(\d{6})(?:\s+\d{4}\s+\d{4}|\s+\d{6})?\s*$/);
          const dot = document.createElement('span');
          dot.className = 'task-status-dot';
          dot.classList.add(getTaskDotClass(schedDateMatch ? schedDateMatch[1] : null));
          todoLi.appendChild(dot);

          innerUl.appendChild(todoLi);
        });

        noteLi.appendChild(innerUl);
        todoList.appendChild(noteLi);
      }
    }
  }
  styleTaskListItems(todoList);
  await setupNoteLinks(todoList);
  if (window.MathJax) {
    MathJax.typesetPromise([todoList]);
  }
  renderSchedule();
}

function setupPreviewTaskCheckboxes() {
  const checkboxes = previewDiv.querySelectorAll('input[type="checkbox"]:not([data-plain-cb])');
  const lines = textarea.value.split(/\n/);
  const taskIndices = [];
  lines.forEach((line, idx) => {
    if (line.trim().startsWith('- [ ]') || line.trim().startsWith('- [x]')) {
      taskIndices.push(idx);
    }
  });

  checkboxes.forEach((cb, i) => {
    cb.disabled = false;
    cb.dataset.lineIndex = taskIndices[i];
    cb.onchange = async () => {
      const lineIdx = parseInt(cb.dataset.lineIndex, 10);
      const currentLines = textarea.value.split(/\n/);
      if (lineIdx >= 0 && lineIdx < currentLines.length) {
        currentLines[lineIdx] = currentLines[lineIdx].replace(/- \[[ xX]\]/, cb.checked ? '- [x]' : '- [ ]');
        textarea.value = currentLines.join('\n');
        if (currentFileName) {
          await NoteStorage.setNote(currentFileName, textarea.value);
          // Keep _lastSavedContent in sync so a pending auto-save timer does
          // not overwrite this checkbox toggle with stale content.
          _lastSavedContent = textarea.value;
        }
        if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
        await updateTodoList();
      }
    };

    const sourceLine = taskIndices[i] !== undefined ? lines[taskIndices[i]] : null;
    const isCompleted = sourceLine && /^[\s]*- \[[xX]\]/.test(sourceLine);
    if (!isCompleted) {
      const dot = document.createElement('span');
      dot.className = 'task-status-dot dot-inline';
      const schedDateMatch = sourceLine && sourceLine.match(/>\s*(\d{6})(?:\s+\d{4}\s+\d{4}|\s+\d{6})?\s*$/);
      dot.classList.add(getTaskDotClass(schedDateMatch ? schedDateMatch[1] : null));
      const li = cb.closest('li');
      if (li) {
        const container = cb.parentElement;
        const boundary = Array.from(container.childNodes).find(n =>
          (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') ||
          (n.nodeType === Node.ELEMENT_NODE &&
           ['P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE'].includes(n.tagName))
        );
        if (boundary) {
          container.insertBefore(dot, boundary);
        } else if (container !== li) {
          container.appendChild(dot);
        } else {
          const liBlock = Array.from(li.childNodes).find(n =>
            n.nodeType === Node.ELEMENT_NODE &&
            ['P', 'UL', 'OL', 'BLOCKQUOTE', 'PRE'].includes(n.tagName)
          );
          if (liBlock) {
            li.insertBefore(dot, liBlock);
          } else {
            li.appendChild(dot);
          }
        }
      }
    }
  });
}

async function toggleTaskStatus(fileName, lineIndex) {
  const content = await NoteStorage.getNote(fileName);
  if (!content) return;
  const lines = content.split(/\n/);
  if (lineIndex >= 0 && lineIndex < lines.length) {
    lines[lineIndex] = lines[lineIndex].replace(/- \[ \]/, '- [x]');
    await NoteStorage.setNote(fileName, lines.join('\n'));
    if (currentFileName === fileName) {
      textarea.value = lines.join('\n');
      if (isPreview) renderPreview(); else refreshHighlight();
    }
  }
  await updateTodoList();
}
