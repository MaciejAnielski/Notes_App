# Notes App

A personal markdown notes app that runs entirely in the browser. All data is stored in localStorage — there is no server, no account, no installation. Open `index.html` in any modern browser and start writing.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Writing Notes](#writing-notes)
3. [Preview Mode](#preview-mode)
4. [Linking Between Notes](#linking-between-notes)
5. [Task Lists](#task-lists)
6. [Schedule](#schedule)
7. [Math Formulas](#math-formulas)
8. [Clickable Math Formula Evaluation](#clickable-math-formula-evaluation)
9. [Footnotes](#footnotes)
10. [Tables](#tables)
11. [Tab Indentation](#tab-indentation)
12. [Searching and Filtering Notes](#searching-and-filtering-notes)
13. [Global Search and Replace](#global-search-and-replace)
14. [The Side Panel](#the-side-panel)
15. [Projects Note](#projects-note)
16. [Import and Export](#import-and-export)
17. [Keyboard Shortcuts](#keyboard-shortcuts)
18. [Storage and Persistence](#storage-and-persistence)

---

## Getting Started

Open `index.html` in a browser. A new note is created automatically with today's date as the title (format `YYMMDD`). Start typing — the note is auto-saved to localStorage one second after you stop.

The first line of every note **must** begin with `#` (a markdown heading). That heading becomes the note's file name. If you change the heading text, the note is renamed accordingly.

If a note with today's date already exists the editor opens blank instead so you don't accidentally overwrite it. If you type only a `#` heading that matches an existing note and nothing else, that note opens automatically.

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

Line breaks are enabled — a single newline in the source creates a `<br>` in the output.

Pressing **Tab** in the editor inserts a literal tab character, which is preserved as visual indentation in preview mode (see [Tab Indentation](#tab-indentation)).

---

## Preview Mode

Click **Preview Markdown** to render the current note. The button text changes to **Edit Markdown** so you can switch back. The last mode you were in (edit or preview) is remembered across browser refreshes.

Preview mode is fully interactive:

- **Collapsible headings** — every heading becomes a toggle. Click a heading to collapse or expand everything beneath it (down to the next heading of equal or higher rank). All sections start expanded. A small `›` / `⌄` indicator appears after each heading.
- **Task checkboxes** — checking or unchecking a task in the preview updates the markdown source and saves immediately (see [Task Lists](#task-lists)).
- **Note links** — clicking an internal link navigates to that note (see [Linking Between Notes](#linking-between-notes)).
- **Auto-aligned tables** — numeric columns are right-aligned, text columns left-aligned, automatically (see [Tables](#tables)).
- **Clickable math formulas** — formulas ending with `=` can be clicked to compute a result (see [Clickable Math Formula Evaluation](#clickable-math-formula-evaluation)).
- **MathJax rendering** — inline and display math expressions are typeset by MathJax 3 (see [Math Formulas](#math-formulas)).

---

## Linking Between Notes

There are two ways to create a link to another note:

| Syntax | Example |
|--------|---------|
| Wiki-link | `[[My Other Note]]` |
| Standard markdown link | `[display text](My Other Note)` |

Wiki-links are converted to standard markdown links during preprocessing, so both forms behave identically in preview.

When you click an internal link in preview mode:

1. If the target note **exists**, it opens. The note you came from is pushed onto a breadcrumb chain shown in the side panel (see [The Side Panel](#the-side-panel)).
2. If the target note **does not exist**, it is created automatically with a `# Title` heading and then opened. These links appear with a distinct style so you can tell they point to notes that haven't been written yet.

Clicking a breadcrumb note in the side panel navigates back to it and trims the chain.

---

## Task Lists

Write tasks using standard markdown checkbox syntax:

```
- [ ] Unchecked task
- [x] Completed task
```

**In preview mode** you can check and uncheck tasks directly — the underlying markdown source is updated and saved in real time.

**In the Tasks panel** (see [The Side Panel](#the-side-panel)) every unchecked task across all notes is collected into a single list. Each task shows:

- The note it belongs to (click the note name to open it).
- A checkbox (checking it marks the task as `- [x]` in the source).
- A coloured status dot indicating its schedule state:
  - **Red** — overdue (scheduled date is in the past).
  - **Amber** — due today.
  - **Blue** — future.
  - **Grey** — no schedule attached.

The Tasks panel has its own search box that supports the same AND / OR / NOT operators as the notes search (see [Searching and Filtering Notes](#searching-and-filtering-notes)).

Wiki-links and inline markdown inside tasks are rendered in both the preview and the Tasks panel.

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

The **Schedule panel** (third tab in the side panel) shows a vertical day-view timeline from 7 AM to 7 PM. Scheduled items appear as blocks positioned at the correct time. Use the `‹` / `›` arrows to move between days, or click the date label to jump back to today.

If the scheduled line is a task (`- [ ]` / `- [x]`), the block includes a checkbox you can toggle directly. Clicking the item name opens the note it belongs to.

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

Math is also rendered inside exported HTML files and the Tasks panel.

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
- Click the formula again to re-evaluate (useful after editing variable definitions and re-entering preview).

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

## Searching and Filtering Notes

The **Search Notes** box in the side panel filters the notes list in real time. The query language supports three operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| (space) or `AND` | Both terms must match | `recipe AND vegetarian` |
| `OR` | Either term may match | `draft OR outline` |
| `NOT` | Exclude results containing the term | `meeting NOT cancelled` |

Operators are case-insensitive. Searches match against both the note name and its content.

To search **note names only** (ignoring content), wrap the query in double quotes:

```
"project"
```

This will only show notes whose title contains "project".

---

## Global Search and Replace

Press **Ctrl+F** (or **Cmd+F** on macOS) to open the global search and replace panel. This searches across **all** notes simultaneously.

- **Search** — type a term and press Enter or click Find. Results appear as a scrollable list showing the note name and a snippet of surrounding context with the match highlighted.
- **Case sensitive** — tick the **Aa** checkbox to require exact case.
- **Navigate results** — click a result to open that note and select the match in the editor. Use **Arrow Up / Down** to move through results.
- **Replace** — type a replacement in the second input, select a result, then click **Replace** to replace that single occurrence.
- **Replace All** — click **All** to replace every occurrence across all matching notes (with a confirmation prompt).
- **Close** — click the `✕` button or press **Escape**.

Search is live — results update as you type (with a 300ms debounce).

---

## The Side Panel

A collapsible panel on the right side of the screen with three tabs, cycled by clicking the `›` arrow at the screen's right edge:

### Notes tab

- Lists all saved notes, sorted reverse-alphabetically (newest date-titled notes first).
- The currently open note is highlighted with a solid purple left border.
- If you navigated through internal links, the breadcrumb chain is shown below the current note with numbered dashed borders. Click any breadcrumb to jump back.
- The search box filters the list (see [Searching and Filtering Notes](#searching-and-filtering-notes)).

### Tasks tab

- Aggregates all unchecked tasks (`- [ ]`) from every note.
- Tasks are grouped under their note name. Click the name to open the note; check the box to complete the task.
- Has its own search box with the same AND / OR / NOT query support.

### Schedule tab

- A day-view timeline (7 AM – 7 PM) showing scheduled items.
- Navigate days with `‹` / `›` or click the date to return to today.
- Checkboxes on task items can be toggled directly.

### Pinning the panel

Click the **pin icon** (top of the panel) to lock it open. When pinned, the panel stays visible as a fixed sidebar and the editor area narrows to accommodate it. Click the pin again to unpin — the panel returns to hover-on-demand behaviour. The pinned state is remembered across refreshes.

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

## Import and Export

All import/export buttons are in the toolbar at the top. Hover over a main button to reveal additional options underneath.

| Action | Button | Format | Scope |
|--------|--------|--------|-------|
| **Backup Notes** | Import Notes → Backup Notes | `.zip` of `.md` files | All notes |
| **Backup Visible Notes** | Import Notes → Backup Visible Notes | `.zip` of `.md` files | Filtered notes only |
| **Import Notes** | Import Notes | `.zip` containing `.md` files | Adds to storage |
| **Export Note** | Export Note | Single `.html` file | Current note |
| **Export Visible Notes** | Export Note → Export Visible Notes | Notebook `.html` with TOC sidebar | Filtered notes |
| **Export All Notes** | Export Note → Export All Notes | Notebook `.html` with TOC sidebar | All notes |
| **Delete Note** | Delete Note | — | Current note |
| **Delete Visible Notes** | Delete Note → Delete Visible Notes | — | Filtered notes |
| **Delete All Notes** | Delete Note → Delete All Notes | — | All notes |

**Exported HTML** files are self-contained and include inline CSS styled to match the app's dark theme. MathJax is loaded from CDN so math renders in the export. The "all notes" notebook export includes a sidebar table of contents with links to each note, and internal note links are rewritten as in-page anchors.

**Importing** a `.zip` file reads every `.md` file inside it and saves each one as a note (using the filename minus the `.md` extension as the note name).

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

Because everything lives in localStorage, your notes are tied to the browser profile and domain you use. To move notes between browsers or devices, use the backup/import workflow described in [Import and Export](#import-and-export).
