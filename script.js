const toggleBtn = document.getElementById('toggle-theme');
const textarea = document.getElementById('editor');
const previewDiv = document.getElementById('preview');
const toggleViewBtn = document.getElementById('toggle-view');
let isPreview = false;
let autoSaveTimer = null;
let currentFileName = null;

function applyTheme(theme) {
  document.body.classList.toggle('dark-mode', theme === 'dark');
  toggleBtn.classList.remove('sun', 'moon');
  toggleBtn.classList.add(theme === 'dark' ? 'moon' : 'sun');
}

function toggleTheme() {
  const newTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
  applyTheme(newTheme);
  localStorage.setItem('theme', newTheme);
}

toggleBtn.addEventListener('click', toggleTheme);

const savedTheme = localStorage.getItem('theme') || 'light';
applyTheme(savedTheme);

const filenameInput = document.getElementById('filename-input');

const saveStorageBtn = document.getElementById('save-storage');
const loadStorageBtn = document.getElementById('load-storage');
const newNoteBtn = document.getElementById('new-note');
const downloadAllBtn = document.getElementById('download-all');
const deleteBtn = document.getElementById('delete-note');
const deleteAllBtn = document.getElementById('delete-all');
const importZipBtn = document.getElementById('import-zip');
const importZipInput = document.getElementById('import-zip-input');
const searchBox = document.getElementById('searchBox');
const fileList = document.getElementById('fileList');
const todoList = document.getElementById('todoList');

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

filenameInput.value = getFormattedDate();

function styleTaskListItems() {
  previewDiv.querySelectorAll('li').forEach(li => {
    const checkbox = li.querySelector('input[type="checkbox"]');
    if (checkbox) {
      li.style.listStyleType = 'none';
      if (!checkbox.nextSibling || checkbox.nextSibling.nodeValue !== ' ') {
        checkbox.insertAdjacentText('afterend', ' ');
      }
    }
  });
}

function toggleView() {
  if (isPreview) {
    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
    toggleViewBtn.textContent = 'Preview Markdown';
    isPreview = false;
  } else {
    previewDiv.innerHTML = marked.parse(textarea.value);
    styleTaskListItems();
    setupPreviewTaskCheckboxes();
    previewDiv.style.display = 'block';
    textarea.style.display = 'none';
    toggleViewBtn.textContent = 'Edit Markdown';
    isPreview = true;
  }
}

toggleViewBtn.addEventListener('click', toggleView);

function saveNote() {
  const name = filenameInput.value.trim();
  const content = textarea.value;
  if (!name) {
    alert('Enter a filename.');
    return;
  }
  if (localStorage.getItem('md_' + name) !== null && currentFileName !== name) {
    alert('A file with this name already exists. Please choose a different name.');
    return;
  }
  localStorage.setItem('md_' + name, content);
  currentFileName = name;
  updateFileList();
}

function autoSaveNote() {
  const name = filenameInput.value.trim();
  if (!name) return;
  if (localStorage.getItem('md_' + name) !== null && currentFileName !== name) {
    return;
  }
  localStorage.setItem('md_' + name, textarea.value);
  currentFileName = name;
  updateFileList();
}

function loadNote() {
  const name = filenameInput.value.trim();
  const content = localStorage.getItem('md_' + name);
  if (content === null) {
    alert('File not found.');
    return;
  }
  textarea.value = content;
  currentFileName = name;
  if (isPreview) {
    previewDiv.innerHTML = marked.parse(textarea.value);
    styleTaskListItems();
    setupPreviewTaskCheckboxes();
  }
}

function newNote() {
  textarea.value = '';
  filenameInput.value = getFormattedDate();
  if (isPreview) {
    toggleView();
  }
  clearTimeout(autoSaveTimer);
  currentFileName = null;
  updateFileList();
}

function deleteNote() {
  const name = filenameInput.value.trim();
  if (!name) {
    alert('Enter a filename.');
    return;
  }
  if (localStorage.getItem('md_' + name) === null) {
    alert('File not found.');
    return;
  }
  
  localStorage.removeItem('md_' + name);
  textarea.value = '';
  currentFileName = null;
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
  const search = searchBox.value.toLowerCase();

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const fileName = key.slice(3);
      const content = localStorage.getItem(key).toLowerCase();

      if (fileName.toLowerCase().includes(search) || content.includes(search)) {
        const li = document.createElement('li');
        li.textContent = fileName;
        li.style.cursor = 'pointer';
        li.onclick = () => {
          filenameInput.value = fileName;
          loadNote();
        };
        fileList.appendChild(li);
      }
    }
  }

  updateTodoList();
}

function updateTodoList() {
  todoList.innerHTML = '';

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      const fileName = key.slice(3);
      const lines = localStorage.getItem(key).split(/\n/);
      const todos = lines
        .map((line, idx) => ({ line, idx }))
        .filter(obj => obj.line.trim().startsWith('- [ ]'));

      if (todos.length > 0) {
        const noteLi = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = fileName;
        title.style.cursor = 'pointer';
        title.onclick = () => {
          filenameInput.value = fileName;
          loadNote();
        };
        noteLi.appendChild(title);

        const innerUl = document.createElement('ul');
        todos.forEach(t => {
          const todoLi = document.createElement('li');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          const text = t.line.trim().replace(/^- \[ \]/, '').trim();
          checkbox.addEventListener('change', () => {
            toggleTaskStatus(fileName, t.idx);
          });
          todoLi.appendChild(checkbox);
          todoLi.appendChild(document.createTextNode(' ' + text));
          innerUl.appendChild(todoLi);
        });

        noteLi.appendChild(innerUl);
        todoList.appendChild(noteLi);
      }
    }
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
        previewDiv.innerHTML = marked.parse(textarea.value);
        styleTaskListItems();
        setupPreviewTaskCheckboxes();
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
        previewDiv.innerHTML = marked.parse(textarea.value);
        styleTaskListItems();
        setupPreviewTaskCheckboxes();
      }
    }
  }
  updateTodoList();
}

function filterNotes() {
  updateFileList();
}

saveStorageBtn.addEventListener('click', saveNote);
loadStorageBtn.addEventListener('click', loadNote);
newNoteBtn.addEventListener('click', newNote);
downloadAllBtn.addEventListener('click', downloadAllNotes);
deleteBtn.addEventListener('click', deleteNote);
deleteAllBtn.addEventListener('click', deleteAllNotes);
importZipBtn.addEventListener('click', () => importZipInput.click());
importZipInput.addEventListener('change', e => {
  if (e.target.files.length > 0) {
    importNotesFromZip(e.target.files[0]);
  }
});
searchBox.addEventListener('input', filterNotes);
textarea.addEventListener('input', () => {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(autoSaveNote, 1000);
});

updateFileList();
