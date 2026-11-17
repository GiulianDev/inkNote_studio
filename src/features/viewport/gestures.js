/**
 * @module features/viewport/gestures
 *
 * GESTURE VIEWPORT — pan (1 dito), pinch (2 dita), wheel, pull-to-add-page.
 *
 * ------------------------------------------------------------------
 * PALM REJECTION (state.palmRejection)
 * ------------------------------------------------------------------
 *   - Penna a contatto (_penDown) → blocca qualsiasi touch
 *   - Penna in hover (_penInRange) → blocca qualsiasi touch,
 *     con safety net 800ms per driver che non emettono pointerleave
 *   - Grace post pointerup penna: 150ms
 *   - Grace post pointerleave penna: 300ms
 *   - Tocco con dimensione > PALM_CONTACT_SIZE (50px) → rifiutato
 *     come palmo/nocca, indipendentemente dal resto
 *
 * ------------------------------------------------------------------
 * NUMERO MASSIMO DI TOCCHI
 * ------------------------------------------------------------------
 *   - Pan: 1 solo tocco valido
 *   - Pinch: 2 tocchi, non di più
 *   - >= 3 tocchi → BLOCCO TOTALE del gesto (rollback posizione,
 *     reset pan/pinch) finché TUTTI i pointer non si alzano
 *   - Durante il blocco, ogni nuovo pointerdown viene ignorato
 *
 * ------------------------------------------------------------------
 * PINCH INTENZIONALE
 * ------------------------------------------------------------------
 * Il pinch parte solo se TUTTE queste condizioni sono vere:
 *
 *   1) Timing: il 2° tocco arriva entro 200ms dal 1°
 *      (nocca+palmo arrivano di solito a 200-500ms)
 *   2) Dimensione: nessuno dei due tocchi ha dimensione > 50px
 *   3) Conferma (entro 150ms):
 *        a) entrambi i tocchi si spostano di almeno 3px, OPPURE
 *        b) la distanza tra i due cambia di almeno 15px
 *
 * Fase di conferma: se una delle due condizioni si verifica prima
 * del timeout, il pinch parte subito. Se scade il timeout senza
 * che nessuna si verifichi, il pinch parte comunque (l'utente
 * tiene le dita ferme → è intenzionale).
 *
 * Se durante la conferma uno dei due tocchi si alza:
 *   → rollback alla posizione pre-pinch
 *   → il tocco rimasto torna a fare pan
 *
 * Distanza iniziale LIBERA:
 *   - 2cm e allargare → zoom in
 *   - 10cm e stringere → zoom out
 *   L'utente può partire da qualunque distanza.
 *
 * ------------------------------------------------------------------
 * PAN (1 DITO)
 * ------------------------------------------------------------------
 *   - 1 solo tocco → pan
 *   - Se arriva un 2° tocco: tenta pinch (con i filtri sopra)
 *     - pinch confermato → diventa pinch
 *     - pinch rifiutato → il 2° tocco viene ignorato, pan continua
 *
 * ------------------------------------------------------------------
 * PULL-TO-ADD-PAGE
 * ------------------------------------------------------------------
 *   - Attivo solo se il gesto è INIZIATO al fondo (overscroll
 *     volontario). Soglia 80px. Si alza il dito per aggiungere.
 *
 * ------------------------------------------------------------------
 * WHEEL
 * ------------------------------------------------------------------
 *   - Ctrl+wheel → zoom pivot al cursore
 *   - wheel → pan
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

// ============================================================
// COSTANTI — PALM REJECTION
// ============================================================

/** Dimensione massima (px CSS) di un tocco valido come "dito". */
const PALM_CONTACT_SIZE = 50;

/** Grace dopo pointerup/pointercancel penna. */
const PEN_CONTACT_GRACE_MS = 150;

/** Grace dopo pointerleave penna (mignolo che appoggia). */
const PEN_LEAVE_GRACE_MS = 300;

/**
 * Safety net per driver che non emettono pointerleave affidabile.
 * Se non riceviamo eventi penna per 800ms, consideriamo la penna
 * fuori range e sblocchiamo i touch.
 */
const PEN_HOVER_TIMEOUT_MS = 800;

/**
 * Finestra (ms) entro cui un pan breve viene annullato se la penna
 * entra in contatto. Pan più lunghi di così sono considerati
 * volontari e non vengono annullati.
 */
const PEN_CANCEL_PAN_WINDOW_MS = 400;

// ============================================================
// COSTANTI — PINCH
// ============================================================

/** Timing massimo tra 1° e 2° tocco. */
const PINCH_SECOND_TOUCH_MAX_MS = 200;

/** Timeout della fase di conferma. */
const PINCH_CONFIRM_MS = 150;

/** Spostamento minimo di ENTRAMBI i tocchi per confermare. */
const PINCH_CONFIRM_MIN_MOVE_PX = 3;

/** Variazione minima della distanza tra i due per confermare. */
const PINCH_CONFIRM_MIN_DIST_PX = 15;

// ============================================================
// COSTANTI — SCROLL AXIS LOCK
// ============================================================

const SCROLL_DECISION_WINDOW_MS = 400;
const SCROLL_DECISION_WINDOW_PX = 80;
const SCROLL_ENTER_SPEED = 1.0;
const SCROLL_AXIS_DOMINANCE = 2.5;
const SCROLL_MAX_CROSS_SPEED = 0.8;

// ============================================================
// COSTANTI — MOMENTUM
// ============================================================

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

// ============================================================
// STATO MODULO
// ============================================================

// --- Palm rejection ---
let _penDown = false;
let _penInRange = false;
let _lastPenContactEndTime = 0;
let _lastPenLeaveTime = 0;
let _lastPenEventTime = 0;

// --- Blocco gesto (>= 3 tocchi) ---
let _gestureBlocked = false;

// --- Pan ---
let _panStartTime = 0;
let _firstTouchDownTime = 0;
let _startedAtBottom = false;
let _scrollDecisionMade = false;
let _scrollAxisLocked = false;

// --- Pinch ---
/**
 * @type {null | {
 *   deadline: number,
 *   confirmed: boolean,
 *   startTransform: {x:number,y:number,scale:number},
 *   startP0: {x:number,y:number},
 *   startP1: {x:number,y:number},
 *   startDist: number
 * }}
 */
let _pinchConfirm = null;

// --- Momentum ---
let _momentumRaf = null;
let _momentumVelX = 0;
let _momentumVelY = 0;
let _momentumLastTime = 0;
const _velocitySamples = [];

// ============================================================
// HELPER
// ============================================================

function _isPenEvent(e) {
  return e.pointerType === 'pen' || e.pointerType === 'eraser';
}

function _isPalmContact(e) {
  return (e.width || 0) > PALM_CONTACT_SIZE || (e.height || 0) > PALM_CONTACT_SIZE;
}

/**
 * True se i touch devono essere ignorati per via della penna.
 *
 * Ordine di valutazione:
 *   1. Stroke in corso (pen down) → bloccato
 *   2. Grace post-pointerup (150ms) → bloccato
 *   3. Grace post-pointerleave (300ms) → bloccato
 *   4. Hover attivo (con safety net 800ms) → bloccato
 *   5. Fuori range → touch liberi
 */
function _isPenBlockingTouches() {
  if (_penDown) return true;

  const now = performance.now();

  if (_lastPenContactEndTime > 0 &&
      now - _lastPenContactEndTime < PEN_CONTACT_GRACE_MS) {
    return true;
  }

  if (_lastPenLeaveTime > 0 &&
      now - _lastPenLeaveTime < PEN_LEAVE_GRACE_MS) {
    return true;
  }

  if (_penInRange) {
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

// ============================================================
// MOMENTUM
// ============================================================

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

// ============================================================
// RESET / ROLLBACK
// ============================================================

/**
 * Annulla pan/pinch in corso, riporta la vista a uno stato stabile.
 * Usato quando la penna entra in contatto durante un gesto touch,
 * quando arrivano >= 3 tocchi, o quando un pinch viene rifiutato.
 *
 * @param {boolean} rollbackPosition  se true, riporta x/y/scale
 *                                    allo stato pre-gesto
 */
function _cancelCurrentGesture(rollbackPosition) {
  if (rollbackPosition) {
    if (_pinchConfirm && !_pinchConfirm.confirmed) {
      viewport.x = _pinchConfirm.startTransform.x;
      viewport.y = _pinchConfirm.startTransform.y;
      viewport.scale = _pinchConfirm.startTransform.scale;
    } else if (viewport.isPanning && viewport.panStartTransform) {
      viewport.x = viewport.panStartTransform.x;
      viewport.y = viewport.panStartTransform.y;
    }
    applyTransform(false);
  }
  viewport.isPanning = false;
  viewport.isPinching = false;
  _pinchConfirm = null;
  _startedAtBottom = false;
  _scrollDecisionMade = false;
  _scrollAxisLocked = false;
  state.pullOverscrollY = 0;
  hidePullIndicator();
}

// ============================================================
// SETUP
// ============================================================

export function setupViewportGestures() {
  const viewportEl = document.getElementById('viewport');

  window.addEventListener('resize', invalidateClampCache);

  window.addEventListener('blur', () => {
    _penDown = false;
    _penInRange = false;
    _lastPenContactEndTime = 0;
    _lastPenLeaveTime = 0;
    _lastPenEventTime = 0;
    _gestureBlocked = false;
  });

  // ----------------------------------------------------------
  // PEN TRACKING
  // ----------------------------------------------------------

  viewportEl.addEventListener('pointerenter', (e) => {
    if (_isPenEvent(e)) {
      _penInRange = true;
      _lastPenEventTime = performance.now();
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointermove', (e) => {
    if (_isPenEvent(e)) {
      _lastPenEventTime = performance.now();
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointerleave', (e) => {
    if (_isPenEvent(e)) {
      _penInRange = false;
      _lastPenEventTime = 0;
      _lastPenLeaveTime = performance.now();
    }
  }, { capture: true, passive: true });

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

      // Cancella gli eventuali touch attivi (palmo appoggiato prima
      // che la penna arrivasse). Il gesto touch viene annullato.
      const hadTouchGesture = viewport.isPanning || viewport.isPinching;
      for (const [id, ptr] of [...viewport.activePointers]) {
        if (ptr.pointerType !== 'pen' && ptr.pointerType !== 'eraser') {
          viewport.activePointers.delete(id);
          try { viewportEl.releasePointerCapture(id); } catch (err) {}
        }
      }
      if (hadTouchGesture) {
        const panDuration = performance.now() - _panStartTime;
        // Rollback solo se il pan era breve (probabilmente palmo
        // appena appoggiato). Pan più lunghi sono volontari.
        const shouldRollback = viewport.isPinching
          ? true
          : panDuration < PEN_CANCEL_PAN_WINDOW_MS;
        _cancelCurrentGesture(shouldRollback);
      }
      _gestureBlocked = false;
      return;
    }

    // ---- TOCCO ----
    if (state.palmRejection) {
      if (_isPenBlockingTouches()) return;
      if (_isPalmContact(e)) return;
    }

    // Durante il blocco (>= 3 tocchi), ignora qualsiasi nuovo tocco
    if (_gestureBlocked) return;

    _cancelMomentum();
    _resetVelocitySamples();
    _scrollAxisLocked = false;
    _scrollDecisionMade = false;

    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

    const count = viewport.activePointers.size;

    // ---- BLOCCO: 3+ TOCCHI ----
    if (count >= 3) {
      _gestureBlocked = true;
      _cancelCurrentGesture(true);
      return;
    }

    // ---- PRIMO TOCCO: PAN ----
    if (count === 1) {
      _firstTouchDownTime = performance.now();

      viewport.isPanning = true;
      viewport.panStart = { x: e.clientX, y: e.clientY };
      viewport.panStartTransform = { x: viewport.x, y: viewport.y };
      _panStartTime = performance.now();
      _pushVelocitySample(e.clientX, e.clientY);

      const c0 = clampViewport(viewport.x, viewport.y);
      _startedAtBottom = !!(c0.bounds &&
        Math.abs(viewport.y - c0.bounds.minY) < 2);

      try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    // ---- SECONDO TOCCO: TENTA PINCH ----
    if (count === 2) {
      const now = performance.now();
      const timeSinceFirst = now - _firstTouchDownTime;

      // Filtro 1: timing
      if (timeSinceFirst > PINCH_SECOND_TOUCH_MAX_MS) {
        viewport.activePointers.delete(e.pointerId);
        try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}
        return;
      }

      // Filtro 2: dimensione (appena arrivato)
      if (state.palmRejection && _isPalmContact(e)) {
        viewport.activePointers.delete(e.pointerId);
        try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}
        return;
      }

      // Ok, potenziale pinch. Avvia fase di conferma.
      const pts = Array.from(viewport.activePointers.values());
      const p0 = pts[0];
      const p1 = pts[1];
      const startDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);

      viewport.isPanning = false;
      viewport.isPinching = true;
      _startedAtBottom = false;
      abortCurrentDrawing();

      const startCenter = {
        x: (p0.x + p1.x) / 2,
        y: (p0.y + p1.y) / 2
      };

      _pinchConfirm = {
        deadline: now + PINCH_CONFIRM_MS,
        confirmed: false,
        startTransform: { x: viewport.x, y: viewport.y, scale: viewport.scale },
        startP0: { x: p0.x, y: p0.y },
        startP1: { x: p1.x, y: p1.y },
        startDist
      };

      viewport.pinchStartDist = startDist;
      viewport.pinchStartCenter = startCenter;
      viewport.pinchStartTransform = { x: viewport.x, y: viewport.y, scale: viewport.scale };

      try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }
  };

  // ----------------------------------------------------------
  // POINTER MOVE
  // ----------------------------------------------------------
  const onPointerMove = (e) => {
    if (_isPenEvent(e)) return;
    if (_gestureBlocked) return;

    if (!viewport.activePointers.has(e.pointerId)) return;
    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

    // ---- PAN (1 dito) ----
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

    // ---- PINCH (2 dita) ----
    } else if (viewport.isPinching && viewport.activePointers.size === 2) {
      e.preventDefault();
      const pts = Array.from(viewport.activePointers.values());
      const p0 = pts[0];
      const p1 = pts[1];
      const currentDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const newCenter = {
        x: (p0.x + p1.x) / 2,
        y: (p0.y + p1.y) / 2
      };

      // ---- Fase di conferma ----
      if (_pinchConfirm && !_pinchConfirm.confirmed) {
        const now = performance.now();
        const moveP0 = Math.hypot(p0.x - _pinchConfirm.startP0.x, p0.y - _pinchConfirm.startP0.y);
        const moveP1 = Math.hypot(p1.x - _pinchConfirm.startP1.x, p1.y - _pinchConfirm.startP1.y);
        const bothMoved = (moveP0 >= PINCH_CONFIRM_MIN_MOVE_PX &&
                           moveP1 >= PINCH_CONFIRM_MIN_MOVE_PX);
        const distChanged = Math.abs(currentDist - _pinchConfirm.startDist) >= PINCH_CONFIRM_MIN_DIST_PX;
        const timeExpired = now >= _pinchConfirm.deadline;

        if (bothMoved || distChanged || timeExpired) {
          _pinchConfirm.confirmed = true;
        } else {
          return;  // aspetta conferma
        }
      }

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

    viewport.activePointers.delete(e.pointerId);

    // ---- Nessun tocco residuo ----
    if (viewport.activePointers.size === 0) {
      _gestureBlocked = false;
      _firstTouchDownTime = 0;

      // Pinch non confermato: rollback
      if (_pinchConfirm && !_pinchConfirm.confirmed) {
        viewport.x = _pinchConfirm.startTransform.x;
        viewport.y = _pinchConfirm.startTransform.y;
        viewport.scale = _pinchConfirm.startTransform.scale;
        applyTransform(false);
      }
      _pinchConfirm = null;

      const shouldAddPage = _startedAtBottom && state.pullOverscrollY >= PULL_THRESHOLD;

      state.pullOverscrollY = 0;
      hidePullIndicator();

      const wasPanning = viewport.isPanning;
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
      return;
    }

    // ---- Un tocco residuo: forse pinch rifiutato o uno dei due si è alzato ----
    if (viewport.activePointers.size === 1) {
      // Pinch in fase di conferma e uno sparisce → rollback + pan
      if (_pinchConfirm && !_pinchConfirm.confirmed) {
        viewport.x = _pinchConfirm.startTransform.x;
        viewport.y = _pinchConfirm.startTransform.y;
        viewport.scale = _pinchConfirm.startTransform.scale;
        applyTransform(false);
        _pinchConfirm = null;
        viewport.isPinching = false;

        const entries = Array.from(viewport.activePointers.entries());
        const [, remaining] = entries[0];
        viewport.isPanning = true;
        viewport.panStart = { x: remaining.x, y: remaining.y };
        viewport.panStartTransform = { x: viewport.x, y: viewport.y };
        _panStartTime = performance.now();
        _resetVelocitySamples();
        _pushVelocitySample(remaining.x, remaining.y);
        _startedAtBottom = false;
        _firstTouchDownTime = performance.now();
        return;
      }

      // Pinch confermato e uno sparisce → fine pinch, continua con pan
      if (viewport.isPinching) {
        _pinchConfirm = null;
        viewport.isPinching = false;

        const entries = Array.from(viewport.activePointers.entries());
        const [, remaining] = entries[0];
        viewport.isPanning = true;
        viewport.panStart = { x: remaining.x, y: remaining.y };
        viewport.panStartTransform = { x: viewport.x, y: viewport.y };
        _panStartTime = performance.now();
        _resetVelocitySamples();
        _pushVelocitySample(remaining.x, remaining.y);
        _startedAtBottom = false;
        _firstTouchDownTime = performance.now();
      }
    }
  };

  viewportEl.addEventListener('pointerdown', onPointerDown, { capture: true });
  viewportEl.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  viewportEl.addEventListener('pointerup', onPointerEnd, { capture: true });
  viewportEl.addEventListener('pointercancel', onPointerEnd, { capture: true });

  // ----------------------------------------------------------
  // WHEEL
  // ----------------------------------------------------------
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

// ============================================================
// PULL INDICATOR
// ============================================================

function showPullIndicator(isReady) {
  const ind = document.getElementById('pullPageIndicator');
  const txt = document.getElementById('pullText');
  const icon = document.getElementById('pullIcon');
  if (!ind) return;
  ind.classList.remove('hidden');
  ind.classList.add('flex');
  if (isReady) {
    ind.classList.remove('bg-indigo-600', 'dark:bg-indigo-500');
    ind.classList.add('bg-emerald-600', 'dark:bg-emerald-500', 'scale-105');
    if (txt)  txt.innerText  = 'Rilascia per creare una nuova pagina!';
    if (icon) icon.innerText = '✨';
  } else {
    ind.classList.remove('bg-emerald-600', 'dark:bg-emerald-500', 'scale-105');
    ind.classList.add('bg-indigo-600', 'dark:bg-indigo-500');
    if (txt)  txt.innerText  = 'Scorri in su per aggiungere una nuova pagina...';
    if (icon) icon.innerText = '⬆️';
  }
}

function hidePullIndicator() {
  const ind = document.getElementById('pullPageIndicator');
  if (!ind) return;
  ind.classList.add('hidden');
  ind.classList.remove('flex');
}

// ============================================================
// TOGGLE PALM REJECTION
// ============================================================

export function togglePalmRejection(enabled) {
  showToast(
    enabled ? 'Palm Rejection ATTIVO: Solo Penna scrive, dita attive dopo il rilascio'
            : 'Palm Rejection DISATTIVO: 1 dito scrive, 2 dita muovono',
    enabled ? '🖐️' : '✏️'
  );
}