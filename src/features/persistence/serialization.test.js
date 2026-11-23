import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { packStroke, unpackStroke, packStrokes, unpackStrokes } from './serialization.js';
import { translateStrokeInPlace, invalidateStrokeBBox } from '../render/stroke-geometry.js';

describe('serialization: _packedCache & immutable snapshot safety', () => {
  it('reuses cached packed object for unchanged stroke and invalidates on edits', () => {
    const stroke = {
      tool: 'pen',
      color: '#111827',
      size: 4,
      opacity: 0.9,
      style: 'solid',
      points: [
        { x: 10, y: 20, pressure: 0.5, tiltX: 1, tiltY: -2, speed: 3, pointerType: 'pen' },
        { x: 40, y: 55, pressure: 0.7, tiltX: 0, tiltY: 0, speed: 2, pointerType: 'pen' }
      ]
    };

    const p1 = packStroke(stroke);
    const p2 = packStroke(stroke);
    assert.equal(p1, p2, 'unchanged stroke must return same immutable packed object reference');
    assert.equal(Object.keys(stroke).includes('_packedCache'), false);

    // In-place translation clears _packedCache without mutating p1
    translateStrokeInPlace(stroke, 100, 50);
    const p3 = packStroke(stroke);
    assert.notEqual(p3, p1);
    assert.equal(p1.packed[0], 10);
    assert.equal(p3.packed[0], 110);

    // Style/color/size mutation automatically bypasses stale cache
    stroke.color = '#ef4444';
    const p4 = packStroke(stroke);
    assert.notEqual(p4, p3);
    assert.equal(p4.color, '#ef4444');
    assert.equal(p3.color, '#111827');

    // Appending a point bypasses stale cache by count mismatch
    stroke.points.push({ x: 80, y: 90, pressure: 0.6 });
    const p5 = packStroke(stroke);
    assert.notEqual(p5, p4);
    assert.equal(p5.count, 3);
    assert.equal(p4.count, 2);

    // invalidateStrokeBBox also clears _packedCache
    invalidateStrokeBBox(stroke);
    const p6 = packStroke(stroke);
    assert.notEqual(p6, p5);
    assert.equal(p6.count, 3);
  });

  it('unpackStroke creates independent points array while keeping _packedCache ready', () => {
    const original = {
      tool: 'highlighter',
      color: '#fde047',
      size: 7,
      opacity: 0.4,
      style: 'solid',
      points: [
        { x: 12, y: 34, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
        { x: 56, y: 78, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' }
      ]
    };

    const [packed] = packStrokes([original]);
    const [restoredA] = unpackStrokes([packed]);
    const [restoredB] = unpackStrokes([packed]);

    assert.notEqual(restoredA.points, restoredB.points);
    assert.notEqual(restoredA.points[0], restoredB.points[0]);
    assert.ok(restoredA._packedCache);
    assert.equal(restoredA._packedCache.packed, packed.packed);

    translateStrokeInPlace(restoredA, 30, 40);
    assert.equal(restoredB.points[0].x, 12);
    assert.equal(restoredA.points[0].x, 42);
    assert.equal(packStroke(restoredA).packed[0], 42);
  });

  it('preserves optional inkParams snapshot through packStroke and unpackStroke', () => {
    const customParams = { lightMul: 0.22, heavyMul: 4.1, curve: 1.55, speedWeight: 0.35 };
    const strokeWithInk = {
      tool: 'pen',
      color: '#1e293b',
      size: 5,
      opacity: 1,
      style: 'solid',
      inkParams: customParams,
      points: [
        { x: 10, y: 15, pressure: 0.3, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
        { x: 50, y: 65, pressure: 0.8, tiltX: 0, tiltY: 0, speed: 2, pointerType: 'pen' }
      ]
    };
    const packed = packStroke(strokeWithInk);
    assert.deepEqual(packed.inkParams, customParams);

    const restored = unpackStroke(packed);
    assert.deepEqual(restored.inkParams, customParams);
    assert.notEqual(restored.inkParams, customParams);

    // Mutating settings/object externally does not leak between strokes
    restored.inkParams.heavyMul = 999;
    assert.equal(packed.inkParams.heavyMul, 4.1);
  });
});

