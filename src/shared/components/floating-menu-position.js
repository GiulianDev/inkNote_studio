/**
 * @module components/floating-menu-position
 *
 * Logica pura per il calcolo del viewport visibile (`visualViewport` + fallback),
 * posizionamento di menu/barre ancorate (sotto o sopra con flip automatico)
 * e clamping ai margini reali dello schermo (inclusa tastiera virtuale/zoom su iPad).
 */

function _normalizeViewportRect({
  viewportRect = null,
  viewportLeft = 0,
  viewportTop = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = 8,
  minWidth = margin * 2,
  minHeight = margin * 2
}) {
  const hasRect = viewportRect && typeof viewportRect === 'object';
  const rawLeft = hasRect ? Number(viewportRect.left) : Number(viewportLeft);
  const rawTop = hasRect ? Number(viewportRect.top) : Number(viewportTop);
  const rawWidth = hasRect ? Number(viewportRect.width) : Number(viewportWidth);
  const rawHeight = hasRect ? Number(viewportRect.height) : Number(viewportHeight);

  const left = Number.isFinite(rawLeft) ? rawLeft : 0;
  const top = Number.isFinite(rawTop) ? rawTop : 0;
  const width = Math.max(minWidth, Number.isFinite(rawWidth) ? rawWidth : 0);
  const height = Math.max(minHeight, Number.isFinite(rawHeight) ? rawHeight : 0);

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  };
}

/**
 * Restituisce il rettangolo reale del viewport visibile (in px CSS rispetto al
 * layout viewport per `position: fixed`), tenendo conto di `window.visualViewport`
 * (tastiera virtuale su iPadOS/mobile e pinch-zoom).
 *
 * @param {Window|null} [win]
 * @returns {{ left: number, top: number, width: number, height: number, right: number, bottom: number }}
 */
export function getVisualViewportRect(win = typeof window !== 'undefined' ? window : null) {
  if (!win) {
    return { left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768 };
  }
  const vv = win.visualViewport;
  const fallbackW = Number(win.innerWidth) || Number(win.document?.documentElement?.clientWidth) || 0;
  const fallbackH = Number(win.innerHeight) || Number(win.document?.documentElement?.clientHeight) || 0;

  if (vv && Number(vv.width) > 0 && Number(vv.height) > 0) {
    const left = Number.isFinite(vv.offsetLeft) ? vv.offsetLeft : 0;
    const top = Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
    const width = Number(vv.width);
    const height = Number(vv.height);
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height
    };
  }

  return {
    left: 0,
    top: 0,
    width: fallbackW,
    height: fallbackH,
    right: fallbackW,
    bottom: fallbackH
  };
}

/**
 * Forza coordinate `(x, y)` di un pannello/dock mobile (es. `#undoRedoContainer`)
 * dentro i margini del viewport visibile corrente.
 *
 * @param {object} params
 * @param {number} params.x
 * @param {number} params.y
 * @param {number} params.width
 * @param {number} params.height
 * @param {{ left: number, top: number, width: number, height: number }} [params.viewportRect]
 * @param {number} [params.viewportLeft=0]
 * @param {number} [params.viewportTop=0]
 * @param {number} [params.viewportWidth=0]
 * @param {number} [params.viewportHeight=0]
 * @param {number} [params.margin=8]
 * @param {number} [params.minTop]
 * @returns {{ x: number, y: number }}
 */
export function clampBoxToViewportRect({
  x,
  y,
  width,
  height,
  viewportRect = null,
  viewportLeft = 0,
  viewportTop = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = 8,
  minTop
}) {
  const boxW = Math.max(0, width || 0);
  const boxH = Math.max(0, height || 0);
  const vp = _normalizeViewportRect({
    viewportRect,
    viewportLeft,
    viewportTop,
    viewportWidth,
    viewportHeight,
    margin
  });

  const minX = vp.left + margin;
  const maxX = Math.max(minX, vp.right - boxW - margin);
  const baseMinY = vp.top + margin;
  const safeMinY = minTop != null ? Math.max(baseMinY, minTop) : baseMinY;
  const maxY = Math.max(safeMinY, vp.bottom - boxH - margin);

  return {
    x: Math.round(Math.max(minX, Math.min(maxX, Number.isFinite(x) ? x : minX))),
    y: Math.round(Math.max(safeMinY, Math.min(maxY, Number.isFinite(y) ? y : safeMinY)))
  };
}

/**
 * Calcola le coordinate `left`, `top` e il lato scelto (`placement: 'top'|'bottom'`)
 * per menu o barre flottanti ancorate sopra o sotto un rettangolo target.
 *
 * @param {object} params
 * @param {{ left: number, right: number, top: number, bottom: number, width?: number }} params.triggerRect
 * @param {number} params.menuWidth
 * @param {number} params.menuHeight
 * @param {{ left: number, top: number, width: number, height: number }} [params.viewportRect]
 * @param {number} [params.viewportLeft=0]
 * @param {number} [params.viewportTop=0]
 * @param {number} [params.viewportWidth=0]
 * @param {number} [params.viewportHeight=0]
 * @param {'start'|'center'|'end'} [params.align='end']
 * @param {boolean} [params.preferAbove=false]
 * @param {number} [params.gap=8]
 * @param {number} [params.bottomGap]
 * @param {number} [params.margin=8]
 * @param {number} [params.minTop]
 * @returns {{ left: number, top: number, placement: 'top'|'bottom' }}
 */
export function computeAnchoredPosition({
  triggerRect,
  menuWidth,
  menuHeight,
  viewportRect = null,
  viewportLeft = 0,
  viewportTop = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  align = 'end',
  preferAbove = false,
  gap = 8,
  bottomGap = gap,
  margin = 8,
  minTop
}) {
  const pw = Math.max(0, menuWidth || 0);
  const ph = Math.max(0, menuHeight || 0);
  const vp = _normalizeViewportRect({
    viewportRect,
    viewportLeft,
    viewportTop,
    viewportWidth,
    viewportHeight,
    margin
  });
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

  const minLeft = vp.left + margin;
  const maxLeft = Math.max(minLeft, vp.right - pw - margin);
  const left = Math.max(minLeft, Math.min(maxLeft, rawLeft));

  const safeMinTop = minTop != null ? Math.max(vp.top + margin, minTop) : (vp.top + margin);
  const maxTop = Math.max(safeMinTop, vp.bottom - ph - margin);

  let placement = preferAbove ? 'top' : 'bottom';
  let top;

  if (preferAbove) {
    const aboveTop = triggerRect.top - ph - gap;
    const belowTop = triggerRect.bottom + bottomGap;
    top = aboveTop;
    if (aboveTop < safeMinTop && belowTop + ph <= vp.bottom - margin) {
      placement = 'bottom';
      top = belowTop;
    }
    top = Math.max(safeMinTop, Math.min(maxTop, top));
  } else {
    const belowTop = triggerRect.bottom + gap;
    const aboveTop = triggerRect.top - ph - gap;
    if (belowTop + ph > vp.bottom - margin) {
      if (aboveTop >= safeMinTop) {
        placement = 'top';
        top = aboveTop;
      } else {
        placement = 'bottom';
        top = Math.max(safeMinTop, Math.min(maxTop, belowTop));
      }
    } else {
      top = Math.max(safeMinTop, Math.min(maxTop, belowTop));
    }
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    placement
  };
}

/**
 * Calcola le coordinate `left` e `top` (in px rispetto al viewport per
 * `position: fixed`) di un menu flottante standard.
 *
 * @param {object} params
 * @returns {{ left: number, top: number }}
 */
export function computeFloatingMenuPosition(params) {
  const { left, top } = computeAnchoredPosition(params);
  return { left, top };
}
