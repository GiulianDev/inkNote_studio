/**
 * @module features/tools/geometric-shapes
 *
 * Logica geometrica pura (zero DOM / zero state) per il riconoscimento
 * delle forme geometriche chiuse (cerchio, ellisse, rettangolo, triangolo)
 * attivate tramite hold-to-snap (tenendo la penna ferma qualche ms).
 */

import { distSqPointToSegment } from './arrow-recognition.js';
import { trimStationaryTail } from './ink-calibration.js';
import { cleanIosShapePoints } from '../platform/profiles/ios.js';

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

export function resamplePolyline(pts, spacing = 4.5) {
  if (!Array.isArray(pts) || pts.length < 2) return pts ? pts.slice() : [];
  const step = Math.max(1.5, spacing);
  const out = [{ x: pts[0].x, y: pts[0].y, pressure: pts[0].pressure ?? 0.5 }];
  let acc = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    let curr = pts[i];
    let dx = curr.x - prev.x;
    let dy = curr.y - prev.y;
    let d = Math.hypot(dx, dy);
    while (d > 1e-6 && acc + d >= step) {
      const need = step - acc;
      const t = need / d;
      const nx = prev.x + dx * t;
      const ny = prev.y + dy * t;
      out.push({ x: nx, y: ny, pressure: curr.pressure ?? 0.5 });
      prev = { x: nx, y: ny, pressure: curr.pressure ?? 0.5 };
      dx = curr.x - prev.x;
      dy = curr.y - prev.y;
      d = Math.hypot(dx, dy);
      acc = 0;
    }
    acc += d;
    prev = curr;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.75) {
    out.push({ x: last.x, y: last.y, pressure: last.pressure ?? 0.5 });
  }
  return out;
}

export function rdpSimplify(pts, epsilon = 6) {
  if (!Array.isArray(pts) || pts.length < 3) return pts ? pts.slice() : [];
  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const epsSq = epsilon * epsilon;
  const stack = [[0, n - 1]];

  while (stack.length > 0) {
    const [lo, hi] = stack.pop();
    if (hi - lo <= 1) continue;
    const a = pts[lo];
    const b = pts[hi];
    let maxDistSq = -1;
    let bestIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const dSq = distSqPointToSegment(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1 && maxDistSq > epsSq) {
      keep[bestIdx] = 1;
      stack.push([lo, bestIdx], [bestIdx, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  return out;
}

function _evaluateClosedPolygonFit(pts, verts) {
  const k = verts.length;
  const n = pts.length;
  let perim = 0;
  for (let i = 0; i < k; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % k];
    perim += Math.hypot(b.x - a.x, b.y - a.y);
  }
  let sumSq = 0;
  let maxSq = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let best = Infinity;
    for (let j = 0; j < k; j++) {
      const a = verts[j];
      const b = verts[(j + 1) % k];
      const d = distSqPointToSegment(p.x, p.y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
    sumSq += best;
    if (best > maxSq) maxSq = best;
  }
  return {
    perim,
    rmsDist: Math.sqrt(sumSq / Math.max(n, 1)),
    maxDist: Math.sqrt(maxSq)
  };
}

function _extractClosedCorners(uPts, cx, cy, eps, minEdgeLen, minTurnDeg) {
  const n = uPts.length;
  if (n < 6) return [];
  let splitIdx = 0;
  let maxR = -1;
  for (let i = 0; i < n; i++) {
    const r = (uPts[i].x - cx) ** 2 + (uPts[i].y - cy) ** 2;
    if (r > maxR) { maxR = r; splitIdx = i; }
  }
  const loop = [];
  for (let i = 0; i < n; i++) loop.push(uPts[(splitIdx + i) % n]);
  loop.push(uPts[splitIdx]);

  const simp = rdpSimplify(loop, eps);
  if (simp.length >= 2) simp.pop();
  let verts = simp.map(p => ({ x: p.x, y: p.y }));

  // Mergia vertici ravvicinati e rimuovi quasi-collineari
  const minTurnCos = Math.cos(minTurnDeg * Math.PI / 180);
  for (let round = 0; round < 3 && verts.length >= 3; round++) {
    let changed = false;
    for (let i = 0; i < verts.length && verts.length >= 3; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) < minEdgeLen) {
        const nextIdx = (i + 1) % verts.length;
        a.x = (a.x + b.x) * 0.5;
        a.y = (a.y + b.y) * 0.5;
        verts.splice(nextIdx, 1);
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (let i = 0; i < verts.length && verts.length >= 3; i++) {
        const prev = verts[(i - 1 + verts.length) % verts.length];
        const curr = verts[i];
        const next = verts[(i + 1) % verts.length];
        const ux1 = curr.x - prev.x, uy1 = curr.y - prev.y;
        const ux2 = next.x - curr.x, uy2 = next.y - curr.y;
        const l1 = Math.hypot(ux1, uy1), l2 = Math.hypot(ux2, uy2);
        if (l1 > 1e-4 && l2 > 1e-4) {
          const cosTurn = (ux1 * ux2 + uy1 * uy2) / (l1 * l2);
          if (cosTurn > minTurnCos) {
            verts.splice(i, 1);
            changed = true;
            break;
          }
        }
      }
    }
    if (!changed) break;
  }
  return verts;
}

function _fitOrientedRectangle(uPts, verts, bboxDiag) {
  if (!verts || verts.length !== 4) return null;
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % 4];
    sides.push({ dx: b.x - a.x, dy: b.y - a.y, len: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  const minSide = Math.min(sides[0].len, sides[1].len, sides[2].len, sides[3].len);
  if (minSide < Math.max(20, bboxDiag * 0.16)) return null;
  if (Math.min(sides[0].len, sides[2].len) / Math.max(sides[0].len, sides[2].len) < 0.60) return null;
  if (Math.min(sides[1].len, sides[3].len) / Math.max(sides[1].len, sides[3].len) < 0.60) return null;

  for (let i = 0; i < 4; i++) {
    const s0 = sides[(i + 3) % 4];
    const s1 = sides[i];
    const dot = (s0.dx * s1.dx + s0.dy * s1.dy) / (Math.max(1e-4, s0.len * s1.len));
    if (Math.abs(dot) > 0.52) return null; // Angoli devono stare attorno a 90° ± 31°
  }

  // Orienta sull'asse dominante delle due coppie di lati opposti
  const pair0Len = sides[0].len + sides[2].len;
  const pair1Len = sides[1].len + sides[3].len;
  let axX, axY;
  if (pair0Len >= pair1Len) {
    axX = sides[0].dx - sides[2].dx;
    axY = sides[0].dy - sides[2].dy;
  } else {
    axX = sides[1].dx - sides[3].dx;
    axY = sides[1].dy - sides[3].dy;
  }
  const axLen = Math.hypot(axX, axY);
  if (axLen < 1e-4) return null;
  let theta = Math.atan2(axY, axX);
  const nearestRight = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(theta - nearestRight) < (8 * Math.PI / 180)) {
    theta = nearestRight;
  }
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const vx = -uy, vy = ux;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of uPts) {
    const pu = p.x * ux + p.y * uy;
    const pv = p.x * vx + p.y * vy;
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
  }
  const rectVerts = [
    { x: minU * ux + minV * vx, y: minU * uy + minV * vy },
    { x: maxU * ux + minV * vx, y: maxU * uy + minV * vy },
    { x: maxU * ux + maxV * vx, y: maxU * uy + maxV * vy },
    { x: minU * ux + maxV * vx, y: minU * uy + maxV * vy }
  ];
  const fit = _evaluateClosedPolygonFit(uPts, rectVerts);
  return {
    vertices: rectVerts,
    center: { x: (minU + maxU) * 0.5 * ux + (minV + maxV) * 0.5 * vx, y: (minU + maxU) * 0.5 * uy + (minV + maxV) * 0.5 * vy },
    fit
  };
}

function _detectGeometricShapeIos(rawPoints, {
  allowCircle = true,
  allowRect = true,
  allowTriangle = true
} = {}) {
  let pts = cleanIosShapePoints(rawPoints, 10.5);
  if (!Array.isArray(pts) || pts.length < 8) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, pathLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
  }
  const preDiag = Math.hypot(maxX - minX, maxY - minY);
  if (preDiag < 64) return null;

  // Taglia eventuale coda sovrapposta oltre il punto iniziale (molto comune su iPad)
  const rawClosure = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
  if (pts.length >= 14 && rawClosure > Math.max(14, preDiag * 0.09)) {
    const scanStart = Math.floor(pts.length * 0.72);
    let bestK = -1;
    let bestD = rawClosure * 0.65;
    for (let k = scanStart; k < pts.length - 1; k++) {
      const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y);
      if (d < bestD) { bestD = d; bestK = k; }
    }
    if (bestK > 8 && bestD <= Math.max(24, preDiag * 0.16)) {
      pts = pts.slice(0, bestK + 1);
    }
  }

  minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity; pathLen = 0;
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
  if (bboxDiag < 66 || w < 22 || h < 22) return null;

  const startPt = pts[0];
  const endPt = pts[pts.length - 1];
  const closureDist = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (closureDist / Math.max(pathLen, 1) > 0.22) return null;
  if (closureDist > Math.max(44, bboxDiag * 0.28)) return null;

  const spacing = Math.max(3.0, Math.min(7.0, bboxDiag / 64));
  const uPts = resamplePolyline(pts, spacing);
  if (uPts.length < 9) return null;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < uPts.length; i++) {
    sumX += uPts[i].x;
    sumY += uPts[i].y;
  }
  const cx = sumX / uPts.length;
  const cy = sumY / uPts.length;

  // Controlla copertura angolare >= ~283° (blocca lettere aperte tipo C, U, S)
  const angles = new Float64Array(uPts.length);
  for (let i = 0; i < uPts.length; i++) {
    angles[i] = Math.atan2(uPts[i].y - cy, uPts[i].x - cx);
  }
  angles.sort();
  let maxGap = (angles[0] + Math.PI * 2) - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) {
    const g = angles[i] - angles[i - 1];
    if (g > maxGap) maxGap = g;
  }
  if (maxGap > 1.45) return null;

  // 1. Valuta Cerchio
  let circleMatch = null;
  if (allowCircle) {
    let rSum = 0;
    for (let i = 0; i < uPts.length; i++) rSum += Math.hypot(uPts[i].x - cx, uPts[i].y - cy);
    const avgR = rSum / uPts.length;
    let rVar = 0;
    for (let i = 0; i < uPts.length; i++) rVar += (Math.hypot(uPts[i].x - cx, uPts[i].y - cy) - avgR) ** 2;
    const cvR = avgR > 0 ? Math.sqrt(rVar / uPts.length) / avgR : Infinity;
    const perimRatio = pathLen / Math.max(2 * Math.PI * avgR, 1);
    if (avgR >= 14 && cvR < 0.165 && perimRatio > 0.78 && perimRatio < 1.26) {
      circleMatch = { avgR, cvR };
    }
  }

  // Cerchio netto immediato
  if (circleMatch && circleMatch.cvR < 0.095) {
    const circlePts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      circlePts.push({ x: cx + Math.cos(a) * circleMatch.avgR, y: cy + Math.sin(a) * circleMatch.avgR, pressure: 0.5 });
    }
    return { kind: 'circle', label: 'Forma: Cerchio', icon: '⭕', center: { x: cx, y: cy }, points: circlePts };
  }

  // 2. Valuta Rettangolo (anche ruotato/inclinato) via RDP + AABB fallback
  let rectMatch = null;
  if (allowRect) {
    const minEdge = Math.max(18, bboxDiag * 0.14);
    for (const factor of [0.032, 0.045, 0.060, 0.075]) {
      const verts = _extractClosedCorners(uPts, cx, cy, Math.max(4.5, bboxDiag * factor), minEdge, 28);
      if (verts.length === 4) {
        const fitted = _fitOrientedRectangle(uPts, verts, bboxDiag);
        if (fitted) {
          const pathRatio = pathLen / Math.max(fitted.fit.perim, 1);
          if (pathRatio > 0.78 && pathRatio < 1.28 &&
              fitted.fit.rmsDist <= Math.max(10.5, bboxDiag * 0.078) &&
              fitted.fit.maxDist <= Math.max(24, bboxDiag * 0.18)) {
            if (!rectMatch || fitted.fit.rmsDist < rectMatch.fit.rmsDist) {
              rectMatch = fitted;
            }
          }
        }
      }
    }

    if (!rectMatch) {
      const boxVerts = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY }
      ];
      const fit = _evaluateClosedPolygonFit(uPts, boxVerts);
      const rectPathRatio = pathLen / Math.max(2 * (w + h), 1);
      const cornerTouchRadius = Math.min(Math.max(18, Math.min(w, h) * 0.44), Math.min(w, h) * 0.48);
      const cornersTouched = boxVerts.every(c =>
        uPts.some(p => Math.hypot(p.x - c.x, p.y - c.y) < cornerTouchRadius)
      );
      if (cornersTouched && rectPathRatio > 0.80 && rectPathRatio < 1.24 &&
          fit.rmsDist <= Math.max(10, bboxDiag * 0.072)) {
        rectMatch = { vertices: boxVerts, center: { x: minX + w * 0.5, y: minY + h * 0.5 }, fit };
      }
    }
  }

  // 3. Valuta Triangolo (RDP 3 vertici oppure max-area su punti ricampionati)
  let triMatch = null;
  if (allowTriangle) {
    const minEdge = Math.max(20, bboxDiag * 0.17);
    const doubleArea = (p1, p2, p3) =>
      Math.abs((p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x));
    const checkTri = (verts) => {
      if (!verts || verts.length !== 3) return null;
      const [v0, v1, v2] = verts;
      const s01 = Math.hypot(v1.x - v0.x, v1.y - v0.y);
      const s12 = Math.hypot(v2.x - v1.x, v2.y - v1.y);
      const s20 = Math.hypot(v0.x - v2.x, v0.y - v2.y);
      const minSide = Math.min(s01, s12, s20);
      const maxSide = Math.max(s01, s12, s20);
      if (minSide < Math.max(22, bboxDiag * 0.20)) return null;
      const alt = doubleArea(v0, v1, v2) / Math.max(maxSide, 1);
      if (alt < Math.max(18, bboxDiag * 0.16)) return null;
      const fit = _evaluateClosedPolygonFit(uPts, verts);
      const ratio = pathLen / Math.max(fit.perim, 1);
      if (ratio <= 0.78 || ratio >= 1.28) return null;
      if (fit.rmsDist > Math.max(10.5, bboxDiag * 0.078)) return null;
      if (fit.maxDist > Math.max(26, bboxDiag * 0.19)) return null;
      return { vertices: verts, fit };
    };

    for (const factor of [0.042, 0.058, 0.078, 0.098]) {
      const verts = _extractClosedCorners(uPts, cx, cy, Math.max(5.0, bboxDiag * factor), minEdge, 32);
      const cand = checkTri(verts);
      if (cand && (!triMatch || cand.fit.rmsDist < triMatch.fit.rmsDist)) {
        triMatch = cand;
      }
    }

    if (!triMatch) {
      let idxA = 0, maxD = -1;
      for (let i = 0; i < uPts.length; i++) {
        const d = (uPts[i].x - cx) ** 2 + (uPts[i].y - cy) ** 2;
        if (d > maxD) { maxD = d; idxA = i; }
      }
      let idxB = 0; maxD = -1;
      for (let i = 0; i < uPts.length; i++) {
        const d = (uPts[i].x - uPts[idxA].x) ** 2 + (uPts[i].y - uPts[idxA].y) ** 2;
        if (d > maxD) { maxD = d; idxB = i; }
      }
      let idxC = 0, bestArea = -1;
      for (let i = 0; i < uPts.length; i++) {
        const a = doubleArea(uPts[idxA], uPts[idxB], uPts[i]);
        if (a > bestArea) { bestArea = a; idxC = i; }
      }
      for (let pass = 0; pass < 2; pass++) {
        let best = doubleArea(uPts[idxA], uPts[idxB], uPts[idxC]);
        for (let i = 0; i < uPts.length; i++) {
          const a = doubleArea(uPts[i], uPts[idxB], uPts[idxC]);
          if (a > best) { best = a; idxA = i; }
        }
        best = doubleArea(uPts[idxA], uPts[idxB], uPts[idxC]);
        for (let i = 0; i < uPts.length; i++) {
          const a = doubleArea(uPts[idxA], uPts[i], uPts[idxC]);
          if (a > best) { best = a; idxB = i; }
        }
        best = doubleArea(uPts[idxA], uPts[idxB], uPts[idxC]);
        for (let i = 0; i < uPts.length; i++) {
          const a = doubleArea(uPts[idxA], uPts[idxB], uPts[i]);
          if (a > best) { best = a; idxC = i; }
        }
      }
      const ord = [idxA, idxB, idxC].sort((i, j) => i - j);
      const cand = checkTri([
        { x: uPts[ord[0]].x, y: uPts[ord[0]].y },
        { x: uPts[ord[1]].x, y: uPts[ord[1]].y },
        { x: uPts[ord[2]].x, y: uPts[ord[2]].y }
      ]);
      if (cand) triMatch = cand;
    }
  }

  // Confronto tra Circle (morbido), Rect e Triangle
  if (circleMatch && !rectMatch && !triMatch) {
    const circlePts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      circlePts.push({ x: cx + Math.cos(a) * circleMatch.avgR, y: cy + Math.sin(a) * circleMatch.avgR, pressure: 0.5 });
    }
    return { kind: 'circle', label: 'Forma: Cerchio', icon: '⭕', center: { x: cx, y: cy }, points: circlePts };
  }
  if (circleMatch && rectMatch) {
    const rectNormRms = rectMatch.fit.rmsDist / Math.max(bboxDiag, 1);
    if (circleMatch.cvR * 0.72 < rectNormRms) {
      const circlePts = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        circlePts.push({ x: cx + Math.cos(a) * circleMatch.avgR, y: cy + Math.sin(a) * circleMatch.avgR, pressure: 0.5 });
      }
      return { kind: 'circle', label: 'Forma: Cerchio', icon: '⭕', center: { x: cx, y: cy }, points: circlePts };
    }
  }

  if (rectMatch && (!triMatch || rectMatch.fit.rmsDist <= triMatch.fit.rmsDist * 1.1)) {
    return {
      kind: 'rectangle',
      label: 'Forma: Rettangolo',
      icon: '⬛',
      center: rectMatch.center,
      points: buildPolygonStrokePoints(rectMatch.vertices)
    };
  }

  if (triMatch) {
    return {
      kind: 'triangle',
      label: 'Forma: Triangolo',
      icon: '🔺',
      center: { x: cx, y: cy },
      points: buildPolygonStrokePoints(triMatch.vertices)
    };
  }

  // 4. Ellisse orientata (PCA 2° momento)
  if (allowCircle) {
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < uPts.length; i++) {
      const dx = uPts[i].x - cx;
      const dy = uPts[i].y - cy;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
    let phi = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const nearAxis = Math.round(phi / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(phi - nearAxis) < (8 * Math.PI / 180)) phi = nearAxis;
    const ux = Math.cos(phi), uy = Math.sin(phi);
    const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of uPts) {
      const pu = (p.x - cx) * ux + (p.y - cy) * uy;
      const pv = (p.x - cx) * vx + (p.y - cy) * vy;
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const rx = (maxU - minU) * 0.5;
    const ry = (maxV - minV) * 0.5;
    const ellAspect = rx / Math.max(ry, 1);
    if (rx >= 12 && ry >= 12 && ellAspect >= 0.30 && ellAspect <= 3.30) {
      const cu = (minU + maxU) * 0.5;
      const cv = (minV + maxV) * 0.5;
      const ecx = cx + cu * ux + cv * vx;
      const ecy = cy + cu * uy + cv * vy;
      let errSqSum = 0;
      for (const p of uPts) {
        const pu = (p.x - ecx) * ux + (p.y - ecy) * uy;
        const pv = (p.x - ecx) * vx + (p.y - ecy) * vy;
        errSqSum += (Math.hypot(pu / rx, pv / ry) - 1) ** 2;
      }
      const rmsEll = Math.sqrt(errSqSum / uPts.length);
      const ellipsePerim = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
      const ellRatio = pathLen / Math.max(ellipsePerim, 1);
      if (rmsEll < 0.145 && ellRatio > 0.78 && ellRatio < 1.26) {
        const ellPts = [];
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          const lu = Math.cos(a) * rx;
          const lv = Math.sin(a) * ry;
          ellPts.push({
            x: ecx + lu * ux + lv * vx,
            y: ecy + lu * uy + lv * vy,
            pressure: 0.5
          });
        }
        return { kind: 'ellipse', label: 'Forma: Ellisse', icon: '⭕', center: { x: ecx, y: ecy }, points: ellPts };
      }
    }
  }

  return null;
}

/**
 * Riconosce cerchio, ellisse, rettangolo o triangolo da uno stroke chiuso
 * (usato durante l'hold-to-snap con la penna ferma).
 */
export function detectGeometricShape(rawPoints, {
  allowCircle = true,
  allowRect = true,
  allowTriangle = true,
  platform = 'desktop'
} = {}) {
  if (!allowCircle && !allowRect && !allowTriangle) return null;
  if (!Array.isArray(rawPoints) || rawPoints.length < 8) return null;
  if (platform === 'ios') {
    return _detectGeometricShapeIos(rawPoints, { allowCircle, allowRect, allowTriangle });
  }

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
