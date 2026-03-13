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
    if (name === '.calendar_metadata') continue;
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
  fileList.innerHTML = '';
  const raw = searchBox.value.trim().toLowerCase();
  const matches = createSearchPredicate(raw, makeNoteTermPredicate);

  const noteMap = {};
  const allNotes = await NoteStorage.getAllNotes();

  for (const { name: fileName, content } of allNotes) {
    if (fileName === '.calendar_metadata') continue;
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

  // Pass the already-fetched notes to updateTodoList to avoid a second
  // round-trip through the native bridge on iOS.
  await updateTodoList(allNotes);
}

async function updateTodoList(cachedNotes) {
  invalidateScheduleCache();
  todoList.innerHTML = '';

  const query = searchTasksBox.value.trim().toLowerCase();
  const matches = createSearchPredicate(query, makeTaskTermPredicate);

  const allNotes = cachedNotes || await NoteStorage.getAllNotes();
  for (const { name: fileName, content: noteContent } of allNotes) {
    if (fileName === '.calendar_metadata') continue;
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
  const checkboxes = previewDiv.querySelectorAll('input[type="checkbox"]');
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
        }
        renderPreview();
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
      if (isPreview) {
        renderPreview();
      }
    }
  }
  await updateTodoList();
}
