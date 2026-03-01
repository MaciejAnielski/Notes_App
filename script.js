// Disable indented code blocks so indented text renders as normal paragraphs.
// Fenced code blocks (``` ... ```) still work correctly.
marked.use({
  breaks: true,
  tokenizer: {
    code(src) {
      // Suppress the indented code block rule entirely
      const indentedCode = /^(?:(?:    |\t)[^\n]+(?:\n|$))+/;
      if (indentedCode.test(src)) return undefined;
    }
  }
});

const textarea = document.getElementById('editor');
const previewDiv = document.getElementById('preview');
const toggleViewBtn = document.getElementById('toggle-view');
let isPreview = false;
let autoSaveTimer = null;
let currentFileName = null;
let linkedNoteChain = [];

const PROJECTS_NOTE = 'Projects';
const SEASON_ORDER = ['Winter', 'Spring', 'Summer', 'Autumn'];
let projectsViewActive = false;
const SCHEDULE_RE = /\s*>\s*\d{6}\s+\d{4}\s+\d{4}\s*$/;

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
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function saveChain() {
  localStorage.setItem('linked_chain', JSON.stringify(linkedNoteChain));
}

function handleRenameAfterReplace(noteName, newContent) {
  const firstLine = newContent.split(/\n/)[0].trim();
  if (!firstLine.startsWith('#')) return;
  const newTitle = firstLine.replace(/^#+\s*/, '').trim();
  if (!newTitle || newTitle === noteName) return;
  if (localStorage.getItem('md_' + newTitle) !== null) return;
  localStorage.removeItem('md_' + noteName);
  localStorage.setItem('md_' + newTitle, newContent);
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

function getSeason(mm) {
  const m = parseInt(mm, 10);
  if (m === 12 || m <= 2) return 'Winter';
  if (m <= 5)             return 'Spring';
  if (m <= 8)             return 'Summer';
  return 'Autumn';
}

function generateProjectsNoteContent() {
  const grouped = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('md_')) continue;
    const name = key.slice(3);
    if (name === PROJECTS_NOTE) continue;
    const match = name.match(/^(\d{2})(\d{2})\d{2} Project .+$/);
    if (!match) continue;
    const yy = match[1], mm = match[2], season = getSeason(mm);
    if (!grouped[yy]) grouped[yy] = {};
    if (!grouped[yy][season]) grouped[yy][season] = [];
    grouped[yy][season].push(name);
  }
  for (const yy of Object.keys(grouped))
    for (const s of Object.keys(grouped[yy]))
      grouped[yy][s].sort();

  const years = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const lines = ['# Projects', ''];
  if (years.length === 0) {
    lines.push('*No project notes found. Create a note titled `YYMMDD Project Name`.*', '');
  } else {
    for (const yy of years) {
      lines.push(`## 20${yy}`, '');
      for (const season of SEASON_ORDER) {
        const notes = grouped[yy][season];
        if (!notes || !notes.length) continue;
        lines.push(`### ${season}`, '');
        for (const name of notes) lines.push(`- [[${name}]]`);
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function refreshProjectsNote() {
  const newContent = generateProjectsNoteContent();
  if (localStorage.getItem('md_' + PROJECTS_NOTE) === newContent) return;
  localStorage.setItem('md_' + PROJECTS_NOTE, newContent);
  if (currentFileName === PROJECTS_NOTE) {
    textarea.value = newContent;
    renderPreview();
  }
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

// Pre-process markdown before passing to marked:
//   1. Convert [[Note Name]] wiki-links to standard markdown links
//   2. Preserve tab indentation as CSS padding in the rendered preview
//   3. Convert [^id] footnote references and [^id]: definitions to HTML
function preprocessMarkdown(text) {
  // ── Wiki links ──
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const display = inner.replace(/_/g, ' ').trim();
    const href = encodeURIComponent(inner.trim());
    return `[${display}](${href})`;
  });

  // ── Strip schedule syntax (> YYMMDD HHMM HHMM) from end of lines ──
  text = text.replace(/\s*>\s*\d{6}\s+\d{4}\s+\d{4}\s*$/gm, '');

  // ── Indentation: convert leading tabs into padded HTML blocks ──
  // Fenced code blocks, list items (- / * / + / 1.), blockquotes (>), and
  // headings (#) are left for marked to handle natively even when indented.
  // Only plain prose lines with leading tabs are converted to <p> blocks
  // with matching padding-left so indentation is preserved in the preview.
  //
  // Tab-indented list runs that start a new top-level list are wrapped in a
  // <div style="padding-left:Nem"> so the visual indent is preserved.
  // Marked parses markdown inside a <div> block when surrounded by blank lines.
  // Items that follow a non-tab list line (e.g. `1. Ordered \n\t- sub`) keep
  // their full 4-space depth so they nest as sub-items of the parent list.
  {
    const lines = text.split('\n');
    const out = [];
    let inFence = false;
    // pendingList accumulates lines for a tab-indented top-level list run
    // before we know whether it needs a wrapping <div>.
    let pendingList = null; // { baseDepth, lines[] } | null
    let prevWasListItem = false;

    const flushPendingList = () => {
      if (!pendingList) return;
      const { baseDepth, listLines } = pendingList;
      const padEm = baseDepth * 2;
      out.push(`<div style="padding-left:${padEm}em">`);
      out.push('');
      listLines.forEach(l => out.push(l));
      out.push('');
      out.push('</div>');
      out.push('');
      pendingList = null;
    };

    for (const line of lines) {
      // Track fenced code blocks (``` or ~~~)
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
        flushPendingList();
        inFence = !inFence;
        out.push(line);
        prevWasListItem = false;
        continue;
      }
      if (inFence) {
        out.push(line);
        continue;
      }

      // Blank lines end the current list run
      if (line.trim() === '') {
        flushPendingList();
        out.push(line);
        prevWasListItem = false;
        continue;
      }

      // Count leading tabs on this line
      const tabMatch = line.match(/^(\t+)(.*)/);
      if (tabMatch) {
        const depth = tabMatch[1].length;
        const content = tabMatch[2];
        const trimmed = content.trimStart();
        const isListItem = /^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed);
        const isBlockquote = trimmed.startsWith('>');
        const isHeading = trimmed.startsWith('#');

        if (isListItem) {
          if (!prevWasListItem) {
            // First item of a brand-new top-level list — start a pending run
            flushPendingList();
            pendingList = { baseDepth: depth, listLines: [] };
          }

          if (pendingList) {
            // Accumulate into the pending indented list run, stripping base tabs
            const relativeDepth = depth - pendingList.baseDepth;
            pendingList.listLines.push('    '.repeat(Math.max(0, relativeDepth)) + content);
          } else {
            // Sub-item of a non-tab parent list: keep full 4-space depth
            out.push('    '.repeat(depth) + content);
          }
          prevWasListItem = true;
        } else if (isBlockquote || isHeading) {
          flushPendingList();
          out.push('    '.repeat(depth) + content);
          prevWasListItem = false;
        } else {
          // Plain prose: convert to padded HTML block
          flushPendingList();
          const rendered = marked.parseInline(content);
          // Blank line after HTML block so marked ends it cleanly before
          // whatever follows (lists, paragraphs, etc.)
          out.push(`<p style="padding-left:${depth * 2}em;margin:0.2em 0">${rendered}</p>`);
          out.push('');
          prevWasListItem = false;
        }
      } else {
        // Non-tab-indented line — flush any pending list, then emit as-is.
        // Preserve prevWasListItem so a following tab-indented item knows
        // whether it's continuing a parent list or starting a new one.
        flushPendingList();
        const trimmed = line.trimStart();
        prevWasListItem = /^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed);
        out.push(line);
      }
    }
    // Flush any remaining pending list at end of input
    flushPendingList();

    text = out.join('\n');
  }

  // ── Footnotes ──
  // Collect definitions: lines starting with [^id]: (may span indented continuations)
  const defs = {};
  // Match [^id]: text — captures the whole definition line
  text = text.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, def) => {
    defs[id] = def.trim();
    return ''; // remove definition line from body
  });

  // Only proceed if any definitions were found
  if (Object.keys(defs).length === 0) return text;

  // Replace inline [^id] references with numbered superscripts
  const order = []; // track encounter order for numbering
  text = text.replace(/\[\^([^\]]+)\]/g, (_, id) => {
    if (!order.includes(id)) order.push(id);
    const n = order.indexOf(id) + 1;
    return `<sup><a id="fnref-${id}" href="#fn-${id}" class="footnote-ref">${n}</a></sup>`;
  });

  // Build footnotes section HTML — parse inline markdown so links, bold,
  // italic, LaTeX etc. all render correctly inside footnote definitions
  const items = order.map((id, i) => {
    const n = i + 1;
    const defText = marked.parseInline(defs[id] || '');
    return `<li id="fn-${id}">${n}. ${defText} <a href="#fnref-${id}" class="footnote-back">↩</a></li>`;
  }).join('\n');

  text += `\n\n<hr class="footnote-hr">\n<ol class="footnotes">\n${items}\n</ol>`;

  return text;
}

function setupNoteLinks(container = previewDiv) {
  container.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^[a-zA-Z]+:/.test(href)) {
      return;
    }
    const noteName = decodeURIComponent(href).replace(/_/g, ' ').trim();
    const exists = localStorage.getItem('md_' + noteName) !== null;

    a.href = '#';

    // Style links to non-existent notes differently
    if (!exists) {
      a.classList.add('internal-link-new');
      a.title = `Create note "${noteName}"`;
    }

    a.addEventListener('click', e => {
      e.preventDefault();
      if (localStorage.getItem('md_' + noteName) !== null) {
        // Note exists — navigate into it
        if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
          linkedNoteChain.unshift(currentFileName);
          saveChain();
        }
        loadNote(noteName, true);
      } else {
        // Note doesn't exist — create it and navigate to it
        if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
          linkedNoteChain.unshift(currentFileName);
          saveChain();
        }
        const newContent = `# ${noteName}\n\n`;
        localStorage.setItem('md_' + noteName, newContent);
        loadNote(noteName, true);
        updateStatus(`Created Note "${noteName}".`, true);
      }
    });
  });
}

function setupCollapsibleHeadings(container) {
  const headingTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const headingLevel = el => parseInt(el.tagName[1]);

  // Return the heading level of a node, accounting for the fact that earlier
  // iterations (bottom-up) may have already wrapped headings in <details>.
  function nodeHeadingLevel(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (headingTags.has(node.tagName)) return headingLevel(node);
    if (node.tagName === 'DETAILS') {
      const h = node.querySelector('summary > h1, summary > h2, summary > h3, summary > h4, summary > h5, summary > h6');
      return h ? headingLevel(h) : null;
    }
    return null;
  }

  // Work bottom-up so inner headings are wrapped before outer ones
  const headings = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].reverse();

  headings.forEach(heading => {
    const level = headingLevel(heading);
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');

    // Move heading's content into summary, keep heading tag for styling
    summary.appendChild(heading.cloneNode(true));
    details.appendChild(summary);

    // Collect following siblings until a heading of the same or higher level.
    // Use nodeHeadingLevel so already-wrapped <details> siblings are detected.
    const siblings = [];
    let next = heading.nextSibling;
    while (next) {
      const after = next.nextSibling;
      const sibLevel = nodeHeadingLevel(next);
      if (sibLevel !== null && sibLevel <= level) break;
      siblings.push(next);
      next = after;
    }
    siblings.forEach(s => details.appendChild(s));

    heading.replaceWith(details);
  });
}

function alignTableColumns(container) {
  container.querySelectorAll('table').forEach(table => {
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    if (bodyRows.length === 0) return;

    const firstRow = bodyRows[0];
    const firstCells = Array.from(firstRow.querySelectorAll('td'));

    firstCells.forEach((cell, colIndex) => {
      const text = cell.textContent.trim();
      const cleaned = text.replace(/[,$€£¥%+ ]/g, '');
      const numeric = cleaned !== '' && !isNaN(Number(cleaned));
      const align = numeric ? 'right' : 'left';

      // Align all body cells in this column
      bodyRows.forEach(row => {
        const td = row.querySelectorAll('td')[colIndex];
        if (td) td.style.textAlign = align;
      });

      // Align the header cell to match the first row's content type
      const th = table.querySelectorAll('thead tr th')[colIndex];
      if (th) th.style.textAlign = align;
    });
  });
}

function renderPreview() {
  previewDiv.innerHTML = marked.parse(preprocessMarkdown(textarea.value));
  styleTaskListItems(previewDiv);
  setupNoteLinks(previewDiv);
  setupCollapsibleHeadings(previewDiv);
  alignTableColumns(previewDiv);
  setupPreviewTaskCheckboxes();
  if (window.MathJax) {
    MathJax.typesetPromise([previewDiv]).then(() => {
      setupClickableMathFormulas();
    });
  }
}

function toggleView() {
  if (currentFileName === PROJECTS_NOTE) return;
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
  if (currentFileName === PROJECTS_NOTE) return;
  const name = getNoteTitle();
  if (!name) {
    updateStatus('File Not Saved. Please Add A Title Starting With "#".', false);
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
      updateStatus(`Opened Existing Note "${name}".`, true);
    } else {
      updateStatus(`File Not Saved. A File Named "${name}" Already Exists. Please Rename.`, false);
    }
    return;
  }

  localStorage.setItem('md_' + name, textarea.value);
  currentFileName = name;
  localStorage.setItem('current_file', name);
  updateFileList();
  updateStatus('File Saved Successfully.', true);
}

function loadNote(name, fromLink = false) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (!fromLink) {
    linkedNoteChain = [];
    saveChain();
  }
  const content = localStorage.getItem('md_' + name);
  if (content === null) {
    alert('File not found.');
    return;
  }
  textarea.value = content;
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
  if (isPreview) toggleView();
  else previewDiv.innerHTML = '';
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
  if (isPreview) toggleView();
  else previewDiv.innerHTML = '';
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
  container.innerHTML = marked.parse(preprocessMarkdown(markdown));
  styleTaskListItems(container);
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
      background-color: #1e1e1e;
      color: #e8dcf4;
      margin: 20px auto;
    }
    a { color: #9cdcfe; }
    blockquote {
      margin: 12px 0; padding: 6px 14px;
      border-left: 3px solid #a272b0;
      background-color: #262030; color: #b8a8cc;
      border-radius: 0 4px 4px 0;
    }
    blockquote p { margin: 0; }
    p { margin: 0.5em 0; }
    ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
    li > ul, li > ol { margin: 0; }
    li { margin: 0.15em 0; }
    ul { list-style-type: disc; }
    ul ul { list-style-type: circle; }
    ul ul ul { list-style-type: square; }
    li p:first-child:last-child { margin: 0; }
    li.task-item + li.bullet-item,
    li.bullet-item + li.task-item { margin-top: 8px; }
    .footnote-ref { color: #a272b0; text-decoration: none; font-size: 0.75em; vertical-align: super; }
    .footnote-hr { border: none; border-top: 1px solid #333; margin: 24px 0 12px; }
    .footnotes { list-style: none; padding: 0; font-size: 0.85em; color: #9a8aaa; }
    .footnote-back { color: #6b4e7a; text-decoration: none; margin-left: 4px; }
    table { border-collapse: collapse; margin: 0.75em 0; }
    th, td { border: 1px solid #444; padding: 6px 12px; }
    thead tr { background-color: #2a2040; }
    tbody tr:nth-child(even) { background-color: #242030; }
  `;
  alignTableColumns(container);
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>${title}</title>\n<style>${style}</style>\n<script>window.MathJax = { tex: { inlineMath: [['$','$'],['\\\\(','\\\\)']], displayMath: [['$$','$$'],['\\\\[','\\\\]']] } };</script>\n<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>\n</head>\n<body>\n${container.innerHTML}\n</body>\n</html>`;
}

function noteNameToId(name) {
  return 'note-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generateNotebookHtml(noteEntries) {
  const noteNameSet = new Set(noteEntries.map(e => e.name));

  const tocItems = noteEntries.map(({ name }) =>
    `<li><a href="#${noteNameToId(name)}">${name}</a></li>`
  ).join('\n      ');

  const sections = noteEntries.map(({ name, content }) => {
    const container = document.createElement('div');
    container.innerHTML = marked.parse(preprocessMarkdown(content));
    styleTaskListItems(container);
    container.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || /^[a-zA-Z]+:/.test(href)) return;
      const noteName = decodeURIComponent(href).replace(/_/g, ' ').trim();
      if (noteNameSet.has(noteName)) {
        a.setAttribute('href', '#' + noteNameToId(noteName));
      }
    });
    alignTableColumns(container);
    return `<article id="${noteNameToId(name)}">\n${container.innerHTML}\n</article>`;
  }).join('\n\n');

  const style = `
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; display: flex; height: 100vh; font-family: Arial, sans-serif; font-size: 16px; background-color: #1e1e1e; color: #e8dcf4; }
    #toc { width: 220px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; border-right: 1px solid #333; padding: 20px 12px; background-color: #1a1a1a; scrollbar-width: none; }
    #toc::-webkit-scrollbar { display: none; }
    #toc h3 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b4e7a; }
    #toc ul { list-style: none; margin: 0; padding: 0; }
    #toc a { display: block; padding: 4px 6px; border-radius: 3px; color: #9a7aaa; text-decoration: none; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #toc a:hover { color: #e8dcf4; background-color: #2e2e2e; }
    main { flex: 1; overflow-y: auto; padding: 40px; scrollbar-width: none; }
    main::-webkit-scrollbar { display: none; }
    article { max-width: 800px; margin: 0 auto 60px; }
    article + article { border-top: 1px solid #333; padding-top: 40px; }
    a { color: #9cdcfe; }
    blockquote { margin: 12px 0; padding: 6px 14px; border-left: 3px solid #a272b0; background-color: #262030; color: #b8a8cc; border-radius: 0 4px 4px 0; }
    blockquote p { margin: 0; }
    p { margin: 0.5em 0; }
    ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
    li > ul, li > ol { margin: 0; }
    li { margin: 0.15em 0; }
    ul { list-style-type: disc; }
    ul ul { list-style-type: circle; }
    ul ul ul { list-style-type: square; }
    li p:first-child:last-child { margin: 0; }
    li.task-item + li.bullet-item, li.bullet-item + li.task-item { margin-top: 8px; }
    .footnote-ref { color: #a272b0; text-decoration: none; font-size: 0.75em; vertical-align: super; }
    .footnote-hr { border: none; border-top: 1px solid #333; margin: 24px 0 12px; }
    .footnotes { list-style: none; padding: 0; font-size: 0.85em; color: #9a8aaa; }
    .footnote-back { color: #6b4e7a; text-decoration: none; margin-left: 4px; }
    table { border-collapse: collapse; margin: 0.75em 0; }
    th, td { border: 1px solid #444; padding: 6px 12px; }
    thead tr { background-color: #2a2040; }
    tbody tr:nth-child(even) { background-color: #242030; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Notes Notebook</title>
<style>${style}</style>
<script>window.MathJax = { tex: { inlineMath: [['$','$'],['\\\\(','\\\\)']], displayMath: [['$$','$$'],['\\\\[','\\\\]']] } };</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
</head>
<body>
<nav id="toc">
  <h3>Contents</h3>
  <ul>
      ${tocItems}
  </ul>
</nav>
<main>
${sections}
</main>
</body>
</html>`;
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
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('md_')) {
      entries.push({ name: key.slice(3), content: localStorage.getItem(key) });
    }
  }
  if (entries.length === 0) { alert('No notes found.'); return; }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const html = generateNotebookHtml(entries);
  const blob = new Blob([html], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'notes_notebook.html';
  link.click();
  URL.revokeObjectURL(link.href);
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
  if (notes.length === 0) { alert('No notes match the filter.'); return; }
  const entries = notes
    .map(name => ({ name, content: localStorage.getItem('md_' + name) }))
    .filter(e => e.content !== null);
  const html = generateNotebookHtml(entries);
  const blob = new Blob([html], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'notes_notebook.html';
  link.click();
  URL.revokeObjectURL(link.href);
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
  refreshProjectsNote();
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
          todoLi.appendChild(span);

          const schedDateMatch = t.line.match(/>\s*(\d{6})\s+\d{4}\s+\d{4}\s*$/);
          const dot = document.createElement('span');
          dot.className = 'task-status-dot';
          if (schedDateMatch) {
            const todayStr = toYYMMDD(new Date());
            const taskDateStr = schedDateMatch[1];
            if (taskDateStr < todayStr) {
              dot.classList.add('dot-overdue');
            } else if (taskDateStr === todayStr) {
              dot.classList.add('dot-today');
            } else {
              dot.classList.add('dot-future');
            }
          } else {
            dot.classList.add('dot-unscheduled');
          }
          todoLi.appendChild(dot);

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

function formatScheduleDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function toYYMMDD(d) {
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

function getScheduleItems(dateStr) {
  const items = [];
  const re = />\s*(\d{6})\s+(\d{4})\s+(\d{4})\s*$/;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('md_')) continue;
    const fileName = key.slice(3);
    const content = localStorage.getItem(key);
    content.split(/\n/).forEach((line, idx) => {
      const m = line.match(re);
      if (!m || m[1] !== dateStr) return;
      const trimmed = line.trim();
      const isTask = /^- \[[ xX]\]/.test(trimmed);
      const isCompleted = /^- \[[xX]\]/.test(trimmed);
      let text = trimmed.replace(re, '');
      if (isTask) text = text.replace(/^- \[[ xX]\]\s*/, '');
      items.push({ fileName, lineIndex: idx, text: text.trim(), startTime: m[2], endTime: m[3], isTask, isCompleted });
    });
  }
  items.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return items;
}

// Strip all markdown formatting from a text string for plain-text display.
// Handles wiki-links, markdown links, bullets, ordered lists, bold/italic,
// inline code, and removes stray square-bracket characters.
function stripMarkdownText(text) {
  // Strip wiki-links [[text]] → text
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // Strip bullet / ordered-list markers at line start
  text = text.replace(/^\s*[-*+]\s+/, '');
  text = text.replace(/^\s*\d+[.)]\s+/, '');
  // Use marked + textContent to strip remaining markdown (links, bold, italic, code…)
  const tmp = document.createElement('span');
  tmp.innerHTML = marked.parseInline(text);
  text = tmp.textContent;
  // Strip any remaining stray square brackets
  text = text.replace(/[[\]]/g, '');
  return text.trim();
}

function renderSchedule() {
  if (!scheduleGrid) return;
  scheduleGrid.innerHTML = '';
  scheduleDateLabel.textContent = formatScheduleDate(scheduleDate);

  const dateStr = toYYMMDD(scheduleDate);
  const items = getScheduleItems(dateStr);

  const ROW_H = 40;
  const START_H = 7;
  const END_H = 19;
  const SLOTS = (END_H - START_H) * 2; // 24 half-hour slots

  scheduleGrid.style.height = (SLOTS * ROW_H) + 'px';

  // Gridlines + time labels
  for (let s = 0; s <= SLOTS; s++) {
    const hour = START_H + Math.floor(s / 2);
    const min = (s % 2) * 30;
    const top = s * ROW_H;

    const gl = document.createElement('div');
    gl.className = 'schedule-gridline' + (min === 0 ? ' schedule-gridline-hour' : '');
    gl.style.top = top + 'px';
    scheduleGrid.appendChild(gl);

    if (min === 0) {
      const lbl = document.createElement('div');
      lbl.className = 'schedule-time-label';
      lbl.textContent = (hour % 12 || 12) + (hour < 12 ? ' AM' : ' PM');
      lbl.style.top = top + 'px';
      scheduleGrid.appendChild(lbl);
    }
  }

  // Place items
  const gridStart = START_H * 60;
  items.forEach(item => {
    const startMin = parseInt(item.startTime.slice(0, 2)) * 60 + parseInt(item.startTime.slice(2));
    const endMin   = parseInt(item.endTime.slice(0, 2))   * 60 + parseInt(item.endTime.slice(2));
    const clampedStart = Math.max(startMin, gridStart);
    const clampedEnd   = Math.min(endMin, END_H * 60);
    if (clampedStart >= clampedEnd) return;

    const top    = ((clampedStart - gridStart) / 30) * ROW_H + 2;
    const height = Math.max(((clampedEnd - clampedStart) / 30) * ROW_H - 4, ROW_H / 2 - 4);

    const block = document.createElement('div');
    block.className = 'schedule-item' + (item.isCompleted ? ' completed' : '');
    block.style.top    = top + 'px';
    block.style.height = height + 'px';

    if (item.isTask) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.isCompleted;
      cb.addEventListener('change', () => toggleScheduleTask(item.fileName, item.lineIndex, cb.checked));
      block.appendChild(cb);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'schedule-item-name';
    nameSpan.textContent = stripMarkdownText(item.text);
    nameSpan.addEventListener('click', () => loadNote(item.fileName));
    block.appendChild(nameSpan);

    scheduleGrid.appendChild(block);
  });
}

function toggleScheduleTask(fileName, lineIndex, checked) {
  const key = 'md_' + fileName;
  const content = localStorage.getItem(key);
  if (!content) return;
  const lines = content.split(/\n/);
  if (lineIndex >= 0 && lineIndex < lines.length) {
    lines[lineIndex] = lines[lineIndex].replace(/- \[[ xX]\]/, checked ? '- [x]' : '- [ ]');
    localStorage.setItem(key, lines.join('\n'));
    if (currentFileName === fileName) {
      textarea.value = lines.join('\n');
      if (isPreview || projectsViewActive) renderPreview();
    }
  }
  updateTodoList(); // also calls renderSchedule() at its end
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
searchBox.addEventListener('input', updateFileList);
searchTasksBox.addEventListener('input', updateTodoList);
textarea.addEventListener('input', () => {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(autoSaveNote, 1000);
});

const panelLists = document.getElementById('panel-lists');
const panelArrow = document.getElementById('panel-arrow');
const panelPin   = document.getElementById('panel-pin');
const filesContainer = document.getElementById('files-container');
const todosContainer = document.getElementById('todo-container');
const scheduleContainer = document.getElementById('schedule-container');
const scheduleGrid = document.getElementById('scheduleGrid');
const scheduleDateLabel = document.getElementById('schedule-date-label');
const schedulePrevBtn = document.getElementById('schedule-prev');
const scheduleNextBtn = document.getElementById('schedule-next');
let scheduleDate = new Date();
let peekHideTimer = null;
let isPanelPinned = localStorage.getItem('panel_pinned') === 'true';

function applyPinState() {
  if (isPanelPinned) {
    panelLists.classList.add('pinned', 'visible');
    panelPin.classList.add('active');
    document.body.classList.add('panel-pinned');
  } else {
    panelLists.classList.remove('pinned', 'visible');
    panelPin.classList.remove('active');
    document.body.classList.remove('panel-pinned');
  }
}

panelPin.addEventListener('click', () => {
  isPanelPinned = !isPanelPinned;
  localStorage.setItem('panel_pinned', isPanelPinned);
  applyPinState();
});

// Arrow click cycles: Notes → Tasks → Schedule → Notes
panelArrow.addEventListener('click', () => {
  if (filesContainer.classList.contains('active')) {
    filesContainer.classList.remove('active');
    todosContainer.classList.add('active');
    localStorage.setItem('active_panel', 'tasks');
  } else if (todosContainer.classList.contains('active')) {
    todosContainer.classList.remove('active');
    scheduleContainer.classList.add('active');
    localStorage.setItem('active_panel', 'schedule');
  } else {
    scheduleContainer.classList.remove('active');
    filesContainer.classList.add('active');
    localStorage.setItem('active_panel', 'files');
  }
});

schedulePrevBtn.addEventListener('click', () => {
  scheduleDate.setDate(scheduleDate.getDate() - 1);
  renderSchedule();
});
scheduleNextBtn.addEventListener('click', () => {
  scheduleDate.setDate(scheduleDate.getDate() + 1);
  renderSchedule();
});
scheduleDateLabel.addEventListener('click', () => {
  scheduleDate = new Date();
  renderSchedule();
});

// Hover on arrow or lists panel shows the overlay (skipped when pinned)
function showPanel() {
  if (isPanelPinned) return;
  clearTimeout(peekHideTimer);
  panelLists.classList.add('visible');
}

function scheduleHidePanel() {
  if (isPanelPinned) return;
  clearTimeout(peekHideTimer);
  peekHideTimer = setTimeout(() => panelLists.classList.remove('visible'), 100);
}

panelArrow.addEventListener('mouseenter', showPanel);
panelArrow.addEventListener('mouseleave', scheduleHidePanel);
panelLists.addEventListener('mouseenter', showPanel);
panelLists.addEventListener('mouseleave', scheduleHidePanel);

applyPinState();

// Restore the last active panel (Notes / Tasks / Schedule)
{
  const savedPanel = localStorage.getItem('active_panel');
  if (savedPanel === 'tasks') {
    filesContainer.classList.remove('active');
    todosContainer.classList.add('active');
  } else if (savedPanel === 'schedule') {
    filesContainer.classList.remove('active');
    scheduleContainer.classList.add('active');
  }
  // default ('files' or null) keeps the HTML default (#files-container.active)
}

textarea.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + '\t' + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
  }
});

// ── Global Search & Replace ──────────────────────────────────────────────

const globalSearchPanel = document.getElementById('global-search-panel');
const gsSearchInput     = document.getElementById('gs-search-input');
const gsReplaceInput    = document.getElementById('gs-replace-input');
const gsCaseCheckbox    = document.getElementById('gs-case-checkbox');
const gsFindBtn         = document.getElementById('gs-find-btn');
const gsReplaceBtn      = document.getElementById('gs-replace-btn');
const gsReplaceAllBtn   = document.getElementById('gs-replace-all-btn');
const gsCloseBtn        = document.getElementById('gs-close');
const gsStatus          = document.getElementById('gs-status');
const gsResults         = document.getElementById('gs-results');

let gsCurrentResults = [];
let gsSelectedIndex  = -1;

function openGlobalSearch() {
  globalSearchPanel.classList.remove('gs-hidden');
  gsSearchInput.focus();
  gsSearchInput.select();
}

function closeGlobalSearch() {
  globalSearchPanel.classList.add('gs-hidden');
}

function gsGetAllMatches(query, caseSensitive) {
  const results = [];
  if (!query) return results;
  const needle  = caseSensitive ? query : query.toLowerCase();
  const CONTEXT = 55;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('md_')) continue;
    const noteName   = key.slice(3);
    const rawContent = localStorage.getItem(key);
    const haystack   = caseSensitive ? rawContent : rawContent.toLowerCase();

    let pos = 0;
    while (true) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;
      const start  = Math.max(0, idx - CONTEXT);
      const end    = Math.min(rawContent.length, idx + needle.length + CONTEXT);
      const prefix = (start > 0 ? '\u2026' : '') + rawContent.slice(start, idx);
      const match  = rawContent.slice(idx, idx + query.length);
      const suffix = rawContent.slice(idx + query.length, end) + (end < rawContent.length ? '\u2026' : '');
      results.push({ noteName, matchIndex: idx, prefix, match, suffix });
      pos = idx + needle.length;
    }
  }
  return results;
}

function gsSetStatus(text, ok) {
  gsStatus.textContent = text;
  gsStatus.style.color = ok === false ? '#c07070' : ok === true ? '#70c070' : '#9a8aaa';
}

function gsRenderResults(results, query) {
  gsResults.innerHTML = '';
  gsSelectedIndex = -1;

  if (results.length === 0) {
    gsSetStatus(query ? 'No matches found.' : '', query ? false : null);
    return;
  }

  const noteCount = new Set(results.map(r => r.noteName)).size;
  gsSetStatus(
    `${results.length} match${results.length === 1 ? '' : 'es'} across ` +
    `${noteCount} note${noteCount === 1 ? '' : 's'}.`,
    null
  );

  results.forEach((r, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'gs-note-name';
    nameSpan.textContent = r.noteName;

    const snippetSpan = document.createElement('span');
    snippetSpan.className = 'gs-snippet';
    snippetSpan.appendChild(document.createTextNode(r.prefix));
    const mark = document.createElement('mark');
    mark.textContent = r.match;
    snippetSpan.appendChild(mark);
    snippetSpan.appendChild(document.createTextNode(r.suffix));

    li.appendChild(nameSpan);
    li.appendChild(snippetSpan);

    li.addEventListener('click', () => gsSelectResult(i));
    gsResults.appendChild(li);
  });
}

function gsSelectResult(index) {
  if (gsSelectedIndex >= 0) {
    const prev = gsResults.querySelector(`[data-index="${gsSelectedIndex}"]`);
    if (prev) prev.classList.remove('gs-active');
  }
  gsSelectedIndex = index;
  const item = gsResults.querySelector(`[data-index="${index}"]`);
  if (item) {
    item.classList.add('gs-active');
    item.scrollIntoView({ block: 'nearest' });
  }

  const result = gsCurrentResults[index];
  if (!result) return;

  // Flush any unsaved edits before navigating
  if (currentFileName) {
    localStorage.setItem('md_' + currentFileName, textarea.value);
  }

  loadNote(result.noteName);

  // Select the match in the textarea after load
  setTimeout(() => {
    const query  = gsSearchInput.value;
    const caseSensitive = gsCaseCheckbox.checked;
    const content = textarea.value;
    const hay   = caseSensitive ? content : content.toLowerCase();
    const ndl   = caseSensitive ? query : query.toLowerCase();
    const idx   = hay.indexOf(ndl);
    if (idx !== -1) {
      textarea.setSelectionRange(idx, idx + query.length);
      textarea.focus();
    }
  }, 50);
}

// Ctrl+F intercept
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape' && !globalSearchPanel.classList.contains('gs-hidden')) {
    closeGlobalSearch();
  }
});

gsCloseBtn.addEventListener('click', closeGlobalSearch);

function gsRunFind() {
  const query = gsSearchInput.value;
  if (!query) { gsSetStatus('Enter a search term.', false); return; }
  gsCurrentResults = gsGetAllMatches(query, gsCaseCheckbox.checked);
  gsRenderResults(gsCurrentResults, query);
}

gsFindBtn.addEventListener('click', gsRunFind);

gsSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') gsRunFind();
});

// Debounced live search
let gsDebounce = null;
gsSearchInput.addEventListener('input', () => {
  clearTimeout(gsDebounce);
  gsDebounce = setTimeout(() => {
    if (gsSearchInput.value) {
      gsRunFind();
    } else {
      gsResults.innerHTML = '';
      gsStatus.textContent = '';
      gsCurrentResults = [];
    }
  }, 300);
});

gsCaseCheckbox.addEventListener('change', () => {
  if (gsSearchInput.value) gsRunFind();
});

// Replace in the currently selected note (first occurrence)
gsReplaceBtn.addEventListener('click', () => {
  if (gsSelectedIndex < 0) {
    gsSetStatus('Select a result first.', false);
    return;
  }
  const query   = gsSearchInput.value;
  const replacement = gsReplaceInput.value;
  const caseSensitive = gsCaseCheckbox.checked;
  if (!query) return;

  const result  = gsCurrentResults[gsSelectedIndex];
  let content   = localStorage.getItem('md_' + result.noteName);
  if (content === null) { gsSetStatus(`Note not found.`, false); return; }

  const hay = caseSensitive ? content : content.toLowerCase();
  const ndl = caseSensitive ? query : query.toLowerCase();
  const idx = hay.indexOf(ndl);
  if (idx === -1) { gsSetStatus('Match no longer found (content changed).', false); return; }

  content = content.slice(0, idx) + replacement + content.slice(idx + query.length);
  localStorage.setItem('md_' + result.noteName, content);
  if (currentFileName === result.noteName) {
    textarea.value = content;
    if (isPreview) renderPreview();
  }

  handleRenameAfterReplace(result.noteName, content);
  updateFileList();
  gsCurrentResults = gsGetAllMatches(query, caseSensitive);
  gsRenderResults(gsCurrentResults, query);
  gsSetStatus(`Replaced 1 match in \u201c${result.noteName}\u201d.`, true);
});

// Replace all occurrences across all notes
gsReplaceAllBtn.addEventListener('click', () => {
  const query   = gsSearchInput.value;
  const replacement = gsReplaceInput.value;
  const caseSensitive = gsCaseCheckbox.checked;
  if (!query) { gsSetStatus('Enter a search term.', false); return; }

  const fresh = gsGetAllMatches(query, caseSensitive);
  if (fresh.length === 0) { gsSetStatus('No matches to replace.', false); return; }

  const affected   = [...new Set(fresh.map(r => r.noteName))];
  const totalCount = fresh.length;

  if (!confirm(
    `Replace all ${totalCount} match${totalCount === 1 ? '' : 'es'} ` +
    `across ${affected.length} note${affected.length === 1 ? '' : 's'}?`
  )) return;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags   = caseSensitive ? 'g' : 'gi';
  const regex   = new RegExp(escaped, flags);
  let totalReplaced = 0;

  affected.forEach(noteName => {
    let content = localStorage.getItem('md_' + noteName);
    if (content === null) return;
    const matches = content.match(regex);
    if (!matches) return;
    totalReplaced += matches.length;
    const newContent = content.replace(regex, replacement);
    localStorage.setItem('md_' + noteName, newContent);
    if (currentFileName === noteName) {
      textarea.value = newContent;
      if (isPreview) renderPreview();
    }
    handleRenameAfterReplace(noteName, newContent);
  });

  updateFileList();
  gsCurrentResults = gsGetAllMatches(query, caseSensitive);
  gsRenderResults(gsCurrentResults, query);
  gsSetStatus(
    `Replaced ${totalReplaced} match${totalReplaced === 1 ? '' : 'es'} ` +
    `across ${affected.length} note${affected.length === 1 ? '' : 's'}.`,
    true
  );
});

// Arrow-key navigation through results
globalSearchPanel.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.min(gsSelectedIndex + 1, gsCurrentResults.length - 1);
    if (next >= 0) gsSelectResult(next);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = Math.max(gsSelectedIndex - 1, 0);
    if (gsCurrentResults.length > 0) gsSelectResult(prev);
  }
});

// ── End Global Search & Replace ──────────────────────────────────────────

// ── Clickable Math Formula Evaluation ────────────────────────────────────
//
// Formulas ending with "=" in preview mode become clickable. On click the
// code resolves variable dependencies across all inline ($…$) and block
// ($$…$$) formulas in the note, then evaluates the expression and shows
// the result (≤ 10 significant figures) or "?" when unsolvable.

// Extract every math expression from raw markdown, in document order.
// Returns [{ tex, type, index }, …]
function extractAllMathExpressions(markdown) {
  const exprs = [];
  let i = 0;
  while (i < markdown.length) {
    if (markdown[i] === '\\') { i += 2; continue; } // skip escaped char
    if (markdown[i] !== '$') { i++; continue; }
    if (markdown.slice(i, i + 2) === '$$') {
      // Block math: $$…$$
      const start = i + 2;
      const end = markdown.indexOf('$$', start);
      if (end === -1) { i++; continue; }
      exprs.push({ tex: markdown.slice(start, end).trim(), type: 'block', index: i });
      i = end + 2;
    } else {
      // Inline math: $…$
      const start = i + 1;
      let j = start;
      while (j < markdown.length) {
        if (markdown[j] === '\\') { j += 2; continue; }
        if (markdown[j] === '$') break;
        j++;
      }
      if (j >= markdown.length) { i++; continue; }
      exprs.push({ tex: markdown.slice(start, j).trim(), type: 'inline', index: i });
      i = j + 1;
    }
  }
  return exprs;
}

// Parse a brace-delimited group starting at str[startIdx] (must be '{').
// Returns { content, endIdx } where endIdx is the index after the closing '}'.
function parseBraceGroup(str, startIdx) {
  let depth = 1;
  let i = startIdx + 1;
  while (i < str.length && depth > 0) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') depth--;
    i++;
  }
  return { content: str.slice(startIdx + 1, i - 1), endIdx: i };
}

// Expand all \frac{num}{den} occurrences to ((num)/(den)), handling nesting.
function expandLatexFrac(expr) {
  let result = expr;
  for (let iter = 0; iter < 50; iter++) {
    const idx = result.indexOf('\\frac');
    if (idx === -1) break;
    let i = idx + 5;
    while (i < result.length && result[i] === ' ') i++;
    if (result[i] !== '{') break;
    const { content: num, endIdx: numEnd } = parseBraceGroup(result, i);
    let j = numEnd;
    while (j < result.length && result[j] === ' ') j++;
    if (result[j] !== '{') break;
    const { content: den, endIdx: denEnd } = parseBraceGroup(result, j);
    result = result.slice(0, idx) + `((${num})/(${den}))` + result.slice(denEnd);
  }
  return result;
}

// Expand \sqrt[n]{x} and \sqrt{x} to their JS equivalents, handling nesting.
function expandLatexSqrt(expr) {
  let result = expr;
  for (let iter = 0; iter < 50; iter++) {
    // \sqrt[n]{…}
    const nthMatch = result.match(/\\sqrt\[([^\]]+)\]/);
    if (nthMatch) {
      let i = nthMatch.index + nthMatch[0].length;
      while (i < result.length && result[i] === ' ') i++;
      if (result[i] === '{') {
        const { content: inner, endIdx } = parseBraceGroup(result, i);
        result = result.slice(0, nthMatch.index) +
          `Math.pow((${inner}),1/(${nthMatch[1]}))` +
          result.slice(endIdx);
        continue;
      }
    }
    // \sqrt{…}
    const sqrtIdx = result.search(/\\sqrt(?!\[)/);
    if (sqrtIdx !== -1) {
      let i = sqrtIdx + 5;
      while (i < result.length && result[i] === ' ') i++;
      if (result[i] === '{') {
        const { content: inner, endIdx } = parseBraceGroup(result, i);
        result = result.slice(0, sqrtIdx) + `Math.sqrt(${inner})` + result.slice(endIdx);
        continue;
      }
    }
    break;
  }
  return result;
}

// Substitute user-defined variables into a LaTeX expression string.
// LaTeX command variables (e.g. \alpha) are replaced first; then plain
// variables are substituted character-by-character so letters inside
// LaTeX commands (e.g. the 's' in \sin) are never touched.
function substituteVarsInLatex(texExpr, varMap) {
  // Split into LaTeX-command vars (\alpha …) and plain vars (x, v_0 …)
  const latexVars = Object.entries(varMap)
    .filter(([k]) => k.startsWith('\\'))
    .sort(([a], [b]) => b.length - a.length);
  const plainVars = Object.entries(varMap)
    .filter(([k]) => !k.startsWith('\\'))
    .sort(([a], [b]) => b.length - a.length);

  let result = texExpr;

  // Replace LaTeX command variables
  for (const [varName, val] of latexVars) {
    const esc = varName.replace(/\\/g, '\\\\');
    result = result.replace(new RegExp(esc + '(?![a-zA-Z])', 'g'), `(${val})`);
  }

  if (plainVars.length === 0) return result;

  // Replace plain variables character-by-character
  let output = '';
  let i = 0;
  while (i < result.length) {
    const ch = result[i];

    // Skip entire LaTeX command (e.g. \sin, \pi) without substituting inside
    if (ch === '\\') {
      let cmd = '\\';
      i++;
      while (i < result.length && /[a-zA-Z]/.test(result[i])) cmd += result[i++];
      output += cmd;
      continue;
    }

    // Try to match a plain variable at the current position
    if (/[a-zA-Z]/.test(ch)) {
      let matched = false;
      for (const [varName, val] of plainVars) {
        if (result.slice(i, i + varName.length) !== varName) continue;
        const nextCh = result[i + varName.length] || '';
        if (varName.length === 1) {
          // Single-letter: substitute unless followed by _ (subscript of another var)
          if (nextCh !== '_') {
            output += `(${val})`;
            i += varName.length;
            matched = true;
            break;
          }
        } else {
          // Multi-letter: substitute only when not followed by alphanumeric or _
          if (!/[a-zA-Z0-9_]/.test(nextCh)) {
            output += `(${val})`;
            i += varName.length;
            matched = true;
            break;
          }
        }
      }
      if (!matched) { output += ch; i++; }
      continue;
    }

    output += ch;
    i++;
  }
  return output;
}

// Convert a LaTeX expression (with variables already substituted) to a
// JavaScript string that can be passed to new Function('return …').
function latexToJsExpr(tex) {
  let expr = tex;

  // Structural expansions (handle nested braces correctly)
  expr = expandLatexFrac(expr);
  expr = expandLatexSqrt(expr);

  // Constants
  expr = expr.replace(/\\pi\b/g, `(${Math.PI})`);
  expr = expr.replace(/\\infty\b/g, 'Infinity');

  // Inverse trig (must come before the base names)
  expr = expr.replace(/\\arcsin\b|\\asin\b/g, 'Math.asin');
  expr = expr.replace(/\\arccos\b|\\acos\b/g, 'Math.acos');
  expr = expr.replace(/\\arctan\b|\\atan\b/g, 'Math.atan');

  // Functions
  expr = expr.replace(/\\sin\b/g, 'Math.sin');
  expr = expr.replace(/\\cos\b/g, 'Math.cos');
  expr = expr.replace(/\\tan\b/g, 'Math.tan');
  expr = expr.replace(/\\ln\b/g, 'Math.log');
  expr = expr.replace(/\\log\b/g, 'Math.log10');
  expr = expr.replace(/\\exp\b/g, 'Math.exp');
  expr = expr.replace(/\\abs\b/g, 'Math.abs');
  expr = expr.replace(/\\min\b/g, 'Math.min');
  expr = expr.replace(/\\max\b/g, 'Math.max');
  expr = expr.replace(/\\floor\b/g, 'Math.floor');
  expr = expr.replace(/\\ceil\b/g, 'Math.ceil');

  // Operators
  expr = expr.replace(/\\cdot\b/g, '*');
  expr = expr.replace(/\\times\b/g, '*');
  expr = expr.replace(/\\div\b/g, '/');

  // \left and \right bracket size modifiers
  expr = expr.replace(/\\left\s*\(/g, '(');
  expr = expr.replace(/\\left\s*\[/g, '(');
  expr = expr.replace(/\\left\s*\|/g, 'Math.abs(');
  expr = expr.replace(/\\right\s*\)/g, ')');
  expr = expr.replace(/\\right\s*\]/g, ')');
  expr = expr.replace(/\\right\s*\|/g, ')');

  // Powers: x^{expr} → x**(expr);  x^n → x**n
  expr = expr.replace(/\^\{/g, '**(');
  expr = expr.replace(/\^([a-zA-Z0-9.(])/g, '**$1');

  // Remaining LaTeX braces → JS parentheses
  expr = expr.replace(/\{/g, '(').replace(/\}/g, ')');

  // Implicit multiplication
  expr = expr.replace(/(\d+\.?\d*)\s*\(/g, '$1*(');  // 2( → 2*(
  expr = expr.replace(/\)\s*\(/g, ')*(');              // )( → )*(
  expr = expr.replace(/\)\s*([a-zA-Z])/g, ')*$1');    // )x → )*x

  // Remove any remaining unknown LaTeX commands
  expr = expr.replace(/\\[a-zA-Z]+/g, 'undefined');

  return expr.trim();
}

// Attempt to evaluate a LaTeX expression with the given variable map.
// Returns a number on success, or null if not evaluatable.
function evaluateLatexExpr(texExpr, varMap) {
  try {
    const substituted = substituteVarsInLatex(texExpr, varMap);
    const jsExpr = latexToJsExpr(substituted);
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${jsExpr})`)();
    if (typeof result === 'number' && (isFinite(result) || !isFinite(result))) {
      return result;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Build a map of { variableName → numericValue } from all formulas in the note.
// Does a multi-pass resolve so variables defined in terms of other variables
// (e.g. F = ma, where m and a are defined elsewhere) are fully resolved.
function buildMathVariableMap(expressions) {
  const varMap = {};

  // Pattern for an assignment at the start of a formula:
  //   VARNAME = …
  // VARNAME may be a LaTeX command (\alpha), a subscripted form (x_1, x_{n}),
  // or a plain identifier.
  const assignRe = /^(\\?[a-zA-Z][a-zA-Z0-9]*(?:_\{[^}]+\}|_[a-zA-Z0-9])?)\s*=\s*(.+)$/;
  const numericRe = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  // First pass: simple numeric literals (x = 5, \alpha = 3.14, …)
  for (const { tex } of expressions) {
    const m = tex.match(assignRe);
    if (!m) continue;
    const rhs = m[2].trim();
    if (numericRe.test(rhs)) varMap[m[1]] = parseFloat(rhs);
  }

  // Multi-pass: resolve variables whose RHS references other variables
  for (let changed = true, iters = 0; changed && iters < 20; iters++) {
    changed = false;
    for (const { tex } of expressions) {
      const m = tex.match(assignRe);
      if (!m || m[1] in varMap) continue;
      const val = evaluateLatexExpr(m[2].trim(), varMap);
      if (val !== null) { varMap[m[1]] = val; changed = true; }
    }
  }

  return varMap;
}

// Format a numeric result to at most 10 significant figures, removing
// trailing zeros. Uses scientific notation for very large/small magnitudes.
function formatMathResult(value) {
  if (!isFinite(value)) return value > 0 ? '∞' : '-∞';
  const abs = Math.abs(value);
  const precise = parseFloat(value.toPrecision(10));
  if (abs !== 0 && (abs >= 1e10 || abs < 1e-4)) return precise.toExponential();
  return precise.toString();
}

// Attach a click handler to a rendered MathJax container. On click, the
// formula (minus the trailing "=") is evaluated and the result is displayed
// inline immediately after the container.
function makeFormulaClickable(container, texSource, varMap) {
  container.classList.add('math-evaluable');
  container.title = 'Click to evaluate';

  const isDisplay = container.getAttribute('display') === 'true';

  container.addEventListener('click', (e) => {
    e.stopPropagation();

    // Strip the trailing "=" to obtain the expression to evaluate
    const exprTex = texSource.replace(/=\s*$/, '').trim();
    const result = evaluateLatexExpr(exprTex, varMap);

    // Find or create the result element immediately after the container
    let resultEl = container.nextElementSibling;
    if (!resultEl || !resultEl.classList.contains('math-result')) {
      resultEl = document.createElement(isDisplay ? 'div' : 'span');
      resultEl.classList.add('math-result');
      if (isDisplay) resultEl.classList.add('math-result-block');
      container.after(resultEl);
    }

    if (result !== null && window.MathJax) {
      resultEl.innerHTML = `\\(${formatMathResult(result)}\\)`;
      MathJax.typesetPromise([resultEl]);
    } else {
      resultEl.textContent = result === null ? '?' : formatMathResult(result);
    }
  });
}

// Post-process the rendered preview: locate every MathJax container whose
// source formula ends with "=", build the variable map for the current note,
// and make those containers clickable.
function setupClickableMathFormulas() {
  const mathExprs = extractAllMathExpressions(textarea.value);
  if (mathExprs.length === 0) return;

  const varMap = buildMathVariableMap(mathExprs);
  const containers = Array.from(previewDiv.querySelectorAll('mjx-container'));

  containers.forEach((container, idx) => {
    // MathJax 3 stores the original TeX in the <math alttext="…"> attribute
    let texSource = container.querySelector('math')?.getAttribute('alttext') ?? '';
    // Fallback: correlate by document order if alttext is unavailable
    if (!texSource && idx < mathExprs.length) texSource = mathExprs[idx].tex;

    if (texSource.trim().endsWith('=')) {
      makeFormulaClickable(container, texSource.trim(), varMap);
    }
  });
}

// ── End Clickable Math Formula Evaluation ─────────────────────────────────

const savedChain = localStorage.getItem('linked_chain');
if (savedChain) {
  try { linkedNoteChain = JSON.parse(savedChain); } catch(e) {}
}
if (lastFile && localStorage.getItem('md_' + lastFile) !== null) {
  loadNote(lastFile, true);
} else {
  newNote();
}

if (savedPreview && !isPreview) {
  toggleView();
}
