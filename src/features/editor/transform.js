// ============================================================
// VIEWPORT TRANSFORM + CLAMP RIGOROSO + PINCH
// ============================================================

import { viewport, state } from '../../core/state.js';

let _viewportChangeHandler = null;
export function setViewportChangeHandler(fn) { _viewportChangeHandler = fn; }

// ------------------------------------------------------------
// CLAMP RIGOROSO
// ------------------------------------------------------------
// Regole:
//   - contentW <= viewportW  →  x fissato a (vw - contentW) / 2  (centrato)
//   - contentW >  viewportW  →  x ∈ [vw - contentW, 0]
//   - stessa logica su Y
// In nessun caso il contenuto può "uscire" dai bordi del viewport:
// spingendo a destra si ferma quando il bordo sinistro del foglio
// tocca il bordo sinistro dello schermo, e viceversa.
//
// Il valore di ritorno include clampX/clampY (overscroll respinto):
//   clampX < 0  →  stava spingendo oltre il bordo sinistro
//   clampX > 0  →  stava spingendo oltre il bordo destro
//   clampY < 0  →  stava spingendo oltre il bordo inferiore (fondo)
//   clampY > 0  →  stava spingendo oltre il bordo superiore (cima)
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

  let minX, maxX, minY, maxY;
  if (contentW <= vw) {
    // Contenuto più stretto del viewport: centrato, pan orizzontale disabilitato
    minX = maxX = (vw - contentW) / 2;
  } else {
    // Contenuto più largo: bounds rigorosi
    minX = vw - contentW;
    maxX = 0;
  }
  if (contentH <= vh) {
    minY = maxY = (vh - contentH) / 2;
  } else {
    minY = vh - contentH;
    maxY = 0;
  }

  const bounds = { minX, maxX, minY, maxY };
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

  if (b.maxX === b.minX) {
    // Asse bloccato (contenuto più stretto): centrato, overscroll = offset dal centro
    x = b.minX;
    clampX = rawX - x;
  } else if (rawX > b.maxX) {
    x = b.maxX;
    clampX = rawX - x;
  } else if (rawX < b.minX) {
    x = b.minX;
    clampX = rawX - x;
  }

  if (b.maxY === b.minY) {
    y = b.minY;
    clampY = rawY - y;
  } else if (rawY > b.maxY) {
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
// Dopo aver applicato lo zoom, clampo la posizione per evitare
// che il foglio fuori esca dai bordi del viewport.
// ------------------------------------------------------------

export function applyPinchTransform(startCenter, startTransform, newCenter, targetScale) {
  const contentX = (startCenter.x - startTransform.x) / startTransform.scale;
  const contentY = (startCenter.y - startTransform.y) / startTransform.scale;
  viewport.x = newCenter.x - contentX * targetScale;
  viewport.y = newCenter.y - contentY * targetScale;
  viewport.scale = targetScale;

  // Clamp post-zoom: la cache bounds è già invalidata dal cambio di scale
  // (cacheKey include viewport.scale), quindi il clamp usa i nuovi bounds.
  const c = clampViewport(viewport.x, viewport.y);
  viewport.x = c.x;
  viewport.y = c.y;

  applyTransform();
}