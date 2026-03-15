// graph-view.js — Note Graph visualization using vis.js.
//
// Parses all notes to extract internal links ([[Note Name]] and [text](Note)),
// builds a vis.js Network graph where nodes represent notes and edges represent
// links between them. Nodes are scaled by in-degree (incoming link count).
// Broken links (pointing to non-existent notes) are shown in red.
// Click a node to open that note; hover to see a preview tooltip.

function parseNoteLinks(allNotes) {
  const noteNameSet = new Set(allNotes.map(n => n.name));
  // linkMap: source note name → Set of target note names it links to
  const linkMap = new Map();
  // incomingCount: target note name → number of notes linking to it
  const incomingCount = new Map();

  for (const { name, content } of allNotes) {
    const targets = new Set();

    // Extract [[Note Name]] wiki-style links
    const wikiRe = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = wikiRe.exec(content)) !== null) {
      targets.add(m[1].trim());
    }

    // Extract [text](target) markdown links — internal only
    const mdRe = /\[[^\]]*\]\(([^)]+)\)/g;
    while ((m = mdRe.exec(content)) !== null) {
      const raw = decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
      // Skip external URLs, anchors, and attachment refs
      if (/^[a-zA-Z]+:\/\//.test(raw)) continue;
      if (raw.startsWith('#')) continue;
      if (raw.startsWith('attachment:')) continue;
      if (raw.startsWith('ms-')) continue;
      targets.add(raw);
    }

    // Remove self-links
    targets.delete(name);
    linkMap.set(name, targets);

    for (const target of targets) {
      incomingCount.set(target, (incomingCount.get(target) || 0) + 1);
    }
  }

  return { linkMap, incomingCount, noteNameSet };
}

async function renderNoteGraph() {
  // Clear preview area and set up graph container
  previewDiv.innerHTML = '';
  previewDiv.style.overflow = 'hidden';

  if (!window.vis) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:2em;color:var(--error);font-family:monospace;';
    msg.textContent = 'vis.js library not loaded. Check your network connection and reload.';
    previewDiv.appendChild(msg);
    return;
  }

  const allNotes = await NoteStorage.getAllNotes();
  // Filter by the notes panel search bar (getVisibleNotes respects current search)
  const visibleNoteNames = new Set(await getVisibleNotes());
  // Also exclude internal/virtual notes from the graph
  const graphNotes = allNotes.filter(n =>
    n.name !== '.calendar_metadata' &&
    n.name !== GRAPH_NOTE &&
    visibleNoteNames.has(n.name)
  );

  const { linkMap, incomingCount, noteNameSet } = parseNoteLinks(graphNotes);
  const graphNoteNameSet = new Set(graphNotes.map(n => n.name));

  // Build title bar
  let totalEdges = 0;
  for (const targets of linkMap.values()) totalEdges += targets.size;

  const searchActive = searchBox.value.trim().length > 0;
  const titleBar = document.createElement('div');
  titleBar.className = 'graph-title-bar';
  titleBar.title = 'Click to refresh the graph';
  titleBar.style.cursor = 'pointer';
  titleBar.textContent = `Note Graph — ${graphNotes.length} notes, ${totalEdges} links` +
    (searchActive ? ' (filtered)' : '');
  titleBar.addEventListener('click', () => renderNoteGraph());
  previewDiv.appendChild(titleBar);

  // Graph container takes remaining space
  const container = document.createElement('div');
  container.id = 'note-graph-container';
  previewDiv.appendChild(container);

  // Build vis DataSets
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();

  // Read theme colours from CSS custom properties
  const cs = getComputedStyle(document.documentElement);
  const _v = p => (cs.getPropertyValue(p) || '').trim();
  const gText = _v('--text') || '#e8dcf4';
  const gNodeBg = _v('--graph-node-bg') || '#2e2e2e';
  const gNodeBorder = _v('--graph-node-border') || '#a272b0';
  const gNodeHlBg = _v('--graph-node-hl-bg') || '#4a3a5a';
  const gNodeHlBorder = _v('--graph-node-hl-border') || '#c89fdf';
  const gNodeHoverBg = _v('--graph-node-hover-bg') || '#3a2e4a';
  const gAccent = _v('--accent') || '#a272b0';
  const gError = _v('--error') || '#e05c5c';
  const gErrorBg = _v('--error-bg') || '#3a1a1a';

  // Add real note nodes
  for (const { name } of graphNotes) {
    const degree = incomingCount.get(name) || 0;
    const size = 10 + degree * 5;
    const fontSize = Math.max(10, 10 + degree * 2);
    nodes.add({
      id: name,
      label: name,
      size,
      font: { size: fontSize, color: gText },
      color: {
        background: gNodeBg,
        border: gNodeBorder,
        highlight: { background: gNodeHlBg, border: gNodeHlBorder },
        hover: { background: gNodeHoverBg, border: gNodeHlBorder },
      },
      title: name,
    });
  }

  // Add edges and "missing" nodes for broken links
  const addedMissingNodes = new Set();
  let edgeId = 0;

  for (const [source, targets] of linkMap) {
    for (const target of targets) {
      const exists = graphNoteNameSet.has(target);
      const toId = exists ? target : `__missing__${target}`;

      if (!exists && !addedMissingNodes.has(toId)) {
        nodes.add({
          id: toId,
          label: target,
          size: 8,
          font: { size: 9, color: gError },
          color: {
            background: gErrorBg,
            border: gError,
            highlight: { background: gErrorBg, border: gError },
            hover: { background: gErrorBg, border: gError },
          },
          title: `Missing note: "${target}"`,
          shape: 'dot',
        });
        addedMissingNodes.add(toId);
      }

      edges.add({
        id: edgeId++,
        from: source,
        to: toId,
        color: {
          color: exists ? gAccent : gError,
          opacity: exists ? 0.7 : 0.5,
          highlight: exists ? gNodeHlBorder : gError,
          hover: exists ? gNodeHlBorder : gError,
        },
        dashes: !exists,
        width: exists ? 1.5 : 1,
        arrows: { to: { enabled: true, scaleFactor: 0.4 } },
        smooth: { type: 'continuous' },
      });
    }
  }

  // vis.js network options — tuned for dark theme and mobile touch
  const options = {
    nodes: {
      shape: 'dot',
      scaling: {
        min: 10,
        max: 50,
      },
      borderWidth: 1.5,
      borderWidthSelected: 2.5,
    },
    edges: {
      smooth: { type: 'continuous' },
    },
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -60,
        centralGravity: 0.008,
        springLength: 120,
        springConstant: 0.04,
        damping: 0.4,
        avoidOverlap: 0.5,
      },
      stabilization: {
        enabled: true,
        iterations: 200,
        updateInterval: 25,
        fit: true,
      },
    },
    interaction: {
      hover: true,
      tooltipDelay: 50,
      dragNodes: true,
      dragView: true,
      zoomView: true,
      multiselect: false,
      navigationButtons: false,
      keyboard: false,
      // Touch support for mobile/Capacitor
      zoomSpeed: 1,
    },
    layout: {
      improvedLayout: true,
      randomSeed: 42,
    },
  };

  const network = new vis.Network(container, { nodes, edges }, options);

  // Build hover tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'graph-tooltip';
  previewDiv.appendChild(tooltip);

  // Content map for fast hover lookup (name → first 300 chars of content)
  const contentPreviewMap = new Map();
  for (const { name, content } of graphNotes) {
    contentPreviewMap.set(name, content);
  }

  // Click: open note and add Note Graph to breadcrumb trail
  network.on('click', params => {
    if (params.nodes.length === 0) return;
    const nodeId = params.nodes[0];
    if (typeof nodeId === 'string' && nodeId.startsWith('__missing__')) return;
    if (currentFileName && !linkedNoteChain.includes(currentFileName)) {
      linkedNoteChain.unshift(currentFileName);
      saveChain();
    }
    loadNote(nodeId, true);
  });

  // Hover: show note preview tooltip
  network.on('hoverNode', async params => {
    const nodeId = params.node;
    if (typeof nodeId === 'string' && nodeId.startsWith('__missing__')) {
      const missingName = nodeId.replace(/^__missing__/, '');
      tooltip.innerHTML =
        `<strong style="color:var(--error)">Missing: "${_escHtml(missingName)}"</strong>` +
        `<br><small>This note does not exist yet.</small>`;
      _positionTooltip(tooltip, params.pointer.DOM, container);
      tooltip.style.display = 'block';
      return;
    }
    const content = contentPreviewMap.get(nodeId) || '';
    const snippet = content.length > 320 ? content.slice(0, 320) + '…' : content;
    tooltip.innerHTML =
      `<strong>${_escHtml(nodeId)}</strong><br>` +
      `<small style="white-space:pre-wrap">${_escHtml(snippet)}</small>`;
    _positionTooltip(tooltip, params.pointer.DOM, container);
    tooltip.style.display = 'block';
  });

  network.on('blurNode', () => {
    tooltip.style.display = 'none';
  });

  // Hide tooltip when dragging/zooming to avoid stale positions
  network.on('zoom', () => { tooltip.style.display = 'none'; });
  network.on('dragStart', () => { tooltip.style.display = 'none'; });

  // Fit graph to view after stabilization
  network.once('stabilizationIterationsDone', () => {
    network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
    network.setOptions({ physics: { enabled: false } });
  });
}

function _escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _positionTooltip(tooltip, domPos, container) {
  const cRect = container.getBoundingClientRect();
  const pRect = previewDiv.getBoundingClientRect();
  // domPos is relative to the container canvas
  const x = domPos.x + cRect.left - pRect.left + 14;
  const y = domPos.y + cRect.top - pRect.top + 14;
  // Keep tooltip within previewDiv bounds
  const maxX = pRect.width - tooltip.offsetWidth - 20;
  const maxY = pRect.height - tooltip.offsetHeight - 20;
  tooltip.style.left = Math.min(x, Math.max(0, maxX)) + 'px';
  tooltip.style.top = Math.min(y, Math.max(0, maxY)) + 'px';
}
