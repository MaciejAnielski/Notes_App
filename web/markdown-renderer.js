// markdown-renderer.js — Markdown preprocessing, rendering, and preview.
//
// Handles wiki-links, schedule syntax stripping, collapsible headings,
// highlight syntax, indentation, footnotes, note links, table alignment,
// attachment resolution, and the preview toggle.

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

function preprocessMarkdown(text) {
  // ── Wiki links ──
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const display = inner.replace(/_/g, ' ').trim();
    const href = encodeURIComponent(inner.trim());
    return `[${display}](${href})`;
  });

  // ── Strip schedule syntax from end of lines ──
  // Handles: > YYMMDD HHMM HHMM  (timed)
  //          > YYMMDD YYMMDD      (multi-day)
  //          > YYMMDD             (all-day)
  {
    const schedRe = /\s*>\s*\d{6}(?:\s+(?:\d{6}|\d{4}\s+\d{4}))?\s*$/;
    const schedLines = text.split('\n');
    const schedOut = [];
    for (let si = 0; si < schedLines.length; si++) {
      const line = schedLines[si];
      if (schedRe.test(line)) {
        let stripped = line.replace(schedRe, '');
        const trimmed = stripped.trimStart();
        const isTask    = /^- \[[ xX]\]\s/.test(trimmed);
        const isList    = /^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed);
        const isHeading = /^#+\s/.test(trimmed);
        if (!isTask) {
          if (isHeading) {
            stripped = stripped.replace(/(#+\s)/, '$1🗓️ ');
          } else if (isList) {
            stripped = stripped.replace(/^(\s*(?:[-*+]|\d+[.)]) )/, '$1🗓️ ');
          } else {
            stripped = stripped.replace(/^(\s*)/, '$1🗓️ ');
          }
        }
        schedOut.push(stripped);
        const nextLine = schedLines[si + 1];
        const nextIsBlank = nextLine === undefined || nextLine.trim() === '';
        if (!isList && !isHeading && !nextIsBlank) {
          schedOut.push('');
        }
      } else {
        schedOut.push(line);
      }
    }
    text = schedOut.join('\n');
  }

  // ── Auto-collapse headings: strip trailing ">" and inject collapse marker ──
  {
    const collapseLines = text.split('\n');
    text = collapseLines.map(line => {
      const trimmed = line.trimStart();
      if (!/^#{1,6}\s/.test(trimmed)) return line;
      if (!/\s*>\s*$/.test(line)) return line;
      const stripped = line.replace(/\s*>\s*$/, '');
      return stripped + '<span class="collapse-marker" style="display:none"></span>';
    }).join('\n');
  }

  // ── Highlight syntax ==text== → <mark>text</mark> ──
  {
    const hlLines = text.split('\n');
    let inFence = false;
    text = hlLines.map(line => {
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    }).join('\n');
  }

  // ── Indentation: convert leading tabs into padded HTML blocks ──
  {
    const lines = text.split('\n');
    const out = [];
    let inFence = false;
    let pendingList = null;
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

      if (line.trim() === '') {
        flushPendingList();
        out.push(line);
        prevWasListItem = false;
        continue;
      }

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
            flushPendingList();
            pendingList = { baseDepth: depth, listLines: [] };
          }

          if (pendingList) {
            const relativeDepth = depth - pendingList.baseDepth;
            pendingList.listLines.push('    '.repeat(Math.max(0, relativeDepth)) + content);
          } else {
            out.push('    '.repeat(depth) + content);
          }
          prevWasListItem = true;
        } else if (isBlockquote || isHeading) {
          flushPendingList();
          out.push('    '.repeat(depth) + content);
          prevWasListItem = false;
        } else {
          flushPendingList();
          const rendered = marked.parseInline(content);
          out.push(`<p style="padding-left:${depth * 2}em;margin:0.2em 0">${rendered}</p>`);
          out.push('');
          prevWasListItem = false;
        }
      } else {
        flushPendingList();
        const trimmed = line.trimStart();
        prevWasListItem = /^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed);
        out.push(line);
      }
    }
    flushPendingList();
    text = out.join('\n');
  }

  // ── Footnotes ──
  const defs = {};
  text = text.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, def) => {
    defs[id] = def.trim();
    return '';
  });

  if (Object.keys(defs).length === 0) return text;

  const order = [];
  text = text.replace(/\[\^([^\]]+)\]/g, (_, id) => {
    if (!order.includes(id)) order.push(id);
    const n = order.indexOf(id) + 1;
    return `<sup><a id="fnref-${id}" href="#fn-${id}" class="footnote-ref">${n}</a></sup>`;
  });

  const items = order.map((id, i) => {
    const n = i + 1;
    const defText = marked.parseInline(defs[id] || '');
    return `<li id="fn-${id}">${n}. ${defText} <a href="#fnref-${id}" class="footnote-back">↩</a></li>`;
  }).join('\n');

  text += `\n\n<hr class="footnote-hr">\n<ol class="footnotes">\n${items}\n</ol>`;

  return text;
}

async function setupNoteLinks(container = previewDiv) {
  const allNames = new Set(await NoteStorage.getAllNoteNames());

  container.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    if (!href) {
      return;
    }
    // SharePoint links: rewrite to desktop app protocol
    if (/^https?:\/\/[^/]*\.sharepoint\.com\//i.test(href)) {
      const sharepointProtocols = [
        { exts: /\.(docx?|docm|dotx?|dotm)$/i, scheme: 'ms-word' },
        { exts: /\.(xlsx?|xlsm|xlsb|xltx?|xltm)$/i, scheme: 'ms-excel' },
        { exts: /\.(pptx?|pptm|potx?|potm|ppsx?|ppsm)$/i, scheme: 'ms-powerpoint' },
        { exts: /\.one$/i, scheme: 'ms-onenote' },
        { exts: /\.(vsdx?|vsdm|vssx?|vssm|vstx?|vstm)$/i, scheme: 'ms-visio' },
        { exts: /\.(accdb|mdb)$/i, scheme: 'ms-access' },
      ];
      const urlPath = href.split('?')[0].split('#')[0];
      const match = sharepointProtocols.find(p => p.exts.test(urlPath));
      if (match) {
        a.setAttribute('href', `${match.scheme}:ofe|u|${href}`);
        a.removeAttribute('target');
        a.removeAttribute('rel');
      } else if (/\.html?$/i.test(urlPath)) {
        let directUrl = href;
        directUrl = directUrl.replace(/(\.sharepoint\.com(?:\/sites\/[^/]+)?)\/:.\/:(?:r|s|g)\//i, '$1/');
        a.setAttribute('href', directUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
      return;
    }
    // External links: open in system default browser on desktop/iOS,
    // or in a new tab on plain web.
    if (/^[a-zA-Z]+:/.test(href)) {
      if (window.electronAPI) {
        // Electron desktop: route through shell.openExternal so the OS
        // default browser is used instead of a new Electron window.
        a.removeAttribute('target');
        a.removeAttribute('rel');
        a.addEventListener('click', e => {
          e.preventDefault();
          window.electronAPI.notes.openExternal(href);
        });
      } else if (window.Capacitor) {
        // iOS (Capacitor): use App.openUrl so the default browser opens.
        a.removeAttribute('target');
        a.removeAttribute('rel');
        a.addEventListener('click', e => {
          e.preventDefault();
          const App = window.Capacitor?.Plugins?.App;
          if (App) App.openUrl({ url: href });
        });
      } else {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
      return;
    }
    // Anchor links: don't modify
    if (href.startsWith('#')) {
      return;
    }
    const noteName = decodeURIComponent(href).replace(/_/g, ' ').trim();
    const exists = allNames.has(noteName);

    a.href = '#';

    if (!exists) {
      a.classList.add('internal-link-new');
      a.title = `Create note "${noteName}"`;
    }

    a.addEventListener('click', async e => {
      e.preventDefault();
      if (await NoteStorage.getNote(noteName) !== null) {
        if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
          linkedNoteChain.unshift(currentFileName);
          saveChain();
        }
        await loadNote(noteName, true);
      } else {
        if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
          linkedNoteChain.unshift(currentFileName);
          saveChain();
        }
        const newContent = `# ${noteName}\n\n`;
        await NoteStorage.setNote(noteName, newContent);
        await loadNote(noteName, true);
        updateStatus(`Created Note "${noteName}".`, true);
      }
    });
  });
}

function setupCollapsibleHeadings(container) {
  const headingTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const headingLevel = el => parseInt(el.tagName[1]);

  function nodeHeadingLevel(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (headingTags.has(node.tagName)) return headingLevel(node);
    if (node.tagName === 'DETAILS') {
      const h = node.querySelector('summary > h1, summary > h2, summary > h3, summary > h4, summary > h5, summary > h6');
      return h ? headingLevel(h) : null;
    }
    return null;
  }

  const headings = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].reverse();

  headings.forEach(heading => {
    const level = headingLevel(heading);
    const details = document.createElement('details');
    details.open = !heading.querySelector('.collapse-marker');
    const summary = document.createElement('summary');
    summary.appendChild(heading.cloneNode(true));
    details.appendChild(summary);

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

      bodyRows.forEach(row => {
        const td = row.querySelectorAll('td')[colIndex];
        if (td) td.style.textAlign = align;
      });

      const th = table.querySelectorAll('thead tr th')[colIndex];
      if (th) th.style.textAlign = align;
    });
  });
}

async function resolveAttachments(container) {
  if (!currentFileName) return;
  const hasDesktop = !!window.electronAPI?.notes?.readAttachment;
  const hasIOS     = !!window.CapacitorNoteStorage?.readAttachment;
  if (!hasDesktop && !hasIOS) return;

  if (hasDesktop && _notesDirCache === null) {
    const info = await window.electronAPI.notes.getDir();
    _notesDirCache = info?.path || '';
  }

  for (const img of container.querySelectorAll('img[src^="attachment:"]')) {
    const filename = img.getAttribute('src').slice('attachment:'.length);
    if (hasDesktop && _notesDirCache) {
      const attDir = noteNameToAttachmentDir(currentFileName);
      img.src = encodeURI(`file://${_notesDirCache}/${attDir}/${filename}`);
    } else if (hasIOS) {
      const b64 = await window.CapacitorNoteStorage.readAttachment(currentFileName, filename);
      if (b64) {
        const ext = filename.split('.').pop();
        img.src = `data:${mimeForExtension(ext)};base64,${b64}`;
      }
    }
  }

  for (const link of container.querySelectorAll('a[href^="attachment:"]')) {
    const filename = link.getAttribute('href').slice('attachment:'.length);
    const noteName = currentFileName;
    if (hasDesktop) {
      link.href = '#';
      link.addEventListener('click', e => {
        e.preventDefault();
        window.electronAPI.notes.openAttachment(noteName, filename);
      });
    } else if (hasIOS) {
      link.href = '#';
      link.addEventListener('click', e => {
        e.preventDefault();
        openAttachmentOnIOS(noteName, filename);
      });
    }
  }
}

async function openAttachmentOnIOS(noteName, filename) {
  try {
    const b64 = await window.CapacitorNoteStorage.readAttachment(noteName, filename);
    if (!b64) { updateStatus('File not found.', false); return; }
    const ext = filename.split('.').pop();
    const mime = mimeForExtension(ext);
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: mime });
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      updateStatus('Cannot open file on this device.', false);
    }
  } catch {
    updateStatus('Could not open file.', false);
  }
}

async function renderPreview() {
  previewDiv.innerHTML = marked.parse(preprocessMarkdown(textarea.value));
  styleTaskListItems(previewDiv);
  await setupNoteLinks(previewDiv);
  setupCollapsibleHeadings(previewDiv);
  alignTableColumns(previewDiv);
  setupPreviewTaskCheckboxes();
  await resolveAttachments(previewDiv);
  if (window.MathJax) {
    // Inform MathJax of the actual container width so that multline and
    // automatic line-breaking lay out equations within the visible area.
    if (MathJax.startup?.output?.options) {
      MathJax.startup.output.options.containerWidth = previewDiv.clientWidth;
    }
    MathJax.typesetPromise([previewDiv]).then(() => {
      setupClickableMathFormulas();
    });
  }
}

async function toggleView() {
  if (currentFileName === PROJECTS_NOTE) return;
  if (isPreview) {
    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
    toggleViewBtn.textContent = 'View';
    isPreview = false;
    localStorage.setItem('is_preview', 'false');
  } else {
    renderPreview();
    previewDiv.style.display = 'block';
    textarea.style.display = 'none';
    toggleViewBtn.textContent = 'Edit';
    isPreview = true;
    localStorage.setItem('is_preview', 'true');
  }
}
