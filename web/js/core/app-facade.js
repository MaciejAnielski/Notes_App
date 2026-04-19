// app-facade.js — Tidy top-level namespace for external consumers.
//
// The app exposes many loose `window.*` globals (NoteStorage, CryptoEngine,
// KeyStorage, CryptoStorage, DevicePairing, BinaryUtil, sanitizeHtml, etc.)
// because all modules load into the same window via <script defer> tags.
//
// This file collects them under a single `window.NotesApp` object so third
// parties (e-2-e tests, dev tools, userscripts) have one stable handle.  The
// existing globals are intentionally left in place — they're referenced from
// dozens of call sites across the codebase and removing them would be a huge
// invasive refactor that this review branch isn't scoped for.
//
// Loaded last so every module has already attached its own globals.

'use strict';

(function () {
  // Live getters so the facade always reflects the current value of a global
  // (e.g. NoteStorage is swapped when PowerSync attaches or crypto wraps it).
  function liveProp(target, name) {
    Object.defineProperty(target, name, {
      enumerable: true,
      configurable: true,
      get() { return window[name]; }
    });
  }

  const facade = {};
  const exported = [
    // Storage layer
    'NoteStorage',
    'PowerSyncNoteStorage',
    // Encryption
    'CryptoEngine',
    'CryptoStorage',
    'KeyStorage',
    'DevicePairing',
    // Utilities
    'BinaryUtil',
    'sanitizeHtml',
    'safeRenderMarkdown',
    'safeRenderMarkdownInline'
  ];

  for (const name of exported) liveProp(facade, name);

  // Semver-style version tag for consumers that want to feature-detect.
  facade.version = '1.0.0';

  window.NotesApp = facade;
})();
