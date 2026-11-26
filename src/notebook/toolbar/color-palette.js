/**
 * @module features/toolbar/color-palette
 *
 * Logica pura per gestione colori personalizzati, conversioni HSV <-> Hex,
 * contrasto leggibile e cronologia colori recenti (MRU, max 4).
 */

export const RECENT_COLORS_MAX = 4;

export const DEFAULT_WRITING_COLORS = [
  '#000000',
  '#2563eb',
  '#059669',
  '#e11d48',
  '#d97706'
];

export const HIGHLIGHTER_PRESET_COLORS = [
  '#ffeb3b',
  '#7cff7c',
  '#ff7cbe',
  '#7cd4ff',
  '#ffa97c'
];

/**
 * Normalizza un colore hex (`#rgb` o `#rrggbb`) in `#rrggbb` minuscolo.
 * @param {string|null|undefined} raw
 * @param {string|null} [fallback=null]
 * @returns {string|null}
 */
export function normalizeHexColor(raw, fallback = null) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s.slice(1).split('').map(c => c + c).join('').toLowerCase();
  }
  return fallback;
}

/**
 * Verifica se il colore appartiene ai preset fissi dello strumento.
 * @param {string} colorHex
 * @param {string} [toolName='pen']
 * @returns {boolean}
 */
export function isPresetColor(colorHex, toolName = 'pen') {
  const norm = normalizeHexColor(colorHex);
  if (!norm) return false;
  if (DEFAULT_WRITING_COLORS.includes(norm)) return true;
  if (toolName === 'highlighter' && HIGHLIGHTER_PRESET_COLORS.includes(norm)) return true;
  return false;
}

/**
 * Aggiunge o promuove in testa (MRU) un colore nella cronologia recenti,
 * escludendo i preset fissi dello strumento e rispettando il limite `max`.
 *
 * @param {string[]} recentColors
 * @param {string} colorHex
 * @param {{ max?: number, toolName?: string }} [opts]
 * @returns {string[]}
 */
export function pushRecentColor(recentColors, colorHex, opts = {}) {
  const max = opts.max ?? RECENT_COLORS_MAX;
  const toolName = opts.toolName || 'pen';
  const base = Array.isArray(recentColors)
    ? recentColors.map(c => normalizeHexColor(c)).filter(Boolean)
    : [];

  const norm = normalizeHexColor(colorHex);
  if (!norm || isPresetColor(norm, toolName)) {
    return base.slice(0, max);
  }

  const next = [norm, ...base.filter(c => c !== norm)];
  return next.slice(0, max);
}

/**
 * Restituisce true se due stringhe hex rappresentano lo stesso colore.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function colorsEqual(a, b) {
  const na = normalizeHexColor(a);
  const nb = normalizeHexColor(b);
  return !!na && na === nb;
}

/**
 * Converte HSV (h: 0..360, s: 0..1, v: 0..1) in `#rrggbb`.
 * @param {number} h
 * @param {number} s
 * @param {number} v
 * @returns {string}
 */
export function hsvToHex(h, s, v) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, Number(s) || 0));
  const val = Math.max(0, Math.min(1, Number(v) || 0));

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let r1 = 0, g1 = 0, b1 = 0;
  if (hue < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hue < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hue < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hue < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hue < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/**
 * Converte `#rrggbb` in `{ h, s, v }` (h: 0..360, s: 0..1, v: 0..1).
 * @param {string} hex
 * @returns {{ h: number, s: number, v: number }}
 */
export function hexToHsv(hex) {
  const norm = normalizeHexColor(hex, '#000000');
  const r = parseInt(norm.slice(1, 3), 16) / 255;
  const g = parseInt(norm.slice(3, 5), 16) / 255;
  const b = parseInt(norm.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

/**
 * Restituisce un colore di testo leggibile (`#0f172a` o `#ffffff`) sopra `hex` (tenendo conto dell'opacità su sfondo chiaro).
 * @param {string} hex
 * @param {number} [opacity=1]
 * @returns {'#0f172a'|'#ffffff'}
 */
export function getReadableContrastColor(hex, opacity = 1) {
  const norm = normalizeHexColor(hex, '#000000');
  const a = Math.max(0, Math.min(1, Number(opacity) || 1));
  const r = parseInt(norm.slice(1, 3), 16) * a + 255 * (1 - a);
  const g = parseInt(norm.slice(3, 5), 16) * a + 255 * (1 - a);
  const b = parseInt(norm.slice(5, 7), 16) * a + 255 * (1 - a);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.62 ? '#0f172a' : '#ffffff';
}
