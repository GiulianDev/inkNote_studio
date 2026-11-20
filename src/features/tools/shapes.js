/**
 * @module features/tools/shapes
 *
 * RICONOSCIMENTO FORME + snap angolare.
 *
 * @see core/types.js  — Stroke, Point
 * @see features/render/render.js
 * @see features/history/history.js
 */

import { state } from '../../core/state.js';
import { SHAPE_CAPABLE_TOOLS, showToast } from '../../core/utils.js';
import { clearOverlay, renderPendingShapeOnOverlay, renderFullStroke } from '../render/render.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';

// ------------------------------------------------------------
// Soglie rilevamento linea retta
// ------------------------------------------------------------
const LINE_MIN_CHORD_LEN       = 50;
const LINE_MIN_PATH_RATIO      = 0.94;
const LINE_MAX_RMS_BASE        = 2.5;
const LINE_MAX_RMS_FACTOR      = 0.020;
const LINE_MAX_COS_CONSISTENCY = 0.75;
const LINE_SIGN_HYSTERESIS     = 2.5;

const LINE_ANGLE_ENGAGE_DEG  = 4;
const LINE_ANGLE_RELEASE_DEG = 8;

// ------------------------------------------------------------
// Snap angolare
// ------------------------------------------------------------
export function applyAngleSnap(start, rawEnd, currentAxis, rejected) {
  const dx = rawEnd.x - start.x;
  const dy = rawEnd.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) {
    return { x: rawEnd.x, y: rawEnd.y, axis: currentAxis, rejected };
  }

  const thetaDeg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
  const distH = thetaDeg;
  const distV = 90 - thetaDeg;

  if (rejected) {
    return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
  }

  if (currentAxis === 'h') {
    if (distH > LINE_ANGLE_RELEASE_DEG) {
      return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
    }
    return { x: rawEnd.x, y: start.y, axis: 'h', rejected: false };
  }
  if (currentAxis === 'v') {
    if (distV > LINE_ANGLE_RELEASE_DEG) {
      return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
    }
    return { x: start.x, y: rawEnd.y, axis: 'v', rejected: false };
  }

  if (distH <= LINE_ANGLE_ENGAGE_DEG) {
    return { x: rawEnd.x, y: start.y, axis: 'h', rejected: false };
  }
  if (distV <= LINE_ANGLE_ENGAGE_DEG) {
    return { x: start.x, y: rawEnd.y, axis: 'v', rejected: false };
  }

  return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
}

// ------------------------------------------------------------
// Analisi forma linea
// ------------------------------------------------------------
function countPerpSignChanges(points, A, B, hysteresis) {
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
  if (len < 1) return 0;
  const nx = -dy / len, ny = dx / len;
  let lastSign = 0;
  let changes = 0;
  for (const p of points) {
    const px = p.x - A.x, py = p.y - A.y;
    const perp = px * nx + py * ny;
    if (perp > hysteresis) {
      if (lastSign === -1) changes++;
      lastSign = 1;
    } else if (perp < -hysteresis) {
      if (lastSign === 1) changes++;
      lastSign = -1;
    }
  }
  return changes;
}

function maxSignChangesForChord(chordLen) {
  return Math.max(3, Math.floor(chordLen / 80));
}

function validateLineShape(pts, startPt, endPt, chordLen) {
  const rmsDev = perpendicularRmsDeviationSampled(pts, startPt, endPt, 3);
  if (rmsDev === null) return false;
  if (rmsDev > Math.max(LINE_MAX_RMS_BASE, chordLen * LINE_MAX_RMS_FACTOR)) return false;

  const signChanges = countPerpSignChanges(pts, startPt, endPt, LINE_SIGN_HYSTERESIS);
  if (signChanges > maxSignChangesForChord(chordLen)) return false;

  if (pts.length >= 3) {
    const tip = pts[pts.length - 1];
    const tailWindow = Math.min(18, chordLen * 0.25);
    let tailIdx = pts.length - 2;
    while (tailIdx > 0 && Math.hypot(tip.x - pts[tailIdx].x, tip.y - pts[tailIdx].y) < tailWindow) {
      tailIdx--;
    }
    const tailBase = pts[tailIdx];
    const tailDx = tip.x - tailBase.x, tailDy = tip.y - tailBase.y;
    const tailLen = Math.hypot(tailDx, tailDy);
    if (tailLen >= 8 && chordLen > 0) {
      const chordDx = endPt.x - startPt.x, chordDy = endPt.y - startPt.y;
      const cosTail = (tailDx * chordDx + tailDy * chordDy) / (tailLen * chordLen);
      if (cosTail < LINE_MAX_COS_CONSISTENCY) return false;
    }
  }
  return true;
}

function perpendicularRmsDeviationSampled(points, A, B, step) {
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len, uy = dy / len;
  let sumSq = 0, count = 0;
  for (let i = 0; i < points.length; i += step) {
    const p = points[i], px = p.x - A.x, py = p.y - A.y;
    const along = px * ux + py * uy;
    const perpX = px - along * ux, perpY = py - along * uy;
    sumSq += perpX * perpX + perpY * perpY; count++;
  }
  if ((points.length - 1) % step !== 0) {
    const p = points[points.length - 1], px = p.x - A.x, py = p.y - A.y;
    const along = px * ux + py * uy;
    const perpX = px - along * ux, perpY = py - along * uy;
    sumSq += perpX * perpX + perpY * perpY; count++;
  }
  if (count === 0) return null;
  return Math.sqrt(sumSq / count);
}

// ------------------------------------------------------------
// trySnapToLineDuringDraw — snap durante lo stroke
// (crea pendingShape con pageIndex)
// ------------------------------------------------------------
export function trySnapToLineDuringDraw(pageData, currentPoint) {
  const stroke = state.currentStroke;
  if (!stroke) return false;
  const pts = stroke.points;
  if (pts.length < 4) return false;
  const startPt = pts[0], endPt = currentPoint;
  const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (chordLen < LINE_MIN_CHORD_LEN) return false;

  let pathLen;
  if (stroke._pathLen !== undefined && stroke._pathLen > 0) pathLen = stroke._pathLen;
  else {
    pathLen = 0;
    for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    stroke._pathLen = pathLen;
  }
  if (chordLen / Math.max(pathLen, 1) < LINE_MIN_PATH_RATIO) return false;

  if (!validateLineShape(pts, startPt, endPt, chordLen)) return false;

  const snapRes = applyAngleSnap(
    { x: startPt.x, y: startPt.y },
    { x: endPt.x, y: endPt.y },
    null, false
  );

  state.pendingShape = {
    start: { x: startPt.x, y: startPt.y, pressure: 0.5 },
    end: { x: snapRes.x, y: snapRes.y, pressure: 0.5 },
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    opacity: stroke.opacity != null ? stroke.opacity : 1.0,
    style: stroke.style || 'solid',
    activeHandle: 'end',
    pageId: pageData.pageId,
    pageIndex: pageData.index,
    _snapAxis: snapRes.axis,
    _snapRejected: snapRes.rejected
  };
  state.currentStroke = null;
  clearOverlay(pageData);
  renderPendingShapeOnOverlay(pageData);
  showToast('Linea agganciata — muovi per aggiustare, rilascia per confermare', '📏');
  return true;
}

// ------------------------------------------------------------
// trySnapToLine — snap al pointerup (fallback)
// ------------------------------------------------------------
export function trySnapToLine(stroke) {
  const pts = stroke.points;
  if (pts.length < 4) return false;
  const startPt = pts[0], endPt = pts[pts.length - 1];
  const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (chordLen < LINE_MIN_CHORD_LEN) return false;
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
  if (chordLen / Math.max(pathLen, 1) < LINE_MIN_PATH_RATIO) return false;

  if (!validateLineShape(pts, startPt, endPt, chordLen)) return false;

  const snapRes = applyAngleSnap(
    { x: startPt.x, y: startPt.y },
    { x: endPt.x, y: endPt.y },
    null, false
  );
  const fx = snapRes.x, fy = snapRes.y;

  const finalLen = Math.hypot(fx - startPt.x, fy - startPt.y);
  const steps = Math.max(8, Math.floor(finalLen / 4));
  const straightPts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    straightPts.push({
      x: startPt.x + (fx - startPt.x) * t,
      y: startPt.y + (fy - startPt.y) * t,
      pressure: 0.5
    });
  }
  stroke.points = straightPts;
  return true;
}

// ------------------------------------------------------------
// finalizePendingShape — committa la forma in pendingShape
// sulla pagina di appartenenza (pageIndex)
// ------------------------------------------------------------
export function finalizePendingShape() {
  if (!state.pendingShape) return;
  const ps = state.pendingShape;

  let curr = ps.pageId
    ? state.pages.find(p => p.pageId === ps.pageId)
    : null;
  if (!curr) {
    const targetIndex = typeof ps.pageIndex === 'number' ? ps.pageIndex : state.activePageIndex;
    curr = state.pages[targetIndex] || null;
  }

  if (curr) {
    const startPt = { x: ps.start.x, y: ps.start.y, pressure: 0.5 };
    const endPt = { x: ps.end.x, y: ps.end.y, pressure: 0.5 };
    const steps = Math.max(8, Math.floor(Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) / 4));
    const straightPts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      straightPts.push({
        x: startPt.x + (endPt.x - startPt.x) * t,
        y: startPt.y + (endPt.y - startPt.y) * t,
        pressure: 0.5
      });
    }
    const newStroke = {
      tool: ps.tool,
      color: ps.color,
      size: ps.size,
      opacity: ps.opacity != null ? ps.opacity : 1.0,
      style: ps.style || 'solid',
      points: straightPts
    };
    curr.strokes.push(newStroke);

    if (curr.canvas && curr.ctx) {
      const pctx = curr.ctx, dpr = curr.dpr || 1;
      pctx.save(); pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderFullStroke(pctx, newStroke, state.isDarkMode);
      pctx.restore();
      clearOverlay(curr);
      triggerSnapAnimation(curr);
    }

    scheduleSave({ pageId: curr.pageId });
    if (curr.index === state.activePageIndex) {
      pushHistory();
    }
  }
  state.pendingShape = null;
}

// ------------------------------------------------------------
// Helpers poligoni (rettangoli / triangoli)
// ------------------------------------------------------------
function distSqPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Campiona punti collineari lungo i lati di un poligono chiuso con piccoli
 * punti di guardia vicino ai vertici, così l'interpolazione Catmull-Rom di
 * renderFullStroke mantiene i lati dritti e gli angoli netti (evita "ottagoni").
 */
function buildPolygonStrokePoints(vertices, step = 8) {
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

function detectTriangleVertices(pts, pathLen, bboxDiag) {
  const n = pts.length;
  if (n < 9) return null;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += pts[i].x;
    sumY += pts[i].y;
  }
  const cx = sumX / n;
  const cy = sumY / n;

  // 1. Vertice A più lontano dal centroide
  let idxA = 0, maxD = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i].x - cx) ** 2 + (pts[i].y - cy) ** 2;
    if (d > maxD) { maxD = d; idxA = i; }
  }

  // 2. Vertice B più lontano da A
  let idxB = 0;
  maxD = -1;
  for (let i = 0; i < n; i++) {
    const d = (pts[i].x - pts[idxA].x) ** 2 + (pts[i].y - pts[idxA].y) ** 2;
    if (d > maxD) { maxD = d; idxB = i; }
  }

  // 3. Vertice C che massimizza l'area con A e B + 2 passaggi di raffinamento
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
  if (minSide < Math.max(28, bboxDiag * 0.24)) return null;

  const triArea2 = doubleArea(v0, v1, v2);
  const minAltitude = triArea2 / Math.max(maxSide, 1);
  if (minAltitude < Math.max(24, bboxDiag * 0.18)) return null;

  const triPerim = s01 + s12 + s20;
  const triPathRatio = pathLen / Math.max(triPerim, 1);
  if (triPathRatio <= 0.84 || triPathRatio >= 1.24) return null;

  // Tutti i punti dello stroke devono aderire ai 3 lati del triangolo
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

// ------------------------------------------------------------
// detectAndSnapShape — cerchio / rettangolo / triangolo
// ------------------------------------------------------------
export function detectAndSnapShape(stroke, pageData) {
  const allowCircle   = state.snapCircles !== false;
  const allowRect     = state.snapRectangles !== false;
  const allowTriangle = state.snapTriangles !== false;
  if (!allowCircle && !allowRect && !allowTriangle) return false;

  const pts = stroke.points;
  if (pts.length < 8) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, pathLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (i > 0) pathLen += Math.hypot(p.x - pts[i-1].x, p.y - pts[i-1].y);
  }
  const bboxW = maxX - minX, bboxH = maxY - minY;
  const bboxDiag = Math.hypot(bboxW, bboxH);
  if (bboxDiag < 90) return false;
  const startPt = pts[0], endPt = pts[pts.length - 1];
  const closureDist = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (closureDist / Math.max(pathLen, 1) > 0.14) return false;

  const w = bboxW, h = bboxH;
  const aspect = h > 0 ? w / h : 1;
  const isSquareLike = aspect >= 0.75 && aspect <= 1.35;

  let avgRadius = 0;
  let radiusStdDev = Infinity;
  let isCircle = false;
  if (allowCircle && isSquareLike && w >= 28 && h >= 28) {
    const cx = minX + w / 2, cy = minY + h / 2;
    let radiusSum = 0;
    for (const p of pts) radiusSum += Math.hypot(p.x - cx, p.y - cy);
    avgRadius = radiusSum / pts.length;
    let radiusVariance = 0;
    for (const p of pts) radiusVariance += (Math.hypot(p.x - cx, p.y - cy) - avgRadius) ** 2;
    radiusStdDev = Math.sqrt(radiusVariance / pts.length);
    isCircle = avgRadius > 0 && (radiusStdDev / avgRadius) < 0.15;
  }

  let isRect = false;
  if (allowRect && w >= 28 && h >= 28) {
    const idealRectPerimeter = 2 * (w + h);
    const rectPathRatio = pathLen / idealRectPerimeter;
    const cornerTouchRadius = Math.min(Math.max(16, Math.min(w, h) * 0.42), Math.min(w, h) * 0.46);
    const corners = [{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}];
    const cornersTouched = corners.every(c => pts.some(p => Math.hypot(p.x - c.x, p.y - c.y) < cornerTouchRadius));
    isRect = cornersTouched && rectPathRatio > 0.85 && rectPathRatio < 1.2;
  }

  if (isCircle && (!isRect || radiusStdDev / avgRadius < 0.08)) {
    const cx = minX + w / 2, cy = minY + h / 2;
    const circlePts = [], steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      circlePts.push({ x: cx + Math.cos(a) * avgRadius, y: cy + Math.sin(a) * avgRadius, pressure: 0.5 });
    }
    stroke.points = circlePts;
    showToast('Forma: Cerchio', '⭕');
    triggerSnapAnimation(pageData);
    return true;
  }

  if (isRect) {
    stroke.points = buildPolygonStrokePoints([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ]);
    showToast('Forma: Rettangolo', '⬛');
    triggerSnapAnimation(pageData);
    return true;
  }

  if (allowTriangle) {
    const triVerts = detectTriangleVertices(pts, pathLen, bboxDiag);
    if (triVerts) {
      stroke.points = buildPolygonStrokePoints(triVerts);
      showToast('Forma: Triangolo', '🔺');
      triggerSnapAnimation(pageData);
      return true;
    }
  }

  return false;
}

function triggerSnapAnimation(pageData) {
  pageData.wrapper.classList.add('shape-snapped');
  setTimeout(() => pageData.wrapper.classList.remove('shape-snapped'), 250);
}

// ------------------------------------------------------------
// trySnapHighlighter — raddrizza mantenendo l'angolo
// ------------------------------------------------------------
export function trySnapHighlighter(stroke) {
  const pts = stroke.points;
  if (pts.length < 6) return false;

  const startPt = pts[0], endPt = pts[pts.length - 1];
  const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (chordLen < 80) return false;

  if (!validateLineShape(pts, startPt, endPt, chordLen)) return false;

  const dx = endPt.x - startPt.x;
  const dy = endPt.y - startPt.y;
  const steps = Math.max(8, Math.floor(chordLen / 4));
  const straightPts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    straightPts.push({
      x: startPt.x + dx * t,
      y: startPt.y + dy * t,
      pressure: 0.5
    });
  }
  stroke.points = straightPts;
  return true;
}