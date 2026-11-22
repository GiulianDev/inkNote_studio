/**
 * @module features/viewport/palm-rejection
 *
 * Logica pura (zero DOM) per palm rejection e validazione gesture touch
 * (pan 1 dito / pinch 2 dita) in presenza di stilo o palmo/nocca appoggiata.
 */

export const PALM_CONTACT_SIZE_IOS = 100;
export const PALM_CONTACT_SIZE_DEFAULT = 60;

export const PEN_CONTACT_GRACE_MS = 120;
export const PEN_LEAVE_GRACE_MS = 100;
export const PEN_HOVER_TIMEOUT_MS = 250;

export const PAN_START_THRESHOLD_PX = 6;
export const PINCH_MIN_INITIAL_DIST = 30;
export const PINCH_MAX_INITIAL_DIST_IOS = 850;
export const PINCH_MAX_INITIAL_DIST_DEFAULT = 650;
export const PINCH_START_DIST_DELTA_PX = 12;
export const PINCH_START_MOVE_PX = 14;

export const GESTURE_BLOCK_COOLDOWN_MS = 300;
export const PALM_CONTACT_COOLDOWN_MS = 150;

export const PEN_CANCEL_GESTURE_WINDOW_MS = 1000;
export const PEN_CANCEL_MAX_PAN_PX = 150;
export const PEN_CANCEL_MAX_ZOOM_DELTA = 0.22;

export function isPenPointerType(pointerType) {
  return pointerType === 'pen' || pointerType === 'eraser';
}

/**
 * Rileva contatti larghi/piatti tipici di nocca del mignolo o bordo del palmo.
 * Driver che riportano width/height 0 o 1 non vengono bloccati da questo filtro.
 */
export function isPalmContact(contact, isIOS = false) {
  if (!contact) return false;
  const w = Number(contact.width) || 0;
  const h = Number(contact.height) || 0;
  const maxSize = isIOS ? PALM_CONTACT_SIZE_IOS : PALM_CONTACT_SIZE_DEFAULT;
  return w > maxSize || h > maxSize;
}

/**
 * Crea una macchina a stati deterministica per tracciare presenza stilo
 * e stabilire quando bloccare/annullare/ripristinare gesture touch accidentali.
 */
export function createPalmRejectionTracker({ isIOS = false } = {}) {
  let penDown = false;
  let penInRange = false;
  let lastPenContactEndTime = 0;
  let lastPenLeaveTime = 0;
  let lastPenEventTime = 0;
  let gestureBlockedUntil = 0;

  function resetAll() {
    penDown = false;
    penInRange = false;
    lastPenContactEndTime = 0;
    lastPenLeaveTime = 0;
    lastPenEventTime = 0;
    gestureBlockedUntil = 0;
  }

  function onPenEnter(now) {
    penInRange = true;
    lastPenEventTime = now;
  }

  function onPenHoverMove(now) {
    penInRange = true;
    lastPenEventTime = now;
  }

  function onPenLeave(now) {
    penInRange = false;
    lastPenEventTime = 0;
    lastPenLeaveTime = now;
  }

  function onPenDown(now) {
    penDown = true;
    penInRange = true;
    lastPenEventTime = now;
    gestureBlockedUntil = 0;
  }

  function onPenUp(now) {
    penDown = false;
    penInRange = false;
    lastPenContactEndTime = now;
  }

  function onGlobalPenEnd(now) {
    if (penDown || penInRange) {
      penDown = false;
      penInRange = false;
      lastPenContactEndTime = now;
    }
  }

  function blockGesturesUntil(untilMs) {
    if (untilMs > gestureBlockedUntil) {
      gestureBlockedUntil = untilMs;
    }
  }

  function isPenBlockingTouches(now) {
    if (penDown) return true;

    if (lastPenContactEndTime > 0 &&
        (now - lastPenContactEndTime) < PEN_CONTACT_GRACE_MS) {
      return true;
    }

    if (lastPenLeaveTime > 0 &&
        (now - lastPenLeaveTime) < PEN_LEAVE_GRACE_MS) {
      return true;
    }

    if (penInRange) {
      if (lastPenEventTime > 0 &&
          (now - lastPenEventTime) > PEN_HOVER_TIMEOUT_MS) {
        penInRange = false;
        lastPenEventTime = 0;
        return false;
      }
      return true;
    }

    return false;
  }

  function isGestureBlocked(now) {
    return now < gestureBlockedUntil;
  }

  /**
   * Valuta se una gesture touch (pan o pinch) interrotta dall'arrivo dello stilo
   * debba eseguire il rollback alla trasformazione iniziale pre-tocco.
   */
  function shouldRollbackGestureOnPenArrival({
    isPanning,
    isPinching,
    panCommitted,
    pinchCommitted,
    gestureStartTime,
    now,
    originTransform,
    currentTransform
  }) {
    if (!isPanning && !isPinching) return false;
    if (isPanning && !panCommitted && !isPinching) return true;
    if (isPinching && !pinchCommitted) return true;

    const elapsed = Math.max(0, now - (gestureStartTime || 0));
    if (elapsed < PEN_CANCEL_GESTURE_WINDOW_MS) {
      return true;
    }

    if (originTransform && currentTransform) {
      const dx = currentTransform.x - originTransform.x;
      const dy = currentTransform.y - originTransform.y;
      const panDist = Math.hypot(dx, dy);
      const originScale = originTransform.scale || 1;
      const zoomRatio = (currentTransform.scale || originScale) / originScale;
      const zoomDelta = Math.abs(zoomRatio - 1);

      if (isPinching) {
        return zoomDelta < PEN_CANCEL_MAX_ZOOM_DELTA && panDist < PEN_CANCEL_MAX_PAN_PX;
      }
      if (isPanning) {
        return panDist < PEN_CANCEL_MAX_PAN_PX;
      }
    }

    return false;
  }

  function evaluateTouchDown(contact, { now, palmRejection, isDrawing }) {
    if (palmRejection) {
      if (isDrawing || isPenBlockingTouches(now)) {
        return { allow: false, reason: 'pen-active' };
      }
      if (isPalmContact(contact, isIOS)) {
        blockGesturesUntil(now + PALM_CONTACT_COOLDOWN_MS);
        return { allow: false, reason: 'palm-contact' };
      }
    }

    if (isGestureBlocked(now)) {
      return { allow: false, reason: 'cooldown' };
    }

    return { allow: true };
  }

  return {
    resetAll,
    onPenEnter,
    onPenHoverMove,
    onPenLeave,
    onPenDown,
    onPenUp,
    onGlobalPenEnd,
    blockGesturesUntil,
    isPenBlockingTouches,
    isGestureBlocked,
    shouldRollbackGestureOnPenArrival,
    evaluateTouchDown,
    getSnapshot: () => ({
      penDown,
      penInRange,
      lastPenContactEndTime,
      lastPenLeaveTime,
      lastPenEventTime,
      gestureBlockedUntil
    })
  };
}

export function shouldCommitPinch(startDist, startCenter, currentDist, currentCenter) {
  const distDelta = Math.abs(currentDist - startDist);
  const centerMove = Math.hypot(
    currentCenter.x - startCenter.x,
    currentCenter.y - startCenter.y
  );
  return distDelta >= PINCH_START_DIST_DELTA_PX || centerMove >= PINCH_START_MOVE_PX;
}
