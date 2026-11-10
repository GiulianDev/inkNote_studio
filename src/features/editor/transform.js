// ============================================================
// VIEWPORT TRANSFORM + CLAMP RIGOROSO + PINCH
// ============================================================

import { viewport, state } from '../../core/state.js';

let _viewportChangeHandler = null;
export function setViewportChangeHandler(fn) { _viewportChangeHandler = fn; }

// ------------------------------------------------------------
// CLAMP RIGOROSO (bounded, spostabile fino ai bordi)
// ------------------------------------------------------------
// Il contenuto può essere spostato liberamente, ma il suo bordo
// sinistro non può superare il bordo sinistro del viewport, e il
// suo bordo destro non può superare il bordo destro.
//
// Formula unificata (vale per contenuto stretto E largo):
//   minX = min(0, vw - contentW)
//   maxX = max(0, vw - contentW)
//
// Casi:
//   contentW <= vw → minX = 0, maxX = vw - contentW ≥ 0
//                    il foglio può andare da bordo sx schermo
//                    a bordo dx schermo (completamente spostabile)
//   contentW >  vw → minX = vw - contentW < 0, maxX = 0
//                    il foglio può andare da "bordo dx al bordo dx schermo"
//                    a "bordo sx al bordo sx schermo"
//
// Il valore di ritorno include clampX/clampY (overscroll respinto):
//   clampY < 0  →  spingendo oltre il bordo superiore (fondo contenuto)
//   clampY > 0  →  spingendo oltre il bordo inferiore
// Usato da gestures.js per il pull-to-add-page.
// ------------------------------------------------------------

let _clampCache = null;
export function invalidateClampCache() { _clampCache = null; }

function _computeClampBounds() {
  const cacheKey = `${viewport.scale}|${state.pages.length}|${window.innerWidth}|${window.innerHeight}`;
  if (_clampCache && _clampCache.key === cacheKey) return _clampCache.bounds;

  const vpEl = document.getElementById('viewport');
  const container = document.getElementById('canvasContainer');
  if (!vpEl || !container) return null;
  const vw = vpEl.clientWidth;
  const vh = vpEl.clientHeight;
  const contentW = container.offsetWidth * viewport.scale;
  const contentH = container.offsetHeight * viewport.scale;
  if (contentW <= 0 || contentH <= 0) return null;

  const deltaX = vw - contentW;
  const deltaY = vh - contentH;
  const bounds = {
    minX: Math.min(0, deltaX),
    maxX: Math.max(0, deltaX),
    minY: Math.min(0, deltaY),
    maxY: Math.max(0, deltaY)
  };
  _clampCache = { key: cacheKey, bounds };
  return bounds;
}

/**
 * Applica il clamp rigoroso a una posizione grezza.
 * @returns {{x:number, y:number, clampX:number, clampY:number, bounds:object|null}}
 */
export function clampViewport(rawX, rawY) {
  const b = _computeClampBounds();
  if (!b) return { x: rawX, y: rawY, clampX: 0, clampY: 0, bounds: null };

  let x = rawX, y = rawY;
  let clampX = 0, clampY = 0;

  if (rawX > b.maxX) {
    x = b.maxX;
    clampX = rawX - x;
  } else if (rawX < b.minX) {
    x = b.minX;
    clampX = rawX - x;
  }

  if (rawY > b.maxY) {
    y = b.maxY;
    clampY = rawY - y;
  } else if (rawY < b.minY) {
    y = b.minY;
    clampY = rawY - y;
  }

  return { x, y, clampX, clampY, bounds: b };
}

// ------------------------------------------------------------
// APPLY TRANSFORM
// ------------------------------------------------------------

export function applyTransform(animate = false) {
  const container = document.getElementById('canvasContainer');
  if (!container) return;
  clearTimeout(container._transTimer);
  if (animate) {
    container.classList.add('with-transition');
    container._transTimer = setTimeout(() => {
      container.classList.remove('with-transition');
    }, 350);
  } else {
    container.classList.remove('with-transition');
  }
  container.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
  const zoomText = document.getElementById('zoomText');
  if (zoomText) zoomText.innerText = `${Math.round(viewport.scale * 100)}%`;
  if (_viewportChangeHandler) _viewportChangeHandler();
}

// ------------------------------------------------------------
// APPLY PINCH TRANSFORM
// Dopo lo zoom, clampo la posizione per evitare che il foglio
// fuori esca dai bordi del viewport.
// ------------------------------------------------------------

export function applyPinchTransform(startCenter, startTransform, newCenter, targetScale) {
  const contentX = (startCenter.x - startTransform.x) / startTransform.scale;
  const contentY = (startCenter.y - startTransform.y) / startTransform.scale;
  viewport.x = newCenter.x - contentX * targetScale;
  viewport.y = newCenter.y - contentY * targetScale;
  viewport.scale = targetScale;

  const c = clampViewport(viewport.x, viewport.y);
  viewport.x = c.x;
  viewport.y = c.y;

  applyTransform();
}