const toggleBtn = document.getElementById('toggle-theme');
const textarea = document.getElementById('editor');

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
