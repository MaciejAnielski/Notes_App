# Notes App

This is a browser based project organizer written in HTML, CSS and JavaScript. Projects are stored locally in the browser using `localStorage` so everything works offline.

## Features

- **Create and manage projects** – each project is written in Markdown. The first line should start with `#` followed by the project name.
- **Automatic saving** – the application saves to `localStorage` whenever you edit.
- **Calendar view** – add `Start:` and `End:` dates to projects and they will appear as colour coded bars on the calendar.
- **Search box** – filter projects using keywords or boolean operators (`AND`, `OR`, `NOT`). Quoted phrases search by name only.
- **Completed and incomplete views** – quickly show only finished or unfinished projects.
- **Backup and restore** – export projects to a zip archive or import them from a JSON file.
- **Markdown preview** – toggle between editing and preview mode powered by marked.

## Usage

1. Open `index.html` in a modern web browser.
2. Click **New Project** and enter your notes. The first line should look like:
   ```
   # My Project
   ```
3. Press **Enter** after the heading to automatically insert a `Colour:` line. You can also add optional attributes:
   ```
   Start: 01/01/23
   End:   15/01/23
   Completed: False
   ```
4. As you type, your work is saved automatically. The calendar updates to reflect any start and end dates.
5. Use the search box to filter projects. Examples:
   - `design` – find projects containing the word *design*.
   - `frontend AND "My Project"` – find items whose name contains *My Project* and whose content mentions *frontend*.
   - `bug NOT closed` – projects mentioning *bug* but not *closed*.
6. Click a project name in the list to load it. Use **Delete** buttons to remove the current, all or visible projects.
7. Choose **Backup Projects** to download a zip file or **Import Projects** to load projects from a JSON file.
8. Toggle **Preview Markdown** to see the rendered version of the current project.

All data lives in your browser. Closing the page keeps your projects intact until you clear browser storage.
