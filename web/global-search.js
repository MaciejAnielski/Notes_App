// global-search.js — Global search and replace panel.
//
// Provides find-across-all-notes functionality with live search,
// case-sensitive toggle, single/all replace, and keyboard navigation.

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
let gsKeyboardOffset = 0;

function openGlobalSearch() {
  globalSearchPanel.classList.remove('gs-hidden');
  globalSearchPanel.style.bottom = gsKeyboardOffset > 0 ? gsKeyboardOffset + 'px' : '';
  gsSearchInput.focus();
  gsSearchInput.select();
}

function closeGlobalSearch() {
  globalSearchPanel.classList.add('gs-hidden');
}

async function gsGetAllMatches(query, caseSensitive) {
  const results = [];
  if (!query) return results;
  const needle  = caseSensitive ? query : query.toLowerCase();
  const CONTEXT = 55;

  const allNotes = await NoteStorage.getAllNotes();
  for (const { name: noteName, content: rawContent } of allNotes) {
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
  gsStatus.textContent = toTitleCase(text);
  gsStatus.style.color = ok === false ? 'var(--error)' : ok === true ? 'var(--success)' : 'var(--muted)';
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

  // Scroll each snippet so the highlighted match is always visible.
  // overflow:hidden clips the text but still allows programmatic scrollLeft.
  requestAnimationFrame(() => {
    gsResults.querySelectorAll('.gs-snippet').forEach(snippet => {
      const markEl = snippet.querySelector('mark');
      if (markEl) {
        snippet.scrollLeft = Math.max(0, markEl.offsetLeft - 30);
      }
    });
  });
}

async function gsSelectResult(index) {
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

  if (currentFileName) {
    await NoteStorage.setNote(currentFileName, textarea.value);
  }

  await loadNote(result.noteName);

  setTimeout(() => {
    const query = gsSearchInput.value;
    const caseSensitive = gsCaseCheckbox.checked;
    const occurrenceIndex = gsCurrentResults.slice(0, index).filter(r => r.noteName === result.noteName).length;
    if (isPreview) {
      highlightTextInPreview(query, caseSensitive, occurrenceIndex);
    } else {
      const idx = result.matchIndex;
      if (idx !== -1) {
        textarea.focus();
        textarea.setSelectionRange(idx, idx + query.length);
        textarea.scrollTop = Math.max(0, getLineScrollY(textarea, idx) - textarea.clientHeight / 2);
      }
    }
  }, 50);
}

async function gsRunFind() {
  const query = gsSearchInput.value;
  if (!query) { gsSetStatus('Enter a search term.', false); return; }
  gsCurrentResults = await gsGetAllMatches(query, gsCaseCheckbox.checked);
  gsRenderResults(gsCurrentResults, query);
}

// ── Event listeners ───────────────────────────────────────────────────────

gsCloseBtn.addEventListener('click', closeGlobalSearch);
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
gsReplaceBtn.addEventListener('click', async () => {
  if (gsSelectedIndex < 0) {
    gsSetStatus('Select a result first.', false);
    return;
  }
  const query   = gsSearchInput.value;
  const replacement = gsReplaceInput.value;
  const caseSensitive = gsCaseCheckbox.checked;
  if (!query) return;

  const result  = gsCurrentResults[gsSelectedIndex];
  let content   = await NoteStorage.getNote(result.noteName);
  if (content === null) { gsSetStatus(`Note not found.`, false); return; }

  const hay = caseSensitive ? content : content.toLowerCase();
  const ndl = caseSensitive ? query : query.toLowerCase();
  const idx = hay.indexOf(ndl);
  if (idx === -1) { gsSetStatus('Match no longer found (content changed).', false); return; }

  content = content.slice(0, idx) + replacement + content.slice(idx + query.length);
  await NoteStorage.setNote(result.noteName, content);
  if (currentFileName === result.noteName) {
    textarea.value = content;
    if (isPreview) renderPreview(); else refreshHighlight();
  }

  await handleRenameAfterReplace(result.noteName, content);
  await updateFileList();
  gsCurrentResults = await gsGetAllMatches(query, caseSensitive);
  gsRenderResults(gsCurrentResults, query);
  gsSetStatus(`Replaced 1 match in \u201c${result.noteName}\u201d.`, true);
});

// Replace all occurrences across all notes
gsReplaceAllBtn.addEventListener('click', async () => {
  const query   = gsSearchInput.value;
  const replacement = gsReplaceInput.value;
  const caseSensitive = gsCaseCheckbox.checked;
  if (!query) { gsSetStatus('Enter a search term.', false); return; }

  const fresh = await gsGetAllMatches(query, caseSensitive);
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

  for (const noteName of affected) {
    let content = await NoteStorage.getNote(noteName);
    if (content === null) continue;
    const matches = content.match(regex);
    if (!matches) continue;
    totalReplaced += matches.length;
    const newContent = content.replace(regex, replacement);
    await NoteStorage.setNote(noteName, newContent);
    if (currentFileName === noteName) {
      textarea.value = newContent;
      if (isPreview) renderPreview(); else refreshHighlight();
    }
    await handleRenameAfterReplace(noteName, newContent);
  }

  await updateFileList();
  gsCurrentResults = await gsGetAllMatches(query, caseSensitive);
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
