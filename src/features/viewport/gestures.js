/**
 * @module features/viewport/gestures
 *
 * GESTURE VIEWPORT — pan (1 dito), pinch (2 dita), wheel, pull-to-add-page.
 */

import { state, viewport } from '../../core/state.js';
import { PULL_THRESHOLD, showToast } from '../../core/utils.js';
import { getScrollSensitivity } from '../../core/app-settings.js';
import { abortCurrentDrawing } from '../tools/dispatcher.js';
import { addNewPage, scheduleResolutionRefresh } from '../editor/pages.js';
import {
  canStartTextDragOnTouch, handleTextTapAtClientPoint
} from '../tools/text.js';
import { canStartLassoDragOnTouch } from '../tools/lazo.js';
import {
  applyTransform, applyPinchTransform,
  clampViewport, invalidateClampCache
} from './transform.js';
import {
  createPalmRejectionTracker,
  isPenPointerType,
  isPalmContact,
  shouldCommitPinch,
  PAN_START_THRESHOLD_PX,
  PINCH_MIN_INITIAL_DIST,
  PINCH_MAX_INITIAL_DIST_IOS,
  PINCH_MAX_INITIAL_DIST_DEFAULT,
  GESTURE_BLOCK_COOLDOWN_MS
} from './palm-rejection.js';

// Rilevamento iPadOS / iOS WebKit (iPadOS 13+ si dichiara MacIntel + maxTouchPoints > 1)
const _isIOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

const PINCH_MAX_INITIAL_DIST = _isIOS
  ? PINCH_MAX_INITIAL_DIST_IOS
  : PINCH_MAX_INITIAL_DIST_DEFAULT;

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

const _palmTracker = createPalmRejectionTracker({ isIOS: _isIOS });

let _panStartTime = 0;
let _gestureStartTime = 0;
let _gestureOriginTransform = { x: 0, y: 0, scale: 1 };
let _panCommitted = false;
let _pinchCommitted = false;
let _startedAtBottom = false;
let _scrollDecisionMade = false;
let _scrollAxisLocked = false;

let _momentumRaf = null;
let _momentumVelX = 0;
let _momentumVelY = 0;
let _momentumLastTime = 0;
const _velocitySamples = [];

// Oggetti riusati nel hot path per evitare allocazioni GC ad ogni pointermove
const _pinchCenter = { x: 0, y: 0 };
let _tmpP0 = null;
let _tmpP1 = null;

// ============================================================
// HELPER
// ============================================================

function _isPenEvent(e) {
  return isPenPointerType(e.pointerType);
}

function _readTwoPointers() {
  _tmpP0 = null;
  _tmpP1 = null;
  for (const pt of viewport.activePointers.values()) {
    if (_tmpP0 === null) _tmpP0 = pt;
    else {
      _tmpP1 = pt;
      break;
    }
  }
  return _tmpP0 !== null && _tmpP1 !== null;
}

function _clearTouchPointers(viewportEl) {
  for (const [id, ptr] of viewport.activePointers) {
    if (!isPenPointerType(ptr.pointerType)) {
      viewport.activePointers.delete(id);
      try { viewportEl.releasePointerCapture(id); } catch (err) {}
    }
  }
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

function _cancelCurrentGesture(rollbackPosition) {
  if (rollbackPosition) {
    if ((viewport.isPinching && _pinchCommitted) || (viewport.isPanning && _panCommitted)) {
      viewport.x = _gestureOriginTransform.x;
      viewport.y = _gestureOriginTransform.y;
      viewport.scale = _gestureOriginTransform.scale;
      applyTransform(false);
    }
  }
  viewport.isPanning = false;
  viewport.isPinching = false;
  _panCommitted = false;
  _pinchCommitted = false;
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
    _palmTracker.resetAll();
    viewport.activePointers.clear();
    _cancelCurrentGesture(false);
  });

  // Safety net globale se la penna viene sollevata fuori da #viewport
  const onGlobalPenEnd = (e) => {
    if (_isPenEvent(e)) {
      _palmTracker.onGlobalPenEnd(performance.now());
    }
  };
  window.addEventListener('pointerup', onGlobalPenEnd, { capture: true, passive: true });
  window.addEventListener('pointercancel', onGlobalPenEnd, { capture: true, passive: true });

  // Safari/iPadOS: blocca zoom/scroll nativo browser su #viewport
  const preventNativeGesture = (e) => e.preventDefault();
  viewportEl.addEventListener('gesturestart', preventNativeGesture, { passive: false });
  viewportEl.addEventListener('gesturechange', preventNativeGesture, { passive: false });
  viewportEl.addEventListener('gestureend', preventNativeGesture, { passive: false });
  if (_isIOS) {
    viewportEl.addEventListener('touchmove', preventNativeGesture, { passive: false });
  }

  // ----------------------------------------------------------
  // PEN TRACKING
  // ----------------------------------------------------------

  const _rollbackOnPenArrival = (now) => {
    if (!viewport.isPanning && !viewport.isPinching) return;
    const shouldRollback = _palmTracker.shouldRollbackGestureOnPenArrival({
      isPanning: viewport.isPanning,
      isPinching: viewport.isPinching,
      panCommitted: _panCommitted,
      pinchCommitted: _pinchCommitted,
      gestureStartTime: _gestureStartTime,
      now,
      originTransform: _gestureOriginTransform,
      currentTransform: { x: viewport.x, y: viewport.y, scale: viewport.scale }
    });
    _clearTouchPointers(viewportEl);
    _cancelCurrentGesture(shouldRollback);
  };

  viewportEl.addEventListener('pointerenter', (e) => {
    if (_isPenEvent(e)) {
      const now = performance.now();
      _palmTracker.onPenEnter(now);
      _rollbackOnPenArrival(now);
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointermove', (e) => {
    if (_isPenEvent(e)) {
      _palmTracker.onPenHoverMove(performance.now());
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointerleave', (e) => {
    if (_isPenEvent(e)) {
      _palmTracker.onPenLeave(performance.now());
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointerdown', (e) => {
    if (_isPenEvent(e)) {
      _palmTracker.onPenDown(performance.now());
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointerup', (e) => {
    if (_isPenEvent(e)) {
      _palmTracker.onPenUp(performance.now());
    }
  }, { capture: true, passive: true });

  viewportEl.addEventListener('pointercancel', (e) => {
    if (_isPenEvent(e)) {
      _palmTracker.onPenUp(performance.now());
    }
  }, { capture: true, passive: true });

  // ----------------------------------------------------------
  // POINTER DOWN
  // ----------------------------------------------------------
  const onPointerDown = (e) => {
    if (_isPenEvent(e)) {
      _cancelMomentum();
      _resetVelocitySamples();
      _scrollAxisLocked = false;
      _scrollDecisionMade = false;
      _startedAtBottom = false;

      _rollbackOnPenArrival(performance.now());
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (e.target && e.target.closest &&
        e.target.closest('.text-box-editor-wrap, #textSelectionMenu')) {
      return;
    }

    if (state.activeTool === 'text') {
      if (e.pointerType === 'mouse' && e.target?.closest?.('.page-wrapper')) {
        return;
      }
      if (e.pointerType === 'touch' && viewport.activePointers.size === 0 && canStartTextDragOnTouch(e)) {
        return;
      }
    }

    if (state.activeTool === 'lasso' && e.pointerType === 'touch' &&
        viewport.activePointers.size === 0 && canStartLassoDragOnTouch(e)) {
      return;
    }

    const now = performance.now();
    const touchEval = _palmTracker.evaluateTouchDown(e, {
      now,
      palmRejection: state.palmRejection,
      isDrawing: state.isDrawing
    });
    if (!touchEval.allow) {
      return;
    }

    _cancelMomentum();
    _resetVelocitySamples();
    _scrollAxisLocked = false;
    _scrollDecisionMade = false;

    const hadPointers = viewport.activePointers.size > 0;
    viewport.activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      pointerType: e.pointerType,
      width: e.width || 0,
      height: e.height || 0
    });

    if (!hadPointers) {
      _gestureStartTime = now;
      _gestureOriginTransform = { x: viewport.x, y: viewport.y, scale: viewport.scale };
    }

    const count = viewport.activePointers.size;

    if (count >= 3) {
      _palmTracker.blockGesturesUntil(now + GESTURE_BLOCK_COOLDOWN_MS);
      _cancelCurrentGesture(true);
      _clearTouchPointers(viewportEl);
      return;
    }

    if (count === 1) {
      if (state.fingerWriting) {
        return;
      }

      viewport.isPanning = true;
      _panCommitted = false;
      _pinchCommitted = false;
      viewport.panStart = { x: e.clientX, y: e.clientY };
      viewport.panStartTransform = { x: viewport.x, y: viewport.y };
      _panStartTime = now;
      _pushVelocitySample(e.clientX, e.clientY);

      const c0 = clampViewport(viewport.x, viewport.y);
      _startedAtBottom = !!(c0.bounds &&
        Math.abs(viewport.y - c0.bounds.minY) < 2);

      try { viewportEl.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    if (count === 2) {
      if (!_readTwoPointers()) return;
      const initDist = Math.hypot(_tmpP1.x - _tmpP0.x, _tmpP1.y - _tmpP0.y);

      if (initDist < PINCH_MIN_INITIAL_DIST || initDist > PINCH_MAX_INITIAL_DIST) {
        viewport.activePointers.delete(e.pointerId);
        try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}
        return;
      }

      viewport.isPanning = false;
      _panCommitted = false;
      viewport.isPinching = true;
      _pinchCommitted = false;
      _startedAtBottom = false;
      abortCurrentDrawing();

      viewport.pinchStartDist = initDist;
      viewport.pinchStartCenter = {
        x: (_tmpP0.x + _tmpP1.x) / 2,
        y: (_tmpP0.y + _tmpP1.y) / 2
      };
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
    const now = performance.now();
    if (_palmTracker.isGestureBlocked(now)) return;

    const ptr = viewport.activePointers.get(e.pointerId);
    if (!ptr) return;

    if (state.palmRejection && !_panCommitted && !_pinchCommitted && isPalmContact(e, _isIOS)) {
      _palmTracker.blockGesturesUntil(now + GESTURE_BLOCK_COOLDOWN_MS);
      _cancelCurrentGesture(false);
      _clearTouchPointers(viewportEl);
      return;
    }

    ptr.x = e.clientX;
    ptr.y = e.clientY;
    ptr.width = e.width || ptr.width;
    ptr.height = e.height || ptr.height;

    if (viewport.isPanning && viewport.activePointers.size === 1) {
      e.preventDefault();

      const dxRaw = e.clientX - viewport.panStart.x;
      const dyRaw = e.clientY - viewport.panStart.y;

      if (!_panCommitted) {
        if (Math.hypot(dxRaw, dyRaw) < PAN_START_THRESHOLD_PX) return;
        _panCommitted = true;
      }

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
      if (!_readTwoPointers()) return;

      const currentDist = Math.hypot(_tmpP1.x - _tmpP0.x, _tmpP1.y - _tmpP0.y);
      _pinchCenter.x = (_tmpP0.x + _tmpP1.x) / 2;
      _pinchCenter.y = (_tmpP0.y + _tmpP1.y) / 2;

      if (!_pinchCommitted) {
        if (!shouldCommitPinch(viewport.pinchStartDist, viewport.pinchStartCenter, currentDist, _pinchCenter)) {
          return;
        }
        _pinchCommitted = true;
        viewport.pinchStartDist = currentDist;
        viewport.pinchStartCenter = { x: _pinchCenter.x, y: _pinchCenter.y };
        viewport.pinchStartTransform = { x: viewport.x, y: viewport.y, scale: viewport.scale };
        return;
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
          _pinchCenter,
          targetScale
        );
      }
    }
  };

  // ----------------------------------------------------------
  // POINTER END (globale su window per ripulire anche puntatori usciti da #viewport)
  // ----------------------------------------------------------
  const onPointerEnd = (e) => {
    if (_isPenEvent(e)) return;
    if (!viewport.activePointers.has(e.pointerId)) return;

    viewport.activePointers.delete(e.pointerId);
    try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}

    if (viewport.activePointers.size === 0) {
      const shouldAddPage = _panCommitted && _startedAtBottom && state.pullOverscrollY >= PULL_THRESHOLD;
      const wasQuickTap = viewport.isPanning && !_panCommitted &&
        (performance.now() - _panStartTime) < 350 && e.type !== 'pointercancel';

      state.pullOverscrollY = 0;
      hidePullIndicator();

      const wasPanning = viewport.isPanning && _panCommitted;
      const wasPinching = viewport.isPinching && _pinchCommitted;
      viewport.isPanning = false;
      viewport.isPinching = false;
      _panCommitted = false;
      _pinchCommitted = false;

      if (shouldAddPage) {
        addNewPage();
        showToast('Nuova pagina aggiunta!', '➕');
        _resetVelocitySamples();
        _scrollAxisLocked = false;
        _scrollDecisionMade = false;
        _startedAtBottom = false;
        return;
      }

      if (wasQuickTap && state.activeTool === 'text' &&
          (e.pointerType === 'touch' || (e.pointerType === 'mouse' && !e.target?.closest?.('.page-wrapper')))) {
        handleTextTapAtClientPoint(e.clientX, e.clientY);
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
      } else if (wasPinching) {
        scheduleResolutionRefresh();
      }

      _resetVelocitySamples();
      _scrollAxisLocked = false;
      _scrollDecisionMade = false;
      _startedAtBottom = false;
      return;
    }

    if (viewport.activePointers.size === 1 && viewport.isPinching) {
      const wasPinchCommitted = _pinchCommitted;
      viewport.isPinching = false;
      _pinchCommitted = false;

      if (!state.fingerWriting) {
        const remaining = viewport.activePointers.values().next().value;
        if (remaining) {
          viewport.isPanning = true;
          _panCommitted = wasPinchCommitted;
          viewport.panStart = { x: remaining.x, y: remaining.y };
          viewport.panStartTransform = { x: viewport.x, y: viewport.y };
          _panStartTime = performance.now();
          _resetVelocitySamples();
          _pushVelocitySample(remaining.x, remaining.y);
        }
      }
      _startedAtBottom = false;
    }
  };

  viewportEl.addEventListener('pointerdown', onPointerDown, { capture: true });
  viewportEl.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  window.addEventListener('pointerup', onPointerEnd, { capture: true });
  window.addEventListener('pointercancel', onPointerEnd, { capture: true });

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
// TOGGLE FINGER WRITING
// ============================================================

export function toggleFingerWriting(enabled) {
  showToast(
    enabled
      ? 'Scrittura con il dito ATTIVA: 1 dito scrive, 2 dita muovono/zoomano'
      : 'Scrittura con il dito DISATTIVA: 1 dito muove, la penna scrive',
    enabled ? '✏️' : '🖐️'
  );
}