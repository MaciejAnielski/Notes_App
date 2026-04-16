// mermaid-theme.js — Builds Mermaid theme variables from the current CSS custom
// properties (see css/variables.css, css/theme.css). Covers every Mermaid
// diagram type: flowchart, sequence, gantt, git, pie, class, state, ER,
// journey, requirement, mindmap, timeline, quadrant-chart, and XY-chart.
//
// Exposes two globals used by theme-engine.js and markdown-renderer.js:
//   _buildMermaidThemeVars() → themeVariables object
//   reinitMermaidTheme()     → re-applies the theme to mermaid.initialize()
//
// Loaded non-deferred from index.html (in <head>) so both functions exist
// before any deferred script that calls them (theme-engine.js,
// markdown-renderer.js) runs.

function _buildMermaidThemeVars() {
  var s = getComputedStyle(document.documentElement);
  var v = function(p) { return (s.getPropertyValue(p) || '').trim(); };
  var bg = v('--bg') || '#1e1e1e';
  var text = v('--text') || '#e8dcf4';
  var accent = v('--accent') || '#a272b0';
  var surface = v('--surface') || '#2e2e2e';
  var blockquoteBg = v('--blockquote-bg') || '#262030';
  var tableHeaderBg = v('--table-header-bg') || '#2a2040';
  var hr = v('--hr') || '#6b4e7a';
  var activeColor = v('--active-color') || '#c89fdf';
  var headingMarker = v('--heading-marker') || '#7a5a8a';
  var schedHighlightBg = v('--sched-highlight-bg') || '#3a1060';
  var errorColor = v('--error') || '#e05c5c';
  var successColor = v('--success') || '#4caf72';
  var warningColor = v('--warning') || '#d4a24a';
  var linkColor = v('--link') || '#9cdcfe';
  var border = v('--border') || '#333';
  var mermaidText = v('--mermaid-text') || text;
  var mermaidLine = v('--mermaid-line') || border;

  // Detect light vs dark mode from background lightness
  var bgR = parseInt(bg.slice(1, 3), 16) / 255;
  var bgG = parseInt(bg.slice(3, 5), 16) / 255;
  var bgB = parseInt(bg.slice(5, 7), 16) / 255;
  var bgMax = Math.max(bgR, bgG, bgB), bgMin = Math.min(bgR, bgG, bgB);
  var bgLightness = (bgMax + bgMin) / 2;
  var isDark = bgLightness < 0.5;

  // Helper: pick contrasting text for a given background hex colour.
  // Returns dark text for light backgrounds, light text for dark ones.
  function contrastText(hexBg) {
    var r = parseInt(hexBg.slice(1, 3), 16);
    var g = parseInt(hexBg.slice(3, 5), 16);
    var b = parseInt(hexBg.slice(5, 7), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.5 ? '#1a1a1a' : '#f0f0f0';
  }

  // Gantt: excluded section needs a visible tint, not transparent
  var excludeBkg = isDark
    ? 'rgba(255,255,255,0.05)'
    : 'rgba(0,0,0,0.05)';

  // Done-task text must contrast against successColor background
  var doneTaskText = contrastText(successColor);
  // Active-task text must contrast against warningColor (amber) background
  var activeTaskText = contrastText(warningColor);
  // Crit-task text must contrast against errorColor background
  var critTaskText = contrastText(errorColor);

  // ── Pie chart: 12 slices with rotated accent hues ──
  // Parse accent HSL for hue rotation
  var acR = parseInt(accent.slice(1, 3), 16) / 255;
  var acG = parseInt(accent.slice(3, 5), 16) / 255;
  var acBl = parseInt(accent.slice(5, 7), 16) / 255;
  var acMax = Math.max(acR, acG, acBl), acMin = Math.min(acR, acG, acBl);
  var acHue = 0;
  if (acMax !== acMin) {
    var d = acMax - acMin;
    if (acMax === acR) acHue = ((acG - acBl) / d + (acG < acBl ? 6 : 0)) * 60;
    else if (acMax === acG) acHue = ((acBl - acR) / d + 2) * 60;
    else acHue = ((acR - acG) / d + 4) * 60;
  }
  // Build HSL string helper
  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360;
    return 'hsl(' + Math.round(h) + ',' + Math.round(s) + '%,' + Math.round(l) + '%)';
  }
  var pieSat = isDark ? 55 : 60;
  var pieL = isDark ? 55 : 48;
  var pie = [];
  for (var i = 0; i < 12; i++) {
    pie.push(hsl(acHue + i * 30, pieSat + (i % 3) * 5, pieL + (i % 2) * 8));
  }

  // ── Journey: section fill types (alternating tints) ──
  var journeyFills = [];
  for (var j = 0; j < 8; j++) {
    var jL = isDark ? 18 + (j % 2) * 6 : 88 - (j % 2) * 6;
    journeyFills.push(hsl(acHue + j * 45, isDark ? 20 : 25, jL));
  }

  // ── Timeline: cScale colours ──
  var timelineColors = [];
  var timelineLabels = [];
  for (var t = 0; t < 12; t++) {
    var tc = hsl(acHue + t * 30, isDark ? 35 : 40, isDark ? 25 : 80);
    timelineColors.push(tc);
    timelineLabels.push(text);
  }

  // ── Quadrant chart ──
  var q1 = hsl(acHue, isDark ? 20 : 25, isDark ? 22 : 88);
  var q2 = hsl(acHue + 90, isDark ? 20 : 25, isDark ? 22 : 88);
  var q3 = hsl(acHue + 180, isDark ? 20 : 25, isDark ? 22 : 88);
  var q4 = hsl(acHue + 270, isDark ? 20 : 25, isDark ? 22 : 88);

  // ── Git branch labels: ensure contrast against branch colour ──
  var gitColors = [accent, linkColor, successColor, warningColor,
                   activeColor, errorColor, headingMarker, surface];
  var gitLabels = [];
  var gitInvColors = [];
  for (var gi = 0; gi < 8; gi++) {
    gitLabels.push(contrastText(gitColors[gi]));
    gitInvColors.push(contrastText(gitColors[gi]));
  }

  return {
    darkMode: isDark,
    background: bg, primaryColor: surface, primaryTextColor: mermaidText,
    primaryBorderColor: accent, lineColor: mermaidLine,
    secondaryColor: blockquoteBg, secondaryTextColor: text,
    secondaryBorderColor: headingMarker,
    tertiaryColor: tableHeaderBg, tertiaryTextColor: text,
    tertiaryBorderColor: hr,
    titleColor: activeColor, edgeLabelBackground: surface,
    textColor: mermaidText, fontSize: '14px',

    // ── Flowchart / general ──
    clusterBkg: tableHeaderBg, clusterBorder: hr,
    defaultLinkColor: mermaidLine,

    // ── Notes (sequence, class, etc.) ──
    noteBkgColor: blockquoteBg, noteTextColor: text, noteBorderColor: accent,

    // ── Sequence diagram ──
    actorBkg: surface, actorBorder: accent, actorTextColor: text,
    actorLineColor: mermaidLine, signalColor: mermaidLine,
    signalTextColor: text,
    labelBoxBkgColor: tableHeaderBg, labelBoxBorderColor: accent,
    labelTextColor: text, loopTextColor: text,
    activationBorderColor: activeColor, activationBkgColor: schedHighlightBg,
    sequenceNumberColor: text,

    // ── Gantt chart ──
    gridColor: mermaidLine, gridTextColor: mermaidText,
    todayLineColor: errorColor,
    sectionBkgColor: surface, sectionBkgColor2: tableHeaderBg,
    excludeBkgColor: excludeBkg, excludeBorderColor: border,
    excludeTextColor: mermaidText,
    taskBkgColor: surface, taskBorderColor: accent,
    taskTextColor: text, taskTextOutsideColor: text, taskTextLightColor: text,
    taskTextDarkColor: text, taskTextClickableColor: activeColor,
    activeTaskBkgColor: warningColor, activeTaskBorderColor: warningColor,
    activeTaskTextColor: activeTaskText,
    doneTaskBkgColor: successColor, doneTaskBorderColor: successColor,
    doneTaskTextColor: doneTaskText,
    critBkgColor: errorColor, critBorderColor: errorColor,
    critTextColor: critTaskText,

    // ── Git graph ──
    git0: accent, git1: linkColor, git2: successColor,
    git3: warningColor, git4: activeColor, git5: errorColor,
    git6: headingMarker, git7: surface,
    gitBranchLabel0: gitLabels[0], gitBranchLabel1: gitLabels[1],
    gitBranchLabel2: gitLabels[2], gitBranchLabel3: gitLabels[3],
    gitBranchLabel4: gitLabels[4], gitBranchLabel5: gitLabels[5],
    gitBranchLabel6: gitLabels[6], gitBranchLabel7: gitLabels[7],
    gitInv0: gitInvColors[0], gitInv1: gitInvColors[1],
    gitInv2: gitInvColors[2], gitInv3: gitInvColors[3],
    gitInv4: gitInvColors[4], gitInv5: gitInvColors[5],
    gitInv6: gitInvColors[6], gitInv7: gitInvColors[7],
    commitLabelColor: text, commitLabelBackground: surface,
    commitLabelFontSize: '12px', tagLabelColor: text,
    tagLabelBackground: tableHeaderBg, tagLabelBorder: accent,
    tagLabelFontSize: '11px',

    // ── Pie chart ──
    pie1: pie[0], pie2: pie[1], pie3: pie[2], pie4: pie[3],
    pie5: pie[4], pie6: pie[5], pie7: pie[6], pie8: pie[7],
    pie9: pie[8], pie10: pie[9], pie11: pie[10], pie12: pie[11],
    pieTitleTextColor: text, pieSectionTextColor: '#f0f0f0',
    pieSectionTextSize: '14px',
    pieLegendTextColor: text, pieLegendTextSize: '14px',
    pieStrokeColor: bg, pieStrokeWidth: '1px',
    pieOuterStrokeColor: border, pieOuterStrokeWidth: '1px',
    pieOpacity: '0.9',

    // ── Class diagram ──
    classText: text,

    // ── State diagram ──
    labelColor: text, altBackground: tableHeaderBg,
    compositeBackground: surface, compositeBorder: accent,
    compositeTitleBackground: tableHeaderBg,
    innerEndBackground: accent, specialStateColor: mermaidLine,
    transitionColor: mermaidLine, transitionLabelColor: text,

    // ── ER diagram ──
    attributeBackgroundColorOdd: surface,
    attributeBackgroundColorEven: tableHeaderBg,

    // ── Requirement diagram ──
    requirementBackground: surface, requirementBorderColor: accent,
    requirementBorderSize: '1px', requirementTextColor: text,
    relationColor: mermaidLine, relationLabelBackground: surface,
    relationLabelColor: text,

    // ── Journey / user journey ──
    fillType0: journeyFills[0], fillType1: journeyFills[1],
    fillType2: journeyFills[2], fillType3: journeyFills[3],
    fillType4: journeyFills[4], fillType5: journeyFills[5],
    fillType6: journeyFills[6], fillType7: journeyFills[7],

    // ── Mindmap ──
    // (uses primaryColor/secondaryColor/tertiaryColor — already set above)

    // ── Timeline ──
    cScale0: timelineColors[0], cScale1: timelineColors[1],
    cScale2: timelineColors[2], cScale3: timelineColors[3],
    cScale4: timelineColors[4], cScale5: timelineColors[5],
    cScale6: timelineColors[6], cScale7: timelineColors[7],
    cScale8: timelineColors[8], cScale9: timelineColors[9],
    cScale10: timelineColors[10], cScale11: timelineColors[11],
    cScaleLabel0: timelineLabels[0], cScaleLabel1: timelineLabels[1],
    cScaleLabel2: timelineLabels[2], cScaleLabel3: timelineLabels[3],
    cScaleLabel4: timelineLabels[4], cScaleLabel5: timelineLabels[5],
    cScaleLabel6: timelineLabels[6], cScaleLabel7: timelineLabels[7],
    cScaleLabel8: timelineLabels[8], cScaleLabel9: timelineLabels[9],
    cScaleLabel10: timelineLabels[10], cScaleLabel11: timelineLabels[11],

    // ── Quadrant chart ──
    quadrant1Fill: q1, quadrant2Fill: q2,
    quadrant3Fill: q3, quadrant4Fill: q4,
    quadrant1TextFill: text, quadrant2TextFill: text,
    quadrant3TextFill: text, quadrant4TextFill: text,
    quadrantPointFill: accent, quadrantPointTextFill: text,
    quadrantXAxisTextFill: mermaidText, quadrantYAxisTextFill: mermaidText,
    quadrantTitleFill: activeColor,
    quadrantInternalBorderStrokeFill: border,
    quadrantExternalBorderStrokeFill: hr,

    // ── XY chart ──
    xyChart: {
      backgroundColor: bg, titleColor: activeColor,
      xAxisTitleColor: mermaidText, yAxisTitleColor: mermaidText,
      xAxisLabelColor: mermaidText, yAxisLabelColor: mermaidText,
      xAxisTickColor: mermaidLine, yAxisTickColor: mermaidLine,
      xAxisLineColor: mermaidLine, yAxisLineColor: mermaidLine,
      plotColorPalette: [accent, linkColor, successColor, warningColor,
                         activeColor, errorColor].join(',')
    }
  };
}

function reinitMermaidTheme() {
  if (!window.mermaid) return;
  var vars = _buildMermaidThemeVars();
  mermaid.initialize({
    startOnLoad: false, theme: 'base', darkMode: vars.darkMode,
    securityLevel: 'strict', fontFamily: 'Arial, sans-serif',
    logLevel: 'off', suppressErrorRendering: true,
    themeVariables: vars
  });
  // Suppress console errors from mermaid
  const originalError = console.error;
  const mermaidErrorPatterns = ['Mermaid', 'diagram', 'syntax'];
  console.error = function(...args) {
    const msg = args[0]?.toString?.() || '';
    if (!mermaidErrorPatterns.some(p => msg.includes(p))) {
      originalError.apply(console, args);
    }
  };
}

// Fallback: re-init once the window has finished loading, in case mermaid.js
// has not parsed by the time earlier code first calls reinitMermaidTheme().
window.addEventListener('load', function() {
  if (window.mermaid) reinitMermaidTheme();
});
