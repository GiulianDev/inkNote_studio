/**
 * @module features/tools/selection-style
 *
 * Logica pura (senza dipendenze DOM) per risolvere, applicare e posizionare
 * il cambio di stile del tratto (solido, tratteggiato, tratteggio largo,
 * punteggiato, tratto-punto) sugli stroke selezionati dal tool lazo.
 */

import { computeAnchoredPosition } from '../../shared/components/floating-menu-position.js';

export const SELECTION_STYLE_CAPABLE_TOOLS = ['pen', 'pencil', 'marker'];
export const SELECTION_STROKE_STYLES = ['solid', 'dashed', 'dashed-large', 'dotted', 'dash-dot'];

export function isValidSelectionStrokeStyle(style) {
  return typeof style === 'string' && SELECTION_STROKE_STYLES.includes(style);
}

export function normalizeStrokeStyle(style) {
  return isValidSelectionStrokeStyle(style) ? style : 'solid';
}

export function isStrokeStyleCapable(stroke) {
  if (!stroke || typeof stroke !== 'object') return false;
  if (!stroke.tool) return true;
  return SELECTION_STYLE_CAPABLE_TOOLS.includes(stroke.tool);
}

/**
 * Analizza gli stroke selezionati per determinare se supportano lo stile
 * e quale stile mostrare nella barra selezione.
 *
 * @param {Array<object>} strokes
 * @returns {{
 *   hasStyleCapable: boolean,
 *   capableCount: number,
 *   style: string,
 *   activeStyle: string|null,
 *   isMixed: boolean
 * }}
 */
export function resolveSelectionStrokeStyle(strokes) {
  if (!Array.isArray(strokes) || strokes.length === 0) {
    return {
      hasStyleCapable: false,
      capableCount: 0,
      style: 'solid',
      activeStyle: null,
      isMixed: false
    };
  }

  let capableCount = 0;
  let firstStyle = null;
  let isMixed = false;

  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    if (!isStrokeStyleCapable(s)) continue;
    const normalized = normalizeStrokeStyle(s.style);
    if (capableCount === 0) {
      firstStyle = normalized;
    } else if (normalized !== firstStyle) {
      isMixed = true;
    }
    capableCount++;
  }

  if (capableCount === 0) {
    return {
      hasStyleCapable: false,
      capableCount: 0,
      style: 'solid',
      activeStyle: null,
      isMixed: false
    };
  }

  return {
    hasStyleCapable: true,
    capableCount,
    style: firstStyle,
    activeStyle: isMixed ? null : firstStyle,
    isMixed
  };
}

/**
 * Applica uno stile valido agli stroke selezionati compatibili.
 *
 * @param {Array<object>} strokes
 * @param {string} newStyle
 * @param {{ onInvalidate?: (stroke: object) => void }} [options]
 * @returns {{ updatedCount: number, changedCount: number, changed: boolean }}
 */
export function applyStyleToStrokes(strokes, newStyle, { onInvalidate } = {}) {
  if (!Array.isArray(strokes) || !isValidSelectionStrokeStyle(newStyle)) {
    return { updatedCount: 0, changedCount: 0, changed: false };
  }

  let updatedCount = 0;
  let changedCount = 0;

  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    if (!isStrokeStyleCapable(s)) continue;
    const prevNormalized = normalizeStrokeStyle(s.style);
    const hadExactField = s.style === newStyle;
    if (prevNormalized !== newStyle) {
      changedCount++;
    }
    if (!hadExactField) {
      s.style = newStyle;
      if (typeof onInvalidate === 'function') {
        onInvalidate(s);
      }
    }
    updatedCount++;
  }

  return {
    updatedCount,
    changedCount,
    changed: changedCount > 0
  };
}

export const TEXT_FONT_SIZE_MIN = 10;
export const TEXT_FONT_SIZE_MAX = 72;
export const TEXT_FONT_SIZE_DEFAULT = 18;

export function clampSelectionFontSize(size) {
  const num = Number(size);
  if (!Number.isFinite(num)) return TEXT_FONT_SIZE_DEFAULT;
  return Math.max(TEXT_FONT_SIZE_MIN, Math.min(TEXT_FONT_SIZE_MAX, Math.round(num)));
}

/**
 * Determina la modalità contestuale della barra lazo in base agli elementi selezionati:
 * - `'ink'`: solo tratti (mostra colore, spessore, stile)
 * - `'text'`: solo caselle di testo (mostra colore, dimensione font, e Modifica se 1 sola)
 * - `'mixed'`: tratti + testo insieme (Opzione A: solo colore unificato + azioni)
 * - `'none'`: selezione vuota
 */
export function resolveSelectionMenuMode(strokes, textBoxes) {
  const strokeCount = Array.isArray(strokes) ? strokes.length : 0;
  const textCount = Array.isArray(textBoxes) ? textBoxes.length : 0;
  const hasStrokes = strokeCount > 0;
  const hasText = textCount > 0;

  let mode = 'none';
  if (hasStrokes && hasText) mode = 'mixed';
  else if (hasStrokes) mode = 'ink';
  else if (hasText) mode = 'text';

  return {
    mode,
    hasStrokes,
    hasText,
    showColor: mode !== 'none',
    showInkControls: mode === 'ink',
    showTextControls: mode === 'text',
    showSingleTextEdit: mode === 'text' && textCount === 1
  };
}

function _normalizeHexColor(color) {
  if (typeof color !== 'string') return null;
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return null;
}

export function resolveSelectionColor(strokes, textBoxes) {
  let firstColor = null;
  let isMixed = false;

  const inspect = (list) => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      const hex = _normalizeHexColor(item.color) || '#000000';
      if (firstColor === null) {
        firstColor = hex;
      } else if (hex !== firstColor) {
        isMixed = true;
      }
    }
  };

  inspect(strokes);
  inspect(textBoxes);

  return {
    color: firstColor || '#000000',
    isMixed
  };
}

export function resolveSelectionFontSize(textBoxes) {
  if (!Array.isArray(textBoxes) || textBoxes.length === 0) {
    return { fontSize: TEXT_FONT_SIZE_DEFAULT, isMixed: false };
  }
  let firstSize = null;
  let isMixed = false;
  for (let i = 0; i < textBoxes.length; i++) {
    const tb = textBoxes[i];
    if (!tb) continue;
    const sz = clampSelectionFontSize(tb.fontSize ?? TEXT_FONT_SIZE_DEFAULT);
    if (firstSize === null) firstSize = sz;
    else if (sz !== firstSize) isMixed = true;
  }
  return {
    fontSize: firstSize ?? TEXT_FONT_SIZE_DEFAULT,
    isMixed
  };
}

export function computeSteppedSelectionFontSize(currentSize, delta) {
  const base = clampSelectionFontSize(currentSize);
  const d = Number(delta) || 0;
  return clampSelectionFontSize(base + d);
}

/**
 * Calcola le coordinate (left, top) del popover stile sopra (preferito) o sotto
 * il pulsante trigger nella barra selezione, mantenendolo dentro i margini viewport.
 *
 * @param {{
 *   triggerRect: { left: number, top: number, right: number, bottom: number, width: number, height: number },
 *   popoverWidth: number,
 *   popoverHeight: number,
 *   viewportWidth: number,
 *   viewportHeight: number,
 *   gap?: number,
 *   margin?: number,
 *   minTop?: number
 * }} params
 * @returns {{ left: number, top: number, placement: 'top'|'bottom' }}
 */
export function computeSelectionStylePopoverPosition({
  triggerRect,
  popoverWidth,
  popoverHeight,
  viewportRect = null,
  viewportLeft = 0,
  viewportTop = 0,
  viewportWidth,
  viewportHeight,
  gap = 8,
  margin = 8,
  minTop = 56
}) {
  const pw = Math.max(1, popoverWidth || 200);
  const ph = Math.max(1, popoverHeight || 44);
  const vpW = viewportRect ? viewportRect.width : (viewportWidth || 1024);
  const vpH = viewportRect ? viewportRect.height : (viewportHeight || 768);

  return computeAnchoredPosition({
    triggerRect,
    menuWidth: pw,
    menuHeight: ph,
    viewportRect: viewportRect ? { ...viewportRect, width: Math.max(pw + margin * 2, vpW), height: Math.max(ph + margin * 2, vpH) } : null,
    viewportLeft,
    viewportTop,
    viewportWidth: Math.max(pw + margin * 2, vpW),
    viewportHeight: Math.max(ph + margin * 2, vpH),
    align: 'center',
    preferAbove: true,
    gap,
    bottomGap: gap,
    margin,
    minTop
  });
}

/**
 * Calcola le coordinate (left, top) della barra flottante di selezione lazo
 * sopra la selezione (preferito) o sotto se lo spazio superiore è ostruito
 * dall'header/toolbar, mantenendola sempre entro i margini della viewport.
 */
export function computeSelectionMenuPosition({
  selectionRect,
  menuWidth,
  menuHeight,
  viewportRect = null,
  viewportLeft = 0,
  viewportTop = 0,
  viewportWidth,
  viewportHeight,
  minTop = 64,
  gap = 12,
  bottomGap = 18,
  margin = 12
}) {
  const mw = Math.max(1, menuWidth || 360);
  const mh = Math.max(1, menuHeight || 44);
  const vpW = viewportRect ? viewportRect.width : (viewportWidth || 1024);
  const vpH = viewportRect ? viewportRect.height : (viewportHeight || 768);

  return computeAnchoredPosition({
    triggerRect: selectionRect,
    menuWidth: mw,
    menuHeight: mh,
    viewportRect: viewportRect ? { ...viewportRect, width: Math.max(mw + margin * 2, vpW), height: Math.max(mh + margin * 2, vpH) } : null,
    viewportLeft,
    viewportTop,
    viewportWidth: Math.max(mw + margin * 2, vpW),
    viewportHeight: Math.max(mh + margin * 2, vpH),
    align: 'center',
    preferAbove: true,
    gap,
    bottomGap,
    margin,
    minTop
  });
}
