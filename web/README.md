# Notes App

A personal markdown note-taking app available as a **web app**, **desktop app** (Electron), and **iOS app** (Capacitor).

All three platforms share the same core source code in `web/`.

---

## Table of Contents

1. [Installation Guide](#installation-guide)
2. [Getting Started](#getting-started)
2. [The Interface](#the-interface)
3. [Writing Notes](#writing-notes)
4. [Preview Mode](#preview-mode)
5. [The Side Panel](#the-side-panel)
6. [Linking Between Notes](#linking-between-notes)
7. [Searching and Filtering Notes](#searching-and-filtering-notes)
8. [Global Search and Replace](#global-search-and-replace)
9. [Task Lists](#task-lists)
10. [Schedule](#schedule)
11. [Projects Note](#projects-note)
12. [Tables](#tables)
13. [Footnotes](#footnotes)
14. [Highlighted Text](#highlighted-text)
15. [Tab Indentation](#tab-indentation)
16. [Math Formulas](#math-formulas)
17. [Clickable Math Formula Evaluation](#clickable-math-formula-evaluation)
18. [Import and Export](#import-and-export)
19. [Mobile Navigation](#mobile-navigation)
20. [Cross-Window Sync](#cross-window-sync)
21. [Keyboard Shortcuts](#keyboard-shortcuts)
22. [Storage and Persistence](#storage-and-persistence)

---

## Installation Guide

### Web

Open `web/index.html` directly in a browser, or serve it:

```bash
cd web
python3 -m http.server 8000
```

### Desktop (Electron)

```bash
cd desktop
bash setup.sh    # installs deps + symlinks web/
npm start        # launches the desktop app
```

Requires: Node.js 18+

### iOS (Capacitor)

```bash
cd ios
bash setup.sh    # installs deps, copies web files, adds iOS platform
npm run open     # opens Xcode
```

Requires: Node.js 18+, Xcode 15+, macOS

## Getting Started

Open `index.html` in a browser. A new note is created automatically with today's date as the title (format `YYMMDD`). Start typing — the note is auto-saved to localStorage one second after you stop.

The first line of every note **must** begin with `#` (a markdown heading). That heading becomes the note's file name. If you change the heading text, the note is renamed accordingly.

If a note with today's date already exists the editor opens blank instead so you don't accidentally overwrite it. If you type only a `#` heading that matches an existing note and nothing else, that note opens automatically.

---

## The Interface

The app has three main areas:

### Toolbar

A row of buttons across the top of the screen:

| Button | Action |
|--------|--------|
| **New** | Create a new blank note |
| **Delete** | Delete the current note (hover to reveal **Filtered** and **All**) |
| **Export** | Export the current note as HTML (hover to reveal **Filtered** and **All**) |
| **Import** | Import a `.zip` of `.md` files |
| **Backup** | Download all notes as a `.zip` of `.md` files |
| **Find** | Open global search and replace (or press Ctrl+F / Cmd+F) |
| **View** | Toggle between the markdown editor and the rendered preview |

Hover over buttons like Delete and Export to reveal sub-buttons for bulk operations. When the window is too narrow to fit all buttons, the overflow items collapse behind a **Tools** button — hover over it to reveal them.

### Editor area

The central area where you write markdown or view the rendered preview. A status bar at the bottom shows save confirmations and the time since your last backup.

### Side panel

A collapsible panel on the right edge with three tabs — **Notes**, **Tasks**, and **Schedule**. Move your mouse to the centre right-right of the app window and the side panel should appear. You can pin it by clicking the icon on the top right of the panel so that it doesn't disappear. Cycle through panel pages by clicking on the **Notes**, **Tasks**, and **Schedule** headings. See [The Side Panel](#the-side-panel) for full details.

---

## Writing Notes

The editor supports standard markdown via the **marked** library:

- **Headings** — `#`, `##`, `###`, etc.
- **Bold / Italic** — `**bold**`, `*italic*`
- **Links** — `[text](url)`
- **Images** — `![alt](url)`
- **Blockquotes** — `> quoted text`
- **Fenced code blocks** — triple backticks (` ``` `)
- **Ordered / unordered lists** — `1.` or `-` / `*` / `+`
- **Horizontal rules** — `---`
- **Inline code** — `` `code` ``
- **Highlighted text** — `==highlighted==` (see [Highlighted Text](#highlighted-text))

Line breaks are enabled — a single newline in the source creates a `<br>` in the output.

Pressing **Tab** in the editor inserts a literal tab character, which is preserved as visual indentation in preview mode (see [Tab Indentation](#tab-indentation)).

---

## Preview Mode

Click **View** (or the **Preview Markdown** / **Edit Markdown** toggle) to render the current note. The last mode you were in (edit or preview) is remembered across browser refreshes.

Preview mode is fully interactive:

- **Collapsible headings** — every heading becomes a toggle. Click a heading to collapse or expand everything beneath it (down to the next heading of equal or higher rank). All sections start expanded. A small `›` / `⌄` indicator appears after each heading.
- **Auto-collapsed headings** — append a `>` to the end of any heading line in your markdown to make it start collapsed in preview mode. The `>` is stripped from the rendered output. For example, `## Details >` renders as "Details" but starts collapsed.
- **Task checkboxes** — checking or unchecking a task in the preview updates the markdown source and saves immediately (see [Task Lists](#task-lists)).
- **Note links** — clicking an internal link navigates to that note (see [Linking Between Notes](#linking-between-notes)).
- **Auto-aligned tables** — numeric columns are right-aligned, text columns left-aligned, automatically (see [Tables](#tables)).
- **Clickable math formulas** — formulas ending with `=` can be clicked to compute a result (see [Clickable Math Formula Evaluation](#clickable-math-formula-evaluation)).
- **Highlighted text** — `==text==` is rendered with a highlight background (see [Highlighted Text](#highlighted-text)).
- **MathJax rendering** — inline and display math expressions are typeset by MathJax 3 (see [Math Formulas](#math-formulas)).

---

## The Side Panel

A collapsible panel on the right side of the screen with three tabs, cycled by clicking on the panel headings:

### Notes tab

- Lists all saved notes, sorted reverse-alphabetically (newest date-titled notes first).
- The currently open note is highlighted with a solid purple left border.
- If you navigated through internal links, the breadcrumb chain is shown below the current note with numbered dashed borders. Click any breadcrumb to jump back.
- The search box filters the list (see [Searching and Filtering Notes](#searching-and-filtering-notes)).

### Tasks tab

- Aggregates all unchecked tasks (`- [ ]`) from every note.
- Tasks are grouped under their note name. Click the name to open the note; check the box to complete the task.
- Has its own search box with AND / OR / NOT support and colour-based schedule filtering (see [Searching and Filtering Notes](#searching-and-filtering-notes)).

### Schedule tab

- A day-view timeline (7 AM – 7 PM) showing scheduled items.
- **Week row** — a compact week calendar is displayed above the timeline. Each day shows a letter (M–S), the date number, and a colour-coded dot indicating the busiest task status for that day (red for overdue, amber for today, green for future). Click any day in the week row to jump directly to it. The currently selected day and today are visually highlighted; weekend days are dimmed.
- Navigate between weeks with `‹` / `›` or click the date to return to today.
- Checkboxes on task items can be toggled directly.

### Pinning the panel

Click the **pin icon** (top of the panel) to lock it open. When pinned, the panel stays visible as a fixed sidebar and the editor area narrows to accommodate it. Click the pin again to unpin — the panel returns to hover-on-demand behaviour. The pinned state is remembered across refreshes.

---

## Linking Between Notes

There are two ways to create a link to another note:

| Syntax | Example |
|--------|---------|
| Wiki-link | `[[My Other Note]]` |
| Standard markdown link | `[display text](My Other Note)` |

Wiki-links are converted to standard markdown links during preprocessing, so both forms behave identically in preview.

When you click an internal link in preview mode:

1. If the target note **exists**, it opens. The note you came from is pushed onto a breadcrumb chain shown in the Notes tab of the side panel.
2. If the target note **does not exist**, it is created automatically with a `# Title` heading and then opened. These links appear with a distinct style so you can tell they point to notes that haven't been written yet.

Clicking a breadcrumb note in the side panel navigates back to it and trims the chain.

---

## Searching and Filtering Notes

The **Search Notes** box in the Notes tab of the side panel filters the notes list in real time. The query language supports three operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| (space) or `AND` | Both terms must match | `recipe AND vegetarian` |
| `OR` | Either term may match | `draft OR outline` |
| `NOT` | Exclude results containing the term | `meeting NOT cancelled` |

Operators are case-insensitive. Unquoted terms search against both the note name and its content.

### Title-only search

Wrap an individual term in double quotes to restrict that term to **note titles only** (content is ignored for that term). Unquoted terms still search both title and content, so you can mix both styles in one query:

| Query | Result |
|-------|--------|
| `"project"` | Notes whose title contains "project" |
| `"project" AND emily` | Title contains "project" AND title-or-content contains "emily" |
| `"project" AND "emily"` | Title contains both "project" and "emily" |
| `"project" OR meeting` | Title contains "project" OR title-or-content contains "meeting" |

### Task search and colour filters

The Tasks tab has its own search box with the same AND / OR / NOT query support. In addition, quoted colour keywords filter tasks by their **schedule status colour**:

| Quoted keyword | Tasks shown |
|----------------|-------------|
| `"Red"` | Overdue tasks only |
| `"Amber"` | Tasks due today only |
| `"Green"` | Future tasks only |
| `"Grey"` | Unscheduled tasks only |

Colour filters compose with all the standard operators:

| Query | Result |
|-------|--------|
| `"Red" OR "Amber"` | Overdue and today tasks |
| `"Red" AND meeting` | Overdue tasks whose text contains "meeting" |
| `NOT "Grey"` | Any scheduled task |

Only text inside double quotes is treated as a colour filter. Bare terms remain free-text search across the note name and task text.

---

## Global Search and Replace

Press **Ctrl+F** (or **Cmd+F** on macOS), or click the **Find** button in the toolbar, to open the global search and replace panel. This searches across **all** notes simultaneously.

- **Search** — type a term and press Enter or click Find. Results appear as a scrollable list showing the note name and a snippet of surrounding context with the match highlighted.
- **Case sensitive** — tick the **Aa** checkbox to require exact case.
- **Navigate results** — click a result to open that note and select the match in the editor. Use **Arrow Up / Down** to move through results.
- **Replace** — type a replacement in the second input, select a result, then click **Replace** to replace that single occurrence.
- **Replace All** — click **All** to replace every occurrence across all matching notes (with a confirmation prompt).
- **Close** — click the `✕` button or press **Escape**.

Search is live — results update as you type (with a 300ms debounce).

---

## Task Lists

Write tasks using standard markdown checkbox syntax:

```
- [ ] Unchecked task
- [x] Completed task
```

**In preview mode** you can check and uncheck tasks directly — the underlying markdown source is updated and saved in real time.

**In the Tasks tab** (see [The Side Panel](#the-side-panel)) every unchecked task across all notes is collected into a single list. Each task shows:

- The note it belongs to (click the note name to open it).
- A checkbox (checking it marks the task as `- [x]` in the source).
- A coloured status dot indicating its schedule state:
  - **Red** — overdue (scheduled date is in the past).
  - **Amber** — due today.
  - **Green** — due at future date.
  - **Grey** — no schedule attached.

The Tasks tab has its own search box with AND / OR / NOT support and colour-based schedule filtering (see [Searching and Filtering Notes](#searching-and-filtering-notes)).

Wiki-links and inline markdown inside tasks are rendered in both the preview and the Tasks tab.

---

## Schedule

You can attach a date and time window to any line (typically a task) by appending schedule syntax to the end of the line:

```
- [ ] Team meeting > 260315 0900 1030
```

The format is:

```
> YYMMDD HHMM HHMM
```

where the first time is the **start** and the second is the **end** (both in 24-hour format). This suffix is invisible in preview mode — it is stripped during preprocessing.

The **Schedule tab** (third tab in the side panel) shows a vertical day-view timeline from 7 AM to 7 PM. Scheduled items appear as blocks positioned at the correct time. Use the `‹` / `›` arrows to move between days, or click the date label to jump back to today.

If the scheduled line is a task (`- [ ]` / `- [x]`), the block includes a checkbox you can toggle directly. Clicking the item name opens the note it belongs to.

---

## Projects Note

If any note is named using the pattern `YYMMDD Project Name` (e.g. `260301 Project Alpha`), a special read-only **Projects** note is auto-generated and kept up to date. It organises all matching project notes by year and season:

```
# Projects

## 2026

### Spring

- [[260301 Project Alpha]]
- [[260415 Project Beta]]

### Winter

- [[260105 Project Gamma]]
```

The Projects note is always rendered in preview mode and cannot be edited directly. The project links are clickable wiki-links that navigate to each project note.

---

## Tables

Write standard markdown tables:

```
| Item   | Price |
|--------|-------|
| Apples | $1.20 |
| Bread  | $2.50 |
```

In preview mode, columns are **auto-aligned** based on the content of the first data row. Columns whose first cell contains a numeric value (ignoring currency symbols, commas, percent signs, and spaces) are right-aligned; all other columns are left-aligned. Header cells are aligned to match.

---

## Footnotes

Define footnotes with `[^id]: text` on its own line, and reference them inline with `[^id]`:

```
This claim needs a source[^1].

Another point[^note].

[^1]: First reference.
[^note]: A longer explanation that supports inline **markdown**, *links*, and $math$.
```

In preview mode:

- Inline references become clickable superscript numbers (in the order they first appear).
- A horizontal rule and numbered footnote list are appended at the bottom of the note.
- Each footnote includes a `↩` back-link to jump to the reference point.

---

## Highlighted Text

Wrap text in double equals signs to highlight it:

```
This is ==important== information.
```

In preview mode, `==text==` is rendered as `<mark>text</mark>`, which displays with a highlighted background. Highlighting is not applied inside fenced code blocks.

---

## Tab Indentation

Pressing **Tab** in the editor inserts a tab character. In preview mode, tab-indented lines are rendered with proportional left padding (2em per tab level), preserving visual indentation.

How different line types are handled when tab-indented:

| Line type | Behaviour |
|-----------|-----------|
| Plain text | Rendered as a `<p>` with CSS `padding-left` |
| List items (`-`, `*`, `+`, `1.`) | Wrapped in a `<div>` with padding so the entire list block is indented |
| Blockquotes, headings | Passed through to the markdown parser with equivalent space-indentation |
| Fenced code blocks | Never modified (tabs inside code blocks are preserved as-is) |

---

## Math Formulas

Mathematical expressions are rendered by **MathJax 3**.

| Syntax | Delimiters | Renders as |
|--------|------------|------------|
| Inline | `$…$` or `\(…\)` | Math within a line of text |
| Display (block) | `$$…$$` or `\[…\]` | Centred, full-width equation |

Examples:

```
The area of a circle is $A = \pi r^2$.

$$
E = mc^2
$$
```

Math is also rendered inside exported HTML files and the Tasks tab.

---

## Clickable Math Formula Evaluation

Any math formula whose LaTeX source **ends with `=`** becomes clickable in preview mode. It is shown with a dashed underline and a pointer cursor. Clicking it evaluates the expression and displays the result inline (or `?` if it cannot be solved).

### Defining variables

Write a formula of the form `variable = value` anywhere in the same note (as either inline or block math). These act as variable definitions that the evaluator can look up:

```
$m = 10$
$a = 9.81$
$F = m \cdot a$
```

Supported variable name forms:

| Form | Example |
|------|---------|
| Single letter | `$x = 5$` |
| LaTeX Greek letter | `$\alpha = 3.14$` |
| Subscripted | `$x_1 = 10$` or `$x_{10} = 10$` |

### Evaluating a formula

End any formula with `=` to make it clickable:

```
$m \cdot a =$            ← click to get 98.1
$\frac{F}{m} =$          ← click to get 9.81
$$\sqrt{a^2 + b^2} =$$   ← block formula, also clickable
```

### How dependency resolution works

1. **First pass** — the evaluator scans every formula in the note and collects direct numeric assignments (e.g. `$x = 5$`).
2. **Multi-pass resolution** — formulas that define a variable in terms of other variables (e.g. `$F = m \cdot a$`) are iteratively resolved, up to 20 passes deep, until no new variables can be computed.
3. **Evaluation** — when you click a formula ending with `=`, the expression (everything before the trailing `=`) is substituted with known values and evaluated.

Adjacent single-letter variables are treated as implicit multiplication: `$ma$` means `m * a` (matching standard mathematical convention and how MathJax renders it).

### Result display

- Results are shown to a **maximum of 10 significant figures**, with trailing zeros removed.
- Very large (>= 10^10) or very small (< 10^-4) values use scientific notation.
- If the expression cannot be evaluated (undefined variables, unsupported syntax, division by zero, etc.) the result is displayed as `= ?`.
- **Results are saved** — when you click a formula, the computed result is written back into the markdown source (e.g. `$c =` becomes `$c = 5$`), so results persist across preview renders and page reloads.
- **Click again to unsave** — clicking a formula that already shows a result removes the result from both the display and the markdown source, reverting it to a bare trailing `=`.

### Supported LaTeX constructs

| Category | LaTeX | Evaluates as |
|----------|-------|--------------|
| **Fractions** | `\frac{a}{b}` | `a / b` |
| **Square root** | `\sqrt{x}` | `sqrt(x)` |
| **Nth root** | `\sqrt[n]{x}` | `x^(1/n)` |
| **Power** | `x^{n}` or `x^2` | `x^n` |
| **Multiplication** | `\cdot` | `*` |
| **Multiplication** | `\times` | `*` |
| **Division** | `\div` | `/` |
| **Pi** | `\pi` | 3.141592653… |
| **Infinity** | `\infty` | Infinity |
| **Sine** | `\sin(x)` | `sin(x)` |
| **Cosine** | `\cos(x)` | `cos(x)` |
| **Tangent** | `\tan(x)` | `tan(x)` |
| **Inverse sine** | `\arcsin(x)` | `asin(x)` |
| **Inverse cosine** | `\arccos(x)` | `acos(x)` |
| **Inverse tangent** | `\arctan(x)` | `atan(x)` |
| **Natural log** | `\ln(x)` | `ln(x)` |
| **Log base 10** | `\log(x)` | `log10(x)` |
| **Exponential** | `\exp(x)` | `e^x` |
| **Absolute value** | `\abs(x)` or `\left\| x \right\|` | `abs(x)` |
| **Min / Max** | `\min(a, b)` / `\max(a, b)` | `min(a, b)` / `max(a, b)` |
| **Floor / Ceil** | `\floor(x)` / `\ceil(x)` | `floor(x)` / `ceil(x)` |
| **Brackets** | `\left( … \right)` | `( … )` |
| **Implicit multiplication** | `2x`, `ab`, `2(x+1)` | `2*x`, `a*b`, `2*(x+1)` |

Nested constructs such as `\frac{\sqrt{a^2 + b^2}}{2}` are handled correctly.

### Full worked example

Write these formulas in a note:

```
$a = 3$
$b = 4$
$c = \sqrt{a^2 + b^2}$

The hypotenuse is $c =$

The area of the triangle is $\frac{a \cdot b}{2} =$
```

Click `$c =$` to see **5**. Click the area formula to see **6**.

---

## Import and Export

All import/export buttons are in the toolbar at the top. Hover over a main button to reveal additional options underneath. When the browser window is too narrow to fit all toolbar buttons, the overflowing buttons collapse into a **Tools** dropdown. Hover over the Tools button to reveal them.

| Action | Button | Format | Scope |
|--------|--------|--------|-------|
| **Backup Notes** | Backup | `.zip` of `.md` files | All notes |
| **Backup Visible Notes** | Backup (with search filter active) | `.zip` of `.md` files | Filtered notes only |
| **Import Notes** | Import | `.zip` containing `.md` files | Adds to storage |
| **Export Note** | Export | Single `.html` file | Current note |
| **Export Visible Notes** | Export → Filtered | Notebook `.html` with TOC sidebar | Filtered notes |
| **Export All Notes** | Export → All | Notebook `.html` with TOC sidebar | All notes |
| **Delete Note** | Delete | — | Current note |
| **Delete Visible Notes** | Delete → Filtered | — | Filtered notes |
| **Delete All Notes** | Delete → All | — | All notes |

**Exported HTML** files are self-contained and include inline CSS styled to match the app's dark theme. MathJax is loaded from CDN so math renders in the export. The "all notes" notebook export includes a sidebar table of contents with links to each note, and internal note links are rewritten as in-page anchors.

**Importing** a `.zip` file reads every `.md` file inside it and saves each one as a note (using the filename minus the `.md` extension as the note name).

---

## Mobile Navigation

On narrow screens (650 px or less), the side panels are hidden by default and accessible via swipe gestures:

- **Swipe right** — reveals the Notes list panel from the left edge.
- **Swipe left** — reveals the Tasks / Schedule panel from the right edge.
- Tap the **overlay** behind an open panel to close it.

The toolbar buttons also adapt for touch: on mobile, sub-button menus are triggered by a single tap rather than hover.

---

## Cross-Window Sync

If you have the app open in multiple browser tabs or windows, changes are synchronised automatically via `storage` events:

- Editing a note in one tab updates it in any other tab that has the same note open.
- Deleting a note in one tab removes it from all other tabs.
- Creating a backup in one tab updates the backup status indicator in every tab.

No manual refresh is required — changes appear instantly.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+F** / **Cmd+F** | Open global search and replace |
| **Escape** | Close global search panel |
| **Tab** | Insert a tab character in the editor |
| **Arrow Up / Down** | Navigate search results (when the search panel is focused) |

---

## Storage and Persistence

All data is stored in the browser's `localStorage`. Each note is saved under the key `md_<note name>`. The following preferences are also persisted:

| Key | What it stores |
|-----|---------------|
| `current_file` | Name of the last opened note |
| `is_preview` | Whether preview mode was active |
| `panel_pinned` | Whether the side panel was pinned open |
| `linked_chain` | The breadcrumb navigation chain (JSON array) |
| `active_panel` | The last active side panel tab (`files`, `tasks`, or `schedule`) |
| `last_backup_time` | Timestamp (ms) of the most recent backup, used for the backup status indicator |

Because everything lives in localStorage, your notes are tied to the browser profile and domain you use. To move notes between browsers or devices, use the backup/import workflow described in [Import and Export](#import-and-export).
