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
  applyTransform, applyPinchTransform,
  clampViewport, invalidateClampCache
} from './transform.js';

// Rilevamento iPadOS / iOS WebKit (iPadOS 13+ si dichiara MacIntel + maxTouchPoints > 1)
const _isIOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// ============================================================
// COSTANTI — PALM REJECTION
// ============================================================

/**
 * Dimensione massima (px CSS) di un tocco valido come "dito".
 * Su iPadOS WebKit `e.width`/`e.height` = 2 * majorRadius, quindi un dito
 * appoggiato normalmente supera facilmente 60px; su Surface/Android resta 60.
 */
const PALM_CONTACT_SIZE = _isIOS ? 100 : 60;

/** Grace dopo pointerup/pointercancel penna. */
const PEN_CONTACT_GRACE_MS = 150;

/** Grace dopo pointerleave penna (palmo che appoggia dopo). */
const PEN_LEAVE_GRACE_MS = 500;

/** Safety net per driver che non emettono pointerleave affidabile. */
const PEN_HOVER_TIMEOUT_MS = 800;

/** Finestra (ms) entro cui un pan breve viene annullato se arriva la penna. */
const PEN_CANCEL_PAN_WINDOW_MS = 400;

// ============================================================
// COSTANTI — PINCH
// ============================================================

const PINCH_SECOND_TOUCH_MAX_MS_NEAR = 350;
const PINCH_SECOND_TOUCH_MAX_MS_FAR  = _isIOS ? 300 : 200;
const PINCH_NEAR_DIST_THRESHOLD      = 200;

const PINCH_MIN_INITIAL_DIST = 30;
const PINCH_MAX_INITIAL_DIST = _isIOS ? 850 : 600;

const PINCH_CONFIRM_MS = 250;
const PINCH_CONFIRM_MIN_MOVE_PX = 10;
const PINCH_CONFIRM_MIN_DIST_PX = 20;

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

let _penDown = false;
let _penInRange = false;
let _lastPenContactEndTime = 0;
let _lastPenLeaveTime = 0;
let _lastPenEventTime = 0;

let _gestureBlocked = false;

let _panStartTime = 0;
let _firstTouchDownTime = 0;
let _startedAtBottom = false;
let _scrollDecisionMade = false;
let _scrollAxisLocked = false;

let _pinchConfirm = null;

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
    viewport.activePointers.clear();
    _cancelCurrentGesture(false);
  });

  // Safety net globale se la penna viene sollevata fuori da #viewport
  const onGlobalPenEnd = (e) => {
    if (_isPenEvent(e) && _penDown) {
      _penDown = false;
      _lastPenContactEndTime = performance.now();
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

  viewportEl.addEventListener('pointerenter', (e) => {
    if (_isPenEvent(e)) {
      _penInRange = true;
      _lastPenEventTime = performance.now();

      if (viewport.isPanning || viewport.isPinching) {
        const panDuration = performance.now() - _panStartTime;
        const shouldRollback = viewport.isPinching
          ? !(_pinchConfirm && _pinchConfirm.confirmed)
          : panDuration < PEN_CANCEL_PAN_WINDOW_MS;

        for (const [id, ptr] of [...viewport.activePointers]) {
          if (ptr.pointerType !== 'pen' && ptr.pointerType !== 'eraser') {
            viewport.activePointers.delete(id);
            try { viewportEl.releasePointerCapture(id); } catch (err) {}
          }
        }
        _cancelCurrentGesture(shouldRollback);
      }
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
    if (_isPenEvent(e)) {
      _cancelMomentum();
      _resetVelocitySamples();
      _scrollAxisLocked = false;
      _scrollDecisionMade = false;
      _startedAtBottom = false;

      const hadTouchGesture = viewport.isPanning || viewport.isPinching;
      for (const [id, ptr] of [...viewport.activePointers]) {
        if (ptr.pointerType !== 'pen' && ptr.pointerType !== 'eraser') {
          viewport.activePointers.delete(id);
          try { viewportEl.releasePointerCapture(id); } catch (err) {}
        }
      }
      if (hadTouchGesture) {
        const panDuration = performance.now() - _panStartTime;
        const shouldRollback = viewport.isPinching
          ? !(_pinchConfirm && _pinchConfirm.confirmed)
          : panDuration < PEN_CANCEL_PAN_WINDOW_MS;
        _cancelCurrentGesture(shouldRollback);
      }
      _gestureBlocked = false;
      return;
    }

    _cancelMomentum();

    if (state.palmRejection) {
      if (_isPenBlockingTouches()) return;
      if (_isPalmContact(e)) return;
    }

    if (_gestureBlocked) return;

    _resetVelocitySamples();
    _scrollAxisLocked = false;
    _scrollDecisionMade = false;

    viewport.activePointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY, pointerType: e.pointerType
    });

    const count = viewport.activePointers.size;

    if (count >= 3) {
      _gestureBlocked = true;
      _cancelCurrentGesture(true);
      return;
    }

    if (count === 1) {
      _firstTouchDownTime = performance.now();

      if (state.fingerWriting) {
        return;
      }

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

    if (count === 2) {
      const now = performance.now();
      const timeSinceFirst = now - _firstTouchDownTime;

      const pts = Array.from(viewport.activePointers.values());
      const p0 = pts[0], p1 = pts[1];
      const initDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);

      if (state.palmRejection && _isPalmContact(e)) {
        viewport.activePointers.delete(e.pointerId);
        try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}
        return;
      }

      const isNearPinch = initDist < PINCH_NEAR_DIST_THRESHOLD;
      const maxTime = isNearPinch
        ? PINCH_SECOND_TOUCH_MAX_MS_NEAR
        : PINCH_SECOND_TOUCH_MAX_MS_FAR;
      if (timeSinceFirst > maxTime) {
        viewport.activePointers.delete(e.pointerId);
        try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}
        return;
      }

      if (initDist < PINCH_MIN_INITIAL_DIST || initDist > PINCH_MAX_INITIAL_DIST) {
        viewport.activePointers.delete(e.pointerId);
        try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) {}
        return;
      }

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
        secondTouchId: e.pointerId,
        startTransform: { x: viewport.x, y: viewport.y, scale: viewport.scale },
        startP0: { x: p0.x, y: p0.y },
        startP1: { x: p1.x, y: p1.y },
        startDist: initDist
      };

      viewport.pinchStartDist = initDist;
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
      const p0 = pts[0];
      const p1 = pts[1];
      const currentDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const newCenter = {
        x: (p0.x + p1.x) / 2,
        y: (p0.y + p1.y) / 2
      };

      if (_pinchConfirm && !_pinchConfirm.confirmed) {
        const now = performance.now();
        const moveP0 = Math.hypot(p0.x - _pinchConfirm.startP0.x, p0.y - _pinchConfirm.startP0.y);
        const moveP1 = Math.hypot(p1.x - _pinchConfirm.startP1.x, p1.y - _pinchConfirm.startP1.y);
        const bothMoved = (moveP0 >= PINCH_CONFIRM_MIN_MOVE_PX &&
                           moveP1 >= PINCH_CONFIRM_MIN_MOVE_PX);
        const distChanged = Math.abs(currentDist - _pinchConfirm.startDist) >= PINCH_CONFIRM_MIN_DIST_PX;
        const timeExpired = now >= _pinchConfirm.deadline;

        if (bothMoved || distChanged) {
          _pinchConfirm.confirmed = true;
        } else if (timeExpired) {
          viewport.x = _pinchConfirm.startTransform.x;
          viewport.y = _pinchConfirm.startTransform.y;
          viewport.scale = _pinchConfirm.startTransform.scale;
          applyTransform(false);

          const secondId = _pinchConfirm.secondTouchId;
          viewport.activePointers.delete(secondId);
          try { viewportEl.releasePointerCapture(secondId); } catch (err) {}

          _pinchConfirm = null;
          viewport.isPinching = false;
          _firstTouchDownTime = performance.now();

          if (!state.fingerWriting) {
            const entries = Array.from(viewport.activePointers.entries());
            if (entries.length >= 1) {
              const [, firstPt] = entries[0];
              viewport.isPanning = true;
              viewport.panStart = { x: firstPt.x, y: firstPt.y };
              viewport.panStartTransform = { x: viewport.x, y: viewport.y };
              _panStartTime = performance.now();
              _resetVelocitySamples();
              _pushVelocitySample(firstPt.x, firstPt.y);
            }
          }
          return;
        } else {
          return;
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

    if (viewport.activePointers.size === 0) {
      _gestureBlocked = false;
      _firstTouchDownTime = 0;

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

    if (viewport.activePointers.size === 1) {
      if (_pinchConfirm && !_pinchConfirm.confirmed) {
        viewport.x = _pinchConfirm.startTransform.x;
        viewport.y = _pinchConfirm.startTransform.y;
        viewport.scale = _pinchConfirm.startTransform.scale;
        applyTransform(false);
        _pinchConfirm = null;
        viewport.isPinching = false;
        _firstTouchDownTime = performance.now();

        if (!state.fingerWriting) {
          const entries = Array.from(viewport.activePointers.entries());
          const [, remaining] = entries[0];
          viewport.isPanning = true;
          viewport.panStart = { x: remaining.x, y: remaining.y };
          viewport.panStartTransform = { x: viewport.x, y: viewport.y };
          _panStartTime = performance.now();
          _resetVelocitySamples();
          _pushVelocitySample(remaining.x, remaining.y);
        }
        _startedAtBottom = false;
        return;
      }

      if (viewport.isPinching) {
        _pinchConfirm = null;
        viewport.isPinching = false;
        _firstTouchDownTime = performance.now();

        if (!state.fingerWriting) {
          const entries = Array.from(viewport.activePointers.entries());
          const [, remaining] = entries[0];
          viewport.isPanning = true;
          viewport.panStart = { x: remaining.x, y: remaining.y };
          viewport.panStartTransform = { x: viewport.x, y: viewport.y };
          _panStartTime = performance.now();
          _resetVelocitySamples();
          _pushVelocitySample(remaining.x, remaining.y);
        }
        _startedAtBottom = false;
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