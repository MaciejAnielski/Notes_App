// markdown-renderer.js — Markdown preprocessing, rendering, and preview.
//
// Handles wiki-links, schedule syntax stripping, collapsible headings,
// highlight syntax, indentation, footnotes, note links, table alignment,
// attachment resolution, and the preview toggle.

// Matches the opening/closing line of a fenced code block (``` or ~~~).
const _FENCE_RE    = /^[ \t]*(`{3,}|~{3,})/;
const _PLAIN_CB_RE = /^(\s*)\[( |[xX])\]\s/;

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

      // If the checkbox was inside a <p> (loose/spaced list), hoist it out so it
      // becomes a direct flex child of <li>. This lets align-items:center on the
      // flex container properly centre the checkbox against the text, instead of
      // leaving it in inline flow where vertical-align:baseline makes it sit too high.
      if (checkbox.parentElement !== li) {
        const p = checkbox.parentElement;
        p.removeChild(checkbox);
        li.insertBefore(checkbox, p);
      }

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
      // Consolidate all content after the checkbox into a single span so that
      // gap: 0.35em on the flex container only creates one gap (between the
      // checkbox and the text), rather than fragmenting inline text nodes and
      // elements (bold, italic, code, links) into separate flex items.
      // Checkbox is always a direct child at this point (hoisted above if needed).
      {
        // Collect siblings that are text content — skip task-status-dot, which
        // must stay as a direct flex child so margin-left:auto keeps it at the
        // right edge of the task list panel.
        const toWrap = [];
        let node = checkbox.nextSibling;
        while (node) {
          if (!(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('task-status-dot'))) {
            toWrap.push(node);
          }
          node = node.nextSibling;
        }
        const alreadyWrapped =
          toWrap.length === 1 &&
          toWrap[0].nodeType === Node.ELEMENT_NODE &&
          toWrap[0].classList.contains('task-text');
        if (toWrap.length > 0 && !alreadyWrapped) {
          const wrapper = document.createElement('span');
          wrapper.className = 'task-text';
          toWrap.forEach(n => wrapper.appendChild(n));
          // Insert before the dot (if any) so flex order is [checkbox][task-text][dot]
          const dot = li.querySelector(':scope > .task-status-dot');
          dot ? li.insertBefore(wrapper, dot) : li.appendChild(wrapper);
        }
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
      if (_FENCE_RE.test(line)) { inFence = !inFence; return line; }
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
      if (_FENCE_RE.test(line)) { inFence = !inFence; }
      if (!inFence && /^[ \t]*(-{3,}|={3,})[ \t]*$/.test(line) && i > 0 && out.length > 0 && out[out.length - 1].trim() !== '') {
        out.push('');
      }
      out.push(line);
    }
    text = out.join('\n');
  }

  // ── Wiki links (supports [[note##heading]] heading-link syntax) ──
  // Two or more consecutive hashes separate the note name from the heading text.
  // The heading is stripped when resolving the target note for graph/link purposes.
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const trimmed = inner.trim();
    const hashMatch = trimmed.match(/^([^#]+)(#{2,})(.+)$/);
    if (hashMatch) {
      const notePart  = hashMatch[1].trim();
      const headingPart = hashMatch[3].trim();
      const display = notePart.replace(/_/g, ' ') + ' › ' + headingPart.replace(/_/g, ' ');
      const href = encodeURIComponent(trimmed);
      return `[${display}](${href})`;
    }
    const display = trimmed.replace(/_/g, ' ');
    const href = encodeURIComponent(trimmed);
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
      if (_FENCE_RE.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    }).join('\n');
  }

  // ── Empty blockquote lines: ensure bare ">" renders as an empty blockquote ──
  // A ">" with nothing after it (or only spaces/tabs) produces no visible output
  // from the parser. Appending a zero-width space (U+200B) gives the parser
  // non-empty content while keeping the rendered line visually blank.
  {
    text = text.replace(/^( {0,3}>)[ \t]*$/gm, '$1 ​');
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
      if (_FENCE_RE.test(line)) {
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
      if (_FENCE_RE.test(line)) { inFence = !inFence; out.push(line); i++; continue; }
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
      if (_FENCE_RE.test(line)) { inFence = !inFence; cbOut.push(line); i++; continue; }
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

// Scroll the preview to a heading whose text matches headingText.
// Opens any collapsed <details> ancestors so the heading is reachable.
function _scrollToHeading(headingText) {
  const target = headingText.toLowerCase();
  const headings = previewDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of headings) {
    if (h.textContent.trim().toLowerCase() === target) {
      // Open all ancestor <details> so the heading is visible
      let el = h.parentElement;
      while (el && el !== previewDiv) {
        if (el.tagName === 'DETAILS') el.open = true;
        el = el.parentElement;
      }
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
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
    // Detect [[note##heading]] links: 2+ hashes separate the note name from heading.
    const decoded = decodeURIComponent(href);
    const headingHashMatch = decoded.match(/^([^#]+)(#{2,})(.+)$/);
    const noteName   = headingHashMatch
      ? headingHashMatch[1].replace(/_/g, ' ').trim()
      : decoded.replace(/_/g, ' ').trim();
    const headingText = headingHashMatch
      ? headingHashMatch[3].replace(/_/g, ' ').trim()
      : null;

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
        // Scroll to heading after note loads (handles both cached and fresh renders)
        if (headingText) requestAnimationFrame(() => _scrollToHeading(headingText));
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
      let cbIndex = 0;
      const allPlainCbs = container.querySelectorAll('input[data-plain-cb]');
      const targetIdx = Array.from(allPlainCbs).indexOf(cb);

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(_PLAIN_CB_RE);
        if (m && !/^\s*- \[/.test(lines[i])) {
          if (cbIndex === targetIdx) {
            lines[i] = lines[i].replace(_PLAIN_CB_RE, `$1[${cb.checked ? 'x' : ' '}] `);
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

// ── Mermaid pan/zoom ──────────────────────────────────────────────────────
// Adds a small toggle button to each mermaid diagram wrapper. Clicking it
// enters pan/zoom mode where the user can drag to pan and scroll/pinch to zoom.
// Clicking again exits and resets the transform.

function setupMermaidPanZoom(wrapper) {
  const svg = wrapper.querySelector('svg');
  if (!svg) return;

  // Toggle button — top-left corner, always visible
  const btn = document.createElement('button');
  btn.className = 'mermaid-panzoom-btn';
  btn.title = 'Pan & zoom';
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  wrapper.appendChild(btn);

  let active = false;
  let scale = 1, panX = 0, panY = 0;
  let dragging = false, lastX = 0, lastY = 0;
  let lastPinchDist = null;
  // Inline styles saved before expanding, restored on exit
  let savedStyles = {};
  // ResizeObserver watches the anchor element so the overlay re-positions
  // whenever the editor area changes size (window resize, sidebar pin/unpin, etc.)
  let anchorResizeObserver = null;

  function applyTransform() {
    svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  // ── Expand wrapper to fill the visible edit/view area ───────────────────
  // Uses position:fixed anchored to #editor-section so it works regardless
  // of how far the preview has been scrolled.

  function applyFullAreaLayout() {
    const anchor = document.getElementById('editor-section') || document.getElementById('preview');
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    wrapper.style.position = 'fixed';
    wrapper.style.top      = r.top    + 'px';
    wrapper.style.left     = r.left   + 'px';
    wrapper.style.width    = r.width  + 'px';
    wrapper.style.height   = r.height + 'px';
    wrapper.style.margin   = '0';
  }

  function onResize() {
    if (active) applyFullAreaLayout();
  }

  // ── Mouse handlers ──────────────────────────────────────────────────────

  function onMouseDown(e) {
    if (e.target === btn || e.target.closest('.mermaid-panzoom-btn')) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    wrapper.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!dragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    wrapper.style.cursor = 'grab';
  }

  // ── Wheel / trackpad pinch handler ──────────────────────────────────────
  // Uses a continuous exponential factor so trackpad pinch is smooth.
  // deltaMode 1 (LINE) deltas are normalised to pixel equivalents first.

  function doZoom(e) {
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 20; // line → pixels
    dy = Math.max(-80, Math.min(80, dy)); // clamp large single steps
    const factor = Math.exp(-dy * 0.008);
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left - panX;
    const cy = e.clientY - rect.top  - panY;
    scale = Math.max(0.1, Math.min(10, scale * factor));
    panX -= cx * (factor - 1);
    panY -= cy * (factor - 1);
    applyTransform();
  }

  function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    doZoom(e);
  }

  // Global interceptor: catches trackpad pinch (wheel + ctrlKey) anywhere on
  // the page while pan/zoom is active and prevents the browser from zooming.
  // Must be registered with passive:false on window to be able to preventDefault.
  function globalPinchInterceptor(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    doZoom(e);
  }

  // ── Touch handlers ──────────────────────────────────────────────────────

  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onTouchStart(e) {
    if (e.target === btn || e.target.closest('.mermaid-panzoom-btn')) return;
    if (e.touches.length === 1) {
      dragging = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      lastPinchDist = null;
    } else if (e.touches.length === 2) {
      dragging = false;
      lastPinchDist = touchDist(e.touches);
    }
    e.preventDefault();
  }

  function onTouchMove(e) {
    if (e.touches.length === 1 && dragging) {
      panX += e.touches[0].clientX - lastX;
      panY += e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      applyTransform();
    } else if (e.touches.length === 2 && lastPinchDist !== null) {
      const dist   = touchDist(e.touches);
      const factor = dist / lastPinchDist;
      const rect   = wrapper.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left - panX;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top  - panY;
      scale = Math.max(0.1, Math.min(10, scale * factor));
      panX -= mx * (factor - 1);
      panY -= my * (factor - 1);
      lastPinchDist = dist;
      applyTransform();
    }
    e.preventDefault();
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) lastPinchDist = null;
    if (e.touches.length === 0) dragging = false;
  }

  // ── Enter / exit ────────────────────────────────────────────────────────

  function enter() {
    active = true;
    btn.classList.add('active');
    btn.title = 'Exit pan & zoom';
    svg.style.transformOrigin = '0 0';

    // Save current inline styles so we can restore them exactly on exit
    savedStyles = {
      position: wrapper.style.position,
      top:      wrapper.style.top,
      left:     wrapper.style.left,
      width:    wrapper.style.width,
      height:   wrapper.style.height,
      margin:   wrapper.style.margin,
      zIndex:   wrapper.style.zIndex,
      overflow: wrapper.style.overflow,
      cursor:   wrapper.style.cursor,
    };

    wrapper.classList.add('mermaid-panzoom-active');
    applyFullAreaLayout();
    // z-index 4: sits above normal preview content but below the status area
    // (z-index 5), side panel (z-index 50+), and toolbar (z-index 100) so
    // that all UI chrome remains visible — matching the editor/view container.
    wrapper.style.zIndex   = '4';
    wrapper.style.overflow = 'hidden';
    wrapper.style.cursor   = 'grab';

    // Prevent scroll behind the overlay
    const previewEl = document.getElementById('preview');
    if (previewEl) previewEl.dataset.pzSavedOverflow = previewEl.style.overflow || '';

    // Watch the anchor element for size changes so the overlay repositions
    // on both window resize and sidebar pin/unpin (which changes the
    // editor area's width via body.panel-pinned padding-right).
    const anchorEl = document.getElementById('editor-section') || document.getElementById('preview');
    if (anchorEl && window.ResizeObserver) {
      anchorResizeObserver = new ResizeObserver(() => { if (active) applyFullAreaLayout(); });
      anchorResizeObserver.observe(anchorEl);
    } else {
      // Fallback for browsers without ResizeObserver (handles window resize only)
      window.addEventListener('resize', onResize);
    }
    // Intercept trackpad pinch (ctrlKey+wheel) at the window level so the
    // browser cannot use it to zoom the page while pan/zoom mode is active.
    window.addEventListener('wheel', globalPinchInterceptor, { passive: false });
    wrapper.addEventListener('mousedown',  onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    wrapper.addEventListener('wheel',      onWheel,      { passive: false });
    wrapper.addEventListener('touchstart', onTouchStart, { passive: false });
    wrapper.addEventListener('touchmove',  onTouchMove,  { passive: false });
    wrapper.addEventListener('touchend',   onTouchEnd,   { passive: true });
  }

  function exit() {
    active = false;
    btn.classList.remove('active');
    btn.title = 'Pan & zoom';
    wrapper.classList.remove('mermaid-panzoom-active');

    // Restore wrapper to its original inline styles
    Object.assign(wrapper.style, savedStyles);
    savedStyles = {};

    scale = 1; panX = 0; panY = 0;
    svg.style.transform = '';
    svg.style.transformOrigin = '';

    const previewEl = document.getElementById('preview');
    if (previewEl && previewEl.dataset.pzSavedOverflow !== undefined) {
      previewEl.style.overflow = previewEl.dataset.pzSavedOverflow;
      delete previewEl.dataset.pzSavedOverflow;
    }

    if (anchorResizeObserver) {
      anchorResizeObserver.disconnect();
      anchorResizeObserver = null;
    } else {
      window.removeEventListener('resize', onResize);
    }
    window.removeEventListener('wheel',  globalPinchInterceptor);
    wrapper.removeEventListener('mousedown',  onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
    wrapper.removeEventListener('wheel',      onWheel);
    wrapper.removeEventListener('touchstart', onTouchStart);
    wrapper.removeEventListener('touchmove',  onTouchMove);
    wrapper.removeEventListener('touchend',   onTouchEnd);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    active ? exit() : enter();
  });
}

async function renderMermaidDiagrams(container, varMap) {
  const codeBlocks = container.querySelectorAll('pre code.language-mermaid');
  if (codeBlocks.length === 0) return;
  if (!window.mermaid) return;
  // Render all mermaid diagrams in parallel for faster preview
  const renderJobs = Array.from(codeBlocks).map(async (codeEl, idx) => {
    const pre = codeEl.parentElement;
    const rawSource = codeEl.textContent;
    const source = (varMap && Object.keys(varMap).length > 0)
      ? substituteVarsInMermaid(rawSource, varMap)
      : rawSource;
    const id = 'mermaid-' + Date.now() + '-' + idx;
    try {
      const { svg } = await mermaid.render(id, source);
      const cleanSvg = svg.replace(/!important/g, '');
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = cleanSvg;
      pre.replaceWith(wrapper);
      setupMermaidPanZoom(wrapper);
    } catch {
      // Silently fail - don't replace the code block or show error messages
    }
  });
  await Promise.all(renderJobs);
}

// ── Clickable emoji pickers in Projects note preview ──────────────────────────
// Wraps the leading emoji in each Projects-note heading with a clickable span.
// Clicking shows a floating picker; choosing a new emoji updates all headings
// of that type across the note (via setProjectEmoji → refreshProjectsNote).

function injectProjectNoteEmojiPickers(container) {
  // Determine emoji type from heading text content
  const TYPE_MAP = [
    { pattern: 'Ongoing',   type: 'active' },
    { pattern: 'Completed', type: 'completed' },
    { pattern: 'Winter',    type: 'Winter' },
    { pattern: 'Spring',    type: 'Spring' },
    { pattern: 'Summer',    type: 'Summer' },
    { pattern: 'Autumn',    type: 'Autumn' },
  ];

  let openPicker = null;

  // Close the open picker when clicking anywhere else
  function closeOpenPicker(e) {
    if (!openPicker) return;
    if (!e.target.closest('.project-emoji-btn') && !e.target.closest('.project-emoji-picker')) {
      openPicker.style.display = 'none';
      openPicker = null;
    }
  }
  document.addEventListener('click', closeOpenPicker);

  // Clean up listener when the previewDiv is next replaced
  const origInnerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  // Simpler: store cleanup on the container so renderPreview can call it
  container._emojiPickerCleanup = () => document.removeEventListener('click', closeOpenPicker);

  const headings = container.querySelectorAll('h2, h3, h4, h5, h6');

  headings.forEach(heading => {
    const text = heading.textContent;

    let emojiType = null;
    for (const { pattern, type } of TYPE_MAP) {
      if (text.includes(pattern)) { emojiType = type; break; }
    }
    if (!emojiType) return;

    // Find the first text node containing content (the leading emoji + label)
    const textNode = Array.from(heading.childNodes).find(
      n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
    );
    if (!textNode) return;

    const nodeText = textNode.textContent;
    const spaceIdx = nodeText.indexOf(' ');
    if (spaceIdx < 1) return;

    const emojiPart = nodeText.slice(0, spaceIdx);
    const restPart  = nodeText.slice(spaceIdx);

    // Replace text node with clickable emoji span + remaining text
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'project-emoji-btn';
    emojiSpan.dataset.emojiType = emojiType;
    emojiSpan.textContent = emojiPart;
    emojiSpan.title = 'Click to change emoji';

    const restNode = document.createTextNode(restPart);
    heading.replaceChild(restNode, textNode);
    heading.insertBefore(emojiSpan, restNode);

    // Build the picker grid (appended to previewDiv so it's cleared on re-render)
    const pickerGrid = document.createElement('div');
    pickerGrid.className = 'project-emoji-picker';
    pickerGrid.style.cssText = 'display:none;position:fixed;grid-template-columns:repeat(auto-fill,32px);gap:6px;padding:8px;background:var(--bg);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.25);z-index:9999;width:240px;';
    container.appendChild(pickerGrid);

    const options = EMOJI_OPTIONS[emojiType] || [];
    for (const emoji of options) {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.style.cssText = 'font-size:22px;width:32px;height:32px;border:none;background:none;cursor:pointer;transition:transform 0.1s;padding:0;line-height:1;border-radius:4px;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setProjectEmoji(emojiType, emoji);
        if (openPicker) { openPicker.style.display = 'none'; openPicker = null; }
        // setProjectEmoji triggers refreshProjectsNote which re-renders; DOM is replaced
      });
      btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.2)'; btn.style.background = 'var(--surface)'; });
      btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.background = 'none'; });
      pickerGrid.appendChild(btn);
    }

    emojiSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openPicker && openPicker !== pickerGrid) {
        openPicker.style.display = 'none';
      }
      if (pickerGrid.style.display === 'none') {
        const rect = emojiSpan.getBoundingClientRect();
        const w = 240;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
        const top  = rect.bottom + 4;
        pickerGrid.style.left = left + 'px';
        pickerGrid.style.top  = top  + 'px';
        pickerGrid.style.display = 'grid';
        openPicker = pickerGrid;
      } else {
        pickerGrid.style.display = 'none';
        openPicker = null;
      }
    });
  });
}

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

  // Capture the note name and generation at the start of rendering so we can
  // detect if the user navigated away during any of the async steps below.
  const _renderTarget = currentFileName;
  const _renderGen = _loadNoteGeneration;

  _lastRenderedHTML = safeRenderMarkdown(preprocessMarkdown(_currentContent));
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

  alignTableColumns(previewDiv);
  wrapTablesForScroll(previewDiv);
  setupTableFeatures(previewDiv);
  setupPreviewTaskCheckboxes();
  setupPlainCheckboxes(previewDiv);
  await resolveAttachments(previewDiv);

  // Staleness check after attachment resolution (can be slow for many images).
  if (_renderGen !== _loadNoteGeneration || currentFileName !== _renderTarget) return;

  const _mathVarMap = buildMermaidVarMap(_currentContent);
  await renderMermaidDiagrams(previewDiv, _mathVarMap);
  if (window.MathJax?.typesetPromise) {
    await MathJax.typesetPromise([previewDiv]);
    if (_renderGen !== _loadNoteGeneration || currentFileName !== _renderTarget) return;
    setupClickableMathFormulas();
    // Defer until the browser has completed layout for the new MathJax nodes;
    // reading scrollWidth/clientWidth synchronously here yields stale values
    // and causes nearly every container to be falsely marked as overflowing.
    requestAnimationFrame(markOverflowingMathContainers);
  }

  // Settings note: inject interactive controls
  if (currentFileName === CALENDARS_NOTE) {
    // Profiles is the unified entry point — the per-profile row owns sync
    // and encryption controls and expands them inline on demand. The
    // dedicated ## ☁️ Sync and ## 🔒 Encryption sections are no longer
    // injected; legacy headings are stripped on save by file-list.js.
    if (typeof injectProfileSettings === 'function') injectProfileSettings(previewDiv);
    injectCalendarColorPickers(previewDiv);
    injectThemeColorPickers(previewDiv);
    injectBookmarklets(previewDiv);
  }

  // Projects note: make emojis clickable to change them
  if (currentFileName === PROJECTS_NOTE) {
    // Clean up any previous click-outside listener before injecting new ones
    if (previewDiv._emojiPickerCleanup) {
      previewDiv._emojiPickerCleanup();
      previewDiv._emojiPickerCleanup = null;
    }
    injectProjectNoteEmojiPickers(previewDiv);
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
    _appendControls(syncSection, wrap);
    return;
  }

  // ── Sync enabled + authenticated: show status and sign-out ──────────────
  if (helpers.enabled && helpers.authenticated) {
    _buildSignedInView(wrap, helpers);
    _appendControls(syncSection, wrap);
    return;
  }

  // ── Sync enabled but not signed in: show sign-in form ───────────────────
  if (helpers.enabled && !helpers.authenticated) {
    _buildSignInForm(wrap, helpers);
    _appendControls(syncSection, wrap);
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

  _appendControls(syncSection, wrap);
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

function _appendControls(section, wrap) {
  const lists = section.querySelectorAll('ul, ol, p');
  const lastEl = lists.length > 0 ? lists[lists.length - 1] : null;
  if (lastEl && lastEl.nextSibling) {
    section.insertBefore(wrap, lastEl.nextSibling);
  } else {
    section.appendChild(wrap);
  }
}
// Exposed for profile-settings-injection.js (loaded later) to reuse the same
// insertion behaviour as injectSyncSettings/injectEncryptionSettings, and
// the four sync/encryption sub-builders so the unified Profiles row can
// expand them inline.
window._appendControls = _appendControls;
window._buildSignInForm = (wrap, helpers) => _buildSignInForm(wrap, helpers);
window._buildSignedInView = (wrap, helpers) => _buildSignedInView(wrap, helpers);
window._buildEncryptionActiveView = (wrap, userId, masterKey) => _buildEncryptionActiveView(wrap, userId, masterKey);
window._buildNeedKeyView = (wrap, userId) => _buildNeedKeyView(wrap, userId);

// ── Encryption settings UI in Settings note preview ──────────────────────
// Injects device pairing, key backup, and encryption status controls into
// the "🔒 Encryption" section of the Settings note.

function injectEncryptionSettings(container) {
  // Find the <details> or parent element wrapping the "Encryption" h2
  let encSection = null;
  for (const details of container.querySelectorAll('details')) {
    const h = details.querySelector('summary h2');
    if (h && h.textContent.includes('Encryption')) { encSection = details; break; }
  }
  if (!encSection) {
    for (const h of container.querySelectorAll('h2')) {
      if (h.textContent.includes('Encryption')) { encSection = h.parentElement; break; }
    }
  }
  if (!encSection) return;
  if (encSection.querySelector('.encryption-controls')) return; // already injected

  const helpers = window._syncHelpers;
  const enc = window._encryption;

  const wrap = document.createElement('div');
  wrap.className = 'encryption-controls';

  // ── Sync not available (web only) ──────────────────────────────────────
  if (!helpers || !helpers.available || !helpers.authenticated) {
    const msg = document.createElement('p');
    msg.className = 'sync-status-msg';
    msg.textContent = !helpers || !helpers.available
      ? 'Encryption requires the desktop or iOS app with sync enabled.'
      : 'Sign in and enable sync first to use encryption.';
    wrap.appendChild(msg);
    _appendControls(encSection, wrap);
    return;
  }

  const userId = enc.userId;

  // ── Encryption active (key loaded) ─────────────────────────────────────
  if (enc.active && enc.key) {
    _buildEncryptionActiveView(wrap, userId, enc.key);
    _appendControls(encSection, wrap);
    return;
  }

  // ── Encryption enabled on server but no local key (Device B) ───────────
  if (enc.enabled && !enc.key) {
    _buildNeedKeyView(wrap, userId);
    _appendControls(encSection, wrap);
    return;
  }

  // ── Encryption not enabled: show enable button ─────────────────────────
  const desc = document.createElement('p');
  desc.className = 'sync-status-msg';
  desc.textContent = 'Encrypt your notes so only your devices can read them. The server will never see your content.';
  wrap.appendChild(desc);

  const warnP = document.createElement('p');
  warnP.className = 'encryption-warning';
  warnP.textContent = 'Warning: If you lose access to all your devices and have no key backup, encrypted notes cannot be recovered.';
  wrap.appendChild(warnP);

  const enableBtn = document.createElement('button');
  enableBtn.className = 'sync-btn sync-btn-primary';
  enableBtn.textContent = 'Enable Encryption';
  enableBtn.addEventListener('click', async () => {
    enableBtn.disabled = true;
    enableBtn.textContent = 'Setting up\u2026';
    try {
      // Generate master key
      const masterKey = await CryptoEngine.generateMasterKey();
      const rawBytes = await CryptoEngine.exportKey(masterKey);

      // Save locally
      await KeyStorage.saveMasterKey(rawBytes, userId);

      // Mark enabled on server
      await DevicePairing.enableEncryption(userId);
      await DevicePairing.registerDevice(userId);

      // Migrate existing notes
      const progressEl = document.createElement('p');
      progressEl.className = 'sync-status-msg';
      progressEl.textContent = 'Encrypting existing notes\u2026';
      wrap.appendChild(progressEl);

      // Use the unwrapped storage for migration (write ciphertext directly)
      const storage = window.NoteStorage._unwrapped || window.NoteStorage;

      // Warn if some notes are already encrypted with a different key.
      // migrateToEncrypted() skips notes that already start with 'enc:v1:', so any
      // notes synced from another device (or a previous encryption session) will
      // remain encrypted with the old key and be unreadable on this device.
      const allNotesRaw = await storage.getAllNotes();
      const alreadyEncrypted = allNotesRaw.filter(
        n => n.content && CryptoEngine.isEncrypted(n.content)
      );
      if (alreadyEncrypted.length > 0) {
        console.warn(
          '[encryption] ' + alreadyEncrypted.length +
          ' note(s) are already encrypted with a different key and will remain unreadable:',
          alreadyEncrypted.map(n => n.name)
        );
        const foreignKeyWarn = document.createElement('p');
        foreignKeyWarn.className = 'encryption-warning';
        foreignKeyWarn.textContent =
          alreadyEncrypted.length + ' note' + (alreadyEncrypted.length !== 1 ? 's' : '') +
          ' are already encrypted with a different key and cannot be read on this device. ' +
          'Pair with the device that holds the original key, or restore a key backup, to recover them.';
        wrap.appendChild(foreignKeyWarn);
      }

      const count = await CryptoStorage.migrateToEncrypted(storage, masterKey, (done, total) => {
        progressEl.textContent = `Encrypting notes\u2026 ${done}/${total}`;
      });

      progressEl.textContent = `Encrypted ${count} note${count !== 1 ? 's' : ''}. Reloading\u2026`;

      // Reload to activate the encryption wrapper
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      console.error('[encryption] Enable failed:', e);
      enableBtn.disabled = false;
      enableBtn.textContent = 'Enable Encryption';
      const errEl = document.createElement('p');
      errEl.className = 'sync-error';
      errEl.textContent = 'Failed: ' + e.message;
      wrap.appendChild(errEl);
    }
  });
  wrap.appendChild(enableBtn);

  _appendControls(encSection, wrap);
}

function _buildEncryptionActiveView(wrap, userId, masterKey) {
  // Status row
  const statusRow = document.createElement('div');
  statusRow.className = 'sync-status-row';
  const dot = document.createElement('span');
  dot.className = 'sync-dot sync-dot-active';
  statusRow.appendChild(dot);
  const label = document.createElement('span');
  label.className = 'sync-status-label';
  label.textContent = 'Encryption active';
  statusRow.appendChild(label);
  wrap.appendChild(statusRow);

  // ── Pair New Device button ─────────────────────────────────────────────
  const pairBtn = document.createElement('button');
  pairBtn.className = 'sync-btn sync-btn-primary';
  pairBtn.textContent = 'Pair New Device';

  const pairingArea = document.createElement('div');
  pairingArea.className = 'pairing-area';
  pairingArea.style.display = 'none';

  pairBtn.addEventListener('click', async () => {
    pairBtn.disabled = true;
    pairBtn.textContent = 'Starting\u2026';
    try {
      const session = await DevicePairing.initiatePairing(masterKey, userId);

      pairBtn.style.display = 'none';
      pairingArea.style.display = 'block';
      pairingArea.innerHTML = '';

      const codeLabel = document.createElement('p');
      codeLabel.className = 'sync-status-msg';
      codeLabel.textContent = 'Enter this code on your other device, or scan the QR code:';
      pairingArea.appendChild(codeLabel);

      // QR code
      if (session.qrDataUrl) {
        const qrImg = document.createElement('img');
        qrImg.src = session.qrDataUrl;
        qrImg.className = 'pairing-qr-code';
        qrImg.alt = 'Pairing QR code';
        pairingArea.appendChild(qrImg);
      }

      // Large code display
      const codeDisplay = document.createElement('div');
      codeDisplay.className = 'pairing-code-display';
      codeDisplay.textContent = session.code.slice(0, 3) + ' ' + session.code.slice(3);
      pairingArea.appendChild(codeDisplay);

      const waitMsg = document.createElement('p');
      waitMsg.className = 'sync-status-msg pairing-wait-msg';
      waitMsg.textContent = 'Waiting for the other device\u2026';
      pairingArea.appendChild(waitMsg);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'sync-btn sync-btn-secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        session.cancel();
        pairingArea.style.display = 'none';
        pairBtn.style.display = '';
        pairBtn.disabled = false;
        pairBtn.textContent = 'Pair New Device';
      });
      pairingArea.appendChild(cancelBtn);

      // Wait for completion in background
      session.waitForCompletion().then(() => {
        waitMsg.textContent = 'Device paired successfully!';
        waitMsg.classList.add('pairing-success');
        cancelBtn.style.display = 'none';
        // Refresh device list
        _refreshDeviceList(wrap, userId);
      }).catch(err => {
        if (err.message !== 'Pairing cancelled') {
          waitMsg.textContent = 'Pairing failed: ' + err.message;
          waitMsg.classList.add('pairing-error');
        }
      });
    } catch (e) {
      pairBtn.disabled = false;
      pairBtn.textContent = 'Pair New Device';
      console.error('[encryption] Pairing init failed:', e);
    }
  });

  wrap.appendChild(pairBtn);
  wrap.appendChild(pairingArea);

  // ── Device list ────────────────────────────────────────────────────────
  const devicesWrap = document.createElement('div');
  devicesWrap.className = 'encryption-devices';
  const devicesTitle = document.createElement('p');
  devicesTitle.className = 'encryption-devices-title';
  devicesTitle.textContent = 'Paired Devices';
  devicesWrap.appendChild(devicesTitle);
  const deviceList = document.createElement('ul');
  deviceList.className = 'device-list';
  devicesWrap.appendChild(deviceList);
  wrap.appendChild(devicesWrap);

  // Load devices async
  _refreshDeviceList(wrap, userId);

  // ── Key Backup buttons ─────────────────────────────────────────────────
  const backupRow = document.createElement('div');
  backupRow.className = 'encryption-backup-row';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'sync-btn sync-btn-secondary';
  exportBtn.textContent = 'Export Key Backup';
  exportBtn.addEventListener('click', () => {
    _showPassphrasePrompt(wrap, 'Enter a passphrase to protect your backup:', async (passphrase) => {
      try {
        await DevicePairing.exportKeyBackup(masterKey, passphrase);
      } catch (e) {
        console.error('[encryption] Export failed:', e);
      }
    });
  });
  backupRow.appendChild(exportBtn);

  wrap.appendChild(backupRow);
}

function _buildNeedKeyView(wrap, userId) {
  const msg = document.createElement('p');
  msg.className = 'sync-status-msg';
  msg.textContent = 'This account uses encryption. Pair this device to decrypt your notes.';
  wrap.appendChild(msg);

  // ── Enter Pairing Code ─────────────────────────────────────────────────
  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.placeholder = 'Enter 6-digit code';
  codeInput.className = 'sync-email-input';
  codeInput.inputMode = 'numeric';
  codeInput.maxLength = 7; // allow space in middle
  codeInput.autocomplete = 'off';
  wrap.appendChild(codeInput);

  const pairBtn = document.createElement('button');
  pairBtn.className = 'sync-btn sync-btn-primary';
  pairBtn.textContent = 'Pair This Device';

  const statusMsg = document.createElement('p');
  statusMsg.className = 'sync-status-msg';
  statusMsg.style.display = 'none';

  const errorMsg = document.createElement('p');
  errorMsg.className = 'sync-error';
  errorMsg.style.display = 'none';

  pairBtn.addEventListener('click', async () => {
    const code = codeInput.value.replace(/\s/g, '').trim();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      errorMsg.textContent = 'Please enter a valid 6-digit code.';
      errorMsg.style.display = 'block';
      return;
    }
    errorMsg.style.display = 'none';
    pairBtn.disabled = true;
    pairBtn.textContent = 'Pairing\u2026';
    statusMsg.textContent = 'Exchanging keys\u2026';
    statusMsg.style.display = 'block';

    try {
      const masterKeyBytes = await DevicePairing.joinPairing(code, userId);
      await KeyStorage.saveMasterKey(masterKeyBytes, userId);
      await DevicePairing.registerDevice(userId);

      statusMsg.textContent = 'Device paired! Reloading\u2026';
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      errorMsg.textContent = 'Pairing failed: ' + e.message;
      errorMsg.style.display = 'block';
      pairBtn.disabled = false;
      pairBtn.textContent = 'Pair This Device';
      statusMsg.style.display = 'none';
    }
  });

  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pairBtn.click();
  });

  wrap.appendChild(pairBtn);
  wrap.appendChild(statusMsg);
  wrap.appendChild(errorMsg);

  // ── Import Key Backup fallback ─────────────────────────────────────────
  const orLabel = document.createElement('p');
  orLabel.className = 'sync-status-msg';
  orLabel.style.marginTop = '12px';
  orLabel.textContent = 'Or restore from a key backup file:';
  wrap.appendChild(orLabel);

  const importBtn = document.createElement('button');
  importBtn.className = 'sync-btn sync-btn-secondary';
  importBtn.textContent = 'Import Key Backup';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (!fileInput.files || !fileInput.files[0]) return;
    const file = fileInput.files[0];
    _showPassphrasePrompt(wrap, 'Enter the passphrase used when creating the backup:', async (passphrase) => {
      try {
        const masterKeyBytes = await DevicePairing.importKeyBackup(file, passphrase);
        await KeyStorage.saveMasterKey(masterKeyBytes, userId);
        await DevicePairing.registerDevice(userId);

        const successEl = document.createElement('p');
        successEl.className = 'sync-status-msg';
        successEl.textContent = 'Key restored! Reloading\u2026';
        wrap.appendChild(successEl);
        setTimeout(() => window.location.reload(), 800);
      } catch (e) {
        const err = document.createElement('p');
        err.className = 'sync-error';
        err.textContent = 'Import failed: ' + (e.message || 'Wrong passphrase or corrupted file');
        wrap.appendChild(err);
      }
    });
  });

  wrap.appendChild(importBtn);
  wrap.appendChild(fileInput);
}

async function _refreshDeviceList(wrap, userId) {
  const deviceList = wrap.querySelector('.device-list');
  if (!deviceList) return;
  const myDeviceId = KeyStorage.getDeviceId();

  try {
    const devices = await DevicePairing.listDevices(userId);
    deviceList.innerHTML = '';
    for (const d of devices) {
      const li = document.createElement('li');
      li.className = 'device-item';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = d.device_name || d.device_id.slice(0, 8);
      if (d.device_id === myDeviceId) {
        nameSpan.textContent += ' (this device)';
        nameSpan.classList.add('device-current');
      }
      li.appendChild(nameSpan);

      if (d.device_id !== myDeviceId) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'device-remove-btn';
        removeBtn.textContent = '\u00d7';
        removeBtn.title = 'Remove device';
        removeBtn.addEventListener('click', async () => {
          await DevicePairing.removeDevice(userId, d.device_id);
          li.remove();
        });
        li.appendChild(removeBtn);
      }
      deviceList.appendChild(li);
    }
    if (devices.length === 0) {
      const li = document.createElement('li');
      li.className = 'device-item';
      li.textContent = 'No devices registered';
      deviceList.appendChild(li);
    }
  } catch (e) {
    console.error('[encryption] Failed to load devices:', e);
  }
}

function _showPassphrasePrompt(container, labelText, onSubmit) {
  // Remove any existing prompt
  const existing = container.querySelector('.passphrase-prompt');
  if (existing) existing.remove();

  const promptDiv = document.createElement('div');
  promptDiv.className = 'passphrase-prompt';

  const label = document.createElement('p');
  label.className = 'sync-status-msg';
  label.textContent = labelText;
  promptDiv.appendChild(label);

  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'Passphrase';
  input.className = 'sync-email-input';
  input.autocomplete = 'off';
  promptDiv.appendChild(input);

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.marginTop = '6px';

  const okBtn = document.createElement('button');
  okBtn.className = 'sync-btn sync-btn-primary';
  okBtn.textContent = 'OK';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'sync-btn sync-btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => promptDiv.remove());

  okBtn.addEventListener('click', () => {
    const val = input.value;
    if (!val) return;
    promptDiv.remove();
    onSubmit(val);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });

  row.appendChild(okBtn);
  row.appendChild(cancelBtn);
  promptDiv.appendChild(row);
  container.appendChild(promptDiv);
  input.focus();
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

// ── Bookmarklets in Settings note preview ─────────────────────────────────
// Injects draggable ⚙ Learn Page and 📋 Extract bookmarklet <a> links into
// the "🔖 Bookmarklets" section. Web only — no bookmarks bar on Electron/iOS.
//
// Palette is derived from the user's current theme (background + accent) via
// _deriveBookmarkletPalette(), so the dragged bookmarklet always carries the
// user's custom colours.  The hrefs are rebuilt live whenever the theme colour
// pickers fire an input event.

// Derive a full bookmarklet colour palette from two theme hex values.
// Uses HSL maths mirroring the approach in theme-engine.js, but limited to
// the ~12 colour slots the bookmarklet panels actually need.
function _deriveBookmarkletPalette(bg, accent) {
  function hexToHsl(hex) {
    const r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    let h=0, s=0;
    const l=(max+min)/2;
    if (max!==min) {
      const d=max-min;
      s=l>0.5?d/(2-max-min):d/(max+min);
      if (max===r) h=((g-b)/d+(g<b?6:0))/6;
      else if (max===g) h=((b-r)/d+2)/6;
      else h=((r-g)/d+4)/6;
    }
    return [h*360, s*100, l*100];
  }
  function hslToHex(h, s, l) {
    h=((h%360)+360)%360; s=Math.min(100,Math.max(0,s)); l=Math.min(100,Math.max(0,l));
    h/=360; s/=100; l/=100;
    let r,g,b;
    if (s===0) { r=g=b=l; } else {
      const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
      const h2r=(p,q,t)=>{if(t<0)t+=1;if(t>1)t-=1;return t<1/6?p+(q-p)*6*t:t<0.5?q:t<2/3?p+(q-p)*(2/3-t)*6:p;};
      r=h2r(p,q,h+1/3); g=h2r(p,q,h); b=h2r(p,q,h-1/3);
    }
    return '#'+[r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
  }
  const cl=(v,a,b)=>Math.min(b,Math.max(a,v));
  const [bgH,bgS,bgL]=hexToHsl(bg);
  const [acH,acS,acL]=hexToHsl(accent);
  const dk=bgL<50;
  return {
    bg,
    surface:     hslToHex(bgH, cl(bgS*0.5+acS*0.15,0,35), cl(dk?bgL+9:bgL-7,  8, 85)),
    inputBg:     hslToHex(bgH, cl(bgS*0.6,0,20),           cl(dk?bgL-4:bgL+4,  4, 96)),
    border:      hslToHex(acH, cl(acS*0.55,0,50),          cl(dk?bgL+22:bgL-18,10, 50)),
    subtle:      hslToHex(acH, cl(acS*0.4,0,35),           cl(dk?bgL+13:bgL-12, 8, 45)),
    text:        hslToHex(acH, cl(acS*0.25,0,25),          cl(dk?cl(93-bgL*0.1,82,94):cl(bgL*0.12,8,18),8,94)),
    muted:       hslToHex(acH, cl(acS*0.35,0,35),          cl(dk?bgL+44:bgL-28,48, 75)),
    dim:         hslToHex(acH, cl(acS*0.3,0,30),           cl(dk?bgL+22:bgL-16,32, 65)),
    accent,
    accentBg:    hslToHex(acH, cl(acS*0.8,20,70),          cl(dk?bgL+16:bgL-14,10, 35)),
    accentDark:  hslToHex(acH, cl(acS*0.9,15,65),          cl(dk?acL-12:acL-18,15, 42)),
    accentLight: hslToHex(acH, cl(acS*0.65,20,65),         cl(dk?acL+18:acL-8, 60, 88)),
    code:        hslToHex((acH+150)%360, 30,               dk?68:35),
  };
}

// Build the ⚙ Learn Page bookmarklet source, with colours from palette p.
// Success/error/warning colours are kept fixed (green/red/amber are universal).
function _buildLearnSrc(p) {
  return `(function(){
var STORAGE_KEY='pageExtractorFields',PANEL_ID='pex-panel',PREVIEW_ID='pex-preview',STYLE_ID='pex-style';
var ep=document.getElementById(PANEL_ID);
if(ep){ep.remove();var epr=document.getElementById(PREVIEW_ID);if(epr)epr.remove();var eps=document.getElementById(STYLE_ID);if(eps)eps.remove();document.body.style.cursor='';return;}
var fields=[],pickIdx=null,hlEl=null,previewVisible=false;
try{fields=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');}catch(e){fields=[];}
function bringToFront(el){[PANEL_ID,PREVIEW_ID].forEach(function(id){var e=document.getElementById(id);if(e)e.style.zIndex='2147483646';});el.style.zIndex='2147483647';}
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(fields));}
function esc(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function defAttr(el){var t=el.tagName.toLowerCase();return t==='time'?'datetime':t==='a'?'href':t==='img'?'src':t==='meta'?'content':'text';}
function genSel(tgt){
  if(tgt.closest&&tgt.closest('#'+PANEL_ID))return null;
  if(tgt.id&&tgt.id.length<40&&!/^\\d/.test(tgt.id)&&!/[a-f0-9]{8,}/.test(tgt.id)){try{var s='#'+CSS.escape(tgt.id);if(document.querySelector(s)===tgt)return s;}catch(e){}}
  function desc(el){var tag=el.tagName.toLowerCase();var cls=Array.from(el.classList).filter(function(c){return c.length>1&&!/^(is-|has-|js-)/.test(c)&&!/^(active|selected|open|closed|hover|focus|visible|hidden|disabled|loading|current|expanded|collapsed|show|hide|first|last|odd|even|highlighted|featured)$/.test(c);});if(cls.length>0){try{return tag+'.'+cls.slice(0,2).map(CSS.escape).join('.');}catch(e){}}return tag;}
  var path=[],cur=tgt;
  while(cur&&cur!==document.body&&cur!==document.documentElement){path.unshift(cur);cur=cur.parentElement;}
  for(var i=path.length-1;i>=0;i--){var cand=path.slice(i).map(desc).join(' > ');try{var m=document.querySelectorAll(cand);if(m.length===1&&m[0]===tgt)return cand;}catch(e){}}
  return path.map(desc).join(' > ');
}
function autoDerive(el,f){
  var tag=el.tagName.toLowerCase();
  if(/^h[1-6]$/.test(tag)){f.label=tag==='h1'?'Title':'Heading';f.attribute='text';f.format=tag;}
  else if(tag==='a'){f.label='Link';f.attribute='href';f.format='link';}
  else if(tag==='img'){f.label='Image';f.attribute='src';f.format='image';}
  else if(tag==='time'){f.label='Date';f.attribute='datetime';f.format='plain';}
  else if(tag==='blockquote'){f.label='Quote';f.attribute='text';f.format='quote';}
  else if(tag==='table'){f.label='Table';f.attribute='text';f.format='table';}
  else if(tag==='ul'){f.label='List';f.attribute='text';f.format='ul';}
  else if(tag==='ol'){f.label='List';f.attribute='text';f.format='ol';}
  else if(tag==='em'||tag==='i'){f.label='Italic';f.attribute='text';f.format='italic';}
  else if(tag==='mark'){f.label='Highlight';f.attribute='text';f.format='highlight';}
  else{f.label='Content';f.attribute=defAttr(el);f.format='plain';}
}
function getTableMd(el){
  var rows=Array.from(el.querySelectorAll('tr'));if(!rows.length)return '';
  var tbl=rows.map(function(row){
    var cells=Array.from(row.querySelectorAll('th,td')).map(function(c){return (c.innerText||c.textContent||'').trim().replace(/\\|/g,'\\\\|').replace(/\\n/g,' ');});
    return '| '+cells.join(' | ')+' |';
  });
  if(tbl.length>1){
    var headCells=Array.from(rows[0].querySelectorAll('th,td'));
    var probeCells=rows.length>1?Array.from(rows[1].querySelectorAll('th,td')):headCells;
    var sep=headCells.map(function(_,i){
      var c=probeCells[i]||headCells[i];
      var a=c&&c.getAttribute&&c.getAttribute('align');
      if(!a){try{a=(window.getComputedStyle(c).textAlign||'').toLowerCase();}catch(e){a='';}}
      if(a==='center')return ':---:';
      if(a==='right'||a==='end')return '---:';
      if(a==='left'||a==='start')return ':---';
      return '---';
    });
    tbl.splice(1,0,'| '+sep.join(' | ')+' |');
  }
  return tbl.join('\\n');
}
function getListMd(el,ordered){
  return Array.from(el.querySelectorAll(':scope > li')).map(function(li,idx){
    var t=(li.innerText||li.textContent||'').trim().split('\\n')[0].trim();
    return (ordered?(idx+1)+'. ':'- ')+t;
  }).join('\\n');
}
function getVal(sel,attr,fmt){
  if(!sel)return '';
  try{
    var el=document.querySelector(sel);if(!el)return '';
    if(fmt==='table')return getTableMd(el);
    if(fmt==='ul')return getListMd(el,false);
    if(fmt==='ol')return getListMd(el,true);
    if(attr==='href')return el.href||el.getAttribute('href')||'';
    if(attr==='src')return el.src||el.getAttribute('src')||'';
    if(attr==='datetime')return el.getAttribute('datetime')||el.innerText||'';
    if(attr==='content')return el.getAttribute('content')||'';
    return (el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ');
  }catch(e){return '';}
}
function fmtMd(f,v){
  if(!v)return '';
  switch(f.format){
    case 'h1':return '# '+v;
    case 'h2':return '## '+v;
    case 'h3':return '### '+v;
    case 'h4':return '#### '+v;
    case 'h5':return '##### '+v;
    case 'h6':return '###### '+v;
    case 'link':return '['+f.label+']('+v+')';
    case 'image':return '!['+f.label+']('+v+')';
    case 'italic':return '*'+v+'*';
    case 'quote':return '> '+v.split('\\n').join('\\n> ');
    case 'highlight':return '=='+v+'==';
    case 'ul':case 'ol':case 'table':return v;
    case 'plain':return v;
    default:return '**'+f.label+':** '+v;
  }
}
function buildMd(){
  var lines=fields.map(function(f){return fmtMd(f,getVal(f.selector,f.attribute,f.format)||'(not found)');});
  lines.push('**URL:** '+window.location.href);
  return lines.join('\\n\\n');
}
function copyText(t,cb){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(cb).catch(function(){fbCopy(t);if(cb)cb();});}else{fbCopy(t);if(cb)cb();}}
function fbCopy(t){var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:-9999px;left:-9999px;opacity:0;';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}
var FMT_OPTS=[['bold','**Bold**'],['plain','Plain'],['h1','# H1'],['h2','## H2'],['h3','### H3'],['h4','#### H4'],['h5','##### H5'],['h6','###### H6'],['link','[Link]()'],['image','![Image]()'],['quote','> Quote'],['italic','*Italic*'],['highlight','==Highlight=='],['ul','- List'],['ol','1. List'],['table','Table']];
var ATTR_OPTS=[['text','text'],['href','href'],['src','src'],['datetime','datetime'],['content','content']];
function makeSelect(name,i,opts,curVal,maxW){
  var lbl=(opts.find(function(o){return o[0]===curVal;})||opts[0]||['','—'])[1];
  return '<div style="position:relative;display:inline-flex;vertical-align:middle;flex-shrink:0;">'+
    '<button data-a="dd-trg" data-sel="'+name+'" data-i="'+i+'" '+
      'style="background:transparent;border:none;border-radius:6px;color:${p.muted};padding:3px 8px;font-size:11px;font-family:Arial,sans-serif;cursor:pointer;white-space:nowrap;max-width:'+(maxW||90)+'px;overflow:hidden;text-overflow:ellipsis;display:block;">'+
      esc(lbl)+' &#9662;'+
    '</button>'+
    '<div class="pex-dd-pn" id="pex-dd-'+name+'-'+i+'" '+
      'style="display:none;position:fixed;z-index:2147483648;background:${p.bg};border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.45);overflow:hidden;min-width:110px;">'+
      opts.map(function(o){var sel=(o[0]===curVal);
        return '<div data-a="dd-opt" data-sel="'+name+'" data-i="'+i+'" data-v="'+o[0]+'" '+
          'style="padding:5px 12px;font-size:11px;cursor:pointer;white-space:nowrap;color:'+(sel?'${p.accent}':'${p.muted}')+';">'+
          (sel?'&#10003; ':'\u00a0\u00a0 ')+o[1]+'</div>';
      }).join('')+
    '</div>'+
  '</div>';
}
var ddTimer=null;
function showDd(trg){
  clearTimeout(ddTimer);ddTimer=null;
  var id='pex-dd-'+trg.getAttribute('data-sel')+'-'+trg.getAttribute('data-i');
  document.querySelectorAll('.pex-dd-pn').forEach(function(el){if(el.id!==id)el.style.display='none';});
  var pn=document.getElementById(id);if(!pn)return;
  var r=trg.getBoundingClientRect();
  pn.style.left=r.left+'px';pn.style.top=(r.bottom+3)+'px';pn.style.display='block';
}
function hideDds(){
  ddTimer=setTimeout(function(){
    document.querySelectorAll('.pex-dd-pn').forEach(function(el){el.style.display='none';});
    ddTimer=null;
  },120);
}
function onDdOver(e){
  var t=e.target;
  var trg=t.closest?t.closest('[data-a="dd-trg"]'):null;
  if(trg){showDd(trg);return;}
  if(t.closest&&t.closest('.pex-dd-pn')){clearTimeout(ddTimer);ddTimer=null;}
}
function onDdOut(e){
  var rt=e.relatedTarget;
  var inTrg=e.target.closest&&e.target.closest('[data-a="dd-trg"]');
  var inPn=e.target.closest&&e.target.closest('.pex-dd-pn');
  if(!inTrg&&!inPn)return;
  if(rt&&rt.closest&&(rt.closest('[data-a="dd-trg"]')||rt.closest('.pex-dd-pn')))return;
  hideDds();
}
function renderPreview(){
  var preview=document.getElementById(PREVIEW_ID);
  if(!previewVisible||!fields.length){if(preview)preview.remove();return;}
  if(!preview){
    preview=document.createElement('div');
    preview.id=PREVIEW_ID;
    var panel=document.getElementById(PANEL_ID);
    var posTop='20px',posLeft='10px';
    if(panel){
      var rect=panel.getBoundingClientRect();
      posTop=rect.top+'px';
      posLeft=Math.max(10,rect.left-380)+'px';
    }
    preview.style.cssText='position:fixed;top:'+posTop+';left:'+posLeft+';width:370px;background:${p.bg};border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:Arial,sans-serif;font-size:13px;z-index:2147483646;overflow:hidden;display:flex;flex-direction:column;';
    document.body.appendChild(preview);
    preview.addEventListener('mousedown',function(){bringToFront(preview);});
  }
  var mdOut=buildMd();
  preview.innerHTML=
    '<div id="pex-preview-drag" style="padding:8px 14px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;">'+
    '<span style="font-size:11px;color:${p.dim};">Markdown Preview</span>'+
    '<button data-a="copy" style="background:transparent;border:none;border-radius:6px;color:${p.accent};padding:3px 9px;cursor:pointer;font-size:11px;">&#128203; Copy</button>'+
    '</div>'+
    '<pre style="margin:0;padding:4px 14px 12px;font-size:10px;color:${p.code};max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;font-family:monospace;line-height:1.5;">'+esc(mdOut)+'</pre>';
  setupDrag(preview,document.getElementById('pex-preview-drag'));
  preview.onclick=function(e){
    if(e.target.getAttribute('data-a')==='copy'){
      var md=buildMd();copyText(md,function(){e.target.textContent='✓ Copied!';setTimeout(function(){e.target.innerHTML='&#128203; Copy';},1600);});
    }
  };
}
function renderPanel(){
  var panel=document.getElementById(PANEL_ID);if(!panel)return;
  var prevScroll=0;var fd=document.getElementById('pex-fields');if(fd)prevScroll=fd.scrollTop;
  var fHtml=fields.map(function(f,i){
    var prev=getVal(f.selector,f.attribute,f.format),isP=pickIdx===i;
    var fmt=f.format||'plain';
    var isLast=i===fields.length-1;
    return '<div style="padding:8px 0;'+(isLast?'':'border-bottom:1px solid rgba(128,128,128,0.1);')+'">'+
      '<div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">'+
      '<input data-a="label" data-i="'+i+'" value="'+esc(f.label)+'" placeholder="Label" style="flex:1;min-width:0;background:transparent;border:none;color:${p.text};padding:4px 6px;font-size:12px;font-family:Arial,sans-serif;">'+
      makeSelect('attribute',i,ATTR_OPTS,f.attribute,70)+
      makeSelect('format',i,FMT_OPTS,fmt,90)+
      '<button data-a="delete" data-i="'+i+'" style="background:transparent;border:none;color:${p.muted};padding:4px 7px;cursor:pointer;font-size:12px;line-height:1;flex-shrink:0;">&#x2715;</button>'+
      '</div>'+
      '<div style="display:flex;gap:5px;align-items:center;">'+
      '<input data-a="selector" data-i="'+i+'" value="'+esc(f.selector||'')+'" placeholder="CSS selector" style="flex:1;min-width:0;background:transparent;border:none;color:${p.code};padding:4px 6px;font-size:11px;font-family:monospace;">'+
      '<button data-a="pick" data-i="'+i+'" style="background:'+(isP?'${p.accentBg}':'transparent')+';border:none;border-radius:6px;color:'+(isP?'${p.accent}':'${p.muted}')+';padding:4px 8px;cursor:pointer;font-size:11px;white-space:nowrap;flex-shrink:0;">'+(isP?'&#x1F3AF; Picking\u2026':'&#x1F5B1; Pick')+'</button>'+
      '</div>'+
      '<div style="margin-top:4px;font-size:11px;color:${p.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+
      (prev?'<span style="color:#4caf72;">&#8594; </span>'+esc(prev.substring(0,80))+(prev.length>80?'&#8230;':''):'<span style="color:${p.subtle};font-style:italic;">No Match</span>')+
      '</div></div>';
  }).join('');
  panel.innerHTML=
    '<div id="pex-drag" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;">'+
    '<span style="font-weight:600;font-size:13px;color:${p.text};">&#129504; Learn Page</span>'+
    '<div style="display:flex;gap:4px;align-items:center;">'+
    '<span style="font-size:11px;color:${p.dim};">'+fields.length+' field'+(fields.length!==1?'s':'')+'</span>'+
    '<button data-a="addpick" title="Add Field &amp; Pick Element" style="background:transparent;border:none;color:${p.accent};cursor:pointer;font-size:18px;line-height:1;padding:1px 6px;">+</button>'+
    '<button data-a="close" style="background:transparent;border:none;color:${p.dim};cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;">&#x2715;</button>'+
    '</div></div>'+
    (pickIdx!==null?'<div style="background:${p.accentBg};color:${p.accent};padding:6px 14px;font-size:12px;text-align:center;">Click an element on the page &#8212; Esc to Cancel</div>':'')+
    '<div id="pex-fields" style="padding:4px 12px 8px;overflow-y:auto;max-height:360px;">'+
    (fHtml||'<div style="color:${p.dim};text-align:center;padding:24px 0;font-size:12px;">Click + to Add a Field</div>')+
    '</div>'+
    '<div style="padding:7px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(128,128,128,0.1);">'+
    '<button data-a="clear" style="background:transparent;border:none;color:${p.muted};padding:3px 0;cursor:pointer;font-size:11px;">Clear All</button>'+
    '<button data-a="toggle-preview" style="background:transparent;border:none;color:${p.accent};padding:3px 0;cursor:pointer;font-size:11px;">'+(previewVisible?'Hide Preview':'Show Preview')+'</button>'+
    '</div>';
  setupDrag(panel,document.getElementById('pex-drag'));
  var newFd=document.getElementById('pex-fields');if(newFd)newFd.scrollTop=prevScroll;
  renderPreview();
}
function setupDrag(panel,handle){if(!handle)return;handle.onmousedown=function(e){if(e.target.tagName==='BUTTON'||e.target.tagName==='SELECT'||e.target.tagName==='INPUT')return;var sx=e.clientX,sy=e.clientY,sl=panel.offsetLeft,st=panel.offsetTop;function mv(e){panel.style.left=(sl+e.clientX-sx)+'px';panel.style.top=(st+e.clientY-sy)+'px';panel.style.right='auto';}function up(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);}document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);e.preventDefault();};}
function onClick(e){
  var a=e.target.getAttribute('data-a');if(!a)return;
  var i=parseInt(e.target.getAttribute('data-i'),10);
  if(a==='close'){cleanup();}
  else if(a==='addpick'){var ni=fields.length;fields.push({label:'Field '+(ni+1),selector:'',attribute:'text',format:'plain'});save();pickIdx=ni;startPick();renderPanel();}
  else if(a==='delete'){if(pickIdx===i){pickIdx=null;stopPick();}fields.splice(i,1);save();renderPanel();}
  else if(a==='pick'){if(pickIdx===i){pickIdx=null;stopPick();}else{if(pickIdx!==null)stopPick();pickIdx=i;startPick();}renderPanel();}
  else if(a==='clear'){if(confirm('Remove all '+fields.length+' field(s)?')){fields=[];if(pickIdx!==null){pickIdx=null;stopPick();}save();renderPanel();}}
  else if(a==='toggle-preview'){previewVisible=!previewVisible;if(!previewVisible){var pv=document.getElementById(PREVIEW_ID);if(pv)pv.remove();}renderPanel();}
  else if(a==='dd-opt'){
    var sel=e.target.getAttribute('data-sel'),optI=parseInt(e.target.getAttribute('data-i'),10),v=e.target.getAttribute('data-v');
    if(!isNaN(optI)){if(sel==='format'){fields[optI].format=v;save();renderPanel();}else if(sel==='attribute'){fields[optI].attribute=v;save();renderPanel();}}
    document.querySelectorAll('.pex-dd-pn').forEach(function(el){el.style.display='none';});
  }
}
var debT=null;
function onInput(e){var a=e.target.getAttribute('data-a'),i=parseInt(e.target.getAttribute('data-i'),10);if(isNaN(i))return;if(a==='label'){fields[i].label=e.target.value;save();}else if(a==='selector'){fields[i].selector=e.target.value;save();clearTimeout(debT);debT=setTimeout(renderPanel,550);}}
function startPick(){document.addEventListener('mouseover',onHov,true);document.addEventListener('click',onPickEl,true);document.addEventListener('keydown',onKey,true);document.body.style.cursor='crosshair';}
function stopPick(){document.removeEventListener('mouseover',onHov,true);document.removeEventListener('click',onPickEl,true);document.removeEventListener('keydown',onKey,true);document.body.style.cursor='';clearHl();}
function clearHl(){if(hlEl){hlEl.style.outline=hlEl._pexOut||'';hlEl.style.outlineOffset=hlEl._pexOff||'';delete hlEl._pexOut;delete hlEl._pexOff;hlEl=null;}}
function onHov(e){var t=e.target;if(t.closest&&(t.closest('#'+PANEL_ID)||t.closest('#'+PREVIEW_ID)))return;clearHl();hlEl=t;t._pexOut=t.style.outline;t._pexOff=t.style.outlineOffset;t.style.outline='2px solid ${p.accent}';t.style.outlineOffset='2px';}
function onPickEl(e){
  var t=e.target;
  if(t.closest&&(t.closest('#'+PANEL_ID)||t.closest('#'+PREVIEW_ID))){
    if(pickIdx!==null){e.preventDefault();e.stopPropagation();pickIdx=null;stopPick();renderPanel();}
    return;
  }
  e.preventDefault();e.stopPropagation();
  if(pickIdx===null)return;
  var sel=genSel(t);
  if(sel){fields[pickIdx].selector=sel;autoDerive(t,fields[pickIdx]);save();}
  var ni=fields.length;
  fields.push({label:'Field '+(ni+1),selector:'',attribute:'text',format:'plain'});
  save();pickIdx=ni;startPick();renderPanel();
}
function onKey(e){if(e.key==='Escape'){pickIdx=null;stopPick();renderPanel();}}
function cleanup(){
  stopPick();
  var pn=document.getElementById(PANEL_ID);if(pn)pn.remove();
  var pv=document.getElementById(PREVIEW_ID);if(pv)pv.remove();
  var ps=document.getElementById(STYLE_ID);if(ps)ps.remove();
}
var pexStyle=document.createElement('style');
pexStyle.id=STYLE_ID;
pexStyle.textContent='#pex-panel input,#pex-panel button,#pex-preview button{transition:background-color 0.15s,box-shadow 0.15s;}#pex-panel button,#pex-preview button{border-radius:6px;box-shadow:none;}#pex-panel button:hover,#pex-preview button:hover{background-color:${p.surface}!important;box-shadow:0 2px 8px rgba(0,0,0,0.35)!important;}#pex-panel input:focus{outline:none;}[data-a="dd-trg"]:hover{background-color:${p.surface}!important;box-shadow:0 2px 8px rgba(0,0,0,0.35)!important;}.pex-dd-pn [data-a="dd-opt"]:hover{background-color:${p.surface}!important;}';
document.head.appendChild(pexStyle);
var panel=document.createElement('div');
panel.id=PANEL_ID;
panel.style.cssText='position:fixed;top:20px;right:20px;width:370px;background:${p.bg};border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:Arial,sans-serif;font-size:13px;z-index:2147483647;overflow:hidden;display:flex;flex-direction:column;';
panel.addEventListener('mousedown',function(){bringToFront(panel);});
panel.addEventListener('click',onClick);
panel.addEventListener('input',onInput);
panel.addEventListener('mouseover',onDdOver);
panel.addEventListener('mouseout',onDdOut);
document.body.appendChild(panel);
renderPanel();
if(!fields.length){fields.push({label:'Field 1',selector:'',attribute:'text',format:'plain'});save();pickIdx=0;startPick();renderPanel();}
})();`;
}

// Build the 📋 Extract bookmarklet source, with colours from palette p.
function _buildExtractSrc(p) {
  return `(function(){
var STORAGE_KEY='pageExtractorFields';
var fields=[];
try{fields=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');}catch(e){}
if(!fields.length){alert('No fields configured.\\nUse the 🧠 Learn Page bookmarklet first.');return;}
function getTableMd(el){
  var rows=Array.from(el.querySelectorAll('tr'));if(!rows.length)return '';
  var tbl=rows.map(function(row){
    var cells=Array.from(row.querySelectorAll('th,td')).map(function(c){return (c.innerText||c.textContent||'').trim().replace(/\\|/g,'\\\\|').replace(/\\n/g,' ');});
    return '| '+cells.join(' | ')+' |';
  });
  if(tbl.length>1){
    var headCells=Array.from(rows[0].querySelectorAll('th,td'));
    var probeCells=rows.length>1?Array.from(rows[1].querySelectorAll('th,td')):headCells;
    var sep=headCells.map(function(_,i){
      var c=probeCells[i]||headCells[i];
      var a=c&&c.getAttribute&&c.getAttribute('align');
      if(!a){try{a=(window.getComputedStyle(c).textAlign||'').toLowerCase();}catch(e){a='';}}
      if(a==='center')return ':---:';
      if(a==='right'||a==='end')return '---:';
      if(a==='left'||a==='start')return ':---';
      return '---';
    });
    tbl.splice(1,0,'| '+sep.join(' | ')+' |');
  }
  return tbl.join('\\n');
}
function getListMd(el,ordered){
  return Array.from(el.querySelectorAll(':scope > li')).map(function(li,idx){
    var t=(li.innerText||li.textContent||'').trim().split('\\n')[0].trim();
    return (ordered?(idx+1)+'. ':'- ')+t;
  }).join('\\n');
}
function getVal(sel,attr,fmt){
  if(!sel)return '';
  try{
    var el=document.querySelector(sel);if(!el)return '';
    if(fmt==='table')return getTableMd(el);
    if(fmt==='ul')return getListMd(el,false);
    if(fmt==='ol')return getListMd(el,true);
    if(attr==='href')return el.href||el.getAttribute('href')||'';
    if(attr==='src')return el.src||el.getAttribute('src')||'';
    if(attr==='datetime')return el.getAttribute('datetime')||el.innerText||'';
    if(attr==='content')return el.getAttribute('content')||'';
    return (el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ');
  }catch(e){return '';}
}
function fmtMd(f,v){
  if(!v)return '';
  switch(f.format){
    case 'h1':return '# '+v;
    case 'h2':return '## '+v;
    case 'h3':return '### '+v;
    case 'h4':return '#### '+v;
    case 'h5':return '##### '+v;
    case 'h6':return '###### '+v;
    case 'link':return '['+f.label+']('+v+')';
    case 'image':return '!['+f.label+']('+v+')';
    case 'italic':return '*'+v+'*';
    case 'quote':return '> '+v.split('\\n').join('\\n> ');
    case 'highlight':return '=='+v+'==';
    case 'ul':case 'ol':case 'table':return v;
    case 'plain':return v;
    default:return '**'+f.label+':** '+v;
  }
}
var missing=[];
var lines=fields.map(function(f){var v=getVal(f.selector,f.attribute,f.format);if(!v)missing.push(f.label);return fmtMd(f,v);}).filter(Boolean);
lines.push('**URL:** '+window.location.href);
var md=lines.join('\\n\\n');
function copyText(t,ok){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok).catch(function(){fbCopy(t);ok();});}else{fbCopy(t);ok();}}
function fbCopy(t){var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:-9999px;left:-9999px;opacity:0;';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}
function escHtml(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function showToast(ok){
  var ex=document.getElementById('pex-toast');if(ex)ex.remove();
  var toast=document.createElement('div');
  toast.id='pex-toast';
  toast.style.cssText='position:fixed;bottom:28px;right:28px;max-width:420px;min-width:260px;background:${p.bg};border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:Arial,sans-serif;font-size:13px;z-index:2147483647;overflow:hidden;';
  var warnHtml=missing.length?'<div style="padding:6px 14px;background:#2d2200;font-size:11px;color:#d4a24a;border-bottom:1px solid rgba(128,128,128,0.15);">&#9888; Not Found: '+escHtml(missing.join(', '))+'</div>':'';
  toast.innerHTML=
    '<div style="background:'+(ok?'#1a3428':'#3a1820')+';color:'+(ok?'#4caf72':'#e05c5c')+';padding:9px 14px;font-weight:600;display:flex;align-items:center;gap:8px;">'+
    '<span>'+(ok?'&#10003;':'&#9888;')+'</span>'+
    '<span>'+(ok?'Copied &#8212; Paste Into a Note':'Copy Failed &#8212; Select Below')+'</span>'+
    '</div>'+
    warnHtml+
    '<pre style="margin:0;padding:10px 14px;font-size:10px;color:${p.code};max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;font-family:monospace;line-height:1.5;">'+escHtml(md)+'</pre>'+
    '<div style="padding:7px 14px;text-align:right;">'+
    '<button id="pex-toast-close" style="background:transparent;border:none;color:${p.muted};cursor:pointer;font-size:12px;font-family:Arial,sans-serif;">Dismiss</button>'+
    '</div>';
  document.body.appendChild(toast);
  document.getElementById('pex-toast-close').onclick=function(){toast.remove();};
  setTimeout(function(){if(toast.parentNode){toast.style.transition='opacity 0.4s';toast.style.opacity='0';setTimeout(function(){if(toast.parentNode)toast.remove();},450);}},6000);
}
copyText(md,function(){showToast(true);});
})();`;
}

function injectBookmarklets(container) {
  if (window.electronAPI || window.Capacitor?.isNativePlatform()) return;

  // Find the <details> wrapping the "Bookmarklets" h2 (autocollapsed headings
  // get wrapped in <details> by setupCollapsibleHeadings)
  let bmSection = null;
  for (const details of container.querySelectorAll('details')) {
    const h = details.querySelector('summary h2');
    if (h && h.textContent.includes('Bookmarklets')) { bmSection = details; break; }
  }
  if (!bmSection) {
    for (const h of container.querySelectorAll('h2')) {
      if (h.textContent.includes('Bookmarklets')) { bmSection = h.parentElement; break; }
    }
  }
  if (!bmSection) return;
  if (bmSection.querySelector('.bookmarklet-controls')) return; // already injected

  // ── Build the UI ──────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'bookmarklet-controls';

  const row = document.createElement('div');
  row.className = 'bookmarklet-row';

  const learnLink = document.createElement('a');
  learnLink.className = 'bookmarklet-btn';
  learnLink.textContent = '🧠 Learn Page';
  learnLink.draggable = true;
  learnLink.addEventListener('click', e => e.preventDefault());

  const extractLink = document.createElement('a');
  extractLink.className = 'bookmarklet-btn';
  extractLink.textContent = '📋 Extract';
  extractLink.draggable = true;
  extractLink.addEventListener('click', e => e.preventDefault());

  // Rebuild hrefs from the current theme palette.  Called once on inject and
  // again whenever the user adjusts a colour picker in the Theme section.
  function updateHrefs() {
    const theme = getCurrentTheme();
    const p = _deriveBookmarkletPalette(theme.background, theme.accent);
    learnLink.href   = 'javascript:' + encodeURIComponent(_buildLearnSrc(p));
    extractLink.href = 'javascript:' + encodeURIComponent(_buildExtractSrc(p));
  }
  updateHrefs();

  // Set a per-bookmarklet emoji favicon so the browser captures the right icon
  // when the link is dragged to the bookmarks bar.
  //
  // Strategy (three layers for maximum reliability):
  //
  // 1. MOUSEDOWN (not dragstart) — fires before the drag gesture is recognised,
  //    giving Chrome's favicon service more time to register the change before
  //    the bookmark is committed on drop.
  //
  // 2. Inject a NEW <link rel="icon" type="image/svg+xml"> element rather than
  //    mutating the existing favicon.ico link.  Chrome 80+ explicitly prefers
  //    an SVG-typed icon link over a generic one when both are present, and
  //    inserting a fresh element forces a re-evaluation of icon candidates
  //    instead of relying on a href mutation being picked up from cache.
  //
  // 3. setDragImage() with an emoji canvas — works regardless of favicon cache
  //    behaviour: the user always sees the emoji following the cursor while
  //    dragging, giving clear visual feedback about which bookmarklet is in
  //    flight even if the saved bookmark ends up with the app favicon.
  //
  // A shared <link id="_pex-fav"> element is reused across both bookmarklets
  // (only one drag can be active at a time) to avoid leaving stray nodes.
  function addFaviconSwap(link, emoji) {
    const svgUri = 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
      `<text y=".9em" font-size="90">${emoji}</text></svg>`
    );

    let dragging = false;
    let restoreTimer = null;

    function setEmoji() {
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
      let el = document.getElementById('_pex-fav');
      if (!el) {
        el = document.createElement('link');
        el.rel = 'icon';
        el.id  = '_pex-fav';
        el.type = 'image/svg+xml';
        document.head.appendChild(el);
      }
      el.href = svgUri;
    }

    function restoreOrig(delay) {
      restoreTimer = setTimeout(() => {
        const el = document.getElementById('_pex-fav');
        if (el) el.remove();
        restoreTimer = null;
      }, delay);
    }

    // Layer 1: start as early as possible so Chrome has time to sync.
    link.addEventListener('mousedown', setEmoji);

    link.addEventListener('dragstart', e => {
      dragging = true;
      setEmoji(); // belt-and-suspenders if mousedown missed
      // Layer 3: emoji canvas follows the cursor — always visible to the user.
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.font = '52px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, 32, 36);
      e.dataTransfer.setDragImage(c, 32, 32);
    });

    // Restore after a brief pause so Chrome has time to write the icon before
    // it disappears from the DOM.
    link.addEventListener('dragend', () => {
      dragging = false;
      restoreOrig(200);
    });

    // If mousedown happened but the user clicked rather than dragged, clean up.
    link.addEventListener('mouseup', () => {
      if (!dragging) restoreOrig(50);
    });
  }
  addFaviconSwap(learnLink, '🧠');
  addFaviconSwap(extractLink, '📋');

  // Re-derive whenever the colour pickers fire (live preview updates theme
  // synchronously via applyTheme, so getCurrentTheme() reflects the new value)
  for (const picker of container.querySelectorAll('.theme-color-picker')) {
    picker.addEventListener('input', updateHrefs);
  }

  row.appendChild(learnLink);
  row.appendChild(extractLink);
  wrap.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'bookmarklet-hint';
  hint.textContent = 'Drag to your bookmarks bar. Show it with Ctrl+Shift+B (⌘+Shift+B on Mac).';
  wrap.appendChild(hint);

  _appendControls(bmSection, wrap);
}

// ── Refresh Settings note UI after sync ───────────────────────────────────
// Called after applySyncedPreferences() to ensure the colour picker circles
// in the Settings note preview reflect the latest values.

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
}

window._refreshSettingsPickerUI = refreshSettingsPickerUI;

// ── Toggle-view scroll helpers ─────────────────────────────────────────────

// Strip markdown syntax from a single source line to get comparable plain text.
function _mdLineToPlain(line) {
  return line
    .replace(/^#{1,6}\s+/, '')                    // heading markers
    .replace(/\s*>\s*$/, '')                       // autocollapse ">"
    .replace(/<[^>]*>/g, '')                       // injected HTML spans
    .replace(/\*\*([^*\n]*)\*\*/g, '$1')           // bold **
    .replace(/\*([^*\n]*)\*/g, '$1')               // italic *
    .replace(/__([^_\n]*)__/g, '$1')               // bold __
    .replace(/_([^_\n]*)_/g, '$1')                 // italic _
    .replace(/`([^`\n]*)`/g, '$1')                 // inline code
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')       // [text](url)
    .replace(/^\s*[-*+]\s+/, '')                   // bullet markers
    .replace(/^\s*\d+\.\s+/, '')                   // numbered list
    .replace(/^\s*>\s*/, '')                        // blockquote >
    .replace(/[|]/g, ' ')                          // table pipes
    .replace(/\u200b/g, '')                        // zero-width spaces
    .trim();
}

// Find the source line that appears at the top of the textarea viewport.
// Uses binary search on line offsets with getLineScrollY for accuracy.
// Returns the stripped plain text of the first content line found, or ''.
function _getEditorScrollAnchor(ta) {
  const scrollTop = ta.scrollTop;
  const text = ta.value;
  if (!text.trim()) return '';

  const lines = text.split('\n');

  // If at the very top, use the first content line.
  if (scrollTop <= 2) {
    for (const line of lines) {
      const plain = _mdLineToPlain(line);
      if (plain.length > 5) return plain.slice(0, 50);
    }
    return '';
  }

  // Build cumulative char offsets for each line start.
  const lineOffsets = [];
  let off = 0;
  for (const l of lines) {
    lineOffsets.push(off);
    off += l.length + 1;
  }

  // Binary search: find the last line whose visual top Y ≤ scrollTop.
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getLineScrollY(ta, lineOffsets[mid]) <= scrollTop) lo = mid;
    else hi = mid - 1;
  }

  // Scan forward from that line for a meaningful content snippet.
  // Skip table rows (contain '|') as they produce unreliable anchors.
  for (let i = lo; i < Math.min(lo + 8, lines.length); i++) {
    if (lines[i].trim().startsWith('|')) continue;
    const plain = _mdLineToPlain(lines[i]);
    if (plain.length > 5) return plain.slice(0, 50);
  }
  return '';
}

// Scroll the preview so the element containing anchorText is near the top.
// Skips text inside closed <details> (autocollapsed sections).
// Returns true if a match was found and scrolled, false otherwise.
function _scrollPreviewToText(anchorText) {
  if (!anchorText || anchorText.length < 4) return false;

  // Try the anchor as-is, then with markdown formatting stripped.
  const needles = [anchorText.slice(0, 40).toLowerCase()];
  const stripped = anchorText.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  if (stripped !== anchorText && stripped.length > 3) {
    needles.push(stripped.slice(0, 40).toLowerCase());
  }

  const candidates = previewDiv.querySelectorAll(
    'p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote'
  );

  for (const needle of needles) {
    for (const el of candidates) {
      // Skip elements hidden inside closed <details>.
      let hidden = false;
      let p = el.parentElement;
      while (p && p !== previewDiv) {
        if (p.tagName === 'DETAILS' && !p.open) { hidden = true; break; }
        p = p.parentElement;
      }
      if (hidden) continue;

      const elText = el.textContent.replace(/\u200b/g, '').toLowerCase();
      if (elText.includes(needle)) {
        const elTop = el.getBoundingClientRect().top;
        const contTop = previewDiv.getBoundingClientRect().top;
        previewDiv.scrollTop += (elTop - contTop) - 8;
        return true;
      }
    }
  }
  return false;
}

// Find the first visible block element near the top of the preview and
// return a text snippet suitable for locating in the source markdown.
function _getPreviewTopAnchorText() {
  const rect = previewDiv.getBoundingClientRect();
  const topThreshold = rect.top;

  const candidates = previewDiv.querySelectorAll(
    'h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote'
  );

  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;               // collapsed / hidden element
    if (r.bottom < topThreshold + 4) continue;  // above the visible area
    if (r.top > rect.bottom) break;             // below the visible area
    const text = el.textContent.replace(/\u200b/g, '').trim();
    if (text.length >= 4) return text.slice(0, 60);
  }
  return '';
}

// Scroll textarea to show the line containing anchorText.
// Tries direct match, then with heading '#' prefixes, then stripped markdown.
// Returns true if found and scrolled.
function _scrollEditorToText(ta, anchorText) {
  if (!anchorText || anchorText.length < 4) return false;
  const source = ta.value;

  const snippet = anchorText.slice(0, 25);
  let idx = source.indexOf(snippet);

  // Try with heading markers.
  if (idx < 0) {
    for (let hashes = 1; idx < 0 && hashes <= 6; hashes++) {
      const headingLine = '#'.repeat(hashes) + ' ' + snippet.slice(0, 20);
      const found = source.indexOf(headingLine);
      if (found >= 0) idx = found;
    }
  }

  // Fallback: strip common markdown characters and try a shorter snippet.
  if (idx < 0) {
    const bare = anchorText.replace(/[*_`#>|[\]()]/g, '').trim().slice(0, 20);
    if (bare.length > 4) idx = source.indexOf(bare);
  }

  if (idx < 0) return false;

  const y = getLineScrollY(ta, idx);
  ta.scrollTop = Math.max(0, y - 8);
  return true;
}

// ── Collapse breadcrumb trail ──────────────────────────────────────────────
// When toggling edit→view, if the cursor's line lives inside collapsed
// heading(s), highlight the outermost closed heading's summary so the user
// knows where they were. Each time the user expands a highlighted section the
// highlight advances to the next inner collapsed ancestor, forming a breadcrumb
// trail. Once all ancestors are open the cursor's own content element is
// highlighted. Everything expires 30 s after the toggle.

let _breadcrumbCleanup = null;

function _setupCollapseBreadcrumb(sourceText, cursorOffset) {
  // Dismiss any breadcrumb from a previous toggle.
  if (_breadcrumbCleanup) { _breadcrumbCleanup(); _breadcrumbCleanup = null; }

  // Find the source line the cursor is on.
  const lines = sourceText.split('\n');
  let charCount = 0;
  let cursorLineText = '';
  for (const line of lines) {
    if (charCount + line.length >= cursorOffset) { cursorLineText = line; break; }
    charCount += line.length + 1;
  }

  const plain = _mdLineToPlain(cursorLineText);
  if (!plain || plain.length < 3) return;

  // Find the rendered element that corresponds to the cursor line.
  const needle = plain.slice(0, 40).toLowerCase();
  const candidates = previewDiv.querySelectorAll(
    'p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote'
  );
  let targetEl = null;
  for (const el of candidates) {
    if (el.textContent.replace(/\u200b/g, '').toLowerCase().includes(needle)) {
      targetEl = el;
      break;
    }
  }
  if (!targetEl) return;

  // Walk up from targetEl to collect all <details> ancestors, outermost first.
  const chain = [];
  let node = targetEl.parentElement;
  while (node && node !== previewDiv) {
    if (node.tagName === 'DETAILS') chain.push(node);
    node = node.parentElement;
  }
  chain.reverse(); // outermost → innermost

  // Nothing to trail if cursor content is already fully visible.
  if (chain.length === 0 || chain.every(d => d.open)) return;

  let activeEl = null;
  const handlers = new Map();

  function removeHighlight() {
    if (activeEl) { activeEl.classList.remove('schedule-highlight'); activeEl = null; }
  }

  function applyHighlight(el) {
    removeHighlight();
    el.classList.add('schedule-highlight');
    activeEl = el;
    // Scroll the highlighted element into view if it's off-screen.
    const elTop = el.getBoundingClientRect().top;
    const contTop = previewDiv.getBoundingClientRect().top;
    if (elTop < contTop + 4 || elTop > contTop + previewDiv.clientHeight * 0.75) {
      previewDiv.scrollTop += (elTop - contTop) - 20;
    }
  }

  function advance() {
    const nextClosed = chain.find(d => !d.open);
    if (nextClosed) {
      // Highlight the heading inside the next still-collapsed summary.
      const h = nextClosed.querySelector(
        ':scope > summary h1,:scope > summary h2,:scope > summary h3,' +
        ':scope > summary h4,:scope > summary h5,:scope > summary h6'
      );
      applyHighlight(h || nextClosed.querySelector(':scope > summary'));
    } else {
      // All ancestors open — highlight the cursor's actual content element.
      applyHighlight(targetEl);
    }
  }

  function handleToggle(e) {
    if (e.target.open) advance(); // user expanded a section — move highlight inward
  }

  chain.forEach(d => {
    d.addEventListener('toggle', handleToggle);
    handlers.set(d, handleToggle);
  });

  advance(); // start by highlighting the outermost closed heading

  const expireTimer = setTimeout(cleanup, 30000);

  function cleanup() {
    clearTimeout(expireTimer);
    removeHighlight();
    handlers.forEach((fn, d) => d.removeEventListener('toggle', fn));
    handlers.clear();
    if (_breadcrumbCleanup === cleanup) _breadcrumbCleanup = null;
  }

  _breadcrumbCleanup = cleanup;
}

async function toggleView() {
  if (currentFileName === PROJECTS_NOTE) return;
  if (isPreview) {
    // Dismiss any active breadcrumb when going back to edit mode.
    if (_breadcrumbCleanup) { _breadcrumbCleanup(); _breadcrumbCleanup = null; }

    // Flush any active table sort to markdown before switching to edit mode.
    _saveAllTableSorts(previewDiv);

    previewDiv.style.display = 'none';
    textarea.style.display = 'block';
    toggleViewBtn.textContent = 'View';
    isPreview = false;
    localStorage.setItem('is_preview', 'false');
  } else {
    // Capture cursor position before any async work.
    const cursorOffset = textarea.selectionStart;
    const sourceSnapshot = textarea.value;

    // Flush any pending auto-save and apply a pending title rename so the
    // preview and file list immediately reflect the committed note name.
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await autoSaveNote();
    }
    await applyPendingRename();

    // Clean up table formatting before switching to preview.
    const _cleanedText = _cleanupMarkdownTables(textarea.value);
    if (_cleanedText !== textarea.value) {
      textarea.value = _cleanedText;
      await autoSaveNote();
    }

    await renderPreview();
    previewDiv.style.display = 'block';
    textarea.style.display = 'none';
    toggleViewBtn.textContent = 'Edit';
    isPreview = true;
    localStorage.setItem('is_preview', 'true');

    // Set up breadcrumb trail: if the cursor was inside collapsed heading(s),
    // highlight them so the user can follow the trail to their position.
    _setupCollapseBreadcrumb(sourceSnapshot, cursorOffset);
  }
}
