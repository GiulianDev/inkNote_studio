import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  setNonEnumerable,
  getRawStrokeBBox,
  getStrokeBBox,
  getStrokeBBoxRect,
  invalidateStrokeBBox,
  invalidateStrokePacked,
  translateStrokeInPlace,
  mergeDirtyBBox,
  clampDirtyRect,
  bboxesOverlap,
  computePolygonBBox,
  isPointInPolygon,
  getSelectionBBoxFromItems,
  computeSegmentSteps
} from './stroke-geometry.js';

describe('stroke-geometry: bbox cache & non-enumerability', () => {
  it('computes and caches non-enumerable _bbox, recomputes when points grow', () => {
    const stroke = {
      tool: 'pen',
      color: '#000000',
      size: 3,
      points: [
        { x: 10, y: 20 },
        { x: 50, y: 40 },
        { x: 30, y: 80 }
      ]
    };

    const b1 = getRawStrokeBBox(stroke);
    assert.deepEqual(b1, { minX: 10, maxX: 50, minY: 20, maxY: 80, len: 3 });
    // Cached object identity reused when length is unchanged
    assert.equal(getRawStrokeBBox(stroke), b1);
    // Non-enumerable: must not pollute Object.keys or JSON serialization
    assert.equal(Object.prototype.hasOwnProperty.call(stroke, '_bbox'), true);
    assert.equal(Object.keys(stroke).includes('_bbox'), false);
    assert.equal(JSON.parse(JSON.stringify(stroke))._bbox, undefined);

    // Growing points automatically invalidates via len mismatch
    stroke.points.push({ x: 120, y: 5 });
    const b2 = getRawStrokeBBox(stroke);
    assert.notEqual(b2, b1);
    assert.deepEqual(b2, { minX: 10, maxX: 120, minY: 5, maxY: 80, len: 4 });
  });

  it('returns padded bbox and unclamped integer rect', () => {
    const stroke = {
      tool: 'pen',
      points: [{ x: 4.2, y: 8.7 }, { x: 20.1, y: 30.3 }]
    };
    const padded = getStrokeBBox(stroke, 10);
    assert.deepEqual(padded, {
      minX: 4.2 - 10,
      maxX: 20.1 + 10,
      minY: 8.7 - 10,
      maxY: 30.3 + 10
    });

    const rect = getStrokeBBoxRect(stroke, 12);
    assert.deepEqual(rect, {
      x: Math.floor(4.2 - 12),
      y: Math.floor(8.7 - 12),
      w: Math.ceil(20.1 + 12) - Math.floor(4.2 - 12),
      h: Math.ceil(30.3 + 12) - Math.floor(8.7 - 12)
    });
  });

  it('handles empty or null strokes safely', () => {
    assert.equal(getRawStrokeBBox(null), null);
    assert.equal(getRawStrokeBBox({ points: [] }), null);
    assert.equal(getStrokeBBox({ points: [] }, 10), null);
    assert.equal(getStrokeBBoxRect({ points: [] }, 10), null);
  });
});

describe('stroke-geometry: translateStrokeInPlace & invalidation', () => {
  it('shifts points, _bbox, _hlPts, and _cacheCanvas.bbox without clearing bitmap ref', () => {
    const fakeCanvas = { tag: 'bitmap' };
    const stroke = {
      tool: 'highlighter',
      points: [{ x: 10, y: 15 }, { x: 40, y: 55 }]
    };
    getRawStrokeBBox(stroke);
    setNonEnumerable(stroke, '_hlPts', [{ x: 11, y: 14 }, { x: 39, y: 56 }]);
    setNonEnumerable(stroke, '_hlPtsLen', 2);
    setNonEnumerable(stroke, '_cacheCanvas', {
      canvas: fakeCanvas,
      bbox: { x: -10, y: -5, w: 80, h: 90 }
    });

    translateStrokeInPlace(stroke, 25, -10);

    assert.deepEqual(stroke.points, [{ x: 35, y: 5 }, { x: 65, y: 45 }]);
    assert.deepEqual(stroke._bbox, { minX: 35, maxX: 65, minY: 5, maxY: 45, len: 2 });
    assert.deepEqual(stroke._hlPts, [{ x: 36, y: 4 }, { x: 64, y: 46 }]);
    assert.equal(stroke._cacheCanvas.canvas, fakeCanvas);
    assert.deepEqual(stroke._cacheCanvas.bbox, { x: 15, y: -15, w: 80, h: 90 });

    invalidateStrokeBBox(stroke);
    assert.equal(stroke._bbox, null);
    assert.equal(stroke._hlPts, null);
    assert.equal(stroke._hlPtsLen, 0);
  });
});

describe('stroke-geometry: broad-phase polygon & selection bbox', () => {
  it('detects bbox overlap and polygon inclusion accurately', () => {
    const square = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 }
    ];
    const polyBox = computePolygonBBox(square);
    assert.deepEqual(polyBox, { minX: 100, maxX: 200, minY: 100, maxY: 200 });

    assert.equal(bboxesOverlap(polyBox, { minX: 210, maxX: 260, minY: 110, maxY: 180 }), false);
    assert.equal(bboxesOverlap(polyBox, { minX: 210, maxX: 260, minY: 110, maxY: 180 }, 12), true);
    assert.equal(bboxesOverlap(polyBox, { minX: 150, maxX: 260, minY: 150, maxY: 260 }), true);

    assert.equal(isPointInPolygon({ x: 150, y: 150 }, square), true);
    assert.equal(isPointInPolygon({ x: 99, y: 150 }, square), false);
  });

  it('combines strokes and textBoxes in getSelectionBBoxFromItems', () => {
    const strokes = [
      { points: [{ x: 20, y: 30 }, { x: 80, y: 90 }] }
    ];
    const textBoxes = [
      { x: 100, y: 10, width: 150, height: 40 }
    ];
    const box = getSelectionBBoxFromItems(strokes, textBoxes, 5);
    assert.deepEqual(box, {
      minX: 15,
      maxX: 255,
      minY: 5,
      maxY: 95,
      width: 240,
      height: 90
    });
    assert.equal(getSelectionBBoxFromItems([], []), null);
  });

  it('computes segment interpolation steps within expected bounds', () => {
    assert.equal(computeSegmentSteps(1, 0), 1);
    assert.equal(computeSegmentSteps(12, 1), 3);
    assert.ok(computeSegmentSteps(6, 0.5) >= 1);
  });

  it('invalidates _packedCache on translateStrokeInPlace, invalidateStrokeBBox, and invalidateStrokePacked', () => {
    const stroke = {
      tool: 'pen',
      color: '#000000',
      size: 3,
      points: [{ x: 10, y: 20 }]
    };
    setNonEnumerable(stroke, '_packedCache', { count: 1 });
    assert.ok(stroke._packedCache);
    assert.equal(Object.keys(stroke).includes('_packedCache'), false);

    translateStrokeInPlace(stroke, 5, -5);
    assert.equal(stroke._packedCache, null);

    setNonEnumerable(stroke, '_packedCache', { count: 1 });
    invalidateStrokeBBox(stroke);
    assert.equal(stroke._packedCache, null);

    setNonEnumerable(stroke, '_packedCache', { count: 1 });
    invalidateStrokePacked(stroke);
    assert.equal(stroke._packedCache, null);
  });

  it('merges and clamps dirtyRect bounds safely', () => {
    let dirty = mergeDirtyBBox(null, 20, 60, 30, 90);
    dirty = mergeDirtyBBox(dirty, -15, 50, 40, 1200);
    assert.deepEqual(dirty, { minX: -15, maxX: 60, minY: 30, maxY: 1200 });

    const clamped = clampDirtyRect(dirty, 794, 1123);
    assert.deepEqual(clamped, { minX: 0, maxX: 60, minY: 30, maxY: 1123 });

    assert.equal(clampDirtyRect({ minX: 800, maxX: 900, minY: 10, maxY: 50 }, 794, 1123), null);
    assert.equal(clampDirtyRect(null, 794, 1123), null);
  });
});
