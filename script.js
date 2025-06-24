const toggleBtn = document.getElementById('toggle-theme');
const saveBtn = document.getElementById('save-text');
const textarea = document.querySelector('textarea');

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

// Save markdown file using the provided filename
saveBtn.addEventListener('click', () => {
  const text = textarea.value;
  const filename = filenameInput.value.trim() || 'untitled';
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.md`;
  a.click();

  URL.revokeObjectURL(url);
});
