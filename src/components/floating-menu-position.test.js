import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFloatingMenuPosition } from './floating-menu-position.js';

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
