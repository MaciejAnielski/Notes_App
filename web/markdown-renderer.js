// markdown-renderer.js — Markdown preprocessing, rendering, and preview.
//
// Handles wiki-links, schedule syntax stripping, collapsible headings,
// highlight syntax, indentation, footnotes, note links, table alignment,
// attachment resolution, and the preview toggle.

// Custom marked renderer: prevent CSP violations for attachment: images.
// Instead of <img src="attachment:file">, emit <img data-attachment="file" src="">
// so the browser doesn't try to load the unsupported scheme. resolveAttachments()
// then fills in the real data URI.
{
  const renderer = new marked.Renderer();
  const defaultImage = renderer.image.bind(renderer);
  renderer.image = function({ href, title, text }) {
    if (href && href.startsWith('attachment:')) {
      const filename = href.slice('attachment:'.length);
      const titleAttr = title ? ` title="${title}"` : '';
      return `<img data-attachment="${filename}" alt="${text || ''}"${titleAttr} src="">`;
    }
    return defaultImage({ href, title, text });
  };
  marked.use({ renderer });
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
  // ── Disable underscore italics (_text_) ──
  // Escape lone underscores so marked doesn't treat them as emphasis.
  // Keeps __bold__ and ___bold-italic___ intact. Skips code fences and inline code.
  {
    const lines = text.split('\n');
    let inFence = false;
    text = lines.map(line => {
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      const codes = [];
      let safe = line.replace(/`[^`\n]+`/g, m => { codes.push(m); return '\x01' + (codes.length - 1) + '\x01'; });
      safe = safe.replace(/(?<![_\\])_(?!_)/g, '\\_');
      safe = safe.replace(/\x01(\d+)\x01/g, (_, i) => codes[+i]);
      return safe;
    }).join('\n');
  }

  // ── Fix setext headings: insert blank line before "---"/"===" that follow text ──
  // Without this, "Some text\n---" is parsed as an h2 instead of a horizontal rule.
  {
    const lines = text.split('\n');
    let inFence = false;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; }
      if (!inFence && /^[ \t]*(-{3,}|={3,})[ \t]*$/.test(line) && i > 0 && out.length > 0 && out[out.length - 1].trim() !== '') {
        out.push('');
      }
      out.push(line);
    }
    text = out.join('\n');
  }

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
  //          > YYMMDD @Calendar   (with calendar name)
  {
    const schedRe = /\s*>\s*\d{6}(?:\s+(?:\d{6}|\d{4}\s+\d{4}))?(?:\s+@\S+)?\s*$/;
    const schedLines = text.split('\n');
    const schedOut = [];
    for (let si = 0; si < schedLines.length; si++) {
      const line = schedLines[si];
      if (schedRe.test(line)) {
        let stripped = line.replace(schedRe, '');
        const trimmed = stripped.trimStart();
        const isTask    = /^- \[[ xX]\]\s/.test(trimmed);
        const isList    = /^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed) || /^[a-zA-Z][.)]\s/.test(trimmed);
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
    let prevWasBlankLine = false;

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
        prevWasBlankLine = false;
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
        prevWasBlankLine = true;
        continue;
      }

      const wasBlankBefore = prevWasBlankLine;
      prevWasBlankLine = false;

      const tabMatch = line.match(/^(\t+)(.*)/);
      if (tabMatch) {
        const depth = tabMatch[1].length;
        const content = tabMatch[2];
        const trimmed = content.trimStart();
        const isListItem = /^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed) || /^[a-zA-Z][.)]\s/.test(trimmed) || /^\[[ xX]\]\s/.test(trimmed);
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
          const topMargin = wasBlankBefore ? '1em' : '0.2em';
          out.push(`<p style="padding-left:${depth * 2}em;margin:${topMargin} 0">${rendered}</p>`);
          out.push('');
          prevWasListItem = false;
        }
      } else {
        flushPendingList();
        // Do not propagate prevWasListItem from non-tab lines — tab-indented list
        // items should always start their own grouped block (div wrapper) rather
        // than being folded into a preceding non-tab list as space-indented items.
        prevWasListItem = false;
        out.push(line);
      }
    }
    flushPendingList();
    text = out.join('\n');
  }

  // ── Lettered lists: a. Item / A. Item → <ol type="a/A">...</ol> ──
  // Converts runs of lines starting with a single letter followed by "." or ")"
  // into HTML ordered lists, matching the behaviour of numeric ordered lists.
  // Works at any indentation level, including inside tab-indented <div> wrappers.
  {
    const lines = text.split('\n');
    const out = [];
    let inFence = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; out.push(line); i++; continue; }
      if (inFence) { out.push(line); i++; continue; }
      const m = line.match(/^(\s*)([a-zA-Z])[.)]\s+(.*)$/);
      if (m) {
        const indent = m[1];
        const listType = /[A-Z]/.test(m[2]) ? 'A' : 'a';
        const items = [];
        let j = i;
        while (j < lines.length) {
          const ln = lines[j];
          if (/^[ \t]*(`{3,}|~{3,})/.test(ln)) break;
          const lm = ln.match(/^(\s*)([a-zA-Z])[.)]\s+(.*)$/);
          if (!lm || lm[1] !== indent) break;
          items.push(marked.parseInline(lm[3]));
          j++;
        }
        out.push(`${indent}<ol type="${listType}">`);
        items.forEach(item => out.push(`${indent}<li>${item}</li>`));
        out.push(`${indent}</ol>`);
        out.push('');
        i = j;
      } else {
        out.push(line);
        i++;
      }
    }
    text = out.join('\n');
  }

  // ── Non-task checkboxes: [ ] text and [x] text (without leading "- ") ──
  // These render identically to - [ ] task items (same list structure, same
  // spacing) but are NOT picked up by the task list or treated as tasks.
  // Consecutive plain-checkbox lines are grouped into a single <ul> so their
  // spacing is indistinguishable from a run of - [ ] items.
  {
    const cbLines = text.split('\n');
    let inFence = false;
    const cbOut = [];
    let i = 0;
    while (i < cbLines.length) {
      const line = cbLines[i];
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; cbOut.push(line); i++; continue; }
      if (inFence) { cbOut.push(line); i++; continue; }
      // Match lines starting with [ ] or [x]/[X] that are NOT preceded by "- "
      const m = line.match(/^(\s*)\[( |[xX])\]\s(.*)$/);
      if (m && !/^(\s*)- \[/.test(line)) {
        // Collect all consecutive plain-checkbox lines into one <ul>
        const items = [];
        let j = i;
        while (j < cbLines.length) {
          const ln = cbLines[j];
          if (/^[ \t]*(`{3,}|~{3,})/.test(ln)) break;
          const lm = ln.match(/^(\s*)\[( |[xX])\]\s(.*)$/);
          if (!lm || /^(\s*)- \[/.test(ln)) break;
          const checked = lm[2] !== ' ';
          const checkedAttr = checked ? ' checked' : '';
          // Hide {calendarId} codes at end of item (used in Settings note)
          const rawContent = lm[3].replace(/(\s*\{[^}]+\})\s*$/, '<span style="display:none">$1</span>');
          const content = marked.parseInline(rawContent);
          items.push(`<li><input type="checkbox"${checkedAttr} data-plain-cb> ${content}</li>`);
          j++;
        }
        cbOut.push(`<ul class="contains-task-list plain-cb-list">\n${items.join('\n')}\n</ul>`);
        i = j;
      } else {
        cbOut.push(line);
        i++;
      }
    }
    text = cbOut.join('\n');
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
          e.stopPropagation();
          if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(href);
          }
        });
      } else if (window.Capacitor) {
        // iOS (Capacitor): use App.openUrl so the default browser opens.
        a.removeAttribute('target');
        a.removeAttribute('rel');
        a.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          const App = window.Capacitor?.Plugins?.App;
          if (App) App.openUrl({ url: href });
        });
      } else {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        // Prevent click from bubbling to a parent heading or <summary> element.
        a.addEventListener('click', e => e.stopPropagation());
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
      e.stopPropagation();
      if (await NoteStorage.getNote(noteName) !== null) {
        if (linkedNoteChain.includes(noteName) || noteName === currentFileName) {
          // Target is already in the trail (or is the current note): navigate
          // without modifying the trail order.
          await loadNote(noteName, true);
        } else {
          // Target is a new note in the link chain: push the current note onto
          // the front of the trail and navigate.
          if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
            linkedNoteChain.unshift(currentFileName);
            saveChain();
          }
          await loadNote(noteName, true);
        }
      } else {
        // Clicking a link to a non-existent note creates it and adds it to
        // the trail exactly like navigating to an existing note via a link.
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

  // H1 is never collapsible — it acts as the note title
  const headings = [...container.querySelectorAll('h2,h3,h4,h5,h6')].reverse();

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

// Cache for iOS attachment data URIs — keyed by "noteName/filename".
// Cleared when a different note is rendered.
let _attachmentCache = {};
let _attachmentCacheNote = null;

// Attach open-in-default-app behaviour to an image element.
// Desktop: double-click. Mobile (touch): long-press (~500 ms).
function _attachOpenImageHandler(img, noteName, filename) {
  async function openImage() {
    if (window.electronAPI?.openAttachmentFile) {
      // Desktop: write to temp file and open with OS default app
      const b64 = await NoteStorage.readAttachment(noteName, filename);
      if (!b64) { updateStatus('Could not open image.', false); return; }
      const ok = await window.electronAPI.openAttachmentFile(filename, b64);
      if (!ok) updateStatus('Could not open image in default app.', false);
    } else if (window.Capacitor?.isNativePlatform()) {
      // iOS: reuse share-sheet helper
      await openAttachmentOnIOS(noteName, filename);
    }
  }

  if (window.electronAPI) {
    img.style.cursor = 'zoom-in';
    img.addEventListener('dblclick', (e) => {
      e.preventDefault();
      openImage();
    });
  } else if (window.Capacitor?.isNativePlatform()) {
    let _longPressTimer = null;
    img.addEventListener('touchstart', () => {
      _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        openImage();
      }, 500);
    }, { passive: true });
    img.addEventListener('touchend', () => {
      clearTimeout(_longPressTimer);
      _longPressTimer = null;
    }, { passive: true });
    img.addEventListener('touchmove', () => {
      clearTimeout(_longPressTimer);
      _longPressTimer = null;
    }, { passive: true });
  }
}

async function resolveAttachments(container) {
  if (!currentFileName) return;
  const hasAttachments = typeof NoteStorage.readAttachment === 'function';
  if (!hasAttachments) return;

  // Invalidate cache when switching notes
  if (_attachmentCacheNote !== currentFileName) {
    _attachmentCache = {};
    _attachmentCacheNote = currentFileName;
  }

  const imgEls = [...container.querySelectorAll('img[data-attachment]')];
  await Promise.all(imgEls.map(async img => {
    const filename = img.getAttribute('data-attachment');
    const cacheKey = currentFileName + '/' + filename;
    if (_attachmentCache[cacheKey]) {
      img.src = _attachmentCache[cacheKey];
    } else {
      const b64 = await NoteStorage.readAttachment(currentFileName, filename);
      if (b64) {
        const ext = filename.split('.').pop();
        const dataUri = `data:${mimeForExtension(ext)};base64,${b64}`;
        _attachmentCache[cacheKey] = dataUri;
        img.src = dataUri;
      }
    }
    // Attach open-in-default-app behaviour (dblclick on desktop, long-press on mobile)
    _attachOpenImageHandler(img, currentFileName, filename);
  }));

  for (const link of container.querySelectorAll('a[href^="attachment:"]')) {
    const filename = link.getAttribute('href').slice('attachment:'.length);
    const noteName = currentFileName;
    link.href = '#';
    link.addEventListener('click', async e => {
      e.preventDefault();
      // On iOS, use the share sheet to open attachments
      if (window.Capacitor?.isNativePlatform()) {
        await openAttachmentOnIOS(noteName, filename);
      } else {
        // On desktop, download via data URI
        const b64 = await NoteStorage.readAttachment(noteName, filename);
        if (b64) {
          const ext = filename.split('.').pop();
          const a = document.createElement('a');
          a.href = `data:${mimeForExtension(ext)};base64,${b64}`;
          a.download = filename;
          a.click();
        }
      }
    });
  }
}

async function openAttachmentOnIOS(noteName, filename) {
  try {
    const b64 = await NoteStorage.readAttachment(noteName, filename);
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

function setupPlainCheckboxes(container) {
  const checkboxes = container.querySelectorAll('input[data-plain-cb]');
  checkboxes.forEach(cb => {
    cb.disabled = false;
    cb.addEventListener('change', () => {
      // Find all plain checkboxes in source and toggle the matching one
      const lines = textarea.value.split('\n');
      const plainCbRe = /^(\s*)\[( |[xX])\]\s/;
      let cbIndex = 0;
      const allPlainCbs = container.querySelectorAll('input[data-plain-cb]');
      const targetIdx = Array.from(allPlainCbs).indexOf(cb);

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(plainCbRe);
        if (m && !/^\s*- \[/.test(lines[i])) {
          if (cbIndex === targetIdx) {
            lines[i] = lines[i].replace(plainCbRe, `$1[${cb.checked ? 'x' : ' '}] `);
            break;
          }
          cbIndex++;
        }
      }
      textarea.value = lines.join('\n');
      if (currentFileName) {
        // Update _lastSavedContent immediately so a pending auto-save timer
        // does not overwrite this checkbox toggle with stale content.
        _lastSavedContent = textarea.value;
        NoteStorage.setNote(currentFileName, textarea.value);
      }
      if (isPreview || projectsViewActive) renderPreview(); else refreshHighlight();
    });
  });
}

async function renderMermaidDiagrams(container) {
  const codeBlocks = container.querySelectorAll('pre code.language-mermaid');
  if (codeBlocks.length === 0) return;
  if (!window.mermaid) {
    try {
      await loadScript('vendor/mermaid.min.js');
      if (typeof reinitMermaidTheme === 'function') reinitMermaidTheme();
    } catch { return; }
  }
  // Render all mermaid diagrams in parallel for faster preview
  const renderJobs = Array.from(codeBlocks).map(async (codeEl, idx) => {
    const pre = codeEl.parentElement;
    const source = codeEl.textContent;
    const id = 'mermaid-' + Date.now() + '-' + idx;
    try {
      const { svg } = await mermaid.render(id, source);
      const cleanSvg = svg.replace(/!important/g, '');
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = cleanSvg;
      pre.replaceWith(wrapper);
    } catch {
      // Silently fail - don't replace the code block or show error messages
    }
  });
  await Promise.all(renderJobs);
}

// Per-note collapse state: tracks the open/closed state of collapsible headings
// for the currently displayed note. Cleared whenever a different note is rendered,
// so every fresh note open uses the markdown's default ("> " markers).
let _collapseStateFile = null;
let _collapseState = {};

// Cache: skip re-parsing when content hasn't changed since last render.
let _lastRenderedFile = null;
let _lastRenderedContent = null;
let _lastRenderedHTML = null;

async function renderPreview() {
  // Reset any overflow override left by graph view so normal notes scroll correctly.
  previewDiv.style.overflow = '';

  // Note Graph: delegate entirely to graph-view.js renderer.
  // Invalidate the render cache because renderNoteGraph() clears previewDiv.innerHTML;
  // without this, returning to a previously-rendered note would hit the stale cache
  // and leave previewDiv blank.
  if (currentFileName === GRAPH_NOTE) {
    _lastRenderedHTML = null;
    _lastRenderedFile = null;
    await renderNoteGraph();
    return;
  }

  const _currentContent = textarea.value;

  // Cache hit: the previewDiv DOM is already fully built (it was hidden, not
  // destroyed, when the user switched to edit mode). Event listeners, MathJax
  // typesetting, and resolved attachments are all still intact — return early
  // so toggling back to view is instantaneous for unchanged content.
  if (
    _lastRenderedFile === currentFileName &&
    _lastRenderedContent === _currentContent &&
    _lastRenderedHTML !== null
  ) {
    return;
  }

  // Cache miss: snapshot open/closed state of collapsible sections before
  // wiping the DOM. Only restore the snapshot if we are re-rendering the same
  // note (e.g. a checkbox toggle). When the note changes, start fresh so the
  // markdown's default collapse markers take effect on every new open.
  if (_collapseStateFile === currentFileName) {
    _collapseState = {};
    let _csIdx = 0;
    previewDiv.querySelectorAll('details').forEach(d => {
      const h = d.querySelector('summary h1,summary h2,summary h3,summary h4,summary h5,summary h6');
      if (h) _collapseState[h.tagName + ':' + h.textContent.trim() + ':' + (_csIdx++)] = d.open;
    });
  } else {
    _collapseState = {};
  }
  _collapseStateFile = currentFileName;

  // Capture the note name and generation at the start of rendering so we can
  // detect if the user navigated away during any of the async steps below.
  const _renderTarget = currentFileName;
  const _renderGen = _loadNoteGeneration;

  _lastRenderedHTML = marked.parse(preprocessMarkdown(_currentContent));
  _lastRenderedFile = currentFileName;
  _lastRenderedContent = _currentContent;
  previewDiv.innerHTML = _lastRenderedHTML;
  styleTaskListItems(previewDiv);
  // Collapsible headings must be set up BEFORE note-links so that when
  // setupNoteLinks runs, anchor elements inside <summary> already exist
  // in their final DOM positions and receive click handlers correctly.
  // (cloneNode used inside setupCollapsibleHeadings does not copy listeners.)
  setupCollapsibleHeadings(previewDiv);
  await setupNoteLinks(previewDiv);

  // If the user navigated to a different note while we were awaiting async
  // operations, stop updating the DOM to prevent "back and forth" flicker.
  if (_renderGen !== _loadNoteGeneration || currentFileName !== _renderTarget) return;

  // H1 title: clicking navigates back to the previously accessed note (breadcrumb).
  previewDiv.querySelectorAll('h1').forEach(h1 => {
    if (linkedNoteChain.length > 0) {
      h1.classList.add('note-title-back');
      h1.title = `Back to "${linkedNoteChain[0]}"`;
    }
    h1.addEventListener('click', e => {
      if (e.target.closest('a')) return; // let link clicks pass through unobstructed
      if (linkedNoteChain.length === 0) return;
      const prevNote = linkedNoteChain[0];
      linkedNoteChain = linkedNoteChain.slice(1);
      saveChain();
      loadNote(prevNote, true);
    });
  });

  // Restore collapse state after re-render (only applies to same-note re-renders)
  let _restoreIdx = 0;
  previewDiv.querySelectorAll('details').forEach(d => {
    const h = d.querySelector('summary h1,summary h2,summary h3,summary h4,summary h5,summary h6');
    if (h) {
      const key = h.tagName + ':' + h.textContent.trim() + ':' + (_restoreIdx++);
      if (key in _collapseState) d.open = _collapseState[key];
    }
  });

  alignTableColumns(previewDiv);
  setupPreviewTaskCheckboxes();
  setupPlainCheckboxes(previewDiv);
  await resolveAttachments(previewDiv);

  // Staleness check after attachment resolution (can be slow for many images).
  if (_renderGen !== _loadNoteGeneration || currentFileName !== _renderTarget) return;

  await renderMermaidDiagrams(previewDiv);
  // Lazy-load MathJax only when the note contains math syntax.
  // Check for typesetPromise (not just window.MathJax) because window.MathJax
  // is pre-set to a config object in index.html before the script loads.
  if (!window.MathJax?.typesetPromise && /\$\$[\s\S]+?\$\$|\$[^\n$]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(textarea.value)) {
    try {
      await loadScript('vendor/tex-chtml-full.js');
    } catch { /* MathJax failed to load */ }
  }
  if (window.MathJax?.typesetPromise) {
    // Await typesetting so setupClickableMathFormulas runs after the mjx-container
    // elements exist, and doesn't race against isPreview being set by the caller.
    await MathJax.typesetPromise([previewDiv]);
    if (_renderGen !== _loadNoteGeneration || currentFileName !== _renderTarget) return;
    markOverflowingMathContainers();
    setupClickableMathFormulas();
  }

  // Settings note: inject interactive controls
  if (currentFileName === CALENDARS_NOTE) {
    injectSyncSettings(previewDiv);
    injectCalendarColorPickers(previewDiv);
    injectThemeColorPickers(previewDiv);
    injectProjectEmojiPickers(previewDiv);
  }
}

// ── Sync settings UI in Settings note preview ────────────────────────────
// Injects an interactive sign-in / status panel into the "☁️ Sync" section.

function injectSyncSettings(container) {
  // Find the <details> wrapping the "Sync" h2
  let syncSection = null;
  for (const details of container.querySelectorAll('details')) {
    const h = details.querySelector('summary h2');
    if (h && h.textContent.includes('Sync')) { syncSection = details; break; }
  }
  if (!syncSection) {
    for (const h of container.querySelectorAll('h2')) {
      if (h.textContent.includes('Sync')) { syncSection = h.parentElement; break; }
    }
  }
  if (!syncSection) return;
  if (syncSection.querySelector('.sync-controls')) return; // already injected

  const helpers = window._syncHelpers; // set by powersync-storage.js on Desktop/iOS

  const wrap = document.createElement('div');
  wrap.className = 'sync-controls';

  // ── Web: sync not available ──────────────────────────────────────────────
  if (!helpers || !helpers.available) {
    const msg = document.createElement('p');
    msg.className = 'sync-status-msg';
    msg.textContent = 'Sync is available in the desktop and iOS apps.';
    wrap.appendChild(msg);
    _appendSyncControls(syncSection, wrap);
    return;
  }

  // ── Sync enabled + authenticated: show status and sign-out ──────────────
  if (helpers.enabled && helpers.authenticated) {
    _buildSignedInView(wrap, helpers);
    _appendSyncControls(syncSection, wrap);
    return;
  }

  // ── Sync enabled but not signed in: show sign-in form ───────────────────
  if (helpers.enabled && !helpers.authenticated) {
    _buildSignInForm(wrap, helpers);
    _appendSyncControls(syncSection, wrap);
    return;
  }

  // ── Sync disabled: show enable button ───────────────────────────────────
  const desc = document.createElement('p');
  desc.className = 'sync-status-msg';
  desc.textContent = 'Sync is currently off. Enable it to back up and sync notes across devices.';
  wrap.appendChild(desc);

  const enableBtn = document.createElement('button');
  enableBtn.className = 'sync-btn sync-btn-primary';
  enableBtn.textContent = 'Enable Sync';
  enableBtn.addEventListener('click', async () => {
    enableBtn.disabled = true;
    enableBtn.textContent = 'Enabling\u2026';
    await helpers.enable(); // reloads the page
  });
  wrap.appendChild(enableBtn);

  _appendSyncControls(syncSection, wrap);
}

function _buildSignedInView(wrap, helpers) {
  const statusRow = document.createElement('div');
  statusRow.className = 'sync-status-row';

  const dot = document.createElement('span');
  dot.className = 'sync-dot sync-dot-active';
  statusRow.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'sync-status-label';
  label.textContent = helpers.userEmail
    ? `Syncing as ${helpers.userEmail}`
    : 'Sync active';
  statusRow.appendChild(label);
  wrap.appendChild(statusRow);

  const signOutBtn = document.createElement('button');
  signOutBtn.className = 'sync-btn sync-btn-secondary';
  signOutBtn.textContent = 'Sign Out & Disable Sync';
  signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    signOutBtn.textContent = 'Signing out\u2026';
    await helpers.disable(); // signs out + reloads
  });
  wrap.appendChild(signOutBtn);
}

function _buildSignInForm(wrap, helpers) {
  let pendingEmail = '';

  // --- Email step ---
  const emailStep = document.createElement('div');
  emailStep.className = 'sync-step';

  const emailDesc = document.createElement('p');
  emailDesc.className = 'sync-status-msg';
  emailDesc.textContent = 'Enter your email to receive a sign-in link.';
  emailStep.appendChild(emailDesc);

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = 'you@example.com';
  emailInput.className = 'sync-email-input';
  emailInput.autocomplete = 'email';
  emailStep.appendChild(emailInput);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'sync-btn sync-btn-primary';
  sendBtn.textContent = 'Send Sign-In Link';
  emailStep.appendChild(sendBtn);

  const errorEl = document.createElement('p');
  errorEl.className = 'sync-error';
  errorEl.style.display = 'none';
  emailStep.appendChild(errorEl);

  wrap.appendChild(emailStep);

  // --- Waiting step (shown after link is sent) ---
  const waitStep = document.createElement('div');
  waitStep.className = 'sync-step';
  waitStep.style.display = 'none';

  const waitMsg = document.createElement('p');
  waitMsg.className = 'sync-wait-msg';
  wrap.appendChild(waitStep);

  const otpToggle = document.createElement('button');
  otpToggle.className = 'sync-otp-toggle';
  otpToggle.textContent = 'I have a code instead';

  const otpRow = document.createElement('div');
  otpRow.className = 'sync-otp-row';
  otpRow.style.display = 'none';

  const otpInput = document.createElement('input');
  otpInput.type = 'text';
  otpInput.placeholder = 'Enter 6-digit code';
  otpInput.className = 'sync-email-input';
  otpInput.inputMode = 'numeric';
  otpInput.maxLength = 6;
  otpInput.autocomplete = 'one-time-code';

  const verifyBtn = document.createElement('button');
  verifyBtn.className = 'sync-btn sync-btn-primary';
  verifyBtn.textContent = 'Verify Code';

  const otpError = document.createElement('p');
  otpError.className = 'sync-error';
  otpError.style.display = 'none';

  otpRow.appendChild(otpInput);
  otpRow.appendChild(verifyBtn);
  otpRow.appendChild(otpError);

  const resendBtn = document.createElement('button');
  resendBtn.className = 'sync-otp-toggle';
  resendBtn.textContent = 'Resend link';

  waitStep.appendChild(waitMsg);
  waitStep.appendChild(otpToggle);
  waitStep.appendChild(otpRow);
  waitStep.appendChild(resendBtn);

  const disableBtn = document.createElement('button');
  disableBtn.className = 'sync-btn sync-btn-secondary';
  disableBtn.style.marginTop = '8px';
  disableBtn.textContent = 'Disable Sync';
  disableBtn.addEventListener('click', async () => {
    disableBtn.disabled = true;
    await helpers.disable();
  });
  wrap.appendChild(disableBtn);

  // ── Event handlers ───────────────────────────────────────────────────────

  sendBtn.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    pendingEmail = emailInput.value.trim();
    if (!pendingEmail) {
      errorEl.textContent = 'Please enter your email address.';
      errorEl.style.display = 'block';
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending\u2026';
    try {
      await helpers.sendMagicLink(pendingEmail);
      emailStep.style.display = 'none';
      waitMsg.textContent = `Check your email (${pendingEmail}) and click the sign-in link. This page will update automatically once you're signed in.`;
      waitStep.style.display = 'block';
      // Listen for sign-in event (fired by onAuthStateChange after magic link click)
      helpers.onAuthStateChange((event, _session) => {
        if (event === 'SIGNED_IN') {
          waitMsg.textContent = 'Signed in successfully! Reloading\u2026';
        }
      });
    } catch (e) {
      errorEl.textContent = e.message || 'Failed to send link. Please try again.';
      errorEl.style.display = 'block';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Sign-In Link';
    }
  });

  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });

  resendBtn.addEventListener('click', async () => {
    if (!pendingEmail) { waitStep.style.display = 'none'; emailStep.style.display = 'block'; return; }
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending\u2026';
    try {
      await helpers.sendMagicLink(pendingEmail);
      waitMsg.textContent = `Link resent to ${pendingEmail}. Check your email and click the sign-in link.`;
    } catch (e) {
      waitMsg.textContent = `Failed to resend: ${e.message || 'please try again.'}`;
    } finally {
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend link';
    }
  });

  otpToggle.addEventListener('click', () => {
    const open = otpRow.style.display !== 'none';
    otpRow.style.display = open ? 'none' : 'block';
    otpToggle.textContent = open ? 'I have a code instead' : 'Hide code field';
    if (!open) otpInput.focus();
  });

  verifyBtn.addEventListener('click', async () => {
    otpError.style.display = 'none';
    const code = otpInput.value.trim();
    if (!code) {
      otpError.textContent = 'Please enter the code.';
      otpError.style.display = 'block';
      return;
    }
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying\u2026';
    try {
      await helpers.verifyOtp(pendingEmail, code);
      // onAuthStateChange will fire and reload
    } catch (e) {
      otpError.textContent = e.message || 'Invalid code. Please try again.';
      otpError.style.display = 'block';
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify Code';
    }
  });

  otpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyBtn.click();
  });
}

function _appendSyncControls(section, wrap) {
  const lists = section.querySelectorAll('ul, ol, p');
  const lastEl = lists.length > 0 ? lists[lists.length - 1] : null;
  if (lastEl && lastEl.nextSibling) {
    section.insertBefore(wrap, lastEl.nextSibling);
  } else {
    section.appendChild(wrap);
  }
}

// ── Calendar colour pickers in Settings note preview ─────────────────────

function injectCalendarColorPickers(container) {
  // Headings are wrapped in <details> by setupCollapsibleHeadings.
  // Find the <details> containing the "📅 Calendars" h2.
  let calDetails = null;
  for (const details of container.querySelectorAll('details')) {
    const h = details.querySelector('summary h2');
    if (h && h.textContent.includes('Calendars')) { calDetails = details; break; }
  }
  // Fall back to plain h2 if not collapsible
  if (!calDetails) {
    for (const h of container.querySelectorAll('h2')) {
      if (h.textContent.includes('Calendars')) { calDetails = h.parentElement; break; }
    }
  }
  if (!calDetails) return;

  const colors = getCalendarColors();

  calDetails.querySelectorAll('li').forEach(li => {
    // Skip if already processed
    if (li.querySelector('.calendar-color-picker')) return;

    // Remove hidden {id} span but note its text for later restoration
    const hiddenSpan = li.querySelector('span[style*="display:none"]');
    const hiddenText = hiddenSpan ? hiddenSpan.textContent : null;
    if (hiddenSpan) hiddenSpan.remove();

    // Calendar name is the text content (after removing hidden span)
    const calName = li.textContent.trim();
    if (!calName) return;

    const savedColor = colors[calName] || '#a272b0';

    // Wrap text nodes in a coloured span (leave the checkbox element in place)
    const nameSpan = document.createElement('span');
    nameSpan.className = 'calendar-name-label';
    nameSpan.style.color = savedColor;

    // Move non-input child nodes into the nameSpan
    const childNodes = Array.from(li.childNodes).filter(
      n => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'INPUT')
    );
    childNodes.forEach(n => nameSpan.appendChild(n));
    li.appendChild(nameSpan);

    // Restore hidden span after nameSpan (so checkbox toggle logic still works)
    if (hiddenText !== null) {
      const restore = document.createElement('span');
      restore.style.display = 'none';
      restore.textContent = hiddenText;
      li.appendChild(restore);
    }

    // Colour picker
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = savedColor;
    picker.className = 'calendar-color-picker';
    picker.title = `Colour for ${calName}`;
    li.appendChild(picker);

    picker.addEventListener('input', () => {
      nameSpan.style.color = picker.value;
    });
    picker.addEventListener('change', () => {
      setCalendarColor(calName, picker.value);
      nameSpan.style.color = picker.value;
      // Rebuild schedule immediately with new colour
      invalidateScheduleCache();
    });
  });
}

// ── Theme colour pickers in Settings note preview ────────────────────────

function injectThemeColorPickers(container) {
  // Find the <details> containing the "Theme" h2
  let themeSection = null;
  for (const details of container.querySelectorAll('details')) {
    const h = details.querySelector('summary h2');
    if (h && h.textContent.includes('Theme')) { themeSection = details; break; }
  }
  // Fall back to plain h2 if not collapsible
  if (!themeSection) {
    for (const h of container.querySelectorAll('h2')) {
      if (h.textContent.includes('Theme')) { themeSection = h.parentElement; break; }
    }
  }
  if (!themeSection) return;

  // Find or create the controls container
  if (themeSection.querySelector('.theme-controls')) return;

  const theme = getCurrentTheme();
  const defaults = getDefaultTheme();

  const controls = document.createElement('div');
  controls.className = 'theme-controls';
  controls.style.cssText = 'padding: 8px 0;';

  // Background picker
  const bgRow = document.createElement('div');
  bgRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
  const bgLabel = document.createElement('span');
  bgLabel.className = 'theme-label';
  bgLabel.textContent = 'Background';
  const bgPicker = document.createElement('input');
  bgPicker.type = 'color';
  bgPicker.value = theme.background;
  bgPicker.className = 'theme-color-picker';
  bgPicker.title = 'Background colour';
  bgRow.appendChild(bgLabel);
  bgRow.appendChild(bgPicker);
  controls.appendChild(bgRow);

  // Accent picker
  const acRow = document.createElement('div');
  acRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
  const acLabel = document.createElement('span');
  acLabel.className = 'theme-label';
  acLabel.textContent = 'Accent';
  const acPicker = document.createElement('input');
  acPicker.type = 'color';
  acPicker.value = theme.accent;
  acPicker.className = 'theme-color-picker';
  acPicker.title = 'Accent colour';
  acRow.appendChild(acLabel);
  acRow.appendChild(acPicker);
  controls.appendChild(acRow);

  // Reset button
  const resetBtn = document.createElement('button');
  resetBtn.className = 'theme-reset-btn';
  resetBtn.textContent = 'Reset to Default';
  controls.appendChild(resetBtn);

  // Insert controls after the last direct-child block element in the section.
  // querySelectorAll without :scope> would include descendants inside nested
  // <details>, whose nextSibling is not a child of themeSection and would
  // throw a NotFoundError on insertBefore.
  const lists = themeSection.querySelectorAll(':scope > ul, :scope > ol, :scope > p');
  const lastList = lists.length > 0 ? lists[lists.length - 1] : null;
  if (lastList && lastList.nextSibling) {
    themeSection.insertBefore(controls, lastList.nextSibling);
  } else {
    themeSection.appendChild(controls);
  }

  // Live preview on input, save on change
  function applyFromPickers() {
    applyTheme(bgPicker.value, acPicker.value);
  }

  bgPicker.addEventListener('input', applyFromPickers);
  acPicker.addEventListener('input', applyFromPickers);

  bgPicker.addEventListener('change', () => {
    applyTheme(bgPicker.value, acPicker.value);
    saveTheme(bgPicker.value, acPicker.value);
    if (typeof syncThemeToNote === 'function') syncThemeToNote();
    reinitMermaidTheme();
  });
  acPicker.addEventListener('change', () => {
    applyTheme(bgPicker.value, acPicker.value);
    saveTheme(bgPicker.value, acPicker.value);
    if (typeof syncThemeToNote === 'function') syncThemeToNote();
    reinitMermaidTheme();
  });

  resetBtn.addEventListener('click', () => {
    resetTheme();
    bgPicker.value = defaults.background;
    acPicker.value = defaults.accent;
    if (typeof syncThemeToNote === 'function') syncThemeToNote();
    reinitMermaidTheme();
  });
}

// ── Project emoji pickers in Settings note preview ──────────────────────────

function injectProjectEmojiPickers(container) {
  // Find the <details> containing the "Projects Note Emojis" heading (h2 or h3).
  // The section is a top-level ## (h2) alongside Sync and Theme; h3 is also
  // accepted for backwards compatibility with older Settings note content.
  let emojiSection = null;
  for (const details of container.querySelectorAll('details')) {
    const h = details.querySelector('summary h2, summary h3');
    if (h && h.textContent.includes('Projects Note Emojis')) { emojiSection = details; break; }
  }
  // Fall back to plain h2/h3 if not collapsible
  if (!emojiSection) {
    for (const h of container.querySelectorAll('h2, h3')) {
      if (h.textContent.includes('Projects Note Emojis')) { emojiSection = h.parentElement; break; }
    }
  }
  if (!emojiSection) return;

  // Don't inject twice
  if (emojiSection.querySelector('.emoji-controls')) return;

  const emojis = getProjectEmojis();
  const defaults = DEFAULT_PROJECT_EMOJIS;

  const controls = document.createElement('div');
  controls.className = 'emoji-controls';
  controls.style.cssText = 'padding: 8px 0;';

  // Active emoji picker
  const activeRow = document.createElement('div');
  activeRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;';
  const activeLabel = document.createElement('span');
  activeLabel.className = 'theme-label';
  activeLabel.textContent = 'Ongoing Projects';
  activeRow.appendChild(activeLabel);

  const activeWrapper = document.createElement('div');
  activeWrapper.style.cssText = 'display:inline-block;';

  const activeEmojiBtn = document.createElement('button');
  activeEmojiBtn.className = 'emoji-display';
  activeEmojiBtn.textContent = emojis.active;
  activeEmojiBtn.style.cssText = 'font-size:24px;width:32px;height:32px;border:none;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;';

  let activePickerOpen = false;
  const activePickerGrid = document.createElement('div');
  activePickerGrid.className = 'emoji-picker-grid';
  activePickerGrid.style.cssText = 'display:none;position:fixed;grid-template-columns:repeat(auto-fill,32px);gap:6px;padding:6px;background:var(--bg);border:none;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9999;';

  for (const emoji of EMOJI_OPTIONS.active) {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.style.cssText = 'font-size:24px;width:32px;height:32px;border:none;background:none;cursor:pointer;transition:transform 0.15s;padding:0;line-height:1;';
    btn.addEventListener('click', () => {
      setProjectEmoji('active', emoji);
      activeEmojiBtn.textContent = emoji;
      activePickerOpen = false;
      activePickerGrid.style.display = 'none';
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.2)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
    activePickerGrid.appendChild(btn);
  }

  activeEmojiBtn.addEventListener('click', () => {
    activePickerOpen = !activePickerOpen;
    completedPickerGrid.style.display = 'none';
    completedPickerOpen = false;
    if (activePickerOpen) {
      const rect = activeEmojiBtn.getBoundingClientRect();
      const w = Math.min(240, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
      activePickerGrid.style.width = w + 'px';
      activePickerGrid.style.left = left + 'px';
      activePickerGrid.style.top = rect.top + 'px';
      activePickerGrid.style.display = 'grid';
    } else {
      activePickerGrid.style.display = 'none';
    }
  });

  activeWrapper.appendChild(activeEmojiBtn);
  activeWrapper.appendChild(activePickerGrid);
  activeRow.appendChild(activeWrapper);
  controls.appendChild(activeRow);

  // Completed emoji picker
  const completedRow = document.createElement('div');
  completedRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;';
  const completedLabel = document.createElement('span');
  completedLabel.className = 'theme-label';
  completedLabel.textContent = 'Completed Projects';
  completedRow.appendChild(completedLabel);

  const completedWrapper = document.createElement('div');
  completedWrapper.style.cssText = 'display:inline-block;';

  const completedEmojiBtn = document.createElement('button');
  completedEmojiBtn.className = 'emoji-display';
  completedEmojiBtn.textContent = emojis.completed;
  completedEmojiBtn.style.cssText = 'font-size:24px;width:32px;height:32px;border:none;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;';

  let completedPickerOpen = false;
  const completedPickerGrid = document.createElement('div');
  completedPickerGrid.className = 'emoji-picker-grid';
  completedPickerGrid.style.cssText = 'display:none;position:fixed;grid-template-columns:repeat(auto-fill,32px);gap:6px;padding:6px;background:var(--bg);border:none;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9999;';

  for (const emoji of EMOJI_OPTIONS.completed) {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.style.cssText = 'font-size:24px;width:32px;height:32px;border:none;background:none;cursor:pointer;transition:transform 0.15s;padding:0;line-height:1;';
    btn.addEventListener('click', () => {
      setProjectEmoji('completed', emoji);
      completedEmojiBtn.textContent = emoji;
      completedPickerOpen = false;
      completedPickerGrid.style.display = 'none';
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.2)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
    completedPickerGrid.appendChild(btn);
  }

  completedEmojiBtn.addEventListener('click', () => {
    completedPickerOpen = !completedPickerOpen;
    activePickerGrid.style.display = 'none';
    activePickerOpen = false;
    if (completedPickerOpen) {
      const rect = completedEmojiBtn.getBoundingClientRect();
      const w = Math.min(240, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
      completedPickerGrid.style.width = w + 'px';
      completedPickerGrid.style.left = left + 'px';
      completedPickerGrid.style.top = rect.top + 'px';
      completedPickerGrid.style.display = 'grid';
    } else {
      completedPickerGrid.style.display = 'none';
    }
  });

  completedWrapper.appendChild(completedEmojiBtn);
  completedWrapper.appendChild(completedPickerGrid);
  completedRow.appendChild(completedWrapper);
  controls.appendChild(completedRow);

  // Reset button
  const resetBtn = document.createElement('button');
  resetBtn.className = 'theme-reset-btn';
  resetBtn.textContent = 'Reset to Defaults';
  resetBtn.addEventListener('click', () => {
    resetProjectEmojis();
    activeEmojiBtn.textContent = DEFAULT_PROJECT_EMOJIS.active;
    completedEmojiBtn.textContent = DEFAULT_PROJECT_EMOJIS.completed;
  });
  controls.appendChild(resetBtn);

  // Insert after the last direct-child block element (same :scope > fix as theme pickers).
  const lists = emojiSection.querySelectorAll(':scope > ul, :scope > ol, :scope > p');
  const lastList = lists.length > 0 ? lists[lists.length - 1] : null;
  if (lastList && lastList.nextSibling) {
    emojiSection.insertBefore(controls, lastList.nextSibling);
  } else {
    emojiSection.appendChild(controls);
  }
}

// ── Refresh Settings note UI after sync ───────────────────────────────────
// Called after applySyncedPreferences() to ensure the colour picker circles
// and emoji buttons in the Settings note preview reflect the latest values.

function refreshSettingsPickerUI() {
  if (currentFileName !== CALENDARS_NOTE) return;

  // Theme colour pickers
  const theme = getCurrentTheme();
  for (const picker of previewDiv.querySelectorAll('.theme-color-picker')) {
    if (picker.title === 'Background colour') picker.value = theme.background;
    else if (picker.title === 'Accent colour') picker.value = theme.accent;
  }

  // Calendar colour pickers
  const calColors = getCalendarColors();
  for (const picker of previewDiv.querySelectorAll('.calendar-color-picker')) {
    const calName = picker.title.replace('Colour for ', '');
    if (calColors[calName]) {
      picker.value = calColors[calName];
      // Also update the name-span colour next to the picker
      const nameSpan = picker.closest('li')?.querySelector('.calendar-name-label');
      if (nameSpan) nameSpan.style.color = calColors[calName];
    }
  }

  // Emoji display buttons (order: active first, completed second)
  const emojis = getProjectEmojis();
  const emojiDisplays = previewDiv.querySelectorAll('.emoji-display');
  if (emojiDisplays.length >= 2) {
    emojiDisplays[0].textContent = emojis.active;
    emojiDisplays[1].textContent = emojis.completed;
  }
}

window._refreshSettingsPickerUI = refreshSettingsPickerUI;

async function toggleView() {
  if (currentFileName === PROJECTS_NOTE) return;
  if (isPreview) {
    const scrollRatio = (previewDiv.scrollHeight - previewDiv.clientHeight) > 0
      ? previewDiv.scrollTop / (previewDiv.scrollHeight - previewDiv.clientHeight)
      : 0;
    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
    toggleViewBtn.textContent = 'View';
    isPreview = false;
    localStorage.setItem('is_preview', 'false');
    const maxScroll = textarea.scrollHeight - textarea.clientHeight;
    textarea.scrollTop = maxScroll > 0 ? scrollRatio * maxScroll : 0;
  } else {
    const scrollRatio = (textarea.scrollHeight - textarea.clientHeight) > 0
      ? textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight)
      : 0;
    const cursorOffset = textarea.selectionStart;
    const totalLen = textarea.value.length;

    // Identify which heading section the cursor is in so we can expand it
    // after rendering if it happens to be collapsed.
    const sourceLines = textarea.value.split('\n');
    let charCount = 0;
    let cursorLineIdx = 0;
    for (let li = 0; li < sourceLines.length; li++) {
      if (charCount + sourceLines[li].length >= cursorOffset) { cursorLineIdx = li; break; }
      charCount += sourceLines[li].length + 1;
    }
    let cursorSectionHeading = null;
    let cursorSectionDefaultCollapsed = false;
    for (let li = cursorLineIdx; li >= 0; li--) {
      const hm = sourceLines[li].match(/^#{1,6}\s+(.*?)$/);
      if (hm) {
        // Check if this heading is default-collapsed (has trailing ">")
        cursorSectionDefaultCollapsed = /\s*>\s*$/.test(hm[1]);
        // Strip trailing collapse marker ">" and any injected HTML
        cursorSectionHeading = hm[1].replace(/\s*>\s*$/, '').replace(/<[^>]*>/g, '').trim();
        break;
      }
    }

    // Flush any pending auto-save and apply a pending title rename so the
    // preview and file list immediately reflect the committed note name.
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await autoSaveNote();
    }
    await applyPendingRename();

    await renderPreview();
    previewDiv.style.display = 'block';
    textarea.style.display = 'none';
    toggleViewBtn.textContent = 'Edit';
    isPreview = true;
    localStorage.setItem('is_preview', 'true');

    // Expand any collapsed heading section that contains the cursor position,
    // but only if the heading is not default-collapsed (marked with ">").
    // Respecting default-collapsed markers prevents repeated toggle from
    // permanently uncollapsing sections the user intended to keep collapsed.
    if (cursorSectionHeading && !cursorSectionDefaultCollapsed) {
      for (const d of previewDiv.querySelectorAll('details')) {
        const h = d.querySelector('summary h1,summary h2,summary h3,summary h4,summary h5,summary h6');
        if (h && h.textContent.trim() === cursorSectionHeading) {
          expandCollapsedAncestors(d);
          break;
        }
      }
    }

    const maxScroll = previewDiv.scrollHeight - previewDiv.clientHeight;
    if (maxScroll > 0) previewDiv.scrollTop = scrollRatio * maxScroll;
  }
}
