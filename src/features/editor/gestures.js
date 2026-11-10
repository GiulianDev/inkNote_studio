// ============================================================
// PAN / PINCH / WHEEL / PULL-TO-ADD-PAGE
// Palm rejection: contact size + finestra post-penna + 3+ dita.
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

// ------------------------------------------------------------
// PALM REJECTION
// ------------------------------------------------------------
// Soglia contact size (px CSS): un dito è ~10-20, un palmo 40-80+.
const PALM_CONTACT_SIZE = 40;
// Finestra dopo l'ultima SCRITTURA (penna che tocca) in cui i touch
// restano bloccati. L'hover NON aggiorna questo timer.
const PEN_ACTIVITY_WINDOW_MS = 100;
// Se la penna arriva entro questa finestra dall'inizio di un pan da
// palmo, il pan viene annullato e la vista torna alla posizione
// pre-pan. Oltre, si presume un pan volontario e lo si lascia.
const PALM_PAN_CANCEL_WINDOW_MS = 400;

let _lastPenActivityTime = 0;
let _panStartTime = 0;

function _isPenEvent(e) {
  return e.pointerType === 'pen' || e.pointerType === 'eraser';
}

function _isPalmContact(e) {
  return (e.width || 0) > PALM_CONTACT_SIZE || (e.height || 0) > PALM_CONTACT_SIZE;
}

function _isPenBlockingTouches() {
  if (_lastPenActivityTime === 0) return false;
  return (performance.now() - _lastPenActivityTime) < PEN_ACTIVITY_WINDOW_MS;
}

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

  window.addEventListener('resize', invalidateClampCache);

  // ----------------------------------------------------------
  // Tracking penna
  // Aggiorna _lastPenActivityTime SOLO quando la penna tocca il
  // vetro (buttons > 0). L'hover non conta.
  // ----------------------------------------------------------
  viewportEl.addEventListener('pointerdown', (e) => {
    if (_isPenEvent(e)) _lastPenActivityTime = performance.now();
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointermove', (e) => {
    if (_isPenEvent(e) && e.buttons > 0) {
      _lastPenActivityTime = performance.now();
    }
  }, { capture: true, passive: true });

  // ----------------------------------------------------------
  // POINTER DOWN
  // ----------------------------------------------------------
  const onPointerDown = (e) => {
    // ---- PENNA ----
    // La penna non partecipa mai al tracking gesture.
    if (_isPenEvent(e)) {
      // Rimuovi eventuali touch tracciati (erano il palmo)
      for (const [id, ptr] of [...viewport.activePointers]) {
        if (ptr.pointerType !== 'pen' && ptr.pointerType !== 'eraser') {
          viewport.activePointers.delete(id);
          try { viewportEl.releasePointerCapture(id); } catch (err) {}
        }
      }

      if (viewport.isPanning) {
        const panDuration = performance.now() - _panStartTime;
        if (viewport.panStartTransform && panDuration < PALM_PAN_CANCEL_WINDOW_MS) {
          // Pan appena iniziato: quasi certamente causato dal palmo.
          viewport.x = viewport.panStartTransform.x;
          viewport.y = viewport.panStartTransform.y;
          applyTransform(false);
        }
        viewport.isPanning = false;
      }

      viewport.isPinching = false;
      state.pullOverscrollY = 0;
      hidePullIndicator();
      return;
    }

    // ---- TOCCO ----
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck) {
      if (_isPenBlockingTouches()) return;   // penna attiva di recente
      if (_isPalmContact(e)) return;         // contatto troppo largo
    }

    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

    // 3+ dita → nessun gesto
    if (viewport.activePointers.size > 2) {
      viewport.isPanning = false;
      viewport.isPinching = false;
      state.pullOverscrollY = 0;
      hidePullIndicator();
      return;
    }

    if (viewport.activePointers.size === 1) {
      if (palmCheck) {
        viewport.isPanning = true;
        viewport.panStart = { x: e.clientX, y: e.clientY };
        viewport.panStartTransform = { x: viewport.x, y: viewport.y };
        _panStartTime = performance.now();
        try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
      }
    } else if (viewport.activePointers.size === 2) {
      if (viewport.isPanning) viewport.isPanning = false;
      abortCurrentDrawing();
      viewport.isPinching = true;
      const pts = Array.from(viewport.activePointers.values());
      viewport.pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      viewport.pinchStartCenter = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };
      viewport.pinchStartTransform = {
        x: viewport.x, y: viewport.y, scale: viewport.scale
      };
      try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
    }
  };

  // ----------------------------------------------------------
  // POINTER MOVE
  // ----------------------------------------------------------
  const onPointerMove = (e) => {
    // Penna: mai movimentare il foglio
    if (_isPenEvent(e)) return;

    if (!viewport.activePointers.has(e.pointerId)) return;
    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

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
      const newCenter = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };
      if (viewport.pinchStartDist > 0) {
        const factor = currentDist / viewport.pinchStartDist;
        const targetScale = Math.min(
          Math.max(viewport.pinchStartTransform.scale * factor, viewport.minScale),
          viewport.maxScale
        );
        applyPinchTransform(
          viewport.pinchStartCenter,
          viewport.pinchStartTransform,
          newCenter,
          targetScale
        );
      }
    }
  };

  // ----------------------------------------------------------
  // POINTER END
  // ----------------------------------------------------------
  const onPointerEnd = (e) => {
    // Penna: mai gestita qui (il suo pointerup è gestito da input.js)
    if (_isPenEvent(e)) return;

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
      applyPinchTransform(
        pivot,
        { x: viewport.x, y: viewport.y, scale: viewport.scale },
        pivot,
        newScale
      );
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