// theme-engine.js — Theme system: derives all UI colours from two root values
// (background + accent) and applies them as CSS custom properties on :root.
//
// Colours are stored in localStorage as { background, accent } hex strings.
// Every other colour used in the app is computed from these two roots.

const THEME_STORAGE_KEY = 'app_theme';

const DEFAULT_THEME = {
  background: '#1e1e1e',
  accent:     '#a272b0',
};

// ── Colour math helpers ──────────────────────────────────────────────────

function _hexToHSL(hex) {
  let r = parseInt(hex.slice(1, 3), 16) / 255;
  let g = parseInt(hex.slice(3, 5), 16) / 255;
  let b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function _hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

// Shift lightness of a hex colour by delta (can be negative)
function _shiftL(hex, delta) {
  const [h, s, l] = _hexToHSL(hex);
  return _hslToHex(h, s, l + delta);
}

// Shift saturation of a hex colour by delta
function _shiftS(hex, delta) {
  const [h, s, l] = _hexToHSL(hex);
  return _hslToHex(h, s + delta, l);
}

// Blend towards accent hue at given lightness/saturation
function _accentShade(accentHSL, lightness, saturation) {
  return _hslToHex(accentHSL[0], saturation != null ? saturation : accentHSL[1], lightness);
}

// Determine if background is dark or light
function _isDark(hex) {
  const [, , l] = _hexToHSL(hex);
  return l < 50;
}

// ── Derive full palette from background + accent ─────────────────────────

function deriveThemeVars(bg, accent) {
  const [bgH, bgS, bgL] = _hexToHSL(bg);
  const [acH, acS, acL] = _hexToHSL(accent);
  const dark = _isDark(bg);

  // Text colour: light on dark bg, dark on light bg
  const textL = dark ? 90 : 10;
  const textS = Math.min(acS, 30);
  const text = _hslToHex(acH, textS, textL);

  // Muted text (toolbar buttons, secondary) — pure accent colour
  const mutedL = dark ? 55 : 30;
  const muted = _hslToHex(acH, acS, mutedL);

  // Surface: slightly lighter/darker than bg
  const surfaceDelta = dark ? 6 : -6;
  const surface = _hslToHex(bgH, bgS, bgL + surfaceDelta);

  // Border colour — pure accent colour
  const borderL = dark ? 55 : 30;
  const border = _hslToHex(acH, acS, borderL);

  // Heading hierarchy — full accent saturation, lightness-only steps
  const h1Color = _hslToHex(acH, acS, dark ? 85 : 20);
  const h2Color = _hslToHex(acH, acS, dark ? 77 : 26);
  const h3Color = _hslToHex(acH, acS, dark ? 69 : 32);
  const h4Color = _hslToHex(acH, acS, dark ? 61 : 37);
  const h5Color = _hslToHex(acH, acS, dark ? 54 : 42);
  const h6Color = _hslToHex(acH, acS, dark ? 48 : 47);

  // Heading marker (hash symbols) — dimmer than heading text
  const headingMarker = _hslToHex(acH, acS, dark ? 38 : 55);

  // Bold / italic / bold-italic — full accent saturation, lightness near body text
  const boldColor = _hslToHex(acH, acS, dark ? 93 : 7);
  const italicColor = _hslToHex(acH, acS, dark ? 80 : 22);
  const boldItalicColor = _hslToHex(acH, acS, dark ? 96 : 5);

  // Code: complementary-ish hue (green-tinted)
  const codeHue = (acH + 150) % 360;
  const codeColor = _hslToHex(codeHue, 50, dark ? 70 : 35);
  const codeBg = _hslToHex(codeHue, 30, dark ? 10 : 92);
  const codeBlockBg = _hslToHex(codeHue, 20, dark ? 9 : 94);
  const codeBlockBorder = _hslToHex(codeHue, 20, dark ? 18 : 82);

  // Fence markers
  const fenceColor = accent;

  // Strikethrough — accent colour, mid-lightness to suggest dimming
  const strikeColor = _hslToHex(acH, acS, dark ? 45 : 50);

  // Highlight (==text==) — warm gold
  const highlightColor = _hslToHex(45, 80, dark ? 70 : 40);
  const highlightBg = _hslToHex(45, 60, dark ? 20 : 85);

  // Links
  const linkHue = (acH + 200) % 360;
  const linkColor = _hslToHex(linkHue, 60, dark ? 75 : 35);
  const wikiColor = _hslToHex(linkHue, 50, dark ? 70 : 40);

  // List markers
  const listMarker = accent;

  // Blockquote
  const blockquoteBorder = accent;
  const blockquoteText = _hslToHex(acH, acS, dark ? 72 : 30);
  const blockquoteBg = _hslToHex(acH, acS * 0.3, dark ? bgL + 4 : bgL - 4);

  // HR — full accent saturation, dimmed lightness
  const hrColor = _hslToHex(acH, acS, dark ? 40 : 45);

  // Schedule syntax
  const scheduleColor = hrColor;

  // Placeholder text — pure accent colour
  const placeholderColor = _hslToHex(acH, acS, dark ? 55 : 30);

  // Active note in sidebar — full accent saturation
  const activeColor = _hslToHex(acH, acS, dark ? 75 : 25);
  const activeBorder = accent;

  // Linked file chain — full accent saturation, slightly dimmer
  const linkedColor = _hslToHex(acH, acS, dark ? 58 : 40);
  const linkedBorder = hrColor;

  // Today note
  const todayColor = activeColor;

  // Panel heading hover
  const panelHeadingHover = activeColor;

  // Pin button colors
  const pinColor = hrColor;
  const pinActive = accent;

  // Footnotes
  const footnoteColor = accent;
  const footnoteMuted = muted;
  const footnoteBack = hrColor;

  // Table header bg, alternating row
  const tableHeaderBg = _hslToHex(acH, acS * 0.3, dark ? bgL + 6 : bgL - 6);
  const tableAltRowBg = _hslToHex(acH, acS * 0.2, dark ? bgL + 3 : bgL - 3);

  // Global search
  const gsActiveBg = _hslToHex(acH, acS * 0.4, dark ? 14 : 88);
  const gsSnippetMark = _hslToHex(acH, acS * 0.5, dark ? 18 : 85);
  const gsSnippetMarkText = _hslToHex(acH, textS, dark ? 95 : 8);
  const gsSnippetColor = muted;
  const gsNoteName = activeColor;

  // Schedule highlight
  const schedHighlightBg = _hslToHex(acH, acS * 0.5, dark ? 12 : 88);
  const schedHighlightOutline = _hslToHex(acH, acS, dark ? 55 : 40);

  // Schedule week
  const weekSelectedBg = accent;

  // Schedule dots
  const dotEvent = accent;

  // Schedule item
  const schedItemBg = blockquoteBg;
  const schedItemBorder = accent;

  // Schedule gridlines — both accent-based; half-hour dimmer than hour
  const gridlineColor = _hslToHex(acH, acS, dark ? 32 : 68);
  const gridlineHour = border;

  // Time label
  const timeLabelColor = hrColor;

  // Graph
  const graphNodeBg = surface;
  const graphNodeBorder = accent;
  const graphNodeHighlightBg = _hslToHex(acH, acS * 0.4, dark ? bgL + 15 : bgL - 15);
  const graphNodeHighlightBorder = activeColor;
  const graphNodeHoverBg = _hslToHex(acH, acS * 0.3, dark ? bgL + 10 : bgL - 10);
  const graphTooltipBg = tableHeaderBg;
  const graphTooltipBorder = accent;
  const graphTitleColor = headingMarker;

  // Error / red colour (for missing nodes, overdue, conflicts)
  const errorL = dark ? 60 : 45;
  const errorColor = _hslToHex(0, 65, errorL);
  const errorBg = _hslToHex(0, 30, dark ? 15 : 88);

  // Contrasting text colours for use on coloured backgrounds
  // (e.g. selected / today cells in the schedule week row)
  const textOnAccent = acL >= 50
    ? _hslToHex(acH, Math.min(acS * 0.2, 12), 8)
    : _hslToHex(acH, Math.min(acS * 0.2, 12), 95);
  const textOnError = errorL >= 50
    ? _hslToHex(0, 8, 8)
    : _hslToHex(0, 8, 95);

  // Warning / amber
  const warningColor = _hslToHex(35, 65, dark ? 60 : 45);

  // Success / green
  const successColor = _hslToHex(145, 50, dark ? 55 : 38);

  // Hover overlay
  const hoverOverlay = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';

  // Math result
  const mathResultColor = accent;
  const mathUnderline = accent;

  // Caret colour
  const caretColor = text;

  // Mark (==) in preview
  const markBg = highlightBg;
  const markColor = highlightColor;

  return {
    '--bg': bg,
    '--text': text,
    '--muted': muted,
    '--surface': surface,
    '--border': border,
    '--accent': accent,
    '--hover-overlay': hoverOverlay,
    '--caret': caretColor,
    '--placeholder': placeholderColor,

    // Headings
    '--h1': h1Color, '--h2': h2Color, '--h3': h3Color,
    '--h4': h4Color, '--h5': h5Color, '--h6': h6Color,
    '--heading-marker': headingMarker,

    // Emphasis
    '--bold': boldColor, '--italic': italicColor, '--bold-italic': boldItalicColor,
    '--strike': strikeColor,

    // Code
    '--code': codeColor, '--code-bg': codeBg,
    '--code-block-bg': codeBlockBg, '--code-block-border': codeBlockBorder,
    '--fence': fenceColor,

    // Highlight
    '--highlight': highlightColor, '--highlight-bg': highlightBg,
    '--mark-bg': markBg, '--mark-color': markColor,

    // Links
    '--link': linkColor, '--wiki': wikiColor,

    // Lists
    '--list-marker': listMarker,

    // Blockquote
    '--blockquote-border': blockquoteBorder,
    '--blockquote-text': blockquoteText,
    '--blockquote-bg': blockquoteBg,

    // HR / schedule
    '--hr': hrColor, '--schedule': scheduleColor,

    // Sidebar
    '--active-color': activeColor, '--active-border': activeBorder,
    '--linked-color': linkedColor, '--linked-border': linkedBorder,
    '--today-color': todayColor,
    '--panel-heading-hover': panelHeadingHover,
    '--pin-color': pinColor, '--pin-active': pinActive,

    // Footnotes
    '--footnote': footnoteColor, '--footnote-muted': footnoteMuted,
    '--footnote-back': footnoteBack,

    // Tables
    '--table-header-bg': tableHeaderBg, '--table-alt-row': tableAltRowBg,

    // Global search
    '--gs-active-bg': gsActiveBg, '--gs-snippet-mark': gsSnippetMark,
    '--gs-snippet-mark-text': gsSnippetMarkText,
    '--gs-snippet': gsSnippetColor, '--gs-note-name': gsNoteName,

    // Schedule
    '--sched-highlight-bg': schedHighlightBg,
    '--sched-highlight-outline': schedHighlightOutline,
    '--week-selected-bg': weekSelectedBg,
    '--dot-event': dotEvent,
    '--sched-item-bg': schedItemBg, '--sched-item-border': schedItemBorder,
    '--gridline': gridlineColor, '--gridline-hour': gridlineHour,
    '--time-label': timeLabelColor,

    // Graph
    '--graph-node-bg': graphNodeBg, '--graph-node-border': graphNodeBorder,
    '--graph-node-hl-bg': graphNodeHighlightBg,
    '--graph-node-hl-border': graphNodeHighlightBorder,
    '--graph-node-hover-bg': graphNodeHoverBg,
    '--graph-tooltip-bg': graphTooltipBg,
    '--graph-tooltip-border': graphTooltipBorder,
    '--graph-title': graphTitleColor,

    // Status colours
    '--error': errorColor, '--error-bg': errorBg,
    '--warning': warningColor, '--success': successColor,

    // Contrasting text for coloured backgrounds
    '--text-on-accent': textOnAccent,
    '--text-on-error': textOnError,

    // Math
    '--math-result': mathResultColor, '--math-underline': mathUnderline,
  };
}

// ── Apply / load / save ──────────────────────────────────────────────────

function applyTheme(bg, accent) {
  const vars = deriveThemeVars(bg, accent);
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(vars)) {
    root.style.setProperty(prop, val);
  }
  // Update meta theme-color for mobile browsers
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
}

function saveTheme(bg, accent) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ background: bg, accent: accent }));
}

function loadSavedTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function getDefaultTheme() {
  return { ...DEFAULT_THEME };
}

function getCurrentTheme() {
  return loadSavedTheme() || getDefaultTheme();
}

function resetTheme() {
  localStorage.removeItem(THEME_STORAGE_KEY);
  const d = getDefaultTheme();
  applyTheme(d.background, d.accent);
}

// ── Init: apply theme on page load ───────────────────────────────────────

(function initTheme() {
  const theme = getCurrentTheme();
  applyTheme(theme.background, theme.accent);
})();
