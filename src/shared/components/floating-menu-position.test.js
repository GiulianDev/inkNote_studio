import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFloatingMenuPosition,
  computeAnchoredPosition,
  clampBoxToViewportRect,
  getVisualViewportRect
} from './floating-menu-position.js';

test('align="end" aligns menu right edge with trigger right edge below trigger', () => {
  const pos = computeFloatingMenuPosition({
    triggerRect: { left: 1000, right: 1040, top: 12, bottom: 52, width: 40 },
    menuWidth: 256,
    menuHeight: 300,
    viewportWidth: 1440,
    viewportHeight: 900,
    align: 'end',
    gap: 8,
    margin: 8
  });

  assert.deepEqual(pos, { left: 784, top: 60 });
});

test('align="start" and align="center" align left and centered respectively', () => {
  const start = computeFloatingMenuPosition({
    triggerRect: { left: 200, right: 240, top: 10, bottom: 40, width: 40 },
    menuWidth: 200,
    menuHeight: 150,
    viewportWidth: 1200,
    viewportHeight: 800,
    align: 'start',
    gap: 6,
    margin: 8
  });
  assert.deepEqual(start, { left: 200, top: 46 });

  const center = computeFloatingMenuPosition({
    triggerRect: { left: 200, right: 240, top: 10, bottom: 40, width: 40 },
    menuWidth: 200,
    menuHeight: 150,
    viewportWidth: 1200,
    viewportHeight: 800,
    align: 'center',
    gap: 6,
    margin: 8
  });
  assert.deepEqual(center, { left: 120, top: 46 });
});

test('clamps horizontally inside viewport margins on narrow screens', () => {
  const nearLeft = computeFloatingMenuPosition({
    triggerRect: { left: 4, right: 44, top: 10, bottom: 46 },
    menuWidth: 256,
    menuHeight: 200,
    viewportWidth: 390,
    viewportHeight: 844,
    align: 'end',
    gap: 8,
    margin: 8
  });
  assert.equal(nearLeft.left, 8);

  const nearRight = computeFloatingMenuPosition({
    triggerRect: { left: 360, right: 400, top: 10, bottom: 46 },
    menuWidth: 256,
    menuHeight: 200,
    viewportWidth: 390,
    viewportHeight: 844,
    align: 'start',
    gap: 8,
    margin: 8
  });
  assert.equal(nearRight.left, 126);
});

test('flips above trigger when overflowing bottom edge and enough space above', () => {
  const pos = computeFloatingMenuPosition({
    triggerRect: { left: 800, right: 840, top: 760, bottom: 800 },
    menuWidth: 256,
    menuHeight: 240,
    viewportWidth: 1440,
    viewportHeight: 900,
    align: 'end',
    gap: 8,
    margin: 8
  });

  assert.deepEqual(pos, { left: 584, top: 512 });
});

test('clamps vertically inside viewport when neither below nor above fits without clipping', () => {
  const pos = computeFloatingMenuPosition({
    triggerRect: { left: 100, right: 140, top: 120, bottom: 160 },
    menuWidth: 240,
    menuHeight: 400,
    viewportWidth: 390,
    viewportHeight: 480,
    align: 'start',
    gap: 8,
    margin: 8
  });

  assert.deepEqual(pos, { left: 100, top: 72 });
});

test('getVisualViewportRect prefers visualViewport dimensions/offsets and falls back cleanly', () => {
  const withVV = getVisualViewportRect({
    innerWidth: 1024,
    innerHeight: 768,
    visualViewport: { offsetLeft: 40, offsetTop: 20, width: 900, height: 380 }
  });
  assert.deepEqual(withVV, { left: 40, top: 20, width: 900, height: 380, right: 940, bottom: 400 });

  const fallback = getVisualViewportRect({
    innerWidth: 1280,
    innerHeight: 800,
    visualViewport: null
  });
  assert.deepEqual(fallback, { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 });
});

test('clampBoxToViewportRect keeps draggable dock inside shrunk visualViewport (iPad keyboard)', () => {
  const clamped = clampBoxToViewportRect({
    x: 920,
    y: 620,
    width: 112,
    height: 56,
    viewportRect: { left: 0, top: 0, width: 1024, height: 390 },
    margin: 8
  });
  assert.deepEqual(clamped, { x: 904, y: 326 });

  const shiftedZoom = clampBoxToViewportRect({
    x: 10,
    y: 12,
    width: 112,
    height: 56,
    viewportRect: { left: 80, top: 100, width: 500, height: 300 },
    margin: 8
  });
  assert.deepEqual(shiftedZoom, { x: 88, y: 108 });
});

test('computeAnchoredPosition with preferAbove flips below top obstruction and clamps inside visualViewport', () => {
  // Vicino alla toolbar superiore: non entra sopra minTop=128, quindi ribalta sotto
  const flipped = computeAnchoredPosition({
    triggerRect: { left: 240, right: 440, top: 135, bottom: 175, width: 200 },
    menuWidth: 180,
    menuHeight: 38,
    viewportRect: { left: 0, top: 0, width: 1024, height: 768 },
    align: 'center',
    preferAbove: true,
    gap: 10,
    bottomGap: 14,
    margin: 12,
    minTop: 128
  });
  assert.deepEqual(flipped, { left: 250, top: 189, placement: 'bottom' });

  // Sotto la tastiera aperta: viene clampato sopra al bordo inferiore visibile
  const clampedAboveKeyboard = computeAnchoredPosition({
    triggerRect: { left: 30, right: 230, top: 420, bottom: 460, width: 200 },
    menuWidth: 180,
    menuHeight: 38,
    viewportRect: { left: 50, top: 0, width: 700, height: 390 },
    align: 'center',
    preferAbove: true,
    gap: 10,
    bottomGap: 14,
    margin: 12,
    minTop: 120
  });
  assert.deepEqual(clampedAboveKeyboard, { left: 62, top: 340, placement: 'top' });
});

