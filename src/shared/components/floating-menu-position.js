/**
 * @module components/floating-menu-position
 *
 * Calcolo puro della posizione di un menu flottante ancorato a un elemento
 * trigger, con clamping automatico ai margini del viewport e flip verticale
 * quando sotto non c'è spazio sufficiente.
 */

/**
 * Calcola le coordinate `left` e `top` (in px, rispetto al viewport per
 * `position: fixed`) di un menu flottante.
 *
 * @param {object} params
 * @param {{ left: number, right: number, top: number, bottom: number, width?: number }} params.triggerRect
 * @param {number} params.menuWidth
 * @param {number} params.menuHeight
 * @param {number} params.viewportWidth
 * @param {number} params.viewportHeight
 * @param {'start'|'center'|'end'} [params.align='end']
 * @param {number} [params.gap=8]
 * @param {number} [params.margin=8]
 * @returns {{ left: number, top: number }}
 */
export function computeFloatingMenuPosition({
  triggerRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  align = 'end',
  gap = 8,
  margin = 8
}) {
  const pw = Math.max(0, menuWidth || 0);
  const ph = Math.max(0, menuHeight || 0);
  const vw = Math.max(margin * 2, viewportWidth || 0);
  const vh = Math.max(margin * 2, viewportHeight || 0);
  const triggerWidth = triggerRect.width != null
    ? triggerRect.width
    : (triggerRect.right - triggerRect.left);

  let rawLeft;
  if (align === 'start') {
    rawLeft = triggerRect.left;
  } else if (align === 'center') {
    rawLeft = triggerRect.left + (triggerWidth - pw) / 2;
  } else {
    rawLeft = triggerRect.right - pw;
  }

  const maxLeft = Math.max(margin, vw - pw - margin);
  const left = Math.max(margin, Math.min(maxLeft, rawLeft));

  let top = triggerRect.bottom + gap;
  if (top + ph > vh - margin) {
    const above = triggerRect.top - ph - gap;
    if (above >= margin) {
      top = above;
    } else {
      const maxTop = Math.max(margin, vh - ph - margin);
      top = Math.max(margin, Math.min(maxTop, top));
    }
  } else {
    top = Math.max(margin, top);
  }

  return {
    left: Math.round(left),
    top: Math.round(top)
  };
}
