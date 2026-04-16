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

  // Highlight (==text==) — warm gold by default; shifts to pink/magenta when
  // the background hue is in the yellow range (±40°) to prevent a washed-out
  // appearance on yellowy/amber themes.
  let hlHue = 45;
  const hlHueDist = Math.min(Math.abs(bgH - hlHue), 360 - Math.abs(bgH - hlHue));
  if (hlHueDist < 40 && bgS > 15) {
    hlHue = 320;  // pink/magenta — still universally reads as "highlight"
  }
  // Ensure highlight bg is distinct from page bg (at least 12 L-units apart)
  let hlBgL = dark ? 20 : 85;
  if (Math.abs(hlBgL - bgL) < 12) {
    hlBgL = dark ? bgL + 15 : bgL - 15;
  }
  const highlightColor = _hslToHex(hlHue, 80, dark ? 70 : 40);
  const highlightBg    = _hslToHex(hlHue, 60, hlBgL);

  // Links — standard web blue (~215°), rotating away only when the background
  // is itself blue (within ±45°) or when contrast would be insufficient.
  const LINK_BASE_HUE = 215;
  const bgBlueProximity = Math.min(Math.abs(bgH - LINK_BASE_HUE), 360 - Math.abs(bgH - LINK_BASE_HUE));
  let linkHue;
  if (bgBlueProximity < 45 && bgS > 15) {
    // Background is blue-ish — check if accent gives a better alternative
    const acBlueProximity = Math.min(Math.abs(acH - LINK_BASE_HUE), 360 - Math.abs(acH - LINK_BASE_HUE));
    if (acBlueProximity > 45) {
      // Accent is distinct from blue; use an accent-adjacent hue for links
      linkHue = (acH + 150) % 360;
    } else {
      // Both bg and accent are blue — fall back to a contrasting complement
      linkHue = (LINK_BASE_HUE + 180) % 360;
    }
  } else {
    linkHue = LINK_BASE_HUE;
  }
  const linkColor = _hslToHex(linkHue, 65, dark ? 72 : 38);
  const wikiColor = _hslToHex(linkHue, 55, dark ? 67 : 43);

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
  const todayBg    = surface;

  // Panel heading hover
  const panelHeadingHover = activeColor;

  // Pin button colors
  const pinColor = hrColor;
  const pinActive = accent;

  // Footnotes
  const footnoteColor = accent;
  const footnoteMuted = muted;
  const footnoteBack = hrColor;

  // Table header bg — stronger shift than surface so headers are distinct
  const tableHeaderBg = _hslToHex(bgH, bgS, bgL + (dark ? 10 : -10));
  const tableAltRowBg = surface;

  // Global search
  const gsActiveBg = surface;
  const gsSnippetMark = surface;
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

  // Frosted glass background — semi-transparent version of bg for backdrop-filter elements
  const bgR = parseInt(bg.slice(1, 3), 16);
  const bgG = parseInt(bg.slice(3, 5), 16);
  const bgB = parseInt(bg.slice(5, 7), 16);
  const bgGlass = `rgba(${bgR}, ${bgG}, ${bgB}, 0.82)`;

  // Math result
  const mathResultColor = accent;
  const mathUnderline = accent;

  // Caret colour
  const caretColor = text;

  // Mark (==) in preview — text must contrast against its own coloured bg,
  // so use a more extreme lightness than the editor highlight text.
  const markBg    = highlightBg;
  const markColor = _hslToHex(hlHue, 85, dark ? 82 : 22);

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

  // Image syntax in editor — slightly distinct from link (slightly more teal)
  const imageColor = _hslToHex((linkHue + 20) % 360, 45, dark ? 65 : 42);

  return {
    '--bg': bg,
    '--text': text,
    '--muted': muted,
    '--surface': surface,
    '--border': border,
    '--accent': accent,
    '--hover-overlay': hoverOverlay,
    '--bg-glass': bgGlass,
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
    '--today-color': todayColor, '--today-bg': todayBg,
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

    // Mermaid diagrams
    '--mermaid-text': text,
    '--mermaid-line': border,

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

function saveTheme(bg, accent, recordTs = true) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ background: bg, accent: accent }));
  if (recordTs) localStorage.setItem(THEME_TS_KEY, Date.now().toString());
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

// ── Cross-device preferences sync ────────────────────────────────────────
// Stores theme + calendar colours in a hidden note (.app_preferences) that
// syncs alongside regular notes through PowerSync.

const PREFS_NOTE = '.app_preferences';

// Timestamps (ms since epoch) recording when each setting was last edited
// locally.  Used by applySyncedPreferences() to implement "latest edit wins"
// so the most-recently-changed device's value propagates to all others.
const THEME_TS_KEY = 'app_theme_ts';
const EMOJI_TS_KEY = 'project_emojis_ts';
const CAL_COLORS_TS_KEY = 'calendar_colors_ts';

// ── Project emoji preferences ────────────────────────────────────────────────

const PROJECT_EMOJI_STORAGE_KEY = 'project_emojis';

const DEFAULT_PROJECT_EMOJIS = {
  active: '🚀',
  completed: '✨',
  Winter: '❄️',
  Spring: '🌱',
  Summer: '☀️',
  Autumn: '🍂'
};

function _filterNonDefaultEmojis(emojis) {
  const out = {};
  for (const key of Object.keys(emojis)) {
    if (emojis[key] !== DEFAULT_PROJECT_EMOJIS[key]) out[key] = emojis[key];
  }
  return out;
}

const EMOJI_OPTIONS = {
  active: ['🚀', '🔥', '⚡', '📍', '🎯', '💡', '🌟', '🎨', '💼', '🔔', '📌', '✏️', '🌿', '🪴', '🌙', '🦋', '🌊', '🍀', '🎀', '🪐', '💫', '🔮', '🌺', '🫧', '🐚', '🌸', '🍃', '🪷', '🎋', '🌻'],
  completed: ['✨', '🎉', '🏆', '💎', '🌈', '🎊', '✅', '🎖️', '👑', '🏅', '🌸', '🫶', '💐', '🌻', '🍵', '🕊️', '🌷', '🥂', '🪩', '💝', '🎗️', '🫰', '🍰', '🪄', '🌙', '💌', '🦢', '🌼', '🫐'],
  Winter: ['❄️', '🌨️', '🏔️', '🌙', '⛄', '🧊', '🌬️', '🎿', '☃️', '🦊', '🌲', '🏒', '🧣', '🍵', '⛷️', '🌌', '🫐', '🦌', '🕯️', '🌃'],
  Spring: ['🌱', '🌸', '🌺', '🌻', '🌼', '🌷', '🦋', '🐝', '🌿', '🍀', '🪴', '🌈', '🐣', '🌦️', '🪻', '🐸', '🌵', '🦜', '🫧', '☘️'],
  Summer: ['☀️', '🌊', '🏖️', '🌴', '🍦', '⛱️', '🌺', '🌞', '🍉', '🏄', '🌻', '🦀', '🔆', '🍹', '🌅', '🎆', '🌮', '🦩', '🐠', '🌈'],
  Autumn: ['🍂', '🍁', '🎃', '🌾', '🦊', '🍄', '🌰', '🍎', '🌙', '🍯', '🦔', '☕', '🎑', '🌫️', '🍇', '🧹', '🕯️', '🍺', '🌾', '🎋'],
};

function getProjectEmojis() {
  const stored = localStorage.getItem(PROJECT_EMOJI_STORAGE_KEY);
  if (stored) {
    try {
      return { ...DEFAULT_PROJECT_EMOJIS, ...JSON.parse(stored) };
    } catch {}
  }
  return DEFAULT_PROJECT_EMOJIS;
}

function setProjectEmoji(type, emoji) {
  const current = getProjectEmojis();
  const updated = { ...current, [type]: emoji };
  // Remove defaults to keep storage lean
  const toStore = _filterNonDefaultEmojis(updated);
  localStorage.setItem(PROJECT_EMOJI_STORAGE_KEY, JSON.stringify(toStore));
  localStorage.setItem(EMOJI_TS_KEY, Date.now().toString());
  syncProjectEmojisToNote();
  if (typeof refreshProjectsNote === 'function') {
    refreshProjectsNote();
  }
}

function resetProjectEmojis() {
  localStorage.removeItem(PROJECT_EMOJI_STORAGE_KEY);
  localStorage.setItem(EMOJI_TS_KEY, Date.now().toString());
  syncProjectEmojisToNote();
  if (typeof refreshProjectsNote === 'function') {
    refreshProjectsNote();
  }
}

// ── Synced preferences ────────────────────────────────────────────────────────

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
  const ts = parseInt(localStorage.getItem(THEME_TS_KEY) || '0', 10);
  await saveSyncedPreferences({ theme, themeTs: ts });
}

async function syncCalendarColorsToNote() {
  try {
    const colors = JSON.parse(localStorage.getItem('calendar_colors') || '{}');
    const ts = parseInt(localStorage.getItem(CAL_COLORS_TS_KEY) || '0', 10);
    await saveSyncedPreferences({ calendarColors: colors, calendarColorsTs: ts });
  } catch {}
}

async function syncProjectEmojisToNote() {
  try {
    const emojis = getProjectEmojis();
    const toStore = _filterNonDefaultEmojis(emojis);
    // Always save (even empty) so that "reset to defaults" propagates to other
    // devices, and always include the timestamp so latest-edit wins.
    const ts = parseInt(localStorage.getItem(EMOJI_TS_KEY) || '0', 10);
    await saveSyncedPreferences({ projectEmojis: toStore, projectEmojisTs: ts });
  } catch {}
}

async function applySyncedPreferences() {
  const prefs = await loadSyncedPreferences();
  if (!prefs) return;

  // "Latest edit wins": compare timestamps stored alongside each preference.
  // A missing timestamp (legacy data or first sync) is treated as 0, so synced
  // values always win over a device that has never locally edited that setting.

  // Apply synced theme
  if (prefs.theme) {
    const localTs  = parseInt(localStorage.getItem(THEME_TS_KEY) || '0', 10);
    const syncedTs = prefs.themeTs || 0;
    if (syncedTs >= localTs) {
      const local = getCurrentTheme();
      if (prefs.theme.background !== local.background || prefs.theme.accent !== local.accent) {
        applyTheme(prefs.theme.background, prefs.theme.accent);
        // Pass false so we don't overwrite the local edit timestamp with now
        saveTheme(prefs.theme.background, prefs.theme.accent, false);
        if (typeof reinitMermaidTheme === 'function') reinitMermaidTheme();
      }
    }
  }

  // Apply synced calendar colours
  if (prefs.calendarColors) {
    const localTs  = parseInt(localStorage.getItem(CAL_COLORS_TS_KEY) || '0', 10);
    const syncedTs = prefs.calendarColorsTs || 0;
    if (syncedTs >= localTs) {
      // Merge: local-only calendar entries are preserved; synced values win for
      // shared keys so iOS native colours propagate to desktop.
      const local  = JSON.parse(localStorage.getItem('calendar_colors') || '{}');
      const merged = { ...local, ...prefs.calendarColors };
      localStorage.setItem('calendar_colors', JSON.stringify(merged));
      if (typeof invalidateScheduleCache === 'function') invalidateScheduleCache();
    }
  }

  // Apply synced project emojis
  if (prefs.projectEmojis !== undefined) {
    const localTs  = parseInt(localStorage.getItem(EMOJI_TS_KEY) || '0', 10);
    const syncedTs = prefs.projectEmojisTs || 0;
    if (syncedTs >= localTs) {
      // Replace local emojis with the synced set (don't merge) so that a
      // "reset to defaults" on one device propagates cleanly to all others.
      const toStore = _filterNonDefaultEmojis(prefs.projectEmojis);
      if (Object.keys(toStore).length > 0) {
        localStorage.setItem(PROJECT_EMOJI_STORAGE_KEY, JSON.stringify(toStore));
      } else {
        localStorage.removeItem(PROJECT_EMOJI_STORAGE_KEY);
      }
      if (typeof refreshProjectsNote === 'function') refreshProjectsNote();
    }
  }
}

// ── Init: apply theme on page load ───────────────────────────────────────

(function initTheme() {
  const theme = getCurrentTheme();
  applyTheme(theme.background, theme.accent);
})();
