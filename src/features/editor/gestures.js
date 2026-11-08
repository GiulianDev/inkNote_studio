// ============================================================
// PAN / PINCH / WHEEL / PULL-TO-ADD-PAGE
// ============================================================

import { state, viewport } from '../../core/state.js';
import { PULL_THRESHOLD, showToast } from '../../core/utils.js';
import { abortCurrentDrawing } from './input.js';
import { addNewPage, scheduleResolutionRefresh } from './pages.js';
import { applyTransform, applyPinchTransform } from './transform.js';

export function setupViewportGestures() {
  const viewportEl = document.getElementById('viewport');

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
      viewport.x = viewport.panStartTransform.x + dx;
      viewport.y = viewport.panStartTransform.y + dy;
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