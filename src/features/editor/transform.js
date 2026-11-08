// ============================================================
// VIEWPORT TRANSFORM (applyTransform + pinch)
// Estratto da gestures.js: rompe il ciclo pages ↔ gestures.
// ============================================================

import { viewport } from '../../core/state.js';

let _viewportChangeHandler = null;
export function setViewportChangeHandler(fn) { _viewportChangeHandler = fn; }

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

export function applyPinchTransform(startCenter, startTransform, newCenter, targetScale) {
  const contentX = (startCenter.x - startTransform.x) / startTransform.scale;
  const contentY = (startCenter.y - startTransform.y) / startTransform.scale;
  viewport.x = newCenter.x - contentX * targetScale;
  viewport.y = newCenter.y - contentY * targetScale;
  viewport.scale = targetScale;
  applyTransform();
}