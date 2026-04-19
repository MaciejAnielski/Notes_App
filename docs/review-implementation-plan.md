# Review Implementation Plan

Ordered by risk, not by difficulty. Each stage is independently shippable; later stages assume earlier ones landed.

---

## Stage 1 — Security-critical (ship first)

Goal: close exploitable holes before touching anything else.

1.1 **Sanitize rendered markdown**
- Add a small wrapper `web/js/utils/sanitize.js` exposing `window.safeRenderMarkdown(src)` that pipes `marked.parse(src)` through DOMPurify (vendor in `web/vendor/purify.min.js`).
- Replace every `innerHTML = marked.parse(...)` with `innerHTML = safeRenderMarkdown(...)` at:
  - `web/js/editor/syntax-highlight.js:64`
  - `web/js/notes/file-list.js:447`
  - `web/js/notes/export-import.js:243`
  - `web/js/notes/note-manager.js:772`
  - `web/js/schedule/schedule.js:442`
  - `web/js/ui/graph-view.js:358`
- Load DOMPurify before `marked` in `index.html`.

1.2 **Fix HKDF salt in device pairing**
- `web/js/encryption/device-pairing.js:168`: replace `new Uint8Array(32)` with a deterministic context-bound salt (`SHA-256("notes-app-pairing" || pairingCode)`) so both peers derive the same key without leaking randomness requirements.
- Version the pairing record (`salt_version: 2`) so older in-flight rows are rejected.

1.3 **Stop swallowing pairing-completion errors**
- `web/js/encryption/device-pairing.js:172-175`: `await` the `status:'consumed'` update, check `error`, throw on failure. Add a retry (max 3) before surfacing to the UI.

1.4 **Audit loose comparisons on auth-adjacent paths**
- Replace `==`/`!=` with `===`/`!==` in `encryption/*.js` and `storage/*.js` (rest of codebase handled in Stage 4).

**Exit criteria**: DOMPurify in place, pairing roundtrip still works, `npm test` green.

---

## Stage 2 — Functional bugs

Goal: fix wrong behaviour users can trip over.

2.1 **Notifications tag safety** — `web/js/ui/notifications.js:150`: coalesce `item.text || 'event'` before interpolating into the notification tag.

2.2 **Event-listener leak on mobile button group** — `web/js/core/app-init.js:33-40`: register `document.addEventListener('click', hide, { once: true })` and explicitly remove on group close.

2.3 **Stale closure in global search** — `web/js/notes/global-search.js:115-164`: snapshot `isPreview` and the active `textarea` reference at selection time; bail out of `applyHighlight` if the current note changed.

2.4 **Multi-day date comparison** — `web/js/schedule/schedule.js`: convert YYMMDD strings to numbers (or `Date`) before `<=`/`>=` to make intent explicit and guard against unpadded inputs.

2.5 **DOM cache null-checks** — `web/js/core/app-state.js:46-76`: assert each `getElementById` result is non-null; throw a single descriptive error listing missing IDs.

2.6 **PowerSync IPC timeout** — `web/js/storage/powersync-storage.js:23-30`: wrap secondary-window proxy calls in a `Promise.race` against a 5 s timeout, surface as a "primary window unavailable" toast.

**Exit criteria**: new regression tests under `web/tests/` cover 2.1, 2.3, 2.4.

---

## Stage 3 — CSS correctness

Goal: make styles render what they claim to render.

3.1 **Wrong variable in search highlight** — `web/css/search.css:178`: replace `var(--sched-highlight-outline)` with `var(--accent)`.

3.2 **Narrow-desktop media query conflict** — `web/css/responsive.css:303`: change to `@media (max-width: 650px) and (hover: hover) and (not (any-pointer: coarse))` so touchscreen laptops fall into the mobile section instead.

3.3 **iOS viewport trap** — `web/css/base.css:2-7`: drop `position: fixed; height: 100%` from `html`; let `body` own the scroll container. Validate on iOS Safari.

3.4 **`1lh` unit fallback** — `web/css/schedule.css:291`: replace `calc((1lh - 7px) / 2)` with `0.2em`.

3.5 **`accent-color` fallback** — `web/css/theme.css:114,160`: append `, currentColor` to each `var(--checkbox-accent)`.

**Exit criteria**: visual diff on desktop Chrome, Firefox, Safari, and iOS Safari.

---

## Stage 4 — Redundancy & consistency

Goal: shrink surface area so later work stays cheap.

4.1 **Shared binary helpers** — create `web/js/utils/binary.js` exporting:
- `uint8ToBase64(arr)` / `base64ToUint8(b64)` (single chunk-safe impl)
- `arrayBufferToString(buf)` / `stringToArrayBuffer(str)`

Remove the duplicates at `crypto-engine.js:297-308`, `key-storage.js:85-86`, `app-state.js:414-422`, `crypto-storage.js:125-127`.

4.2 **Strict equality sweep** — codemod `==`/`!=` → `===`/`!==` across `web/js/**`, skipping intentional nullish checks (`x == null`).

4.3 **CSS variables centralised** — move every ad-hoc custom property (colours, `--panel-width: 300px`, `--easing-bounce`) into `web/css/variables.css`. Replace hardcoded `300px` in `responsive.css:32,24,25` and `cubic-bezier(0.34, 1.4, 0.64, 1)` in `base.css:45-48`.

4.4 **CSS rule consolidation**
- Merge `textarea` + `#editor-highlight` padding rule at `responsive.css:221-228`.
- Collapse the duplicate `touch-action: pan-y` at `schedule.css:377-378`.
- Group the repeated `fill` rules across `diagrams.css:134-228` into one compound selector.

**Exit criteria**: no lint warnings from stylelint; bundle size smaller or equal.

---

## Stage 5 — Accessibility

Goal: keyboard and assistive-tech users can drive the app.

5.1 **Focus-visible rings** — add `:focus-visible` outlines for `textarea`, `#searchBox`, `#searchTasksBox`, `#button-container button`, `.sub-button`. Drop the blanket `textarea:focus { outline: none }` at `editor.css:161`.

5.2 **Reduced motion** — wrap transitions/animations in `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation: none !important; transition: none !important; } }` in `base.css`.

5.3 **ARIA labels** — attach `aria-label`s to task checkboxes (`web/js/notes/file-list.js:95-100`) and schedule items (`web/js/schedule/schedule.js`).

5.4 **Forced-colors mode** — add borders/high-contrast hints in `theme.css` under `@media (forced-colors: active)`.

5.5 **Print styles** — new `@media print` block in `base.css` hiding toolbar/panels, expanding the editor column.

**Exit criteria**: axe-core scan of the rendered preview + schedule passes without violations.

---

## Stage 6 — Missing features

Goal: close the functional gaps users have asked for.

6.1 **Ctrl+S save** — explicit save shortcut in `web/js/core/app-init.js` that flushes `NoteStorage.setNote` immediately and shows a "Saved" toast.

6.2 **Undo/redo beyond the textarea** — _deferred_. The `<textarea>` already gives native Ctrl+Z / Ctrl+Shift+Z. A second custom stack tied to the note id risks desyncing with the browser's native undo history (which also tracks selection and IME composition) and the behaviour users would want (does undoing cross a note switch?) needs product sign-off before writing code. Revisit when the product team has a clear answer.

6.3 **Sync conflict detection** — _deferred_. The data plumbing (`_lastSavedContent` vs `_lastRemoteContent`) exists, but the UX copy (modal title, button labels, what "merge" means for markdown) needs design input. The current behaviour (Stage 2 hardened it to "remote change detected — keeping your unsaved edits") is a safe fallback until the modal is specified.

6.4 **Keyboard help overlay** — expose the existing `SYNTAX_REFERENCE_TABLE` (`note-manager.js:6-23`) through a `?`-key modal that also lists all shortcuts.

6.5 **Global namespace cleanup** — collect `window.*` exports into a single `window.NotesApp = { … }` façade; keep thin aliases for one release to stay backwards-compatible.

**Exit criteria**: each feature gated behind a manual test plan in the PR description.

---

## Stage 7 — Test coverage

Goal: stop regressing the fixes above.

7.1 Add Jest suites under `web/tests/`:
- `crypto-engine.test.js` — encrypt/decrypt roundtrip, base64 helpers, wrap/unwrap.
- `device-pairing.test.js` — ECDH derivation determinism, salt regression (Stage 1.2).
- `app-state.test.js` — DOM-cache null assertions, search predicate matrix, conflict detection (Stage 6.3).
- `powersync-storage.test.js` — IPC timeout (Stage 2.6), primary-only guards.
- `sanitize.test.js` — XSS payload battery against `safeRenderMarkdown`.

7.2 Wire `npm test` into CI via `.github/workflows/` if not already; fail PRs on coverage drop.

**Exit criteria**: coverage ≥ 60 % on the files touched by Stages 1-6.

---

## Rollout notes

- Stages 1-3 can each be a single PR. Stage 4 is best split per sub-step (4.1-4.4) to keep diffs reviewable.
- Stage 5 ships safely as one PR because it's additive.
- Stages 6 and 7 should interleave: land 6.x, then add its 7.x tests before moving on.
- No stage requires a DB migration; pairing-record salt versioning (1.2) is backwards-compatible because new rows carry `salt_version`.
