// ============================================================
// PAN / PINCH / WHEEL / PULL-TO-ADD-PAGE
// Palm rejection: contact size + finestra post-penna + 3+ dita.
// Scroll con inerzia (flick scrolling) per un feeling naturale.
// ============================================================

import { state, viewport } from '../../core/state.js';
import { PULL_THRESHOLD, showToast } from '../../core/utils.js';
import { getScrollSensitivity } from '../../services/preferences.js';
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
const PALM_CONTACT_SIZE = 40;
// Finestra dopo l'ultima SCRITTURA (penna che tocca) in cui i touch
// restano bloccati. Volutamente breve. L'hover NON aggiorna il timer.
const PEN_ACTIVITY_WINDOW_MS = 100;
// Se la penna arriva entro questa finestra dall'inizio di un pan da
// palmo, il pan viene annullato e la vista torna alla posizione
// pre-pan. Oltre, si presume un pan volontario e lo si lascia.
const PALM_PAN_CANCEL_WINDOW_MS = 400;

// ------------------------------------------------------------
// MOMENTUM / FLICK SCROLLING
// ------------------------------------------------------------
// Friction per millisecondo: decay esponenziale della velocità.
// 0.996 → ~500px di "corsa" partendo da 2 px/ms (2000 px/s).
const MOMENTUM_FRICTION_PER_MS = 0.997;
// Amplifica la velocità calcolata dal gesto (feeling iOS-like).
const MOMENTUM_VELOCITY_BOOST = 1.15;
// Sotto questa soglia (px/ms) il gesto non genera momentum.
const MOMENTUM_MIN_FLING_VELOCITY = 0.08;  // ~80 px/s
// Sotto questa soglia (px/ms) il momentum si ferma.
const MOMENTUM_STOP_VELOCITY = 0.02;       // ~20 px/s
// Quanti campioni di posizione del dito tenere per stimare la velocità.
const VELOCITY_SAMPLE_COUNT = 6;
// Finestra temporale (ms) entro cui i campioni sono validi.
const VELOCITY_SAMPLE_WINDOW_MS = 100;
// Boost dinamico in base alla velocità del flick:
// speed ≤ 2 px/ms → 1.0x
// speed 5 px/ms  → 1.9x
// speed 8+ px/ms → 2.8x
const MOMENTUM_SPEED_BASE = 2.0;        // px/ms sotto cui boost = 1
const MOMENTUM_SPEED_SLOPE = 0.30;      // incremento per px/ms sopra la base
const MOMENTUM_SPEED_MAX = 8.0;         // px/ms oltre cui boost satura
const MOMENTUM_SPEED_BOOST_MAX = 2.8;   // tetto del boost

let _lastPenActivityTime = 0;
let _panStartTime = 0;

// Stato momentum
let _momentumRaf = null;
let _momentumVelX = 0;    // px/ms
let _momentumVelY = 0;    // px/ms
let _momentumLastTime = 0;
// Campioni di posizione del dito per stimare la velocità al rilascio
const _velocitySamples = [];

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

// ------------------------------------------------------------
// MOMENTUM
// ------------------------------------------------------------

function _cancelMomentum() {
  if (_momentumRaf !== null) {
    cancelAnimationFrame(_momentumRaf);
    _momentumRaf = null;
  }
  _momentumVelX = 0;
  _momentumVelY = 0;
  _momentumLastTime = 0;
}

function _pushVelocitySample(x, y) {
  _velocitySamples.push({ x, y, t: performance.now() });
  while (_velocitySamples.length > VELOCITY_SAMPLE_COUNT) _velocitySamples.shift();
}

function _resetVelocitySamples() {
  _velocitySamples.length = 0;
}

/**
 * Stima la velocità del dito (px/ms) sull'ultima finestra utile.
 * Ritorna { vx, vy } nella direzione del movimento del dito.
 */
function _computeFlingVelocity() {
  if (_velocitySamples.length < 2) return { vx: 0, vy: 0 };
  const now = performance.now();
  let firstIdx = 0;
  for (let i = 0; i < _velocitySamples.length; i++) {
    if (now - _velocitySamples[i].t <= VELOCITY_SAMPLE_WINDOW_MS) {
      firstIdx = i;
      break;
    }
  }
  const first = _velocitySamples[firstIdx];
  const last = _velocitySamples[_velocitySamples.length - 1];
  const dt = last.t - first.t;
  if (dt < 1) return { vx: 0, vy: 0 };
  return {
    vx: (last.x - first.x) / dt,
    vy: (last.y - first.y) / dt
  };
}

function _computeSpeedBoost(speed) {
  if (speed <= MOMENTUM_SPEED_BASE) return 1.0;
  const over = Math.min(speed, MOMENTUM_SPEED_MAX) - MOMENTUM_SPEED_BASE;
  return Math.min(MOMENTUM_SPEED_BOOST_MAX, 1 + over * MOMENTUM_SPEED_SLOPE);
}

function _startMomentum(vx, vy) {
  const speed = Math.hypot(vx, vy);
  const speedBoost = _computeSpeedBoost(speed);
  const userSensitivity = getScrollSensitivity();   // 0.2x - 2.0x
  const totalBoost = MOMENTUM_VELOCITY_BOOST * speedBoost * userSensitivity;

  _momentumVelX = vx * totalBoost;
  _momentumVelY = vy * totalBoost;
  _momentumLastTime = 0;

  if (Math.hypot(_momentumVelX, _momentumVelY) < MOMENTUM_MIN_FLING_VELOCITY) {
    _cancelMomentum();
    return;
  }

  if (_momentumRaf === null) {
    _momentumRaf = requestAnimationFrame(_momentumStep);
  }
}

function _momentumStep(now) {
  _momentumRaf = null;

  if (_momentumLastTime === 0) _momentumLastTime = now;
  // Clamp del delta per evitare salti enormi dopo un tab in background
  const dt = Math.min(now - _momentumLastTime, 32);
  _momentumLastTime = now;

  // Decay indipendente dal framerate: friction^dt
  const decay = Math.pow(MOMENTUM_FRICTION_PER_MS, dt);
  _momentumVelX *= decay;
  _momentumVelY *= decay;

  // Sotto soglia → stop e snap finale al clamp
  if (Math.abs(_momentumVelX) < MOMENTUM_STOP_VELOCITY &&
      Math.abs(_momentumVelY) < MOMENTUM_STOP_VELOCITY) {
    _cancelMomentum();
    const c = _clampXY(viewport.x, viewport.y, false);
    if (c.x !== viewport.x || c.y !== viewport.y) {
      viewport.x = c.x;
      viewport.y = c.y;
      applyTransform(true);
    }
    scheduleResolutionRefresh();
    return;
  }

  // Muovi il viewport (stessa direzione del dito: drag-naturale)
  viewport.x += _momentumVelX * dt;
  viewport.y += _momentumVelY * dt;

  // Applica i limiti elastici. Se ho sbattuto contro un bordo,
  // azzera la componente di velocità corrispondente.
  const c = _clampXY(viewport.x, viewport.y, true);
  if (c.x !== viewport.x) _momentumVelX = 0;
  if (c.y !== viewport.y) _momentumVelY = 0;
  viewport.x = c.x;
  viewport.y = c.y;
  applyTransform();

  _momentumRaf = requestAnimationFrame(_momentumStep);
}

// ------------------------------------------------------------
// CLAMP BOUNDS
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

// ------------------------------------------------------------
// SETUP
// ------------------------------------------------------------

export function setupViewportGestures() {
  const viewportEl = document.getElementById('viewport');

  window.addEventListener('resize', invalidateClampCache);

  // Tracking penna (solo scrittura, hover non conta)
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
    if (_isPenEvent(e)) {
      _cancelMomentum();
      _resetVelocitySamples();

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
      if (_isPenBlockingTouches()) return;
      if (_isPalmContact(e)) return;
    }

    // Nuovo gesto touch: ferma momentum e resetta i campioni
    _cancelMomentum();
    _resetVelocitySamples();

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
        _pushVelocitySample(e.clientX, e.clientY);
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
    if (_isPenEvent(e)) return;

    if (!viewport.activePointers.has(e.pointerId)) return;
    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

    if (viewport.isPanning && viewport.activePointers.size === 1) {
      e.preventDefault();
      // Registra il campione per la stima di velocità
      _pushVelocitySample(e.clientX, e.clientY);

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
    if (_isPenEvent(e)) return;

    const wasPanning = viewport.isPanning;
    viewport.activePointers.delete(e.pointerId);

    if (viewport.activePointers.size === 0) {
      const shouldAddPage = state.pullOverscrollY >= PULL_THRESHOLD;

      state.pullOverscrollY = 0;
      hidePullIndicator();
      viewport.isPanning = false;
      viewport.isPinching = false;

      if (wasPanning) {
        // Verifica se c'è abbastanza velocità per avviare il momentum
        const { vx, vy } = _computeFlingVelocity();
        const speed = Math.hypot(vx, vy);

        if (!shouldAddPage && speed >= MOMENTUM_MIN_FLING_VELOCITY) {
          // Fling: il momentum prende il controllo (lo snap finale
          // e la chiamata a scheduleResolutionRefresh avvengono
          // quando il momentum si esaurisce)
          _startMomentum(vx, vy);
        } else {
          // Nessun fling: snap immediato al clamp se necessario
          if (shouldAddPage) {
            addNewPage();
            showToast('Nuova pagina aggiunta!', '➕');
          }
          const c = _clampXY(viewport.x, viewport.y, false);
          if (c.x !== viewport.x || c.y !== viewport.y) {
            viewport.x = c.x;
            viewport.y = c.y;
            applyTransform(true);
          }
          scheduleResolutionRefresh();
        }
      } else {
        if (shouldAddPage) {
          addNewPage();
          showToast('Nuova pagina aggiunta!', '➕');
        }
        scheduleResolutionRefresh();
      }
      _resetVelocitySamples();
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
    // Wheel (mouse): cancella momentum, non lo genera.
    _cancelMomentum();
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