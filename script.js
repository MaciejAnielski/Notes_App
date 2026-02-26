// Disable indented code blocks so indented text renders as normal paragraphs.
// Fenced code blocks (``` ... ```) still work correctly.
marked.use({
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
        }
        loadNote(noteName, true);
      } else {
        // Note doesn't exist — create it and navigate to it
        if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
          linkedNoteChain.unshift(currentFileName);
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

  linkedNoteChain.forEach((name, idx) => {
    if (noteMap[name]) {
      noteMap[name].classList.add('linked-file');
      noteMap[name].dataset.chainIndex = idx + 1;
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
          const rawText = t.line.trim().replace(/^- \[[ xX]\]\s*/, '').trim();
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
const filesContainer = document.getElementById('files-container');
const todosContainer = document.getElementById('todo-container');
let peekHideTimer = null;

// Arrow click toggles between Saved Notes and Tasks
panelArrow.addEventListener('click', () => {
  const notesActive = filesContainer.classList.contains('active');
  filesContainer.classList.toggle('active', !notesActive);
  todosContainer.classList.toggle('active', notesActive);
});

// Hover on arrow or lists panel shows the overlay
function showPanel() {
  clearTimeout(peekHideTimer);
  panelLists.classList.add('visible');
}

function scheduleHidePanel() {
  clearTimeout(peekHideTimer);
  peekHideTimer = setTimeout(() => panelLists.classList.remove('visible'), 100);
}

panelArrow.addEventListener('mouseenter', showPanel);
panelArrow.addEventListener('mouseleave', scheduleHidePanel);
panelLists.addEventListener('mouseenter', showPanel);
panelLists.addEventListener('mouseleave', scheduleHidePanel);

textarea.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + '\t' + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
  }
});

if (lastFile && localStorage.getItem('md_' + lastFile) !== null) {
  loadNote(lastFile);
} else {
  newNote();
}

if (savedPreview && !isPreview) {
  toggleView();
}
