# Notes App
A personal notes app that works in the browser.

## Features

- Toggle between light and dark mode. Your choice is remembered between visits.
- The first line of your note starting with `#` becomes its name and is pre-filled with today's date unless a note with today's date already exists.
- Notes are automatically saved to your browser using localStorage.
- Search through saved notes using logical queries (AND, OR, NOT) and download
  them all as a zip archive.
- Delete notes from local storage when you no longer need them.
- Delete all stored notes with a single click.
- Import notes from a zip archive containing Markdown files.
- Export the current note or all notes as HTML files rendered like the preview.
- Toggle between editing and previewing your markdown.
- Check off tasks directly from preview mode.
- Create a new note which clears the editor.
- Notes are automatically saved while you type.
- The last opened note and preview mode are remembered when you refresh.
- Prevent overwriting existing notes by warning when a note title is already in use.
- If the note only contains a title that matches an existing note, that note opens automatically instead of showing a warning.
- View all unchecked tasks across notes in one list. Click a note title to open
  it and click a task checkbox to mark it complete.
- Link to other notes using standard Markdown link syntax, e.g. `[Note](My Note)`.
  Links also work for note names containing spaces.
- Render mathematical expressions with MathJax. Use `$math$` for inline math and
  `$$math$$` for display equations.
