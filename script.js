document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('editor');
    editor.readOnly = false;
    const calendar = document.getElementById('calendar');
    const newFileBtn = document.getElementById('new-file');
    const projectList = document.getElementById('saved-projects-list');
    const projectSearch = document.getElementById('project-search');
    const statusDiv = document.getElementById('status-message');
    const deleteCurrentBtn = document.getElementById('delete-current-file');
    const deleteAllBtn = document.getElementById('delete-all-files');
    const deleteVisibleBtn = document.getElementById('delete-visible-files');
    const backupAllBtn = document.getElementById('backup-all-files');
    const backupVisibleBtn = document.getElementById('backup-visible-files');
    const importBtn = document.getElementById('import-note');
    const importInput = document.getElementById('import-file');
    const previewBtn = document.getElementById('preview-markdown');
    const previewDiv = document.getElementById('preview');
    let previewActive = false;
    const savedPreview = localStorage.getItem('is_preview') === 'true';

    if (typeof marked !== 'undefined') {
        marked.setOptions({ breaks: true });
    }

    const ALL_PROJECTS_NAME = 'All Projects';
    const COMPLETED_PROJECTS_NAME = 'Completed Projects';
    const INCOMPLETE_PROJECTS_NAME = 'Incomplete Projects';
    let currentProject = null;
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const today = new Date();

    function randomColour() {
        const h = Math.floor(Math.random() * 360);
        const s = 60;
        const l = 85;
        return `hsl(${h},${s}%,${l}%)`;
    }

    function toTitleCase(str) {
        return str.replace(/\w\S*/g, (w) =>
            w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        );
    }

    function updateStatus(message, success) {
        const formatted = message ? toTitleCase(message) : '';
        statusDiv.textContent = formatted;
        statusDiv.style.color = success ? 'green' : 'red';
    }

    function parseProjects(text) {
        const lines = text.split('\n'),
            items = [];
        let current = null;

        lines.forEach(line => {
            let m;
            if (m = line.match(/^#\s+(.+)/)) {

                if (current) items.push(current);
                current = {
                    title: m[1].trim(),
                    start: null,
                    end: null,
                    colour: null,
                    completed: false
                };

            } else if (current) {

                if (m = line.match(/Start:\s*(\d{2})\/(\d{2})\/(\d{2})/))
                    current.start = new Date(2000 + +m[3], +m[2] - 1, +m[1]);

                if (m = line.match(/End:\s*(\d{2})\/(\d{2})\/(\d{2})/))
                    current.end = new Date(2000 + +m[3], +m[2] - 1, +m[1]);

                if (m = line.match(/Colour:\s*(.+)/))
                    current.colour = m[1].trim();

                if (m = line.match(/Completed:\s*(True|False)/i))
                    current.completed = m[1].toLowerCase() === 'true';
            }
        });

        if (current) items.push(current);
        return items
            .filter(i => i.start && i.end)
            .map(i => {
                if (!i.colour) i.colour = randomColour();
                return i;
            });
    }

    function loadProject(name) {
        const content = localStorage.getItem('project_' + name) || '';
        currentProject = name;
        editor.readOnly = false;
        editor.value = content;
        localStorage.setItem('currentProject', name);
        renderCalendar(parseProjects(content));
        updateProjectList();
        updateStatus('', true);
        if (previewActive) {
            renderPreview();
        }
    }

    function loadAllProjects() {
        currentProject = ALL_PROJECTS_NAME;
        editor.readOnly = true;
        localStorage.setItem('currentProject', ALL_PROJECTS_NAME);
        updateAllProjectsDisplay();
        updateProjectList();
        updateStatus('Viewing all projects. Editing disabled.', true);
    }

    function loadCompletedProjects() {
        currentProject = COMPLETED_PROJECTS_NAME;
        editor.readOnly = true;
        localStorage.setItem('currentProject', COMPLETED_PROJECTS_NAME);
        updateCompletedProjectsDisplay();
        updateProjectList();
        updateStatus('Viewing completed projects. Editing disabled.', true);
    }

    function loadIncompleteProjects() {
        currentProject = INCOMPLETE_PROJECTS_NAME;
        editor.readOnly = true;
        localStorage.setItem('currentProject', INCOMPLETE_PROJECTS_NAME);
        updateIncompleteProjectsDisplay();
        updateProjectList();
        updateStatus('Viewing incomplete projects. Editing disabled.', true);
    }

    function saveProject() {
        if (editor.readOnly) return;
        const firstLine = editor.value.split('\n')[0] || '';
        const m = firstLine.match(/^#\s+(.+)/);
        if (!m) {
            updateStatus('Project not saved. Please add a title starting with "#".', false);
            return;
        }
        const name = m[1].trim();
        if (name === ALL_PROJECTS_NAME || name === COMPLETED_PROJECTS_NAME || name === INCOMPLETE_PROJECTS_NAME) {
            updateStatus('The selected name is reserved.', false);
            return;
        }
        if (currentProject !== name && localStorage.getItem('project_' + name) !== null) {
            updateStatus('A Project With That Name Already Exists.', false);
            return;
        }
        if (currentProject && currentProject !== name) {
            localStorage.removeItem('project_' + currentProject);
        }
        currentProject = name;
        localStorage.setItem('project_' + name, editor.value);
        localStorage.setItem('currentProject', name);
        updateProjectList();
        updateStatus('Project saved.', true);
    }

    function createSearchPredicate(query) {
        if (!query) return () => true;

        const tokens = query.match(/"[^"]+"|\S+/g) || [];
        const hasOps = tokens.some(t => ['AND', 'OR', 'NOT'].includes(t.toUpperCase()));
        if (!hasOps && tokens.length > 1) {
            const phrase = query.toLowerCase();
            return (n, c) => n.includes(phrase) || c.includes(phrase);
        }

        let index = 0;

        function parseExpression() {
            let left = parseTerm();
            while (tokens[index] && tokens[index].toUpperCase() === 'OR') {
                index++;
                const right = parseTerm();
                const prev = left;
                left = (n, c) => prev(n, c) || right(n, c);
            }
            return left;
        }

        function parseTerm() {
            let left = parseFactor();
            while (tokens[index] && tokens[index].toUpperCase() !== 'OR') {
                if (tokens[index].toUpperCase() === 'AND') {
                    index++;
                }
                const right = parseFactor();
                const prev = left;
                left = (n, c) => prev(n, c) && right(n, c);
            }
            return left;
        }

        function parseFactor() {
            if (tokens[index] && tokens[index].toUpperCase() === 'NOT') {
                index++;
                const next = parseFactor();
                return (n, c) => !next(n, c);
            }
            const termToken = tokens[index++] || '';
            let term = termToken;
            let namesOnly = false;
            if (term.startsWith('"') && term.endsWith('"')) {
                namesOnly = true;
                term = term.slice(1, -1);
            }
            return namesOnly
                ? (n, c) => n.includes(term)
                : (n, c) => n.includes(term) || c.includes(term);
        }

        return parseExpression();
    }

    function updateProjectList() {
        if (!projectList) return;
        projectList.innerHTML = '';
        const raw = projectSearch.value.trim().toLowerCase();
        const matches = createSearchPredicate(raw);
        const projects = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('project_')) {
                const name = key.slice(8);
                const content = (localStorage.getItem(key) || '').toLowerCase();
                if (matches(name.toLowerCase(), content)) {
                    projects.push(name);
                }
            }
        }
        if (matches(ALL_PROJECTS_NAME.toLowerCase(), '')) {
            const allLi = document.createElement('li');
            allLi.textContent = ALL_PROJECTS_NAME;
            if (currentProject === ALL_PROJECTS_NAME) allLi.classList.add('active-file');
            allLi.addEventListener('click', loadAllProjects);
            projectList.appendChild(allLi);
        }
        if (matches(COMPLETED_PROJECTS_NAME.toLowerCase(), '')) {
            const compLi = document.createElement('li');
            compLi.textContent = COMPLETED_PROJECTS_NAME;
            if (currentProject === COMPLETED_PROJECTS_NAME) compLi.classList.add('active-file');
            compLi.addEventListener('click', loadCompletedProjects);
            projectList.appendChild(compLi);
        }
        if (matches(INCOMPLETE_PROJECTS_NAME.toLowerCase(), '')) {
            const incompLi = document.createElement('li');
            incompLi.textContent = INCOMPLETE_PROJECTS_NAME;
            if (currentProject === INCOMPLETE_PROJECTS_NAME) incompLi.classList.add('active-file');
            incompLi.addEventListener('click', loadIncompleteProjects);
            projectList.appendChild(incompLi);
        }

        projects.sort().forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            if (name === currentProject) li.classList.add('active-file');
            li.addEventListener('click', () => loadProject(name));
            projectList.appendChild(li);
        });
    }

    function getAllProjects() {
        const names = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('project_')) names.push(key.slice(8));
        }
        return names.sort();
    }

    function getVisibleProjects() {
        const raw = projectSearch.value.trim().toLowerCase();
        const matches = createSearchPredicate(raw);
        return getAllProjects().filter(n => {
            const content = (localStorage.getItem('project_' + n) || '').toLowerCase();
            return matches(n.toLowerCase(), content);
        });
    }

    function extractProjects(text) {
        const lines = text.split('\n');
        const projects = [];
        let currentLines = [];
        let completed = false;
        let inProject = false;

        function pushCurrent() {
            if (inProject) {
                projects.push({ text: currentLines.join("\n").trim(), completed: completed });
            }
        }

        lines.forEach(line => {
            if (/^#\s+/.test(line)) {
                pushCurrent();
                currentLines = [line];
                completed = false;
                inProject = true;
            } else if (inProject) {
                currentLines.push(line);
                const m = line.match(/Completed:\s*(True|False)/i);
                if (m) completed = m[1].toLowerCase() === 'true';
            }
        });

        pushCurrent();
        return projects;
    }

    function filterProjectsByCompletion(text, done) {
        return extractProjects(text)
            .filter(p => p.completed === done)
            .map(p => p.text)
            .filter(t => t.length)
            .join('\n\n');
    }

    function projectIsCompleted(content) {
        const m = content.match(/Completed:\s*(True|False)/i);
        return m ? m[1].toLowerCase() === 'true' : false;
    }

    function updateAllProjectsDisplay() {
        const names = getVisibleProjects();
        let combined = '';
        names.forEach(name => {
            const txt = localStorage.getItem('project_' + name) || '';
            combined += txt + '\n\n';
        });
        combined = combined.trim();
        editor.value = combined;
        renderCalendar(parseProjects(combined));
        if (previewActive) {
            renderPreview();
        }
    }

    function updateCompletedProjectsDisplay() {
        const names = getVisibleProjects();
        let combined = '';
        names.forEach(name => {
            const txt = localStorage.getItem('project_' + name) || '';
            const part = filterProjectsByCompletion(txt, true);
            if (part) combined += part + '\n\n';
        });
        combined = combined.trim();
        editor.value = combined;
        renderCalendar(parseProjects(combined));
        if (previewActive) {
            renderPreview();
        }
    }

    function updateIncompleteProjectsDisplay() {
        const names = getVisibleProjects();
        let combined = '';
        names.forEach(name => {
            const txt = localStorage.getItem('project_' + name) || '';
            const part = filterProjectsByCompletion(txt, false);
            if (part) combined += part + '\n\n';
        });
        combined = combined.trim();
        editor.value = combined;
        renderCalendar(parseProjects(combined));
        if (previewActive) {
            renderPreview();
        }
    }

    function deleteCurrentProject() {
        if (!currentProject) {
            updateStatus('No project selected.', false);
            return;
        }
        localStorage.removeItem('project_' + currentProject);
        currentProject = null;
        editor.readOnly = false;
        editor.value = '';
        localStorage.removeItem('currentProject');
        renderCalendar([]);
        updateProjectList();
        updateStatus('Project deleted.', true);
        if (previewActive) {
            renderPreview();
        }
    }

    function deleteAllProjects() {
        if (!confirm('Delete all projects?')) return;
        getAllProjects().forEach(n => localStorage.removeItem('project_' + n));
        currentProject = null;
        editor.readOnly = false;
        editor.value = '';
        localStorage.removeItem('currentProject');
        renderCalendar([]);
        updateProjectList();
        updateStatus('All projects deleted.', true);
        if (previewActive) {
            renderPreview();
        }
    }

    function deleteVisibleProjects() {
        const names = getVisibleProjects();
        if (names.length === 0) {
            updateStatus('No visible projects to delete.', false);
            return;
        }
        if (!confirm('Delete visible projects?')) return;
        names.forEach(n => localStorage.removeItem('project_' + n));
        if (names.includes(currentProject)) {
            currentProject = null;
            editor.readOnly = false;
            editor.value = '';
            localStorage.removeItem('currentProject');
            renderCalendar([]);
        } else {
            if (currentProject === COMPLETED_PROJECTS_NAME) {
                updateCompletedProjectsDisplay();
            } else if (currentProject === INCOMPLETE_PROJECTS_NAME) {
                updateIncompleteProjectsDisplay();
            } else {
                renderCalendar(parseProjects(editor.value));
            }
        }
        updateProjectList();
        updateStatus('Visible projects deleted.', true);
        if (previewActive) {
            renderPreview();
        }
    }


    function backupProjects(names, fileName) {
        if (!names.length) {
            updateStatus('No projects to backup.', false);
            return;
        }
        if (typeof JSZip === 'undefined') {
            updateStatus('Backup failed: JSZip not loaded.', false);
            return;
        }
        const zip = new JSZip();
        names.forEach(n => {
            const content = localStorage.getItem('project_' + n) || '';
            zip.file(n + '.txt', content);
        });
        zip.generateAsync({ type: 'blob' }).then(content => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = fileName;
            link.click();
            URL.revokeObjectURL(link.href);
            updateStatus('Projects backed up.', true);
        });
    }

    function importProjects(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                Object.keys(data).forEach(n => {
                    localStorage.setItem('project_' + n, data[n]);
                });
                updateProjectList();
                updateStatus('Projects imported.', true);
            } catch (e) {
                updateStatus('Import failed.', false);
            }
        };
        reader.readAsText(file);
    }

    function preprocessForPreview(text) {
        const lines = text.split('\n');
        const out = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip attribute lines entirely
            if (/^(Start|End|Colour|Completed):/i.test(line)) continue;

            const heading = line.match(/^#\s+(.+)/);
            if (heading) {
                // Look ahead for attributes before the next heading
                let colour = null;
                let completed = false;
                for (let j = i + 1; j < lines.length; j++) {
                    const next = lines[j];
                    if (/^#\s+/.test(next)) break;
                    let m = next.match(/^Colour:\s*(.+)/);
                    if (m) { colour = m[1].trim(); }
                    m = next.match(/^Completed:\s*(True|False)/i);
                    if (m) { completed = m[1].toLowerCase() === 'true'; }
                    if (!next.trim()) break;
                }
                let title = heading[1].trim();
                if (completed) {
                    title = '<del>' + title + '</del>';
                }
                if (colour) {
                    title = '<span style="color:' + colour + '">' + title + '</span>';
                }
                out.push('# ' + title);
                continue;
            }

            out.push(line);
        }

        return out.join('\n');
    }

    function renderPreview() {
        const text = preprocessForPreview(editor.value);
        let html = '';
        if (typeof marked !== 'undefined') {
            html = marked.parse(text);
        } else {
            html = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            html = html
                .replace(/&lt;(\/?)del&gt;/g, '<$1del>')
                .replace(/&lt;(\/?)span([^&]*)&gt;/g, '<$1span$2>')
                .replace(/\n/g, '<br>');
        }
        previewDiv.innerHTML = html;
    }

    function previewMarkdown() {
        if (!previewActive) {
            renderPreview();
            editor.style.display = 'none';
            previewDiv.style.display = 'block';
            previewBtn.textContent = 'Edit Markdown';
            previewActive = true;
            localStorage.setItem('is_preview', 'true');
        } else {
            previewDiv.style.display = 'none';
            editor.style.display = 'block';
            previewBtn.textContent = 'Preview Markdown';
            previewActive = false;
            localStorage.setItem('is_preview', 'false');
        }
    }

    function disablePreview() {
        if (previewActive) {
            previewDiv.style.display = 'none';
            editor.style.display = 'block';
            previewBtn.textContent = 'Preview Markdown';
            previewActive = false;
            localStorage.setItem('is_preview', 'false');
        }
    }


    function renderCalendar(projects, target = calendar) {
        target.innerHTML = '';
        if (!projects.length) return;

        const years = projects.flatMap(p => [p.start.getFullYear(), p.end.getFullYear()]);
        const minY = Math.min(...years),
            maxY = Math.max(...years);

        for (let year = minY; year <= maxY; year++) {
            const months = new Set();
            projects.forEach(p => {
                const sy = p.start.getFullYear(),
                    ey = p.end.getFullYear();
                if (year < sy || year > ey) return;
                const ms = year === sy ? p.start.getMonth() : 0;
                const me = year === ey ? p.end.getMonth() : 11;
                for (let m = ms; m <= me; m++) months.add(m);
            });
            if (!months.size) continue;

            const yBlock = document.createElement('div');
            yBlock.className = 'year-block';
            yBlock.innerHTML = `<h1>${year}</h1>`;

            Array.from(months).sort((a, b) => a - b).forEach(m => {
                const monthDiv = document.createElement('div');
                monthDiv.className = 'month';
                monthDiv.innerHTML = `<h2>${
new Date(year, m).toLocaleString('default',{month:'long'})
}</h2>`;

                const wdRow = document.createElement('div');
                wdRow.className = 'weekdays';
                weekdays.forEach(w => {
                    const d = document.createElement('div');
                    d.textContent = w;
                    wdRow.appendChild(d);
                });
                monthDiv.appendChild(wdRow);

                const daysGrid = document.createElement('div');
                daysGrid.className = 'days';
                const first = new Date(year, m, 1);
                const offset = (first.getDay() + 6) % 7;
                for (let i = 0; i < offset; i++) {
                    daysGrid.appendChild(Object.assign(
                        document.createElement('div'), {
                            className: 'day'
                        }
                    ));
                }

                const total = new Date(year, m + 1, 0).getDate();
                for (let d = 1; d <= total; d++) {
                    const cell = document.createElement('div');
                    cell.className = 'day';

                    // highlight today
                    if (
                        year === today.getFullYear() &&
                        m === today.getMonth() &&
                        d === today.getDate()
                    ) cell.classList.add('today');

                    const num = document.createElement('div');
                    num.className = 'day-number';
                    num.textContent = d;

                    const date = new Date(year, m, d);
                    const bars = document.createElement('div');
                    bars.className = 'bars';

                    projects.forEach(p => {
                        if (date >= p.start && date <= p.end) {
                            const bar = document.createElement('div');
                            bar.className = 'bar';
                            bar.style.backgroundColor = p.colour;
                            bar.title = p.title;
                            bars.appendChild(bar);
                        }
                    });

                    if (bars.children.length > 0) {
                        num.style.color = '#000';
                    }

                    cell.appendChild(num);
                    cell.appendChild(bars);
                    daysGrid.appendChild(cell);
                }

                monthDiv.appendChild(daysGrid);
                yBlock.appendChild(monthDiv);
            });

            target.appendChild(yBlock);
        }
    }

    function getCalendarHTML(projects) {
        const temp = document.createElement('div');
        renderCalendar(projects, temp);
        return temp.innerHTML;
    }

    updateProjectList();

    const saved = localStorage.getItem('currentProject');
    if (saved === ALL_PROJECTS_NAME) {
        loadAllProjects();
    } else if (saved === COMPLETED_PROJECTS_NAME) {
        loadCompletedProjects();
    } else if (saved === INCOMPLETE_PROJECTS_NAME) {
        loadIncompleteProjects();
    } else if (saved && localStorage.getItem('project_' + saved) !== null) {
        loadProject(saved);
    } else {
        const anyKey = Object.keys(localStorage).find(k => k.startsWith('project_'));
        if (anyKey) {
            loadProject(anyKey.slice(8));
        } else {
            currentProject = null;
            editor.value = '';
            renderCalendar([]);
            updateStatus('Enter project title on the first line starting with "#".', false);
        }
    }

    if (savedPreview) {
        previewMarkdown();
    }

    editor.addEventListener('keydown', e => {
        if (editor.readOnly) return;
        if (e.key !== 'Enter') return;
        const pos = editor.selectionStart;
        const text = editor.value;
        const before = text.slice(0, pos);
        const lastLine = before.split('\n').pop();
        if (!/^#\s+.+$/.test(lastLine)) return;

        e.preventDefault();
        const lineInsert = 'Colour: ' + randomColour();
        const after = text.slice(pos);
        const newText = before + '\n' + lineInsert + '\n' + after;

        editor.value = newText;
        const newPos = pos + 1 + lineInsert.length + 1;
        editor.selectionStart = editor.selectionEnd = newPos;

        saveProject();
        renderCalendar(parseProjects(newText));
    });

    editor.addEventListener('input', () => {
        if (editor.readOnly) return;
        const txt = editor.value;
        saveProject();
        renderCalendar(parseProjects(txt));
    });

    newFileBtn.addEventListener('click', () => {
        currentProject = null;
        editor.readOnly = false;
        editor.value = '';
        localStorage.removeItem('currentProject');
        renderCalendar([]);
        updateProjectList();
        updateStatus('Enter project title on the first line starting with "#".', false);
        disablePreview();
    });

    deleteCurrentBtn.addEventListener('click', deleteCurrentProject);
    deleteAllBtn.addEventListener('click', deleteAllProjects);
    deleteVisibleBtn.addEventListener('click', deleteVisibleProjects);
    backupAllBtn.addEventListener('click', () => backupProjects(getAllProjects(), 'all_projects.zip'));
    backupVisibleBtn.addEventListener('click', () => backupProjects(getVisibleProjects(), 'visible_projects.zip'));
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', e => {
        if (e.target.files.length) importProjects(e.target.files[0]);
        importInput.value = '';
    });
    previewBtn.addEventListener('click', previewMarkdown);

    projectSearch.addEventListener('input', () => {
        updateProjectList();
        if (currentProject === ALL_PROJECTS_NAME) {
            updateAllProjectsDisplay();
        } else if (currentProject === COMPLETED_PROJECTS_NAME) {
            updateCompletedProjectsDisplay();
        } else if (currentProject === INCOMPLETE_PROJECTS_NAME) {
            updateIncompleteProjectsDisplay();
        }
    });
});
