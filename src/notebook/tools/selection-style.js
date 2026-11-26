/**
 * @module features/tools/selection-style
 *
 * Logica pura (senza dipendenze DOM) per risolvere, applicare e posizionare
 * il cambio di stile del tratto (solido, tratteggiato, tratteggio largo,
 * punteggiato, tratto-punto) sugli stroke selezionati dal tool lazo.
 */

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
  viewportWidth,
  viewportHeight,
  gap = 8,
  margin = 8,
  minTop = 56
}) {
  const pw = Math.max(1, popoverWidth || 200);
  const ph = Math.max(1, popoverHeight || 44);
  const vw = Math.max(pw + margin * 2, viewportWidth || 1024);
  const vh = Math.max(ph + margin * 2, viewportHeight || 768);

  const centerX = triggerRect.left + triggerRect.width / 2;
  const maxLeft = Math.max(margin, vw - pw - margin);
  const left = Math.round(Math.max(margin, Math.min(maxLeft, centerX - pw / 2)));

  const aboveTop = triggerRect.top - ph - gap;
  const belowTop = triggerRect.bottom + gap;

  let placement = 'top';
  let top = aboveTop;
  if (aboveTop < minTop && belowTop + ph <= vh - margin) {
    placement = 'bottom';
    top = belowTop;
  }

  const maxTop = Math.max(margin, vh - ph - margin);
  top = Math.round(Math.max(margin, Math.min(maxTop, top)));

  return { left, top, placement };
}

/**
 * Calcola le coordinate (left, top) della barra flottante di selezione lazo
 * sopra la selezione (preferito) o sotto se lo spazio superiore è ostruito
 * dall'header/toolbar, mantenendola sempre entro i margini della viewport.
 *
 * @param {{
 *   selectionRect: { left: number, top: number, right: number, bottom: number },
 *   menuWidth: number,
 *   menuHeight: number,
 *   viewportWidth: number,
 *   viewportHeight: number,
 *   minTop?: number,
 *   gap?: number,
 *   bottomGap?: number,
 *   margin?: number
 * }} params
 * @returns {{ left: number, top: number, placement: 'top'|'bottom' }}
 */
export function computeSelectionMenuPosition({
  selectionRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  minTop = 64,
  gap = 12,
  bottomGap = 18,
  margin = 12
}) {
  const mw = Math.max(1, menuWidth || 360);
  const mh = Math.max(1, menuHeight || 44);
  const vw = Math.max(mw + margin * 2, viewportWidth || 1024);
  const vh = Math.max(mh + margin * 2, viewportHeight || 768);

  const safeMinTop = Math.max(margin, minTop);
  const maxTop = Math.max(safeMinTop, vh - mh - margin);

  const centerX = (selectionRect.left + selectionRect.right) / 2;
  const maxLeft = Math.max(margin, vw - mw - margin);
  const left = Math.round(Math.max(margin, Math.min(maxLeft, centerX - mw / 2)));

  const aboveTop = selectionRect.top - mh - gap;
  const belowTop = selectionRect.bottom + bottomGap;

  let placement = 'top';
  let top = aboveTop;
  if (aboveTop < safeMinTop && belowTop + mh <= vh - margin) {
    placement = 'bottom';
    top = belowTop;
  }

  top = Math.round(Math.max(safeMinTop, Math.min(maxTop, top)));

  return { left, top, placement };
}
