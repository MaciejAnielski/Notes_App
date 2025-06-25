const toggleBtn = document.getElementById('toggle-theme');
const textarea = document.getElementById('editor');
const previewDiv = document.getElementById('preview');
const toggleViewBtn = document.getElementById('toggle-view');
let isPreview = false;

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
const downloadAllBtn = document.getElementById('download-all');
const searchBox = document.getElementById('searchBox');
const fileList = document.getElementById('fileList');

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

function toggleView() {
  if (isPreview) {
    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
    toggleViewBtn.textContent = 'Preview Markdown';
    isPreview = false;
  } else {
    previewDiv.innerHTML = marked.parse(textarea.value);
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
  localStorage.setItem('md_' + name, content);
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
}

function filterNotes() {
  updateFileList();
}

saveStorageBtn.addEventListener('click', saveNote);
loadStorageBtn.addEventListener('click', loadNote);
downloadAllBtn.addEventListener('click', downloadAllNotes);
searchBox.addEventListener('input', filterNotes);

updateFileList();
