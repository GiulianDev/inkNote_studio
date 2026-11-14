/**
 * @module features/viewport/gestures
 *
 * GESTURE VIEWPORT — pan, pinch, wheel, pull-to-add-page.
 *
 * Palm rejection (se state.palmRejection):
 *   - Touch > 40px (contact size) → ignora (palm)
 *   - Touch durante stroke penna (penDown) → ignora
 *   - Touch entro PEN_CONTACT_GRACE_MS dal pointerup → ignora
 *     (grace: palmo che appoggia nel momento del sollevamento)
 *   - Touch mentre penna è in hover (penInRange) → ignora
 *     (finché cursore visibile → no pan/pinch)
 *
 * Due timer, ruoli distinti e non sovrapposti:
 *
 *   PEN_CONTACT_GRACE_MS = 80ms
 *     - Parte SOLO al pointerup/pointercancel della penna
 *     - Copre: sollevo di scatto + allontano + dito appoggia
 *       entro 80ms → bloccato
 *     - Dopo 80ms: scade, non è più valutato
 *
 *   PEN_HOVER_TIMEOUT_MS = 250ms
 *     - Safety net per device che NON emettono pointerleave
 *     - Si applica SOLO se _penInRange === true
 *     - Se non riceviamo eventi hover da 250ms, assume che la
 *       penna sia fuori range e sblocca i touch
 *     - Su Surface Go non si attiva mai (pointerleave arriva)
 *
 * Ritardo post-pointerleave normale: 0ms (il leave azzera
 * _penInRange e _lastPenEventTime, touch liberi subito).
 *
 * Scroll momentum:
 *   - velocity samples (ultimi 6 eventi in 100ms)
 *   - axis lock one-shot (dominanza Y > 2.5× X entro 400ms)
 *   - speed boost progressivo (2.0 → 8.0 px/ms)
 *   - friction 0.997/ms, stop threshold 0.02
 *
 * Pull-to-add-page:
 *   - solo se il gesto è INIZIATO al fondo (overscroll "volontario")
 *   - soglia 80px
 *
 * Wheel:
 *   - Ctrl+wheel = zoom (pivot al cursore)
 *   - wheel = pan
 *
 * Chiama abortCurrentDrawing() (tools/dispatcher.js) al pinch per
 * interrompere uno stroke in corso.
 *
 * @see core/types.js
 * @see features/viewport/transform.js
 * @see features/tools/dispatcher.js
 */

import { state, viewport } from '../../core/state.js';
import { PULL_THRESHOLD, showToast } from '../../core/utils.js';
import { getScrollSensitivity } from '../../core/app-settings.js';
import { abortCurrentDrawing } from '../tools/dispatcher.js';
import { addNewPage, scheduleResolutionRefresh } from '../editor/pages.js';
import {
  applyTransform, applyPinchTransform,
  clampViewport, invalidateClampCache
} from './transform.js';

// ------------------------------------------------------------
// PALM REJECTION
// ------------------------------------------------------------
const PALM_CONTACT_SIZE = 40;

// Grace post-pointerup: breve, copre il caso "sollevo di scatto +
// allontano + dito appoggia". Si esaurisce in 80ms dal pointerup.
const PEN_CONTACT_GRACE_MS = 80;

// Safety net per device che non emettono pointerleave in modo
// affidabile. Si attiva SOLO se _penInRange === true e non riceviamo
// eventi penna da 250ms. Su Surface Go non si attiva mai (il
// pointerleave arriva correttamente quando la penna esce dal range).
const PEN_HOVER_TIMEOUT_MS = 250;

const PALM_PAN_CANCEL_WINDOW_MS = 400;

// ------------------------------------------------------------
// SCROLL AXIS LOCK ONE-SHOT
// ------------------------------------------------------------
const SCROLL_DECISION_WINDOW_MS = 400;
const SCROLL_DECISION_WINDOW_PX = 80;
const SCROLL_ENTER_SPEED = 1.0;
const SCROLL_AXIS_DOMINANCE = 2.5;
const SCROLL_MAX_CROSS_SPEED = 0.8;

// ------------------------------------------------------------
// MOMENTUM / FLICK SCROLLING
// ------------------------------------------------------------
const MOMENTUM_FRICTION_PER_MS = 0.997;
const MOMENTUM_VELOCITY_BOOST = 1.15;
const MOMENTUM_MIN_FLING_VELOCITY = 0.08;
const MOMENTUM_STOP_VELOCITY = 0.02;
const VELOCITY_SAMPLE_COUNT = 6;
const VELOCITY_SAMPLE_WINDOW_MS = 100;
const MOMENTUM_SPEED_BASE = 2.0;
const MOMENTUM_SPEED_SLOPE = 0.30;
const MOMENTUM_SPEED_MAX = 8.0;
const MOMENTUM_SPEED_BOOST_MAX = 2.8;

// ------------------------------------------------------------
// PEN STATE
// ------------------------------------------------------------
// _penDown                 true tra pointerdown e pointerup/cancel penna
// _penInRange              true tra pointerenter e pointerleave penna
// _lastPenContactEndTime   timestamp ultimo pointerup/cancel penna
// _lastPenEventTime        timestamp ultimo evento penna (enter/move/down)
//                          azzerato su pointerleave
let _penDown = false;
let _penInRange = false;
let _lastPenContactEndTime = 0;
let _lastPenEventTime = 0;

let _panStartTime = 0;

let _scrollDecisionMade = false;
let _scrollAxisLocked = false;

// True se al pointerdown la vista era già clampata al fondo del
// contenuto. Il pull-to-add-page si attiva solo in questo caso:
// se l'utente è arrivato al fondo durante lo scroll (o con il
// momentum), il pull NON scatta nello stesso gesto. Deve prima
// rilasciare, poi fare un nuovo gesto dal fondo verso l'alto.
let _startedAtBottom = false;

let _momentumRaf = null;
let _momentumVelX = 0;
let _momentumVelY = 0;
let _momentumLastTime = 0;
const _velocitySamples = [];

function _isPenEvent(e) {
  return e.pointerType === 'pen' || e.pointerType === 'eraser';
}

function _isPalmContact(e) {
  return (e.width || 0) > PALM_CONTACT_SIZE || (e.height || 0) > PALM_CONTACT_SIZE;
}

/**
 * True se i touch devono essere ignorati per via della penna.
 *
 * Ordine di valutazione (nessuna sovrapposizione tra i due timer):
 *   1. Stroke in corso → bloccato
 *   2. Grace post-pointerup (80ms) → bloccato
 *   3. Hover attivo → bloccato, MA se non arrivano eventi penna
 *      da 250ms il safety net considera la penna fuori range
 *      e sblocca i touch
 *   4. Fuori range → touch liberi
 */
function _isPenBlockingTouches() {
  if (_penDown) return true;

  const now = performance.now();

  if (_lastPenContactEndTime > 0 &&
      now - _lastPenContactEndTime < PEN_CONTACT_GRACE_MS) {
    return true;
  }

  if (_penInRange) {
    // Safety net: se non riceviamo eventi hover da troppo tempo,
    // assumiamo che la penna sia fuori range ma il driver non abbia
    // emesso pointerleave. Sblocca i touch.
    if (_lastPenEventTime > 0 &&
        now - _lastPenEventTime > PEN_HOVER_TIMEOUT_MS) {
      _penInRange = false;
      _lastPenEventTime = 0;
      return false;
    }
    return true;
  }

  return false;
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
  if (_scrollAxisLocked) vx = 0;

  const speed = Math.hypot(vx, vy);
  const speedBoost = _computeSpeedBoost(speed);
  const userSensitivity = getScrollSensitivity();
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
  const dt = Math.min(now - _momentumLastTime, 32);
  _momentumLastTime = now;

  const decay = Math.pow(MOMENTUM_FRICTION_PER_MS, dt);
  _momentumVelX *= decay;
  _momentumVelY *= decay;

  if (Math.abs(_momentumVelX) < MOMENTUM_STOP_VELOCITY &&
      Math.abs(_momentumVelY) < MOMENTUM_STOP_VELOCITY) {
    _cancelMomentum();
    const c = clampViewport(viewport.x, viewport.y);
    if (c.x !== viewport.x || c.y !== viewport.y) {
      viewport.x = c.x;
      viewport.y = c.y;
      applyTransform(true);
    }
    scheduleResolutionRefresh();
    return;
  }

  viewport.x += _momentumVelX * dt;
  viewport.y += _momentumVelY * dt;

  const c = clampViewport(viewport.x, viewport.y);
  if (c.x !== viewport.x) _momentumVelX = 0;
  if (c.y !== viewport.y) _momentumVelY = 0;
  viewport.x = c.x;
  viewport.y = c.y;
  applyTransform();

  _momentumRaf = requestAnimationFrame(_momentumStep);
}

// ------------------------------------------------------------
// SETUP
// ------------------------------------------------------------

export function setupViewportGestures() {
  const viewportEl = document.getElementById('viewport');

  window.addEventListener('resize', invalidateClampCache);

  // Reset su blur: se il tab va in background mentre la penna è a
  // contatto o in hover, al ritorno potremmo non ricevere
  // pointerup/pointerleave → flag bloccati. Reset esplicito.
  window.addEventListener('blur', () => {
    _penDown = false;
    _penInRange = false;
    _lastPenContactEndTime = 0;
    _lastPenEventTime = 0;
  });

  // ----------------------------------------------------------
  // PEN TRACKING (enter / leave / down / up)
  // ----------------------------------------------------------

  // Penna entra nel viewport (hover visibile).
  viewportEl.addEventListener('pointerenter', (e) => {
    if (_isPenEvent(e)) {
      _penInRange = true;
      _lastPenEventTime = performance.now();
    }
  }, { capture: true, passive: true });

  // Penna si muove nel viewport (hover o contact). Tiene fresco
  // il safety net di _penInRange.
  viewportEl.addEventListener('pointermove', (e) => {
    if (_isPenEvent(e)) {
      _lastPenEventTime = performance.now();
    }
  }, { capture: true, passive: true });

  // Penna esce dal viewport (fuori range). Sblocca SUBITO i touch:
  // _penInRange=false + _lastPenEventTime=0 → il prossimo touch
  // passa il check senza ritardo.
  viewportEl.addEventListener('pointerleave', (e) => {
    if (_isPenEvent(e)) {
      _penInRange = false;
      _lastPenEventTime = 0;
    }
  }, { capture: true, passive: true });

  // Penna a contatto: blocca touch fino a pointerup/cancel.
  viewportEl.addEventListener('pointerdown', (e) => {
    if (_isPenEvent(e)) {
      _penDown = true;
      _lastPenEventTime = performance.now();
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointerup', (e) => {
    if (_isPenEvent(e)) {
      _penDown = false;
      _lastPenContactEndTime = performance.now();
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointercancel', (e) => {
    if (_isPenEvent(e)) {
      _penDown = false;
      _lastPenContactEndTime = performance.now();
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
      _scrollAxisLocked = false;
      _scrollDecisionMade = false;
      _startedAtBottom = false;

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
    const palmCheck = state.palmRejection;
    if (palmCheck) {
      // Blocca touch se penna a contatto, in grace post-pointerup,
      // o in hover (con safety net integrato).
      if (_isPenBlockingTouches()) return;
      // Blocca se contatto > 40px (palm).
      if (_isPalmContact(e)) return;
    }

    _cancelMomentum();
    _resetVelocitySamples();
    _scrollAxisLocked = false;
    _scrollDecisionMade = false;

    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

    if (viewport.activePointers.size > 2) {
      viewport.isPanning = false;
      viewport.isPinching = false;
      _startedAtBottom = false;
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

        const c0 = clampViewport(viewport.x, viewport.y);
        _startedAtBottom = !!(c0.bounds &&
          Math.abs(viewport.y - c0.bounds.minY) < 2);

        try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
      }
    } else if (viewport.activePointers.size === 2) {
      if (viewport.isPanning) viewport.isPanning = false;
      _startedAtBottom = false;
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
      _pushVelocitySample(e.clientX, e.clientY);

      if (!_scrollDecisionMade) {
        const { vx, vy } = _computeFlingVelocity();
        const speed = Math.hypot(vx, vy);
        const absVx = Math.abs(vx);
        const absVy = Math.abs(vy);

        if (speed >= SCROLL_ENTER_SPEED &&
            absVy > absVx * SCROLL_AXIS_DOMINANCE &&
            absVx < SCROLL_MAX_CROSS_SPEED) {
          _scrollAxisLocked = true;
          _scrollDecisionMade = true;
          viewport.panStartTransform.x = viewport.x;
          viewport.panStart.x = e.clientX;
        } else {
          const elapsed = performance.now() - _panStartTime;
          const dist = Math.hypot(
            e.clientX - viewport.panStart.x,
            e.clientY - viewport.panStart.y
          );
          if (elapsed > SCROLL_DECISION_WINDOW_MS || dist > SCROLL_DECISION_WINDOW_PX) {
            _scrollDecisionMade = true;
          }
        }
      }

      const dx = e.clientX - viewport.panStart.x;
      const dy = e.clientY - viewport.panStart.y;
      const effectiveDx = _scrollAxisLocked ? 0 : dx;
      const effectiveDy = dy;

      const rawX = viewport.panStartTransform.x + effectiveDx;
      const rawY = viewport.panStartTransform.y + effectiveDy;
      const c = clampViewport(rawX, rawY);
      viewport.x = c.x;
      viewport.y = c.y;
      applyTransform();

      if (_startedAtBottom && c.clampY < 0) {
        const pullY = -c.clampY;
        state.pullOverscrollY = pullY;
        showPullIndicator(pullY >= PULL_THRESHOLD);
      } else {
        state.pullOverscrollY = 0;
        hidePullIndicator();
      }

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
      const shouldAddPage = _startedAtBottom && state.pullOverscrollY >= PULL_THRESHOLD;

      state.pullOverscrollY = 0;
      hidePullIndicator();
      viewport.isPanning = false;
      viewport.isPinching = false;

      if (shouldAddPage) {
        addNewPage();
        showToast('Nuova pagina aggiunta!', '➕');
        _resetVelocitySamples();
        _scrollAxisLocked = false;
        _scrollDecisionMade = false;
        _startedAtBottom = false;
        return;
      }

      if (wasPanning) {
        const { vx, vy } = _computeFlingVelocity();
        const speed = Math.hypot(vx, vy);

        if (speed >= MOMENTUM_MIN_FLING_VELOCITY) {
          _startMomentum(vx, vy);
        } else {
          const c = clampViewport(viewport.x, viewport.y);
          if (c.x !== viewport.x || c.y !== viewport.y) {
            viewport.x = c.x;
            viewport.y = c.y;
            applyTransform(true);
          }
          scheduleResolutionRefresh();
        }
      } else {
        scheduleResolutionRefresh();
      }
      _resetVelocitySamples();
      _scrollAxisLocked = false;
      _scrollDecisionMade = false;
      _startedAtBottom = false;
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
      const c = clampViewport(viewport.x, viewport.y);
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
    enabled ? 'Palm Rejection ATTIVO: Solo Penna scrive, dita attive dopo il rilascio'
            : 'Palm Rejection DISATTIVO: 1 dito scrive, 2 dita muovono',
    enabled ? '🖐️' : '✏️'
  );
}