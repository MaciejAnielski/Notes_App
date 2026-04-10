// export-import.js — Export, backup, and import operations.
//
// Handles exporting notes as HTML (single or notebook), backing up as ZIP,
// and importing from ZIP or markdown files. All platforms trigger a browser
// download for exports and backups.

// Escape user-supplied strings before inserting into HTML markup.
// Used for note names that appear as visible text or in attributes.
function _esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Derive a note name from the first-line # header, falling back to the
// file's base name when no header is present.
function _noteNameFromContent(fileBaseName, content) {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.startsWith('#')) {
    const title = firstLine.replace(/^#+\s*/, '').replace(/\s*>\s*$/, '').trim();
    if (title) return title;
  }
  return fileBaseName;
}

// Return the appropriate MathJax block: inlined CSS when available (offline
// export), or a CDN <script> tag for online viewing.
function _mathJaxSection(mathJaxCSS) {
  return mathJaxCSS
    ? `<style>${mathJaxCSS}</style>`
    : `<script>window.MathJax={tex:{inlineMath:[['$','$'],['\\\\(','\\\\)']],displayMath:[['$$','$$'],['\\\\[','\\\\]']]},chtml:{linebreaks:{automatic:true}}};</script><script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>`;
}

// ── Export rendering helpers ───────────────────────────────────────────────

// Reads current CSS custom properties and returns a :root block string so
// exported HTML matches whatever theme the user has active.
function getExportThemeCSSRoot() {
  const s = getComputedStyle(document.documentElement);
  const v = (p, fb) => (s.getPropertyValue(p) || '').trim() || fb;
  return [
    `--bg: ${v('--bg', '#1e1e1e')}`,
    `--text: ${v('--text', '#e8dcf4')}`,
    `--accent: ${v('--accent', '#a272b0')}`,
    `--surface: ${v('--surface', '#2e2e2e')}`,
    `--border: ${v('--border', '#444')}`,
    `--h1: ${v('--h1', '#c89fdf')}`,
    `--h2: ${v('--h2', '#b98fd0')}`,
    `--h3: ${v('--h3', '#a47fc0')}`,
    `--h4: ${v('--h4', '#9370b0')}`,
    `--h5: ${v('--h5', '#8060a0')}`,
    `--h6: ${v('--h6', '#6d5090')}`,
    `--link: ${v('--link', '#9cdcfe')}`,
    `--bold: ${v('--bold', '#f0e6ff')}`,
    `--italic: ${v('--italic', '#c8a0e0')}`,
    `--strike: ${v('--strike', '#7a6a8a')}`,
    `--code: ${v('--code', '#9ec7b5')}`,
    `--code-bg: ${v('--code-bg', '#2a2a3a')}`,
    `--code-block-bg: ${v('--code-block-bg', '#252535')}`,
    `--code-block-border: ${v('--code-block-border', '#3a3a5a')}`,
    `--mark-bg: ${v('--mark-bg', '#3a1060')}`,
    `--mark-color: ${v('--mark-color', '#c89fdf')}`,
    `--blockquote-border: ${v('--blockquote-border', '#a272b0')}`,
    `--blockquote-bg: ${v('--blockquote-bg', '#2a2040')}`,
    `--blockquote-text: ${v('--blockquote-text', '#b8a8cc')}`,
    `--table-header-bg: ${v('--table-header-bg', '#2a2040')}`,
    `--table-alt-row: ${v('--table-alt-row', '#242030')}`,
    `--hr: ${v('--hr', '#6b4e7a')}`,
    `--footnote: ${v('--footnote', '#a272b0')}`,
    `--footnote-back: ${v('--footnote-back', '#6b4e7a')}`,
  ].join('; ');
}

// Pre-fills results of open (trailing "=") equations into the markdown so
// the exported HTML shows solved values without needing math-eval.js.
function preEvaluateOpenEquations(markdown) {
  if (typeof extractAllMathExpressions !== 'function') return markdown;
  const exprs = extractAllMathExpressions(markdown);
  if (exprs.length === 0) return markdown;
  const varMap = buildMathVariableMap(exprs);

  const modifications = [];
  for (const expr of exprs) {
    const tex = expr.tex.trim();
    if (!/=\s*$/.test(tex)) continue;
    const exprPart = tex.replace(/=\s*$/, '').trim();
    const value = evaluateLatexExpr(exprPart, varMap);
    if (value === null) continue;
    modifications.push({ expr, formatted: formatMathResult(value) });
  }
  if (modifications.length === 0) return markdown;

  // Process highest index first so earlier positions stay valid.
  modifications.sort((a, b) => b.expr.index - a.expr.index);

  let result = markdown;
  for (const { expr, formatted } of modifications) {
    if (expr.type === 'block') {
      const innerStart = expr.index + 2;
      const innerEnd = result.indexOf('$$', innerStart);
      if (innerEnd === -1) continue;
      const inner = result.slice(innerStart, innerEnd);
      const newInner = inner.replace(/=\s*$/, `= ${formatted}`);
      if (newInner === inner) continue;
      result = result.slice(0, innerStart) + newInner + result.slice(innerEnd);
    } else {
      let j = expr.index + 1;
      while (j < result.length) {
        if (result[j] === '\\') { j += 2; continue; }
        if (result[j] === '$') break;
        j++;
      }
      if (j >= result.length) continue;
      const inner = result.slice(expr.index + 1, j);
      const newInner = inner.replace(/=\s*$/, `= ${formatted}`);
      if (newInner === inner) continue;
      result = result.slice(0, expr.index + 1) + newInner + result.slice(j);
    }
  }
  return result;
}

// Returns any MathJax-generated CSS present in the document (added by
// MathJax after typesetPromise runs) so it can be embedded in the export.
function getMathJaxCSS() {
  const parts = [];
  for (const style of document.querySelectorAll('style')) {
    if ((style.id && style.id.startsWith('MJX')) ||
        style.textContent.includes('mjx-container')) {
      parts.push(style.textContent);
    }
  }
  return parts.join('\n');
}

// CSS shared by single-note and notebook exports.  Uses the CSS-variable
// names resolved above so the output matches the active theme exactly.
const _EXPORT_SHARED_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  a { color: var(--link); }
  h1 { color: var(--h1); border-bottom: 1px solid var(--accent); padding-bottom: 8px; margin-bottom: 12px; }
  h2 { color: var(--h2); }
  h3 { color: var(--h3); }
  h4 { color: var(--h4); }
  h5 { color: var(--h5); }
  h6 { color: var(--h6); }
  strong { color: var(--bold); }
  em { color: var(--italic); }
  del { color: var(--strike); }
  hr { border: none; border-top: 1px solid var(--accent); margin: 1em 0; }
  code { color: var(--code); background-color: var(--code-bg); padding: 0 4px; border-radius: 3px; font-family: 'Consolas','Monaco','Courier New',monospace; font-size: 0.9em; }
  pre { background-color: var(--code-block-bg); border: 1px solid var(--code-block-border); border-radius: 4px; padding: 10px; overflow-x: auto; margin: 0.75em 0; font-size: 0.9em; line-height: 1.5; }
  pre code { color: var(--code); background: none; padding: 0; border-radius: 0; font-size: 1em; }
  mark { background-color: var(--mark-bg); color: var(--mark-color); border-radius: 2px; padding: 0 2px; }
  mark * { color: var(--mark-color); }
  p { margin: 0.5em 0; }
  blockquote { margin: 12px 0; padding: 6px 14px; border-left: 3px solid var(--blockquote-border); background-color: var(--blockquote-bg); color: var(--blockquote-text); border-radius: 0 4px 4px 0; }
  blockquote p { margin: 0; }
  ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
  li > ul, li > ol { margin: 0; }
  li { margin: 0.15em 0; }
  ul { list-style-type: disc; }
  ul ul { list-style-type: circle; }
  ul ul ul { list-style-type: square; }
  li p:first-child:last-child { margin: 0; }
  li.task-item + li.bullet-item, li.bullet-item + li.task-item { margin-top: 8px; }
  img { max-width: 100%; border: 1px solid var(--border); }
  table { border-collapse: collapse; margin: 0.75em 0; }
  th, td { border: 1px solid var(--border); padding: 6px 12px; }
  thead tr { background-color: var(--table-header-bg); }
  tbody tr:nth-child(even) { background-color: var(--table-alt-row); }
  .footnote-ref { color: var(--footnote); text-decoration: none; font-size: 0.75em; vertical-align: super; }
  .footnote-hr { border: none; border-top: 1px solid var(--border); margin: 24px 0 12px; }
  .footnotes { list-style: none; padding: 0; font-size: 0.85em; color: var(--footnote); }
  .footnote-back { color: var(--footnote-back); text-decoration: none; margin-left: 4px; }
  details { margin: 0; }
  details > summary { list-style: none; cursor: pointer; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary h2, details > summary h3, details > summary h4,
  details > summary h5, details > summary h6 { display: inline; margin: revert; }
  details > summary::after { content: ' \u203a'; font-size: 0.8em; color: var(--accent); }
  details[open] > summary::after { content: ' \u2304'; }
  .mermaid-diagram { overflow-x: auto; margin: 0.75em 0; }
  .mermaid-diagram svg { max-width: 100%; height: auto; }
  mjx-container[jax="CHTML"] { line-height: normal; }
  mjx-container[display="true"] { display: block !important; max-width: 100% !important; overflow-x: auto; margin: 0.5em 0; text-align: center; }
  mjx-container:not([display="true"]) { display: inline-block; max-width: 100% !important; overflow-x: auto; vertical-align: middle; }
  input[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border: 1.5px solid var(--border); background-color: var(--code-bg); vertical-align: middle; margin-right: 4px; border-radius: 3px; position: relative; cursor: default; }
  input[type="checkbox"]:checked { background-color: var(--accent); border-color: var(--accent); }
  input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 3px; top: 0px; width: 5px; height: 9px; border: 2px solid white; border-top: none; border-left: none; transform: rotate(45deg); }
  li.task-item { list-style-type: none; }
`;

// Runs the full rendering pipeline on a detached container:
//   Mermaid diagrams → SVG, then MathJax typeset (requires brief DOM attachment).
// Returns the MathJax CSS that was generated (empty string if MathJax unavailable).
async function renderContainerForExport(container) {
  await renderMermaidDiagrams(container);

  if (!window.MathJax) return '';

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;visibility:hidden;top:-9999px;' +
                       'left:-9999px;pointer-events:none;width:0;height:0;overflow:hidden;';
  host.appendChild(container);
  document.body.appendChild(host);
  try {
    await MathJax.typesetPromise([container]);
  } finally {
    document.body.removeChild(host);
  }
  return getMathJaxCSS();
}

async function embedAttachmentsInHtml(container, noteName) {
  if (typeof NoteStorage.readAttachment !== 'function') return;
  const readFn = (n, f) => NoteStorage.readAttachment(n, f);
  for (const img of container.querySelectorAll('img[src^="attachment:"]')) {
    const filename = img.getAttribute('src').slice('attachment:'.length);
    const b64 = await readFn(noteName, filename);
    if (b64) {
      const ext = filename.split('.').pop();
      img.src = `data:${mimeForExtension(ext)};base64,${b64}`;
    }
  }
  for (const link of container.querySelectorAll('a[href^="attachment:"]')) {
    const filename = link.getAttribute('href').slice('attachment:'.length);
    const b64 = await readFn(noteName, filename);
    if (b64) {
      const ext = filename.split('.').pop();
      link.href = `data:${mimeForExtension(ext)};base64,${b64}`;
      link.setAttribute('download', filename);
    }
  }
}

async function generateHtmlContent(title, markdown, noteName) {
  const processedMarkdown = preEvaluateOpenEquations(markdown);

  const container = document.createElement('div');
  container.innerHTML = marked.parse(preprocessMarkdown(processedMarkdown));
  styleTaskListItems(container);
  if (noteName) await embedAttachmentsInHtml(container, noteName);
  alignTableColumns(container);
  setupCollapsibleHeadings(container);

  const mathJaxCSS = await renderContainerForExport(container);

  const cssRoot = getExportThemeCSSRoot();
  const style = `
    :root { ${cssRoot} }
    body { max-width: 800px; margin: 20px auto; padding: 10px 20px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.5; background-color: var(--bg); color: var(--text); }
    ${_EXPORT_SHARED_CSS}
  `;

  const mathSection = _mathJaxSection(mathJaxCSS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${_esc(title)}</title>
<style>${style}</style>
${mathSection}
</head>
<body>
${container.innerHTML}
</body>
</html>`;
}

function noteNameToId(name) {
  return 'note-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function generateNotebookHtml(noteEntries) {
  const noteNameSet = new Set(noteEntries.map(e => e.name));

  const tocItems = noteEntries.map(({ name }) =>
    `<li><a href="#${noteNameToId(name)}">${_esc(name)}</a></li>`
  ).join('\n      ');

  // Build and pre-process each note container sequentially (avoids mermaid ID
  // collisions that could occur with concurrent renders).
  const noteContainers = [];
  for (const { name, content } of noteEntries) {
    const processedContent = preEvaluateOpenEquations(content);
    const container = document.createElement('div');
    container.innerHTML = marked.parse(preprocessMarkdown(processedContent));
    styleTaskListItems(container);
    await embedAttachmentsInHtml(container, name);
    container.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || /^[a-zA-Z]+:/.test(href)) return;
      const noteName = decodeURIComponent(href).replace(/_/g, ' ').trim();
      if (noteNameSet.has(noteName)) {
        a.setAttribute('href', '#' + noteNameToId(noteName));
      }
    });
    alignTableColumns(container);
    setupCollapsibleHeadings(container);
    await renderMermaidDiagrams(container);
    noteContainers.push({ name, container });
  }

  // Typeset all math at once for efficiency.
  let mathJaxCSS = '';
  if (window.MathJax && noteContainers.length > 0) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden;top:-9999px;' +
                         'left:-9999px;pointer-events:none;width:0;height:0;overflow:hidden;';
    for (const { container } of noteContainers) host.appendChild(container);
    document.body.appendChild(host);
    try {
      await MathJax.typesetPromise(noteContainers.map(nc => nc.container));
    } finally {
      document.body.removeChild(host);
    }
    mathJaxCSS = getMathJaxCSS();
  }

  const sections = noteContainers
    .map(({ name, container }) =>
      `<article id="${noteNameToId(name)}" aria-label="${_esc(name)}">\n${container.innerHTML}\n</article>`)
    .join('\n\n');

  const cssRoot = getExportThemeCSSRoot();
  const style = `
    :root { ${cssRoot} }
    body { margin: 0; display: flex; height: 100vh; font-family: Arial, sans-serif; font-size: 16px; background-color: var(--bg); color: var(--text); }
    #toc { width: 220px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; border-right: 1px solid var(--border); padding: 20px 12px; background-color: var(--bg); scrollbar-width: none; }
    #toc::-webkit-scrollbar { display: none; }
    #toc h3 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--hr); }
    #toc ul { list-style: none; margin: 0; padding: 0; }
    #toc a { display: block; padding: 4px 6px; border-radius: 3px; color: var(--h4); text-decoration: none; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #toc a:hover { color: var(--text); background-color: var(--surface); }
    main { flex: 1; overflow-y: auto; padding: 40px; scrollbar-width: none; }
    main::-webkit-scrollbar { display: none; }
    article { max-width: 800px; margin: 0 auto 60px; }
    article + article { border-top: 1px solid var(--border); padding-top: 40px; }
    ${_EXPORT_SHARED_CSS}
  `;

  const mathSection = _mathJaxSection(mathJaxCSS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Notes Notebook</title>
<style>${style}</style>
${mathSection}
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

// ── Download helper ────────────────────────────────────────────────────────
// On iOS (WKWebView) the `download` attribute on anchor tags is not honoured
// and blob URL clicks are silently ignored. Use navigator.share() instead,
// which opens the native iOS share sheet so the user can save to Files,
// send via Mail, etc. Falls back to the standard link.click() on all other
// platforms where it works reliably.

async function triggerDownload(blob, filename) {
  if (window.Capacitor?.isNativePlatform()) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    // Fallback: shouldn't normally be reached on iOS 15+
    updateStatus('Share not supported on this device.', false);
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ── Export operations ──────────────────────────────────────────────────────

async function exportNote() {
  const name = currentFileName || getNoteTitle();
  if (!name) {
    alert('No note selected.');
    return;
  }
  updateStatus(`Exporting\u2026`, true, true);
  const markdown = textarea.value;
  const html = await generateHtmlContent(name, markdown, name);
  const blob = new Blob([html], { type: 'text/html' });
  await triggerDownload(blob, name + '.html');
  updateStatus(`Exported "${name}".`, true);
}

async function exportAllNotes() {
  const entries = await NoteStorage.getAllNotes();
  if (entries.length === 0) { alert('No notes found.'); return; }
  updateStatus(`Exporting\u2026`, true, true);
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const html = await generateNotebookHtml(entries);
  const blob = new Blob([html], { type: 'text/html' });
  await triggerDownload(blob, 'notes_notebook.html');
  updateStatus(`Exported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
}

async function exportSelectedNotes() {
  const notes = await getVisibleNotes();
  if (notes.length === 0) { alert('No notes match the filter.'); return; }
  updateStatus(`Exporting\u2026`, true, true);
  const results = await Promise.all(notes.map(async name => {
    const content = await NoteStorage.getNote(name);
    return content !== null ? { name, content } : null;
  }));
  const entries = results.filter(Boolean);
  const html = await generateNotebookHtml(entries);
  const blob = new Blob([html], { type: 'text/html' });
  await triggerDownload(blob, 'notes_notebook.html');
  updateStatus(`Exported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
}

// ── Backup operations ─────────────────────────────────────────────────────

async function createBackupZip(noteEntries, downloadName) {
  const zip = new JSZip();
  const total = noteEntries.length;
  updateStatus(`Backing Up (0/${total})\u2026`, true, true);
  let completed = 0;
  await Promise.all(noteEntries.map(async ({ name, content }) => {
    zip.file(name + '.md', content);
    const attFiles = await NoteStorage.listAttachments(name);
    const attDir = noteNameToAttachmentDir(name);
    await Promise.all(attFiles.map(async filename => {
      const b64 = await NoteStorage.readAttachment(name, filename);
      if (b64) zip.file(`${attDir}/${filename}`, b64, { base64: true });
    }));
    completed++;
    updateStatus(`Backing Up (${completed}/${total})\u2026`, true, true);
  }));
  updateStatus(`Compressing\u2026`, true, true);
  const blob = await zip.generateAsync({ type: 'blob' });
  await triggerDownload(blob, downloadName);
}

async function downloadAllNotes() {
  updateStatus(`Backing Up\u2026`, true, true);

  const allNotes = await NoteStorage.getAllNotes();
  if (allNotes.length === 0) {
    alert('No notes found.');
    return;
  }

  try {
    await createBackupZip(allNotes, 'all_notes.zip');
  } catch {
    updateStatus('Backup failed.', false);
    return;
  }

  updateStatus(`Backed Up ${allNotes.length} Note${allNotes.length === 1 ? '' : 's'}.`, true);
}

async function backupSelectedNotes() {
  updateStatus(`Backing Up\u2026`, true, true);
  const notes = await getVisibleNotes();
  if (notes.length === 0) {
    alert('No notes match the filter.');
    return;
  }

  try {
    const results = await Promise.all(notes.map(async name => {
      const content = await NoteStorage.getNote(name);
      return content !== null ? { name, content } : null;
    }));
    const entries = results.filter(Boolean);
    await createBackupZip(entries, 'selected_notes.zip');
  } catch {
    updateStatus('Backup failed.', false);
    return;
  }

  updateStatus(`Backed Up ${notes.length} Note${notes.length === 1 ? '' : 's'}.`, true);
}

// ── Import ────────────────────────────────────────────────────────────────

async function importNotesFromMd(files) {
  updateStatus(`Importing\u2026`, true, true);
  try {
    const entries = [];
    for (const file of files) {
      const fileBaseName = file.name.replace(/\.md$/, '');
      // Skip system/virtual notes — they are auto-generated and should not be imported
      if (fileBaseName === PROJECTS_NOTE || fileBaseName === GRAPH_NOTE || fileBaseName === CALENDARS_NOTE) continue;
      const content = await file.text();
      // Use the first-line # header as the note name so that the name always
      // matches the header, falling back to the filename if no header is present.
      const name = _noteNameFromContent(fileBaseName, content);
      if (name === PROJECTS_NOTE || name === GRAPH_NOTE || name === CALENDARS_NOTE) continue;
      entries.push({ name, content });
    }

    // Check for existing notes that would be overwritten
    const existChecks = await Promise.all(entries.map(({ name }) => NoteStorage.getNote(name)));
    const existingNames = entries.filter((_, i) => existChecks[i] !== null).map(({ name }) => name);
    if (existingNames.length > 0) {
      const list = existingNames.length <= 5
        ? existingNames.map(n => `"${n}"`).join(', ')
        : existingNames.slice(0, 5).map(n => `"${n}"`).join(', ') + ` and ${existingNames.length - 5} more`;
      if (!confirm(`Import will overwrite ${existingNames.length} existing note${existingNames.length === 1 ? '' : 's'}: ${list}. Continue?`)) {
        updateStatus('Import cancelled.', false);
        importZipInput.value = '';
        return;
      }
    }

    updateStatus(`Importing\u2026`, true, true);
    await Promise.all(entries.map(({ name, content }) => NoteStorage.setNote(name, content)));
    await updateFileList();
    importZipInput.value = '';
    updateStatus(`Imported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
  } catch (err) {
    updateStatus('Import failed: ' + err.message, false);
  }
}

async function importNotesFromZip(file) {
  updateStatus(`Importing\u2026`, true, true);
  try {
    const zip = await JSZip.loadAsync(file);
    const rawEntries = [];
    const attachmentEntries = [];
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return;
      if (relativePath.endsWith('.md')) {
        // Track the original dir name for attachment matching before we
        // derive the final note name from the header content below.
        rawEntries.push({ fileBaseName: relativePath.replace(/\.md$/, ''), zipEntry });
      } else if (relativePath.includes('.attachments/')) {
        attachmentEntries.push({ relativePath, zipEntry });
      }
    });

    // Read content upfront so we can derive note names from first-line headers.
    const entries = (await Promise.all(rawEntries.map(async ({ fileBaseName, zipEntry }) => {
      const content = await zipEntry.async('string');
      // Skip system/virtual notes — they are auto-generated and should not be imported
      if (fileBaseName === PROJECTS_NOTE || fileBaseName === GRAPH_NOTE || fileBaseName === CALENDARS_NOTE) return null;
      // Use the first-line # header as the note name so that the name always
      // matches the header, falling back to the filename if no header is present.
      const name = _noteNameFromContent(fileBaseName, content);
      if (name === PROJECTS_NOTE || name === GRAPH_NOTE || name === CALENDARS_NOTE) return null;
      return { name, fileBaseName, content };
    }))).filter(Boolean);

    // Check for existing notes that would be overwritten
    const existChecks = await Promise.all(entries.map(({ name }) => NoteStorage.getNote(name)));
    const existingNames = entries.filter((_, i) => existChecks[i] !== null).map(({ name }) => name);
    if (existingNames.length > 0) {
      const list = existingNames.length <= 5
        ? existingNames.map(n => `"${n}"`).join(', ')
        : existingNames.slice(0, 5).map(n => `"${n}"`).join(', ') + ` and ${existingNames.length - 5} more`;
      if (!confirm(`Import will overwrite ${existingNames.length} existing note${existingNames.length === 1 ? '' : 's'}: ${list}. Continue?`)) {
        updateStatus('Import cancelled.', false);
        importZipInput.value = '';
        return;
      }
    }

    updateStatus(`Importing\u2026`, true, true);
    await Promise.all(entries.map(({ name, content }) => NoteStorage.setNote(name, content)));
    await Promise.all(attachmentEntries.map(async ({ relativePath, zipEntry }) => {
      const slashIdx = relativePath.indexOf('/');
      if (slashIdx < 0) return;
      const dirPart = relativePath.slice(0, slashIdx);
      const filename = relativePath.slice(slashIdx + 1);
      if (!filename) return;
      // Match attachments by the original file-based attachment dir name OR
      // by the header-derived note name's attachment dir.
      const matchedEntry = entries.find(e =>
        noteNameToAttachmentDir(e.fileBaseName) === dirPart ||
        noteNameToAttachmentDir(e.name) === dirPart
      );
      if (!matchedEntry) return;
      const b64 = await zipEntry.async('base64');
      await NoteStorage.writeAttachment(matchedEntry.name, filename, b64);
    }));
    await updateFileList();
    importZipInput.value = '';
    updateStatus(`Imported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
  } catch (err) {
    updateStatus('Import failed: ' + err.message, false);
  }
}
