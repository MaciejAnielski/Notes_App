// export-import.js — Export, backup, and import operations.
//
// Handles exporting notes as HTML (single or notebook), backing up as ZIP,
// and importing from ZIP files. Supports both web (browser download) and
// iCloud (desktop/iOS) save paths.

async function embedAttachmentsInHtml(container, noteName) {
  const hasDesktop = !!window.electronAPI?.notes?.readAttachment;
  const hasIOS     = !!window.CapacitorNoteStorage?.readAttachment;
  if (!hasDesktop && !hasIOS) return;
  const readFn = hasDesktop
    ? (n, f) => window.electronAPI.notes.readAttachment(n, f)
    : (n, f) => window.CapacitorNoteStorage.readAttachment(n, f);
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
  const container = document.createElement('div');
  container.innerHTML = marked.parse(preprocessMarkdown(markdown));
  styleTaskListItems(container);
  if (noteName) await embedAttachmentsInHtml(container, noteName);
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

async function generateNotebookHtml(noteEntries) {
  const noteNameSet = new Set(noteEntries.map(e => e.name));

  const tocItems = noteEntries.map(({ name }) =>
    `<li><a href="#${noteNameToId(name)}">${name}</a></li>`
  ).join('\n      ');

  const sectionParts = await Promise.all(noteEntries.map(async ({ name, content }) => {
    const container = document.createElement('div');
    container.innerHTML = marked.parse(preprocessMarkdown(content));
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
    return `<article id="${noteNameToId(name)}">\n${container.innerHTML}\n</article>`;
  }));
  const sections = sectionParts.join('\n\n');

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

// ── Export operations ──────────────────────────────────────────────────────

async function exportNote() {
  const name = currentFileName || getNoteTitle();
  if (!name) {
    alert('No note selected.');
    return;
  }
  const markdown = textarea.value;
  const html = await generateHtmlContent(name, markdown, name);

  const hasICloud = !!(window.electronAPI?.notes || (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage));
  if (hasICloud) {
    const timestamp = formatTimestamp();
    try { await NoteStorage.writeExport(`${timestamp}_Export.html`, html); } catch {}
  } else {
    const blob = new Blob([html], { type: 'text/html' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name + '.html';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  updateStatus(`Exported "${name}".`, true);
}

async function exportAllNotes() {
  const entries = await NoteStorage.getAllNotes();
  if (entries.length === 0) { alert('No notes found.'); return; }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const html = await generateNotebookHtml(entries);

  const hasICloud = !!(window.electronAPI?.notes || (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage));
  if (hasICloud) {
    const timestamp = formatTimestamp();
    try { await NoteStorage.writeExport(`${timestamp}_Export.html`, html); } catch {}
  } else {
    const blob = new Blob([html], { type: 'text/html' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'notes_notebook.html';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  updateStatus(`Exported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
}

async function exportSelectedNotes() {
  const notes = await getVisibleNotes();
  if (notes.length === 0) { alert('No notes match the filter.'); return; }
  const entries = [];
  for (const name of notes) {
    const content = await NoteStorage.getNote(name);
    if (content !== null) entries.push({ name, content });
  }
  const html = await generateNotebookHtml(entries);

  const hasICloud = !!(window.electronAPI?.notes || (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage));
  if (hasICloud) {
    const timestamp = formatTimestamp();
    try { await NoteStorage.writeExport(`${timestamp}_Export.html`, html); } catch {}
  } else {
    const blob = new Blob([html], { type: 'text/html' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'notes_notebook.html';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  updateStatus(`Exported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
}

// ── Backup operations ─────────────────────────────────────────────────────

async function downloadAllNotes() {
  localStorage.setItem('last_backup_time', Date.now().toString());
  updateBackupStatus();
  const zip = new JSZip();

  const allNotes = await NoteStorage.getAllNotes();
  if (allNotes.length === 0) {
    alert('No notes found.');
    return;
  }

  for (const { name, content } of allNotes) {
    zip.file(name + '.md', content);
    const attFiles = await NoteStorage.listAttachments(name);
    const attDir = noteNameToAttachmentDir(name);
    for (const filename of attFiles) {
      const b64 = await NoteStorage.readAttachment(name, filename);
      if (b64) zip.file(`${attDir}/${filename}`, b64, { base64: true });
    }
  }

  const hasICloud = !!(window.electronAPI?.notes || (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage));
  if (hasICloud) {
    const timestamp = formatTimestamp();
    const base64 = await zip.generateAsync({ type: 'base64' });
    try { await NoteStorage.writeBackup(`${timestamp}_Backup.zip`, base64); } catch {}
  } else {
    const blob = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'all_notes.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  updateStatus(`Backed Up ${allNotes.length} Note${allNotes.length === 1 ? '' : 's'}.`, true);
}

async function backupSelectedNotes() {
  localStorage.setItem('last_backup_time', Date.now().toString());
  updateBackupStatus();
  const notes = await getVisibleNotes();
  if (notes.length === 0) {
    alert('No notes match the filter.');
    return;
  }
  const zip = new JSZip();
  for (const name of notes) {
    const content = await NoteStorage.getNote(name);
    if (content !== null) {
      zip.file(name + '.md', content);
      const attFiles = await NoteStorage.listAttachments(name);
      const attDir = noteNameToAttachmentDir(name);
      for (const filename of attFiles) {
        const b64 = await NoteStorage.readAttachment(name, filename);
        if (b64) zip.file(`${attDir}/${filename}`, b64, { base64: true });
      }
    }
  }

  const hasICloud = !!(window.electronAPI?.notes || (window.Capacitor?.isNativePlatform() && window.CapacitorNoteStorage));
  if (hasICloud) {
    const timestamp = formatTimestamp();
    const base64 = await zip.generateAsync({ type: 'base64' });
    try { await NoteStorage.writeBackup(`${timestamp}_Backup.zip`, base64); } catch {}
  } else {
    const blob = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'selected_notes.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  updateStatus(`Backed Up ${notes.length} Note${notes.length === 1 ? '' : 's'}.`, true);
}

// ── Import ────────────────────────────────────────────────────────────────

async function importNotesFromZip(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const entries = [];
    const attachmentEntries = [];
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return;
      if (relativePath.endsWith('.md')) {
        entries.push({ name: relativePath.replace(/\.md$/, ''), zipEntry });
      } else if (relativePath.includes('.attachments/')) {
        attachmentEntries.push({ relativePath, zipEntry });
      }
    });
    for (const { name, zipEntry } of entries) {
      const content = await zipEntry.async('string');
      await NoteStorage.setNote(name, content);
    }
    for (const { relativePath, zipEntry } of attachmentEntries) {
      const slashIdx = relativePath.indexOf('/');
      if (slashIdx < 0) continue;
      const dirPart = relativePath.slice(0, slashIdx);
      const filename = relativePath.slice(slashIdx + 1);
      if (!filename) continue;
      const matchedEntry = entries.find(e => noteNameToAttachmentDir(e.name) === dirPart);
      if (!matchedEntry) continue;
      const b64 = await zipEntry.async('base64');
      await NoteStorage.writeAttachment(matchedEntry.name, filename, b64);
    }
    await updateFileList();
    importZipInput.value = '';
    updateStatus(`Imported ${entries.length} Note${entries.length === 1 ? '' : 's'}.`, true);
  } catch (err) {
    alert('Error importing zip: ' + err.message);
  }
}
