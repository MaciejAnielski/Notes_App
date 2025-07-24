document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('editor');
    const calendar = document.getElementById('calendar');
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const today = new Date();

    function randomColour() {
        const h = Math.floor(Math.random() * 360);
        const s = 60;
        const l = 85;
        return `hsl(${h},${s}%,${l}%)`;
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


    function renderCalendar(projects) {
        calendar.innerHTML = '';
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

            calendar.appendChild(yBlock);
        }
    }

    const saved = localStorage.getItem('projectsText');
    if (saved) editor.value = saved;
    renderCalendar(parseProjects(editor.value));

    editor.addEventListener('keydown', e => {
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

        localStorage.setItem('projectsText', newText);
        renderCalendar(parseProjects(newText));
    });

    editor.addEventListener('input', () => {
        const txt = editor.value;
        localStorage.setItem('projectsText', txt);
        renderCalendar(parseProjects(txt));
    });
});