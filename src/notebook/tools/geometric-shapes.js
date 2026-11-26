/**
 * @module features/tools/geometric-shapes
 *
 * Logica geometrica pura (zero DOM / zero state) per il riconoscimento
 * delle forme geometriche chiuse (cerchio, ellisse, rettangolo, triangolo)
 * attivate tramite hold-to-snap (tenendo la penna ferma qualche ms).
 */

import { distSqPointToSegment } from './arrow-recognition.js';
import { trimStationaryTail } from './ink-calibration.js';

/**
 * Campiona punti collineari lungo i lati di un poligono chiuso con piccoli
 * punti di guardia vicino ai vertici, così l'interpolazione Catmull-Rom
 * mantiene lati dritti e angoli netti.
 */
export function buildPolygonStrokePoints(vertices, step = 8) {
  const out = [];
  const count = vertices.length;
  for (let i = 0; i < count; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % count];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    out.push({ x: a.x, y: a.y, pressure: 0.5 });
    if (len > 6) {
      const guardT = Math.min(0.15, 2 / len);
      const midSteps = Math.max(1, Math.floor((len - 4) / step));
      out.push({ x: a.x + dx * guardT, y: a.y + dy * guardT, pressure: 0.5 });
      for (let k = 1; k < midSteps; k++) {
        const t = guardT + (1 - 2 * guardT) * (k / midSteps);
        out.push({ x: a.x + dx * t, y: a.y + dy * t, pressure: 0.5 });
      }
      out.push({ x: a.x + dx * (1 - guardT), y: a.y + dy * (1 - guardT), pressure: 0.5 });
    }
  }
  out.push({ x: vertices[0].x, y: vertices[0].y, pressure: 0.5 });
  return out;
}

export function detectTriangleVertices(pts, pathLen, bboxDiag) {
  const n = pts.length;
  if (n < 9) return null;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += pts[i].x;
    sumY += pts[i].y;
  }
  const cx = sumX / n;
  const cy = sumY / n;

  let idxA = 0, maxD = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i].x - cx) ** 2 + (pts[i].y - cy) ** 2;
    if (d > maxD) { maxD = d; idxA = i; }
  }

  let idxB = 0;
  maxD = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i].x - pts[idxA].x) ** 2 + (pts[i].y - pts[idxA].y) ** 2;
    if (d > maxD) { maxD = d; idxB = i; }
  }

  const doubleArea = (p1, p2, p3) =>
    Math.abs((p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x));

  let idxC = 0;
  let bestArea = -1;
  for (let i = 0; i < n; i++) {
    const a = doubleArea(pts[idxA], pts[idxB], pts[i]);
    if (a > bestArea) { bestArea = a; idxC = i; }
  }

  for (let pass = 0; pass < 2; pass++) {
    let best = doubleArea(pts[idxA], pts[idxB], pts[idxC]);
    for (let i = 0; i < n; i++) {
      const a = doubleArea(pts[i], pts[idxB], pts[idxC]);
      if (a > best) { best = a; idxA = i; }
    }
    best = doubleArea(pts[idxA], pts[idxB], pts[idxC]);
    for (let i = 0; i < n; i++) {
      const a = doubleArea(pts[idxA], pts[i], pts[idxC]);
      if (a > best) { best = a; idxB = i; }
    }
    best = doubleArea(pts[idxA], pts[idxB], pts[idxC]);
    for (let i = 0; i < n; i++) {
      const a = doubleArea(pts[idxA], pts[idxB], pts[i]);
      if (a > best) { best = a; idxC = i; }
    }
  }

  const orderedIdx = [idxA, idxB, idxC].sort((i, j) => i - j);
  const v0 = pts[orderedIdx[0]];
  const v1 = pts[orderedIdx[1]];
  const v2 = pts[orderedIdx[2]];

  const s01 = Math.hypot(v1.x - v0.x, v1.y - v0.y);
  const s12 = Math.hypot(v2.x - v1.x, v2.y - v1.y);
  const s20 = Math.hypot(v0.x - v2.x, v0.y - v2.y);
  const minSide = Math.min(s01, s12, s20);
  const maxSide = Math.max(s01, s12, s20);
  if (minSide < Math.max(26, bboxDiag * 0.24)) return null;

  const triArea2 = doubleArea(v0, v1, v2);
  const minAltitude = triArea2 / Math.max(maxSide, 1);
  if (minAltitude < Math.max(22, bboxDiag * 0.18)) return null;

  const triPerim = s01 + s12 + s20;
  const triPathRatio = pathLen / Math.max(triPerim, 1);
  if (triPathRatio <= 0.84 || triPathRatio >= 1.24) return null;

  let sumDistSq = 0;
  let maxDistSq = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const d0 = distSqPointToSegment(p.x, p.y, v0.x, v0.y, v1.x, v1.y);
    const d1 = distSqPointToSegment(p.x, p.y, v1.x, v1.y, v2.x, v2.y);
    const d2 = distSqPointToSegment(p.x, p.y, v2.x, v2.y, v0.x, v0.y);
    const minSq = Math.min(d0, d1, d2);
    sumDistSq += minSq;
    if (minSq > maxDistSq) maxDistSq = minSq;
  }

  const rmsDist = Math.sqrt(sumDistSq / n);
  const maxDist = Math.sqrt(maxDistSq);
  if (rmsDist > Math.max(8, bboxDiag * 0.055)) return null;
  if (maxDist > Math.max(18, bboxDiag * 0.14)) return null;

  return [
    { x: v0.x, y: v0.y },
    { x: v1.x, y: v1.y },
    { x: v2.x, y: v2.y }
  ];
}

/**
 * Riconosce cerchio, ellisse, rettangolo o triangolo da uno stroke chiuso
 * (usato durante l'hold-to-snap con la penna ferma).
 */
export function detectGeometricShape(rawPoints, {
  allowCircle = true,
  allowRect = true,
  allowTriangle = true
} = {}) {
  if (!allowCircle && !allowRect && !allowTriangle) return null;
  if (!Array.isArray(rawPoints) || rawPoints.length < 8) return null;

  const pts = trimStationaryTail(rawPoints, 6.0);
  if (pts.length < 8) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, pathLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
  }

  const w = maxX - minX;
  const h = maxY - minY;
  const bboxDiag = Math.hypot(w, h);
  if (bboxDiag < 72 || w < 26 || h < 26) return null;

  const startPt = pts[0];
  const endPt = pts[pts.length - 1];
  const closureDist = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (closureDist / Math.max(pathLen, 1) > 0.18) return null;

  const cx = minX + w / 2;
  const cy = minY + h / 2;
  const aspect = w / h;
  const isSquareLike = aspect >= 0.78 && aspect <= 1.28;

  // 1. Cerchio
  let avgRadius = 0;
  let radiusStdDev = Infinity;
  let isCircle = false;
  if (allowCircle && isSquareLike) {
    let radiusSum = 0;
    for (const p of pts) radiusSum += Math.hypot(p.x - cx, p.y - cy);
    avgRadius = radiusSum / pts.length;
    let radiusVariance = 0;
    for (const p of pts) radiusVariance += (Math.hypot(p.x - cx, p.y - cy) - avgRadius) ** 2;
    radiusStdDev = Math.sqrt(radiusVariance / pts.length);
    isCircle = avgRadius > 0 && (radiusStdDev / avgRadius) < 0.17;
  }

  // 2. Rettangolo
  let isRect = false;
  if (allowRect) {
    const idealRectPerimeter = 2 * (w + h);
    const rectPathRatio = pathLen / Math.max(idealRectPerimeter, 1);
    const cornerTouchRadius = Math.min(Math.max(16, Math.min(w, h) * 0.42), Math.min(w, h) * 0.46);
    const corners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];
    const cornersTouched = corners.every(c =>
      pts.some(p => Math.hypot(p.x - c.x, p.y - c.y) < cornerTouchRadius)
    );
    isRect = cornersTouched && rectPathRatio > 0.85 && rectPathRatio < 1.2;
  }

  if (isCircle && (!isRect || radiusStdDev / avgRadius < 0.08)) {
    const circlePts = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      circlePts.push({
        x: cx + Math.cos(a) * avgRadius,
        y: cy + Math.sin(a) * avgRadius,
        pressure: 0.5
      });
    }
    return {
      kind: 'circle',
      label: 'Forma: Cerchio',
      icon: '⭕',
      center: { x: cx, y: cy },
      points: circlePts
    };
  }

  if (isRect) {
    return {
      kind: 'rectangle',
      label: 'Forma: Rettangolo',
      icon: '⬛',
      center: { x: cx, y: cy },
      points: buildPolygonStrokePoints([
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY }
      ])
    };
  }

  // 3. Ellisse (se forma ovale ben aderente)
  if (allowCircle && aspect >= 0.34 && aspect <= 2.95) {
    const rx = w * 0.5;
    const ry = h * 0.5;
    let errSqSum = 0;
    for (const p of pts) {
      const rNorm = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      errSqSum += (rNorm - 1) ** 2;
    }
    const rmsEll = Math.sqrt(errSqSum / pts.length);
    const ellipsePerim = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
    const ellRatio = pathLen / Math.max(ellipsePerim, 1);
    if (rmsEll < 0.135 && ellRatio > 0.82 && ellRatio < 1.22) {
      const ellPts = [];
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        ellPts.push({
          x: cx + Math.cos(a) * rx,
          y: cy + Math.sin(a) * ry,
          pressure: 0.5
        });
      }
      return {
        kind: 'ellipse',
        label: 'Forma: Ellisse',
        icon: '⭕',
        center: { x: cx, y: cy },
        points: ellPts
      };
    }
  }

  // 4. Triangolo
  if (allowTriangle) {
    const triVerts = detectTriangleVertices(pts, pathLen, bboxDiag);
    if (triVerts) {
      return {
        kind: 'triangle',
        label: 'Forma: Triangolo',
        icon: '🔺',
        center: { x: cx, y: cy },
        points: buildPolygonStrokePoints(triVerts)
      };
    }
  }

  return null;
}

/**
 * Scala uniformemente i punti di una forma geometrica agganciata rispetto al suo centro.
 */
export function scaleShapePointsFromCenter(basePoints, center, scaleFactor) {
  if (!Array.isArray(basePoints) || !center) return basePoints;
  const s = Math.max(0.25, Math.min(4.0, Number.isFinite(scaleFactor) ? scaleFactor : 1.0));
  return basePoints.map(p => ({
    x: center.x + (p.x - center.x) * s,
    y: center.y + (p.y - center.y) * s,
    pressure: p.pressure != null ? p.pressure : 0.5
  }));
}
