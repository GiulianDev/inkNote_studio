// ============================================================
// PAN / PINCH / WHEEL / PULL-TO-ADD-PAGE
// ============================================================

import { state, viewport } from '../../core/state.js';
import { PULL_THRESHOLD, showToast } from '../../core/utils.js';
import { abortCurrentDrawing } from './input.js';
import { addNewPage, scheduleResolutionRefresh } from './pages.js';
import { applyTransform, applyPinchTransform } from './transform.js';

// Margine minimo di contenuto sempre visibile durante il pan.
const MIN_VISIBLE = 150;
// Fattore di resistenza elastica oltre il bordo.
const ELASTIC_FACTOR = 0.25;

// Cache bounds per evitare reflow ad ogni pointermove durante il pan.
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
  const m = Math.min(MIN_VISIBLE, contentW * 0.3, contentH * 0.3);
  const bounds = {
    minX: m - contentW,
    maxX: vw - m,
    minY: m - contentH,
    maxY: vh - m
  };
  _clampCache = { key: cacheKey, bounds };
  return bounds;
}

function _clampXY(rawX, rawY, elastic) {
  const b = _computeClampBounds();
  if (!b) return { x: rawX, y: rawY };
  let x = rawX, y = rawY;
  if (x > b.maxX) x = elastic ? b.maxX + (x - b.maxX) * ELASTIC_FACTOR : b.maxX;
  else if (x < b.minX) x = elastic ? b.minX + (x - b.minX) * ELASTIC_FACTOR : b.minX;
  if (y > b.maxY) y = elastic ? b.maxY + (y - b.maxY) * ELASTIC_FACTOR : b.maxY;
  else if (y < b.minY) y = elastic ? b.minY + (y - b.minY) * ELASTIC_FACTOR : b.minY;
  return { x, y };
}

export function setupViewportGestures() {
  const viewportEl = document.getElementById('viewport');

  // Invalida la cache bounds al resize della finestra
  window.addEventListener('resize', invalidateClampCache);

  const onPointerDown = (e) => {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    viewport.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pointerType: e.pointerType });

    if (viewport.activePointers.size === 1) {
      if (palmCheck && e.pointerType !== 'pen') {
        viewport.isPanning = true;
        viewport.panStart = { x: e.clientX, y: e.clientY };
        viewport.panStartTransform = { x: viewport.x, y: viewport.y };
        try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
      }
    } else if (viewport.activePointers.size === 2) {
      if (viewport.isPanning) viewport.isPanning = false;
      abortCurrentDrawing();
      viewport.isPinching = true;
      const pts = Array.from(viewport.activePointers.values());
      viewport.pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      viewport.pinchStartCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      viewport.pinchStartTransform = { x: viewport.x, y: viewport.y, scale: viewport.scale };
      try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
    }
  };

  const onPointerMove = (e) => {
    if (!viewport.activePointers.has(e.pointerId)) return;
    viewport.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pointerType: e.pointerType });

    if (viewport.isPanning && viewport.activePointers.size === 1) {
      e.preventDefault();
      const dx = e.clientX - viewport.panStart.x;
      const dy = e.clientY - viewport.panStart.y;
      const rawX = viewport.panStartTransform.x + dx;
      const rawY = viewport.panStartTransform.y + dy;
      const c = _clampXY(rawX, rawY, true);
      viewport.x = c.x;
      viewport.y = c.y;
      applyTransform();

      const container = document.getElementById('canvasContainer');
      const bottomBoundary = viewportEl.clientHeight - (viewport.y + container.getBoundingClientRect().height);
      if (bottomBoundary > 0 && dy < 0) {
        state.pullOverscrollY = bottomBoundary;
        showPullIndicator(state.pullOverscrollY >= PULL_THRESHOLD);
      } else hidePullIndicator();
    } else if (viewport.isPinching && viewport.activePointers.size === 2) {
      e.preventDefault();
      const pts = Array.from(viewport.activePointers.values());
      const currentDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const newCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (viewport.pinchStartDist > 0) {
        const factor = currentDist / viewport.pinchStartDist;
        const targetScale = Math.min(
          Math.max(viewport.pinchStartTransform.scale * factor, viewport.minScale),
          viewport.maxScale
        );
        applyPinchTransform(viewport.pinchStartCenter, viewport.pinchStartTransform, newCenter, targetScale);
      }
    }
  };

  const onPointerEnd = (e) => {
    const wasPanning = viewport.isPanning;
    viewport.activePointers.delete(e.pointerId);
    if (viewport.activePointers.size === 0) {
      if (state.pullOverscrollY >= PULL_THRESHOLD) {
        addNewPage();
        showToast('Nuova pagina aggiunta!', '➕');
      }
      state.pullOverscrollY = 0;
      hidePullIndicator();
      viewport.isPanning = false;
      viewport.isPinching = false;

      if (wasPanning) {
        const c = _clampXY(viewport.x, viewport.y, false);
        if (c.x !== viewport.x || c.y !== viewport.y) {
          viewport.x = c.x;
          viewport.y = c.y;
          applyTransform(true);
        }
      }
      scheduleResolutionRefresh();
    } else if (viewport.activePointers.size === 1) {
      viewport.isPinching = false;
    }
  };

  viewportEl.addEventListener('pointerdown', onPointerDown, { capture: true });
  viewportEl.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  viewportEl.addEventListener('pointerup', onPointerEnd, { capture: true });
  viewportEl.addEventListener('pointercancel', onPointerEnd, { capture: true });

  viewportEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const clampedDelta = Math.max(-50, Math.min(50, e.deltaY));
      const zoomFactor = Math.exp(-clampedDelta * 0.01);
      const newScale = Math.min(
        Math.max(viewport.scale * zoomFactor, viewport.minScale),
        viewport.maxScale
      );
      if (newScale === viewport.scale) return;
      const pivot = { x: e.clientX, y: e.clientY };
      applyPinchTransform(pivot, { x: viewport.x, y: viewport.y, scale: viewport.scale }, pivot, newScale);
    } else {
      viewport.x -= e.deltaX;
      viewport.y -= e.deltaY;
      const c = _clampXY(viewport.x, viewport.y, false);
      viewport.x = c.x;
      viewport.y = c.y;
      applyTransform();
    }
  }, { passive: false });
}

function showPullIndicator(isReady) {
  const ind = document.getElementById('pullPageIndicator');
  const txt = document.getElementById('pullText');
  const icon = document.getElementById('pullIcon');
  ind.classList.remove('hidden');
  ind.classList.add('flex');
  if (isReady) {
    ind.classList.remove('bg-indigo-600', 'dark:bg-indigo-500');
    ind.classList.add('bg-emerald-600', 'dark:bg-emerald-500', 'scale-105');
    txt.innerText = 'Rilascia per creare una nuova pagina!';
    icon.innerText = '✨';
  } else {
    ind.classList.remove('bg-emerald-600', 'dark:bg-emerald-500', 'scale-105');
    ind.classList.add('bg-indigo-600', 'dark:bg-indigo-500');
    txt.innerText = 'Scorri in su per aggiungere una nuova pagina...';
    icon.innerText = '⬆️';
  }
}

function hidePullIndicator() {
  const ind = document.getElementById('pullPageIndicator');
  ind.classList.add('hidden');
  ind.classList.remove('flex');
}

export function togglePalmRejection(enabled) {
  showToast(
    enabled ? 'Palm Rejection ATTIVO: Solo Penna scrive, 1 dito muove'
            : 'Palm Rejection DISATTIVO: 1 dito scrive, 2 dita muovono',
    enabled ? '🖐️' : '✏️'
  );
}