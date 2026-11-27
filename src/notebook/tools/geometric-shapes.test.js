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

  it('recognizes rotated rectangles, jittery triangles with Apple Pencil smudges, and tilted ellipses on iOS while blocking open curves', () => {
    // 1. Rettangolo inclinato ~28° con overshoot finale e micro-sbavature iniziali/finali
    const angle = 28 * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rot = (x, y) => ({ x: 300 + x * cos - y * sin, y: 300 + x * sin + y * cos });
    const rawRect = [
      rot(-70, -45), rot(70, -45), rot(70, 45), rot(-70, 45), rot(-70, -45)
    ];
    const iosRect = [{ x: rawRect[0].x - 7, y: rawRect[0].y + 8, pressure: 0.03 }];
    for (let e = 0; e < 4; e++) {
      const a = rawRect[e], b = rawRect[e + 1];
      for (let s = 0; s < 14; s++) {
        const t = s / 14;
        const j = Math.sin(s * 1.3) * 1.1;
        iosRect.push({ x: a.x + (b.x - a.x) * t + j, y: a.y + (b.y - a.y) * t - j * 0.7, pressure: 0.24 });
      }
    }
    iosRect.push(rot(-55, -45)); // leggero overshoot oltre il vertice iniziale
    iosRect.push({ x: rawRect[0].x + 20, y: rawRect[0].y + 6, pressure: 0.02 });
    const rectRes = detectGeometricShape(iosRect, { platform: 'ios' });
    assert.ok(rectRes, 'rotated iPad rectangle with smudges should be recognized');
    assert.equal(rectRes.kind, 'rectangle');

    // 2. Triangolo con jitter 240Hz, pausa ad angolo e codine di appoggio/sollevamento
    const tVerts = [{ x: 250, y: 120 }, { x: 360, y: 290 }, { x: 130, y: 270 }, { x: 250, y: 120 }];
    const iosTri = [{ x: 244, y: 112, pressure: 0.04 }];
    for (let e = 0; e < 3; e++) {
      const a = tVerts[e], b = tVerts[e + 1];
      for (let s = 0; s < 18; s++) {
        const t = s / 18;
        iosTri.push({
          x: a.x + (b.x - a.x) * t + (s % 2 === 0 ? 1.2 : -1.2),
          y: a.y + (b.y - a.y) * t + (s % 3 === 0 ? -1.1 : 1.1),
          pressure: 0.25
        });
      }
      // mini cluster al vertice
      iosTri.push({ x: b.x + 1.5, y: b.y - 1.5, pressure: 0.2 });
    }
    // codina di sollevamento / hold cluster
    iosTri.push({ x: 252, y: 122, pressure: 0.1 }, { x: 257, y: 114, pressure: 0.02 });
    const triRes = detectGeometricShape(iosTri, { platform: 'ios' });
    assert.ok(triRes, 'iPad triangle with landing/liftoff smudges should be recognized');
    assert.equal(triRes.kind, 'triangle');

    // 3. Ellisse ruotata 25° su iPadOS
    const ellAngle = 25 * Math.PI / 180;
    const ec = Math.cos(ellAngle), es = Math.sin(ellAngle);
    const iosEll = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const lx = Math.cos(a) * 110;
      const ly = Math.sin(a) * 52;
      iosEll.push({ x: 320 + lx * ec - ly * es, y: 320 + lx * es + ly * ec, pressure: 0.3 });
    }
    const ellRes = detectGeometricShape(iosEll, { platform: 'ios' });
    assert.ok(ellRes, 'tilted iPad ellipse should be recognized');
    assert.equal(ellRes.kind, 'ellipse');

    // 4. Lettera aperta "C" NON deve essere classificata come forma geometrica
    const openC = [];
    for (let i = 0; i <= 24; i++) {
      const a = -Math.PI * 0.4 + (i / 24) * Math.PI * 1.15;
      openC.push({ x: 200 - Math.cos(a) * 60, y: 200 + Math.sin(a) * 60, pressure: 0.3 });
    }
    assert.equal(detectGeometricShape(openC, { platform: 'ios' }), null);
  });
});
