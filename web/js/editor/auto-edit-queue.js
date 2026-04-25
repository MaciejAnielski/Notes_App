// ── Auto-edit queue ───────────────────────────────────────────────────────
// Collects deferred rewrites of `textarea.value` and drains them only on
// three triggers: cursor line change, view-mode toggle, note switch.
//
// Transforms are pure, idempotent `(text, ctx) -> text` rewrites; actions are
// async side-effectful callbacks that may mutate storage.  Transforms run
// first (in registration order), then actions.  Registrations reference
// globals (_cleanupMarkdownTables, applyDailyNoteDateCodes, checkAttachmentRenames)
// lazily via closures so script load order does not matter.

(function () {
  const transforms = [];
  const actions = [];

  let isDirty = false;
  let _flushing = false;

  function registerTransform(name, fn) { transforms.push({ name, fn }); }
  function registerAction(name, fn)    { actions.push({ name, fn }); }

  function markDirty() { isDirty = true; }

  async function flush({ reason, generation } = {}) {
    if (_flushing || !isDirty) return;
    if (typeof textarea === 'undefined' || !textarea) return;
    if (textarea.readOnly) { isDirty = false; return; }
    if (!currentFileName) { isDirty = false; return; }

    _flushing = true;
    try {
      const selStart = textarea.selectionStart;
      const selEnd   = textarea.selectionEnd;
      const before   = textarea.value;
      const ctx = {
        fileName: currentFileName,
        prevSavedContent: _lastSavedContent,
        reason,
      };

      let text = before;
      for (const { fn } of transforms) {
        try { text = fn(text, ctx); } catch (e) { console.error('[auto-edit-queue] transform failed:', e); }
      }
      if (text !== before) {
        textarea.value = text;
        const max = textarea.value.length;
        textarea.selectionStart = Math.min(selStart, max);
        textarea.selectionEnd   = Math.min(selEnd, max);
        if (typeof refreshHighlight === 'function') refreshHighlight();
      }

      for (const { fn } of actions) {
        if (generation !== undefined &&
            typeof _loadNoteGeneration !== 'undefined' &&
            generation !== _loadNoteGeneration) return;
        try { await fn(ctx); } catch (e) { console.error('[auto-edit-queue] action failed:', e); }
      }
    } finally {
      isDirty = false;
      _flushing = false;
    }
  }

  // Line-change tracker state (mutated by app-init listeners via resetLineTracker).
  let _lastLineIndex = -1;
  function resetLineTracker(idx = -1) { _lastLineIndex = idx; }
  function currentLineIndex() {
    if (typeof textarea === 'undefined' || !textarea) return 0;
    const v = textarea.value;
    const p = textarea.selectionStart;
    let count = 0;
    for (let i = 0; i < p; i++) if (v.charCodeAt(i) === 10) count++;
    return count;
  }
  function onSelectionChange() {
    const li = currentLineIndex();
    if (li === _lastLineIndex) return;
    _lastLineIndex = li;
    flush({ reason: 'line-change' });
  }

  // ── Built-in registrations ──────────────────────────────────────────────
  // Closures resolve globals at call time, so load-order of note-manager.js
  // and table-features.js relative to this file does not matter.

  registerTransform('daily-date-code', (text, ctx) => {
    if (typeof applyDailyNoteDateCodes === 'function') {
      return applyDailyNoteDateCodes(text, ctx.fileName);
    }
    return text;
  });

  registerTransform('table-cleanup', (text) => {
    if (typeof _cleanupMarkdownTables === 'function') {
      return _cleanupMarkdownTables(text);
    }
    return text;
  });

  registerAction('attachment-rename', async (ctx) => {
    if (typeof checkAttachmentRenames === 'function') {
      await checkAttachmentRenames(ctx.prevSavedContent, textarea.value, ctx.fileName);
    }
  });

  window.AutoEditQueue = {
    markDirty,
    flush,
    resetLineTracker,
    currentLineIndex,
    onSelectionChange,
    registerTransform,
    registerAction,
  };
})();
