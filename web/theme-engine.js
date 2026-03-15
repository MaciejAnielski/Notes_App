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

  // ── Contrast anchor ────────────────────────────────────────────────────
  // When the accent already contrasts well (light accent on dark bg, or dark
  // accent on light bg) we use the accent's own lightness as the anchor so
  // derived colours preserve its character instead of being forced to fixed
  // extremes.  Only correct when contrast is genuinely lacking.
  const sufficientContrast = (dark && acL >= 65) || (!dark && acL <= 35);
  const dimDir = dark ? -1 : 1;          // direction "toward background"
  const refL   = sufficientContrast ? acL : (dark ? 82 : 18);

  // Body text: keep lightly accent-tinted but not fully saturated
  const textL = dark ? 90 : 10;
  const textS = Math.min(acS, 30);
  const text  = _hslToHex(acH, textS, textL);

  // Muted text (toolbar buttons, secondary)
  // On dark themes cap saturation so chrome doesn't outcompete tinted content surfaces.
  // On light themes keep full saturation (user asked to keep light-bg handling as-is).
  const mutedSat = dark ? Math.min(acS, 55) : acS;
  const muted  = _hslToHex(acH, mutedSat, refL + dimDir * 22);

  // Surface: slightly lighter/darker than bg
  const surfaceDelta = dark ? 6 : -6;
  const surface = _hslToHex(bgH, bgS, bgL + surfaceDelta);

  // Border — same saturation cap on dark themes as muted
  const borderSat = dark ? Math.min(acS, 45) : acS;
  const border = _hslToHex(acH, borderSat, refL + dimDir * 22);

  // Heading hierarchy — lightness-only steps from refL
  const h1Color      = _hslToHex(acH, acS, refL);
  const h2Color      = _hslToHex(acH, acS, refL + dimDir *  8);
  const h3Color      = _hslToHex(acH, acS, refL + dimDir * 15);
  const h4Color      = _hslToHex(acH, acS, refL + dimDir * 21);
  const h5Color      = _hslToHex(acH, acS, refL + dimDir * 27);
  const h6Color      = _hslToHex(acH, acS, refL + dimDir * 33);
  const headingMarker = _hslToHex(acH, acS, refL + dimDir * 40);

  // Bold / italic — near body-text lightness but fully accent-saturated
  const boldColor      = _hslToHex(acH, acS, dark ? 93 :  7);
  const italicColor    = _hslToHex(acH, acS, refL + dimDir * 10);
  const boldItalicColor = _hslToHex(acH, acS, dark ? 96 :  5);

  // Code: text colour stays accent-derived for readability.
  // Backgrounds and borders use the same colour system as checkboxes so all
  // tinted-surface elements share a coherent visual language across themes.
  const codeSat        = Math.min(acS * 0.6, 35);
  const codeColor      = _hslToHex(acH, codeSat + 20, dark ? 76 : 28);
  const codeBg         = surface;          // same fill as checkbox background
  const codeBlockBg    = surface;          // same fill as checkbox background
  const codeBlockBorder = border;          // same accent stroke as checkbox border

  // Fence markers
  const fenceColor = accent;

  // Strikethrough — mid-way toward background, still accent-coloured
  const strikeColor = _hslToHex(acH, acS, refL + dimDir * 33);

  // Highlight (==text==) — warm gold, intentionally distinct from accent
  const highlightColor = _hslToHex(45, 80, dark ? 70 : 40);
  const highlightBg    = _hslToHex(45, 60, dark ? 20 : 85);

  // Links — rotated hue for semantic distinctness
  const linkHue  = (acH + 200) % 360;
  const linkColor = _hslToHex(linkHue, 60, dark ? 75 : 35);
  const wikiColor = _hslToHex(linkHue, 50, dark ? 70 : 40);

  // List markers
  const listMarker = accent;

  // Blockquote — uses the same checkbox colour language as code surfaces:
  // fill = surface, accent stroke = border, body text = accent-derived.
  const blockquoteBorder = border;         // same accent stroke as checkbox border
  const blockquoteText   = _hslToHex(acH, acS, refL + dimDir * 12);
  const blockquoteBg     = surface;        // same fill as checkbox background

  // HR / schedule syntax
  const hrColor      = _hslToHex(acH, acS, refL + dimDir * 40);
  const scheduleColor = hrColor;

  // Placeholder text
  const placeholderColor = _hslToHex(acH, acS, refL + dimDir * 22);

  // Active note in sidebar
  const activeColor  = _hslToHex(acH, acS, refL + dimDir *  4);
  const activeBorder = accent;

  // Linked file chain
  const linkedColor  = _hslToHex(acH, acS, refL + dimDir * 26);
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
  const schedHighlightBg      = surface;
  const schedHighlightOutline = border;

  // Schedule week
  const weekSelectedBg = accent;

  // Schedule dots
  const dotEvent = accent;

  // Schedule item — uses the same checkbox colour language:
  // fill = surface, accent stroke = border (calendar-tag overrides still apply in JS).
  const schedItemBg     = surface;
  const schedItemBorder = border;

  // Schedule gridlines — both accent-based; half-hour dimmer than hour
  const gridlineColor = _hslToHex(acH, acS, dark ? 32 : 68);
  const gridlineHour = border;

  // Time label — same accent stroke as checkbox border for visual coherence
  const timeLabelColor = border;

  // Graph
  const graphNodeBg = surface;
  const graphNodeBorder = accent;
  const graphNodeHighlightBg = _hslToHex(acH, acS * 0.4, dark ? bgL + 15 : bgL - 15);
  const graphNodeHighlightBorder = activeColor;
  const graphNodeHoverBg = _hslToHex(acH, acS * 0.3, dark ? bgL + 10 : bgL - 10);
  // Tooltip needs clear separation from the canvas background on both themes.
  // tableHeaderBg (bgL±6) was too close to the page bg on light themes.
  const graphTooltipBg = _hslToHex(acH, acS * 0.25, dark ? bgL + 14 : bgL - 20);
  const graphTooltipBorder = accent;
  const graphTitleColor = headingMarker;

  // Error / red colour (for missing nodes, overdue, conflicts)
  // On light themes errorBg was 88% lightness / 30% sat — almost white, blending
  // into the page.  Use 80% lightness / 50% sat for a clearly pinkish surface.
  const errorL = dark ? 60 : 45;
  const errorColor = _hslToHex(0, 65, errorL);
  const errorBg = _hslToHex(0, dark ? 30 : 50, dark ? 15 : 80);

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

  // Selection highlight
  const selectionBg = _hslToHex(acH, acS * 0.5, dark ? 30 : 72);
  const selectionText = text;

  // Shadows — derived so light themes get softer shadows
  const shadowColor = dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.18)';
  const shadowColorLight = dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.12)';

  // Missing / broken internal links — use error tint
  const linkMissing = errorColor;

  // Checkbox accent — checkboxes styled to match theme
  const checkboxAccent = accent;
  const checkboxBg = surface;
  const checkboxBorder = border;
  const checkboxCheckedBg = accent;

  // Image border in preview
  const imageBorder = _hslToHex(acH, acS * 0.2, dark ? bgL + 10 : bgL - 10);

  // Task checkbox marker in editor — uses accent for the full "- [ ]"
  const taskMarker = accent;

  // Footnote marker in editor
  const footnoteMarker = footnoteColor;

  // Image syntax in editor — slightly distinct from link
  const imageColor = _hslToHex(linkHue, 45, dark ? 65 : 42);

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

    // Selection
    '--selection-bg': selectionBg, '--selection-text': selectionText,

    // Shadows
    '--shadow': shadowColor, '--shadow-light': shadowColorLight,

    // Missing links
    '--link-missing': linkMissing,

    // Checkboxes
    '--checkbox-accent': checkboxAccent, '--checkbox-bg': checkboxBg,
    '--checkbox-border': checkboxBorder, '--checkbox-checked-bg': checkboxCheckedBg,

    // Images
    '--image-border': imageBorder,

    // Editor token colours
    '--task-marker': taskMarker,
    '--footnote-marker': footnoteMarker,
    '--image-syntax': imageColor,
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

// ── Calendar colour palette — theme-integrated defaults ──────────────────
// Generates a deterministic colour for a calendar name derived from the
// current accent, so calendars without a custom colour still look cohesive.

function getThemeCalendarColorByHash(name) {
  const theme = getCurrentTheme();
  const [acH, acS] = _hexToHSL(theme.accent);
  const dark = _isDark(theme.background);

  // Simple string hash → hue offset
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const hueOffset = (((hash % 12) + 12) % 12) * 30;
  const hue = (acH + hueOffset + 60) % 360;
  const sat = Math.max(Math.min(acS, 70), 45);
  const lit = dark ? 65 : 42;
  return _hslToHex(hue, sat, lit);
}

// ── Cross-device preferences sync via iCloud ────────────────────────────
// Stores theme + calendar colours in a hidden note (.app_preferences) that
// syncs alongside regular notes through iCloud.

const PREFS_NOTE = '.app_preferences';

async function loadSyncedPreferences() {
  if (typeof NoteStorage === 'undefined') return null;
  try {
    const content = await NoteStorage.getNote(PREFS_NOTE);
    if (!content) return null;
    return JSON.parse(content);
  } catch { return null; }
}

async function saveSyncedPreferences(prefs) {
  if (typeof NoteStorage === 'undefined') return;
  try {
    const existing = await loadSyncedPreferences() || {};
    const merged = { ...existing, ...prefs };
    await NoteStorage.setNote(PREFS_NOTE, JSON.stringify(merged));
  } catch {}
}

async function syncThemeToNote() {
  const theme = getCurrentTheme();
  await saveSyncedPreferences({ theme });
}

async function syncCalendarColorsToNote() {
  try {
    const colors = JSON.parse(localStorage.getItem('calendar_colors') || '{}');
    await saveSyncedPreferences({ calendarColors: colors });
  } catch {}
}

async function applySyncedPreferences() {
  const prefs = await loadSyncedPreferences();
  if (!prefs) return;

  // Apply synced theme if different from local
  if (prefs.theme) {
    const local = getCurrentTheme();
    if (prefs.theme.background !== local.background || prefs.theme.accent !== local.accent) {
      applyTheme(prefs.theme.background, prefs.theme.accent);
      saveTheme(prefs.theme.background, prefs.theme.accent);
    }
  }

  // Apply synced calendar colours
  if (prefs.calendarColors) {
    const local = JSON.parse(localStorage.getItem('calendar_colors') || '{}');
    const merged = { ...local, ...prefs.calendarColors };
    localStorage.setItem('calendar_colors', JSON.stringify(merged));
  }
}

// ── Init: apply theme on page load ───────────────────────────────────────

(function initTheme() {
  const theme = getCurrentTheme();
  applyTheme(theme.background, theme.accent);
})();
