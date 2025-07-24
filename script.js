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
    const exportAllBtn = document.getElementById('export-all-files');
    const exportVisibleBtn = document.getElementById('export-visible-files');
    const backupAllBtn = document.getElementById('backup-all-files');
    const backupVisibleBtn = document.getElementById('backup-visible-files');
    const importBtn = document.getElementById('import-note');
    const importInput = document.getElementById('import-file');
    const previewBtn = document.getElementById('preview-markdown');

    const ALL_PROJECTS_NAME = 'All Projects';
    let currentProject = null;
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const today = new Date();
    const EXPORT_STYLE = `
body {

background-color: #1e1e1e;
color: #f0f0f0;

font-family: Arial, sans-serif;
}

@media (max-width: 1500px){

#layout-wrapper {

flex-direction: column;

}

}


@media (max-width: 650px){

#widget-container {

flex-direction: column-reverse;

}

}

#saved-projects-list {

  list-style: none;
  margin-left: 5px;
  padding: 0;

}

#saved-projects-list li {
  margin-bottom: 5px;
  cursor: pointer;
}

#saved-projects-list li:hover{
  text-decoration: underline;
}

#status-message {
  margin-top: 30px;
  margin-bottom: 10px;
  margin-left: 10px;
  font-weight: bold;
}

#layout-wrapper {
width: 100%;
display: flex;
gap: 20px;
padding-right: 20px;
box-sizing: border-box;

}

#widget-container{

display:flex;

}

#project-container {

margin: 20px;

}

#button-container {

margin-top: 20px;
margin-left: 10px;
margin-right: 5px;

display: flex;

}

input {

display: block;

background-color: #2e2e2e;
color: #f0f0f0;
border: 1px solid #555;
border-radius: 4px;

width: 100%;
max-width: 400px;

padding: 5px;
margin: 10px;
margin-left: 0px;
margin-top: 20px;

font-size: 16px;
font-family: Arial, sans-serif;

}

button {

background-color: #2e2e2e;
color: #f0f0f0;
border: 1px solid #555;
border-radius: 4px;

padding: 8px 12px;
margin-right: 5px;

font-size: 14px;
font-family: Arial, sans-serif;

cursor: pointer;

}

.button-group {

position: relative;
display: inline-block;

}

.button-group:hover .sub-button {

display: block;

}

.sub-button {

display: none;
position: absolute;
top: 100%;
left: 0;

}


textarea {

background-color: #2e2e2e;
color: #f0f0f0;
border: 1px solid #555;
border-radius: 4px;

width: 100%;
max-width: 800px;
box-sizing: border-box;
height: 400px;
resize: vertical;
padding: 10px;
margin: 10px;

font-size: 16px;
font-family: Arial, sans-serif;

}

/* Calendar CSS Here */

#calendar {
margin: 20px;
margin-left: 10px;
padding: 10px;
overflow: auto;
background-color: #1e1e1e;
width: 500px;
}

.year-block h1 {
margin: 0 0 10px;
color: #eee;
font-size: 1.5em;
}

.month {
margin-bottom: 20px;
}

.month h2 {
margin: 0 0 15px;
color: #eee;
font-size: 1.2em;
}

.weekdays {
display: grid;
grid-template-columns: repeat(7, 1fr);
text-align: center;
margin-bottom: 2px;
font-size: 12px;
color: #ccc;
}

.weekdays div {
padding: 2px 0;
}

.days {
display: grid;
grid-template-columns: repeat(7, 1fr);
gap: 2px;
}

.day {
border: 1px solid #333;
height: 60px;
position: relative;
background-color: #2a2a2a;
box-sizing: border-box;
}

.day.today {
border: 3px solid #fff;

}

.day-number {
position: absolute;
top: 2px;
left: 4px;
font-size: 12px;
color: #bbb;
z-index: 2;
}

.bars {
position: absolute;
top: 0;
left: 0;
right: 0;
bottom: 0;
display: flex;
flex-direction: column;
z-index: 1;
}

.bar {
flex: 1;
cursor: default;
}
`;

    function randomColour() {
        const h = Math.floor(Math.random() * 360);
        const s = 60;
        const l = 85;
        return `hsl(${h},${s}%,${l}%)`;
    }

    function updateStatus(message, success) {
        statusDiv.textContent = message;
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
                    colour: null
                };

            } else if (current) {

                if (m = line.match(/Start:\s*(\d{2})\/(\d{2})\/(\d{2})/))
                    current.start = new Date(2000 + +m[3], +m[2] - 1, +m[1]);

                if (m = line.match(/End:\s*(\d{2})\/(\d{2})\/(\d{2})/))
                    current.end = new Date(2000 + +m[3], +m[2] - 1, +m[1]);

                if (m = line.match(/Colour:\s*(.+)/))
                    current.colour = m[1].trim();
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
    }

    function loadAllProjects() {
        let combined = '';
        const names = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('project_')) {
                names.push(key.slice(8));
            }
        }
        names.sort().forEach(name => {
            const txt = localStorage.getItem('project_' + name) || '';
            combined += txt + '\n\n';
        });
        currentProject = ALL_PROJECTS_NAME;
        editor.readOnly = true;
        editor.value = combined.trim();
        localStorage.removeItem('currentProject');
        renderCalendar(parseProjects(combined));
        updateProjectList();
        updateStatus('Viewing all projects. Editing disabled.', true);
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
        if (name === ALL_PROJECTS_NAME) {
            updateStatus('The name "All Projects" is reserved.', false);
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

    function updateProjectList() {
        if (!projectList) return;
        projectList.innerHTML = '';
        const filter = projectSearch.value.trim().toLowerCase();
        const projects = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('project_')) {
                const name = key.slice(8);
                if (!filter || name.toLowerCase().includes(filter)) {
                    projects.push(name);
                }
            }
        }
        if (!filter || ALL_PROJECTS_NAME.toLowerCase().includes(filter)) {
            const allLi = document.createElement('li');
            allLi.textContent = ALL_PROJECTS_NAME;
            if (currentProject === ALL_PROJECTS_NAME) allLi.classList.add('active-file');
            allLi.addEventListener('click', loadAllProjects);
            projectList.appendChild(allLi);
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
        const filter = projectSearch.value.trim().toLowerCase();
        return getAllProjects().filter(n => !filter || n.toLowerCase().includes(filter));
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
            renderCalendar(parseProjects(editor.value));
        }
        updateProjectList();
        updateStatus('Visible projects deleted.', true);
    }

    function buildProjectHTML(title, text) {
        const projects = parseProjects(text);
        const data = JSON.stringify(projects);
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const script = `<script>const weekdays=${JSON.stringify(weekdays)};const today=new Date();${renderCalendar.toString()}document.addEventListener('DOMContentLoaded',()=>{const data=${data};renderCalendar(data, document.getElementById('calendar'));});<\/script>`;
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${EXPORT_STYLE}</style></head><body><pre>${esc(text)}</pre><div id="calendar"></div>${script}</body></html>`;
    }

    function exportProjects(names, fileName) {
        if (!names.length) {
            updateStatus('No projects to export.', false);
            return;
        }
        if (typeof JSZip === 'undefined') {
            updateStatus('Export failed: JSZip not loaded.', false);
            return;
        }
        const zip = new JSZip();
        let combined = '';
        names.forEach(n => {
            const text = localStorage.getItem('project_' + n) || '';
            zip.file(n + '.html', buildProjectHTML(n, text));
            combined += text + '\n\n';
        });
        const allText = combined.trim();
        zip.file(ALL_PROJECTS_NAME + '.html', buildProjectHTML(ALL_PROJECTS_NAME, allText));
        zip.generateAsync({ type: 'blob' }).then(content => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = fileName;
            link.click();
            URL.revokeObjectURL(link.href);
            updateStatus('Projects exported.', true);
        });
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

    function previewMarkdown() {
        const text = editor.value;
        let html = '';
        if (typeof marked !== 'undefined') {
            html = marked.parse(text);
        } else {
            html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
        }
        const win = window.open('', '_blank');
        win.document.write(html);
        win.document.close();
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

                    const titles = [];
                    projects.forEach(p => {
                        if (date >= p.start && date <= p.end) {
                            const bar = document.createElement('div');
                            bar.className = 'bar';
                            bar.style.backgroundColor = p.colour;
                            bar.title = p.title;
                            bars.appendChild(bar);
                            titles.push(p.title);
                        }
                    });

                    if (bars.children.length > 0) {
                        num.style.color = '#000';
                        cell.title = titles.join(', ');
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
    if (saved && localStorage.getItem('project_' + saved) !== null) {
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
    });

    deleteCurrentBtn.addEventListener('click', deleteCurrentProject);
    deleteAllBtn.addEventListener('click', deleteAllProjects);
    deleteVisibleBtn.addEventListener('click', deleteVisibleProjects);
    exportAllBtn.addEventListener('click', () => exportProjects(getAllProjects(), 'all_projects_html.zip'));
    exportVisibleBtn.addEventListener('click', () => exportProjects(getVisibleProjects(), 'visible_projects_html.zip'));
    backupAllBtn.addEventListener('click', () => backupProjects(getAllProjects(), 'all_projects.zip'));
    backupVisibleBtn.addEventListener('click', () => backupProjects(getVisibleProjects(), 'visible_projects.zip'));
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', e => {
        if (e.target.files.length) importProjects(e.target.files[0]);
        importInput.value = '';
    });
    previewBtn.addEventListener('click', previewMarkdown);

    projectSearch.addEventListener('input', updateProjectList);
});
