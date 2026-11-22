import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPalmRejectionTracker,
  isPalmContact,
  shouldCommitPinch,
  PEN_CONTACT_GRACE_MS,
  PEN_CANCEL_GESTURE_WINDOW_MS
} from './palm-rejection.js';

test('isPalmContact allows tablet finger/thumb sizes and blocks true palm contacts', () => {
  // Normal fingertips and wider tablet thumbs used for scrolling / pull-to-add-page
  assert.equal(isPalmContact({ width: 24, height: 26 }, false), false);
  assert.equal(isPalmContact({ width: 48, height: 52 }, false), false);
  assert.equal(isPalmContact({ width: 32, height: 34 }, true), false);
  assert.equal(isPalmContact({ width: 70, height: 75 }, true), false);
  // Drivers reporting 0 or 1
  assert.equal(isPalmContact({ width: 0, height: 0 }, false), false);
  assert.equal(isPalmContact({ width: 1, height: 1 }, true), false);

  // Genuine large palm contacts (> 60px non-iOS, > 100px iOS)
  assert.equal(isPalmContact({ width: 65, height: 40 }, false), true);
  assert.equal(isPalmContact({ width: 40, height: 68 }, false), true);
  assert.equal(isPalmContact({ width: 105, height: 50 }, true), true);
  assert.equal(isPalmContact({ width: 55, height: 110 }, true), true);
});

test('pen grace blocks inter-stroke knuckle bounces and allows intentional touch right after', () => {
  const tracker = createPalmRejectionTracker({ isIOS: false });

  tracker.onPenDown(1000);
  assert.equal(tracker.evaluateTouchDown({ width: 20, height: 20 }, {
    now: 1050, palmRejection: true, isDrawing: true
  }).allow, false);

  // Lift pen: still blocked within PEN_CONTACT_GRACE_MS (120ms)
  tracker.onPenUp(1100);
  assert.equal(tracker.evaluateTouchDown({ width: 20, height: 20 }, {
    now: 1100 + PEN_CONTACT_GRACE_MS - 30, palmRejection: true, isDrawing: false
  }).allow, false);

  // After grace expires: intentional finger scroll is immediately allowed
  assert.equal(tracker.evaluateTouchDown({ width: 48, height: 48 }, {
    now: 1100 + PEN_CONTACT_GRACE_MS + 10, palmRejection: true, isDrawing: false
  }).allow, true);
});

test('palm contact on touch down triggers short cooldown without cancelling active scroll', () => {
  const tracker = createPalmRejectionTracker({ isIOS: false });

  const res = tracker.evaluateTouchDown({ width: 72, height: 64 }, {
    now: 2000, palmRejection: true, isDrawing: false
  });
  assert.equal(res.allow, false);
  assert.equal(res.reason, 'palm-contact');
  assert.equal(Boolean(res.cancelExisting), false);

  // Secondary knuckle edge arriving 100ms later is blocked by cooldown
  const res2 = tracker.evaluateTouchDown({ width: 22, height: 22 }, {
    now: 2100, palmRejection: true, isDrawing: false
  });
  assert.equal(res2.allow, false);
  assert.equal(res2.reason, 'cooldown');
});

test('shouldCommitPinch ignores minor knuckle jitter and commits intentional pinch/pan', () => {
  assert.equal(
    shouldCommitPinch(120, { x: 400, y: 500 }, 126, { x: 404, y: 503 }),
    false
  );
  assert.equal(
    shouldCommitPinch(120, { x: 400, y: 500 }, 136, { x: 400, y: 500 }),
    true
  );
  assert.equal(
    shouldCommitPinch(120, { x: 400, y: 500 }, 121, { x: 417, y: 500 }),
    true
  );
});

test('shouldRollbackGestureOnPenArrival rolls back BOTH accidental pinch and pan on pen arrival', () => {
  const tracker = createPalmRejectionTracker({ isIOS: false });
  const origin = { x: 100, y: 200, scale: 1.0 };

  // Accidental pinch triggered by pinky knuckle + palm edge 700ms before pen lands
  assert.equal(tracker.shouldRollbackGestureOnPenArrival({
    isPanning: false,
    isPinching: true,
    panCommitted: false,
    pinchCommitted: true,
    gestureStartTime: 1000,
    now: 1700,
    originTransform: origin,
    currentTransform: { x: 130, y: 240, scale: 1.35 }
  }), true);

  // Uncommitted pan or pinch always rolls back cleanly
  assert.equal(tracker.shouldRollbackGestureOnPenArrival({
    isPanning: false,
    isPinching: true,
    panCommitted: false,
    pinchCommitted: false,
    gestureStartTime: 1000,
    now: 3000,
    originTransform: origin,
    currentTransform: origin
  }), true);

  // Large intentional pinch (>1200ms and >22% zoom) before tapping pen is preserved
  assert.equal(tracker.shouldRollbackGestureOnPenArrival({
    isPanning: false,
    isPinching: true,
    panCommitted: false,
    pinchCommitted: true,
    gestureStartTime: 1000,
    now: 1000 + PEN_CANCEL_GESTURE_WINDOW_MS + 500,
    originTransform: origin,
    currentTransform: { x: 80, y: 150, scale: 1.55 }
  }), false);

  // Large intentional pan (>1200ms and >160px) before writing at new area is preserved
  assert.equal(tracker.shouldRollbackGestureOnPenArrival({
    isPanning: true,
    isPinching: false,
    panCommitted: true,
    pinchCommitted: false,
    gestureStartTime: 1000,
    now: 1000 + PEN_CANCEL_GESTURE_WINDOW_MS + 500,
    originTransform: origin,
    currentTransform: { x: 100, y: 460, scale: 1.0 }
  }), false);
});
