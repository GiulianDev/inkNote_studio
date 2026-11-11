// ============================================================
// VIEWPORT TRANSFORM + CLAMP RIGOROSO + PINCH
// Fix 1: cache clamp bounds a scale=1 per evitare reflow ad ogni
// frame di pinch.
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
// Fix 1: contentW e contentH sono calcolati UNA VOLTA a scale=1
// (cachati in _clampCache) e moltiplicati per viewport.scale ad
// ogni chiamata. Così offsetWidth/offsetHeight (che forzano
// reflow) vengono letti solo quando cambiano pagine o window size,
// NON ad ogni frame di pinch/zoom.
// ------------------------------------------------------------

let _clampCache = null;
export function invalidateClampCache() { _clampCache = null; }

function _computeClampBounds() {
  const vpEl = document.getElementById('viewport');
  const container = document.getElementById('canvasContainer');
  if (!vpEl || !container) return null;

  // Cache key SENZA viewport.scale: la base (viewport size + content
  // size a scale 1) cambia solo al resize o al cambio pagine.
  const cacheKey = `${state.pages.length}|${window.innerWidth}|${window.innerHeight}`;

  let base;
  if (_clampCache && _clampCache.key === cacheKey) {
    base = _clampCache;
  } else {
    const vw = vpEl.clientWidth;
    const vh = vpEl.clientHeight;
    const contentW1 = container.offsetWidth;
    const contentH1 = container.offsetHeight;
    if (contentW1 <= 0 || contentH1 <= 0) return null;
    base = { key: cacheKey, vw, vh, contentW1, contentH1 };
    _clampCache = base;
  }

  // Scala al volo, senza reflow
  const vw = base.vw;
  const vh = base.vh;
  const contentW = base.contentW1 * viewport.scale;
  const contentH = base.contentH1 * viewport.scale;

  const deltaX = vw - contentW;
  const deltaY = vh - contentH;
  const bounds = {
    minX: Math.min(0, deltaX),
    maxX: Math.max(0, deltaX),
    minY: Math.min(0, deltaY),
    maxY: Math.max(0, deltaY)
  };
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