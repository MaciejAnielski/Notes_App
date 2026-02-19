const textarea = document.getElementById('editor');
const previewDiv = document.getElementById('preview');
const toggleViewBtn = document.getElementById('toggle-view');
let isPreview = false;
let autoSaveTimer = null;
let currentFileName = null;
let linkedNoteChain = [];

const savedPreview = localStorage.getItem('is_preview') === 'true';
const lastFile = localStorage.getItem('current_file');


const newNoteBtn = document.getElementById('new-note');
const downloadAllBtn = document.getElementById('download-all');
const exportNoteBtn = document.getElementById('export-note');
const exportAllHtmlBtn = document.getElementById('export-all-html');
const deleteBtn = document.getElementById('delete-note');
const deleteAllBtn = document.getElementById('delete-all');
const importZipBtn = document.getElementById('import-zip');
const importZipInput = document.getElementById('import-zip-input');
const searchBox = document.getElementById('searchBox');
const searchTasksBox = document.getElementById('searchTasksBox');
const fileList = document.getElementById('fileList');
const todoList = document.getElementById('todoList');
const statusDiv = document.getElementById('status-message');
const deleteSelectedBtn = document.getElementById('delete-selected');
const exportSelectedBtn = document.getElementById('export-selected');
const backupSelectedBtn = document.getElementById('backup-selected');

function getVisibleNotes() {
  let raw = searchBox.value.trim().toLowerCase();
  const namesOnly = raw.startsWith('"') && raw.endsWith('"');
  if (namesOnly) {
    raw = raw.slice(1, -1);
  }
  const matches = createSearchPredicate(raw, namesOnly);
  const notes = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const name = key.slice(3);
      const content = localStorage.getItem(key).toLowerCase();
      if (matches(name.toLowerCase(), content)) {
        notes.push(name);
      }
    }
  }
  return notes;
}

function updateStatus(message, success) {
  statusDiv.textContent = message;
  statusDiv.style.color = success ? 'green' : 'red';
}

function getFormattedDate() {
  const date = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = date.getDate();
  const suffix = (day % 10 === 1 && day !== 11) ? 'st'
                : (day % 10 === 2 && day !== 12) ? 'nd'
                : (day % 10 === 3 && day !== 13) ? 'rd'
                : 'th';
  return `${days[date.getDay()]} ${day}${suffix} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function getNoteTitle() {
  const firstLine = textarea.value.split(/\n/)[0].trim();
  if (firstLine.startsWith('#')) {
    return firstLine.replace(/^#+\s*/, '').trim();
  }
  return null;
}

function isNoteBodyEmpty() {
  const lines = textarea.value.split(/\n/);
  return lines.slice(1).join('\n').trim() === '';
}

// Build a predicate from a search query supporting AND, OR and NOT operators.
function createSearchPredicate(query, namesOnly = false) {
  if (!query) return () => true;

  const tokens = query.split(/\s+/).filter(Boolean);
  let index = 0;

  function parseExpression() {
    let left = parseTerm();
    while (tokens[index] && tokens[index].toUpperCase() === 'OR') {
      index++;
      const right = parseTerm();
      const prev = left;
      left = (n, c) => prev(n, c) || right(n, c);
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (tokens[index] && tokens[index].toUpperCase() !== 'OR') {
      if (tokens[index].toUpperCase() === 'AND') {
        index++;
      }
      const right = parseFactor();
      const prev = left;
      left = (n, c) => prev(n, c) && right(n, c);
    }
    return left;
  }

  function parseFactor() {
    if (tokens[index] && tokens[index].toUpperCase() === 'NOT') {
      index++;
      const next = parseFactor();
      return (n, c) => !next(n, c);
    }
    const term = tokens[index++] || '';
    return namesOnly ?
      (n, c) => n.includes(term) :
      (n, c) => n.includes(term) || c.includes(term);
  }

  return parseExpression();
}


function styleTaskListItems(container = previewDiv) {
  container.querySelectorAll('li').forEach(li => {
    li.classList.remove('task-item', 'bullet-item');
    li.style.marginTop = '';

    const firstChild = li.firstElementChild;
    let checkbox = null;

    if (firstChild && firstChild.tagName === 'INPUT' && firstChild.type === 'checkbox') {
      checkbox = firstChild;
    } else if (
      firstChild &&
      firstChild.tagName === 'P' &&
      firstChild.firstElementChild &&
      firstChild.firstElementChild.tagName === 'INPUT' &&
      firstChild.firstElementChild.type === 'checkbox'
    ) {
      checkbox = firstChild.firstElementChild;
      firstChild.style.margin = '0';
      firstChild.style.display = 'inline';
    } else if (
      firstChild &&
      firstChild.tagName === 'P' &&
      li.childElementCount === 1
    ) {
      firstChild.style.margin = '0';
    }

    if (checkbox) {
      li.style.listStyleType = 'none';

      li.classList.add('task-item');

      // remove the indentation applied by the parent list while keeping
      // the indentation for non-checkbox items intact
      const parent = li.parentElement;
      if (parent && (parent.tagName === 'UL' || parent.tagName === 'OL')) {
        const computed = window.getComputedStyle(parent);
        const indent = parseFloat(computed.paddingLeft || 0);
        if (!isNaN(indent) && indent > 0) {
          li.style.marginLeft = `-${indent}px`;
        } else {
          li.style.marginLeft = '0';
        }
      } else {
        li.style.marginLeft = '0';
      }

      li.style.paddingLeft = '0';

      if (!checkbox.nextSibling || checkbox.nextSibling.nodeValue !== ' ') {
        checkbox.insertAdjacentText('afterend', ' ');
      }
    } else {
      li.classList.add('bullet-item');
    }
  });
}

function setupNoteLinks(container = previewDiv) {
  container.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^[a-zA-Z]+:/.test(href)) {
      return;
    }
    const noteName = decodeURIComponent(href).replace(/\_/g, ' ').trim();
    a.href = '#';
    a.addEventListener('click', e => {
      e.preventDefault();
      if (localStorage.getItem('md_' + noteName) !== null) {
        if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
          // Add the previously viewed note to the top of the chain so the
          // history is ordered from most recent to oldest.
          linkedNoteChain.unshift(currentFileName);
        }
        loadNote(noteName, true);
      } else {
        alert(`Note "${noteName}" not found.`);
      }
    });
  });
}

function renderPreview() {
  previewDiv.innerHTML = marked.parse(textarea.value);
  styleTaskListItems(previewDiv);
  setupNoteLinks(previewDiv);
  setupPreviewTaskCheckboxes();
  if (window.MathJax) {
    MathJax.typesetPromise([previewDiv]);
  }
}

function toggleView() {
  if (isPreview) {
    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
    toggleViewBtn.textContent = 'Preview Markdown';
    isPreview = false;
    localStorage.setItem('is_preview', 'false');
  } else {
    renderPreview();
    previewDiv.style.display = 'block';
    textarea.style.display = 'none';
    toggleViewBtn.textContent = 'Edit Markdown';
    isPreview = true;
    localStorage.setItem('is_preview', 'true');
  }
}

toggleViewBtn.addEventListener('click', toggleView);


function autoSaveNote() {
  const name = getNoteTitle();
  if (!name) {
    updateStatus('File not saved. Please add a title starting with "#".', false);
    return;
  }
  if (currentFileName && currentFileName !== name) {
    // Remove the old entry when the note title changes to avoid leaving
    // partially typed titles in storage.
    localStorage.removeItem('md_' + currentFileName);
  }

  // If another note already exists with the new name, do not overwrite it.
  if (localStorage.getItem('md_' + name) !== null && currentFileName !== name) {
    if (isNoteBodyEmpty()) {
      loadNote(name);
      updateStatus(`Opened existing note "${name}".`, true);
    } else {
      updateStatus(`File not saved. A file named "${name}" already exists. Please rename.`, false);
    }
    return;
  }

  localStorage.setItem('md_' + name, textarea.value);
  currentFileName = name;
  localStorage.setItem('current_file', name);
  updateFileList();
  updateStatus('File saved successfully.', true);
}

function loadNote(name, fromLink = false) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (!fromLink) {
    linkedNoteChain = [];
  }
  const content = localStorage.getItem('md_' + name);
  if (content === null) {
    alert('File not found.');
    return;
  }
  textarea.value = content;
  currentFileName = name;
  localStorage.setItem('current_file', name);
  if (isPreview) {
    renderPreview();
  }
  updateFileList();
}

function newNote() {
  const today = getFormattedDate();
  const key = 'md_' + today;
  if (localStorage.getItem(key) === null) {
    textarea.value = '# ' + today + '\n\n';
  } else {
    textarea.value = '';
  }
  if (isPreview) {
    toggleView();
  }
  clearTimeout(autoSaveTimer);
  linkedNoteChain = [];
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateFileList();
  updateStatus('', true);
}

function deleteNote() {
  const name = currentFileName || getNoteTitle();
  if (!name) {
    alert('No note selected.');
    return;
  }
  if (localStorage.getItem('md_' + name) === null) {
    alert('File not found.');
    return;
  }

  localStorage.removeItem('md_' + name);
  textarea.value = '';
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateFileList();
}

function deleteAllNotes() {
  if (!confirm('Delete all notes?')) return;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) keys.push(key);
  }
  keys.forEach(k => localStorage.removeItem(k));
  textarea.value = '';
  currentFileName = null;
  localStorage.removeItem('current_file');
  updateFileList();
}

function downloadAllNotes() {
  const zip = new JSZip();
  let count = 0;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const fileName = key.slice(3) + '.md';
      const content = localStorage.getItem(key);
      zip.file(fileName, content);
      count++;
    }
  }

  if (count === 0) {
    alert('No notes found.');
    return;
  }

  zip.generateAsync({ type: 'blob' }).then(function(content) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = 'all_notes.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function generateHtmlContent(title, markdown) {
  const container = document.createElement('div');
  container.innerHTML = marked.parse(markdown);
  styleTaskListItems(container);
  const isDark = document.body.classList.contains('dark-mode');
  const bgColor = isDark ? '#2e2e2e' : '#d8bbdf';
  const textColor = isDark ? '#f0f0f0' : '#000';
  const linkColor = isDark ? '#9cdcfe' : '#0645ad';
  const style = `
    body {
      width: 100%;
      max-width: 800px;
      min-height: 400px;
      padding: 10px;
      font-family: Arial, sans-serif;
      font-size: 16px;
      line-height: 1.5;
      border-radius: 4px;
      box-sizing: border-box;
      background-color: ${bgColor};
      color: ${textColor};
      margin: 20px auto;
    }
    a { color: ${linkColor}; }
    li p:first-child:last-child { margin: 0; }
    li.task-item + li.bullet-item,
    li.bullet-item + li.task-item { margin-top: 8px; }
  `;
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>${title}</title>\n<style>${style}</style>\n<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>\n</head>\n<body>\n${container.innerHTML}\n</body>\n</html>`;
}

function exportNote() {
  const name = currentFileName || getNoteTitle();
  if (!name) {
    alert('No note selected.');
    return;
  }
  const markdown = textarea.value;
  const html = generateHtmlContent(name, markdown);
  const blob = new Blob([html], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name + '.html';
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportAllNotes() {
  const zip = new JSZip();
  let count = 0;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const fileName = key.slice(3);
      const content = localStorage.getItem(key);
      const html = generateHtmlContent(fileName, content);
      zip.file(fileName + '.html', html);
      count++;
    }
  }

  if (count === 0) {
    alert('No notes found.');
    return;
  }

  zip.generateAsync({ type: 'blob' }).then(function(content) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = 'all_notes_html.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function deleteSelectedNotes() {
  const notes = getVisibleNotes();
  if (notes.length === 0) {
    alert('No notes match the filter.');
    return;
  }
  if (!confirm('Delete visible notes?')) return;
  notes.forEach(name => {
    localStorage.removeItem('md_' + name);
    if (currentFileName === name) {
      textarea.value = '';
      currentFileName = null;
      localStorage.removeItem('current_file');
    }
  });
  updateFileList();
}

function backupSelectedNotes() {
  const notes = getVisibleNotes();
  if (notes.length === 0) {
    alert('No notes match the filter.');
    return;
  }
  const zip = new JSZip();
  notes.forEach(name => {
    const content = localStorage.getItem('md_' + name);
    if (content !== null) {
      zip.file(name + '.md', content);
    }
  });
  zip.generateAsync({ type: 'blob' }).then(content => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = 'selected_notes.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function exportSelectedNotes() {
  const notes = getVisibleNotes();
  if (notes.length === 0) {
    alert('No notes match the filter.');
    return;
  }
  const zip = new JSZip();
  notes.forEach(name => {
    const content = localStorage.getItem('md_' + name);
    if (content !== null) {
      const html = generateHtmlContent(name, content);
      zip.file(name + '.html', html);
    }
  });
  zip.generateAsync({ type: 'blob' }).then(content => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = 'selected_notes_html.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function importNotesFromZip(file) {
  JSZip.loadAsync(file).then(zip => {
    const promises = [];
    zip.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir && relativePath.endsWith('.md')) {
        const name = relativePath.replace(/\.md$/, '');
        promises.push(zipEntry.async('string').then(content => {
          localStorage.setItem('md_' + name, content);
        }));
      }
    });
    return Promise.all(promises);
  }).then(() => {
    updateFileList();
    importZipInput.value = '';
  }).catch(err => {
    alert('Error importing zip: ' + err.message);
  });
}

function updateFileList() {
  fileList.innerHTML = '';
  let raw = searchBox.value.trim().toLowerCase();
  const namesOnly = raw.startsWith('"') && raw.endsWith('"');
  if (namesOnly) {
    raw = raw.slice(1, -1);
  }
  const matches = createSearchPredicate(raw, namesOnly);

  const noteMap = {};

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const fileName = key.slice(3);
      const content = localStorage.getItem(key).toLowerCase();

      if (matches(fileName.toLowerCase(), content)) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = fileName;
        span.style.cursor = 'pointer';
        span.onclick = () => {
          loadNote(fileName);
        };
        li.appendChild(span);
        noteMap[fileName] = li;
      }
    }
  }

  const items = [];

  if (currentFileName && noteMap[currentFileName]) {
    noteMap[currentFileName].classList.add('active-file');
    items.push(noteMap[currentFileName]);
    delete noteMap[currentFileName];
  }

  linkedNoteChain.forEach(name => {
    if (noteMap[name]) {
      noteMap[name].classList.add('linked-file');
      items.push(noteMap[name]);
      delete noteMap[name];
    }
  });

  Object.keys(noteMap)
    .sort()
    .forEach(name => {
      items.push(noteMap[name]);
    });

  items.forEach(li => fileList.appendChild(li));

  updateTodoList();
}

function updateTodoList() {
  todoList.innerHTML = '';

  const query = searchTasksBox.value.trim().toLowerCase();
  const matches = createSearchPredicate(query);

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const fileName = key.slice(3);
      const lines = localStorage.getItem(key).split(/\n/);
      const todos = lines
        .map((line, idx) => ({ line, idx }))
        .filter(obj => obj.line.trim().startsWith('- [ ]'))
        .filter(obj => matches(fileName.toLowerCase(), obj.line.toLowerCase()));

      if (todos.length > 0) {
        const noteLi = document.createElement('li');
        const title = document.createElement('strong');
        title.classList.add('todo-note-title');
        title.textContent = fileName;
        title.style.cursor = 'pointer';
        title.onclick = () => {
          loadNote(fileName);
        };
        noteLi.appendChild(title);

        const innerUl = document.createElement('ul');
        todos.forEach(t => {
          const todoLi = document.createElement('li');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          const text = t.line.trim().replace(/^- \[[ xX]\]\s*/, '').trim();
          checkbox.addEventListener('change', () => {
            toggleTaskStatus(fileName, t.idx);
          });
          todoLi.appendChild(checkbox);
          todoLi.appendChild(document.createTextNode(' '));
          const span = document.createElement('span');
          span.innerHTML = marked.parseInline(text);
          todoLi.appendChild(span);
          innerUl.appendChild(todoLi);
        });

        noteLi.appendChild(innerUl);
        todoList.appendChild(noteLi);
      }
    }
  }
  styleTaskListItems(todoList);
  setupNoteLinks(todoList);
  if (window.MathJax) {
    MathJax.typesetPromise([todoList]);
  }
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
    cb.onchange = () => {
      const lineIdx = parseInt(cb.dataset.lineIndex, 10);
      const currentLines = textarea.value.split(/\n/);
      if (lineIdx >= 0 && lineIdx < currentLines.length) {
        currentLines[lineIdx] = currentLines[lineIdx].replace(/- \[[ xX]\]/, cb.checked ? '- [x]' : '- [ ]');
        textarea.value = currentLines.join('\n');
        if (currentFileName) {
          localStorage.setItem('md_' + currentFileName, textarea.value);
        }
        renderPreview();
        updateTodoList();
      }
    };
  });
}

function toggleTaskStatus(fileName, lineIndex) {
  const key = 'md_' + fileName;
  const content = localStorage.getItem(key);
  if (!content) return;
  const lines = content.split(/\n/);
  if (lineIndex >= 0 && lineIndex < lines.length) {
    lines[lineIndex] = lines[lineIndex].replace(/- \[ \]/, '- [x]');
    localStorage.setItem(key, lines.join('\n'));
    if (currentFileName === fileName) {
      textarea.value = lines.join('\n');
      if (isPreview) {
        renderPreview();
      }
    }
  }
  updateTodoList();
}

function filterNotes() {
  updateFileList();
}

function setupMobileButtonGroup(button, action) {
  const group = button.parentElement;
  const sub = group ? group.querySelector('.sub-button') : null;
  if (!group || !sub) {
    button.addEventListener('click', action);
    return;
  }

  let expanded = false;

  button.addEventListener('click', e => {
    const isMobileTouch = window.matchMedia('(hover: none) and (max-width: 650px)').matches;
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

setupMobileButtonGroup(newNoteBtn, newNote);
downloadAllBtn.addEventListener('click', downloadAllNotes);
setupMobileButtonGroup(exportNoteBtn, exportNote);
exportAllHtmlBtn.addEventListener('click', exportAllNotes);
setupMobileButtonGroup(deleteBtn, deleteNote);
deleteAllBtn.addEventListener('click', deleteAllNotes);
deleteSelectedBtn.addEventListener('click', deleteSelectedNotes);
exportSelectedBtn.addEventListener('click', exportSelectedNotes);
backupSelectedBtn.addEventListener('click', backupSelectedNotes);
setupMobileButtonGroup(importZipBtn, () => importZipInput.click());
importZipInput.addEventListener('change', e => {
  if (e.target.files.length > 0) {
    importNotesFromZip(e.target.files[0]);
  }
});
searchBox.addEventListener('input', filterNotes);
searchTasksBox.addEventListener('input', updateTodoList);
textarea.addEventListener('input', () => {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(autoSaveNote, 1000);
});

if (lastFile && localStorage.getItem('md_' + lastFile) !== null) {
  loadNote(lastFile);
} else {
  newNote();
}

if (savedPreview && !isPreview) {
  toggleView();
}
