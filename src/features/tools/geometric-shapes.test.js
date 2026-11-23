import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectGeometricShape, scaleShapePointsFromCenter } from './geometric-shapes.js';

describe('geometric-shapes: hold-to-snap detection with iPad tail jitter', () => {
  it('recognizes a circle even with trailing stationary iPad jitter', () => {
    const cx = 300, cy = 400, r = 65;
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, pressure: 0.4 });
    }
    // Trailing jitter at hold point
    pts.push({ x: cx + r - 2, y: cy + 3, pressure: 0.4 });
    pts.push({ x: cx + r + 1.5, y: cy - 2, pressure: 0.4 });
    pts.push({ x: cx + r - 1, y: cy + 1.5, pressure: 0.4 });

    const res = detectGeometricShape(pts);
    assert.ok(res, 'circle should be recognized');
    assert.equal(res.kind, 'circle');
  });

  it('recognizes an oval/ellipse without turning it into a rectangle', () => {
    const cx = 300, cy = 300, rx = 110, ry = 50;
    const pts = [];
    for (let i = 0; i <= 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, pressure: 0.5 });
    }
    const res = detectGeometricShape(pts);
    assert.ok(res, 'ellipse should be recognized');
    assert.equal(res.kind, 'ellipse');
  });

  it('recognizes a rectangle and respects allowRect=false', () => {
    const pts = [];
    const corners = [
      { x: 100, y: 100 },
      { x: 260, y: 100 },
      { x: 260, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 100 }
    ];
    for (let e = 0; e < 4; e++) {
      const a = corners[e], b = corners[e + 1];
      for (let s = 0; s < 8; s++) {
        const t = s / 8;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: 0.5 });
      }
    }
    pts.push({ x: 100, y: 100, pressure: 0.5 });

    const res = detectGeometricShape(pts);
    assert.ok(res);
    assert.equal(res.kind, 'rectangle');

    const disabled = detectGeometricShape(pts, { allowRect: false, allowCircle: true, allowTriangle: true });
    assert.equal(disabled, null);
  });

  it('recognizes a triangle and scales shape around center cleanly', () => {
    const verts = [{ x: 200, y: 100 }, { x: 310, y: 260 }, { x: 110, y: 260 }, { x: 200, y: 100 }];
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = verts[e], b = verts[e + 1];
      for (let s = 0; s < 8; s++) {
        const t = s / 8;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: 0.5 });
      }
    }
    pts.push({ x: 200, y: 100, pressure: 0.5 });

    const res = detectGeometricShape(pts);
    assert.ok(res);
    assert.equal(res.kind, 'triangle');

    const scaled = scaleShapePointsFromCenter(res.points, res.center, 1.5);
    const origDx = Math.abs(res.points[0].x - res.center.x);
    const scaledDx = Math.abs(scaled[0].x - res.center.x);
    assert.ok(Math.abs(scaledDx - origDx * 1.5) < 1e-6);
  });
});
