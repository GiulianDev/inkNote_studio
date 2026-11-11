// ============================================================
// RICONOSCIMENTO FORME
// ============================================================

import { state } from '../../core/state.js';
import { SHAPE_CAPABLE_TOOLS, showToast } from '../../core/utils.js';
import { clearOverlay, renderPendingShapeOnOverlay, renderFullStroke } from '../render/render.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';

// ------------------------------------------------------------
// Soglie rilevamento linea retta
// ------------------------------------------------------------
const LINE_MIN_CHORD_LEN     = 60;    // lunghezza minima corda
const LINE_MIN_PATH_RATIO    = 0.965; // chord/path
const LINE_MAX_RMS_BASE      = 1.0;   // RMS minimo assoluto
const LINE_MAX_RMS_FACTOR    = 0.010; // RMS massimo proporzionale
const LINE_MAX_COS_CONSISTENCY = 0.85;
const LINE_SIGN_HYSTERESIS   = 1.5;

// ------------------------------------------------------------
// Snap angolare (magnete per linee orizzontali/verticali)
// ENGAGE: soglia di aggancio iniziale (4°)
// RELEASE: soglia di sgancio (8°) → isteresi 2x
// Una volta sganciato, lo stroke resta libero fino alla fine
// (niente ri-aggancio).
// ------------------------------------------------------------
const LINE_ANGLE_ENGAGE_DEG  = 4;
const LINE_ANGLE_RELEASE_DEG = 8;

/**
 * Applica (o mantiene/rilascia) lo snap angolare.
 * @param {{x:number,y:number}} start  Punto fisso della linea
 * @param {{x:number,y:number}} rawEnd Punto grezzo del pointer
 * @param {'h'|'v'|null} currentAxis   Asse agganciato attualmente (o null)
 * @param {boolean} rejected           True se già stato sganciato (o mai agganciato)
 * @returns {{x:number, y:number, axis:'h'|'v'|null, rejected:boolean}}
 */
export function applyAngleSnap(start, rawEnd, currentAxis, rejected) {
  const dx = rawEnd.x - start.x;
  const dy = rawEnd.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) {
    return { x: rawEnd.x, y: rawEnd.y, axis: currentAxis, rejected };
  }

  // thetaDeg ∈ [0, 90]: 0 = orizzontale, 90 = verticale
  const thetaDeg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
  const distH = thetaDeg;       // distanza dall'asse orizzontale (0°/180°)
  const distV = 90 - thetaDeg;  // distanza dall'asse verticale (90°/270°)

  // Già rifiutato in precedenza: mai riagganciare per questo stroke
  if (rejected) {
    return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
  }

  // Già agganciato: mantieni finché non si supera RELEASE, poi sgancia
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

  // Mai agganciato: prova ad agganciare solo se entro ENGAGE
  if (distH <= LINE_ANGLE_ENGAGE_DEG) {
    return { x: rawEnd.x, y: start.y, axis: 'h', rejected: false };
  }
  if (distV <= LINE_ANGLE_ENGAGE_DEG) {
    return { x: start.x, y: rawEnd.y, axis: 'v', rejected: false };
  }

  // Fuori soglia iniziale: rifiutato definitivamente
  return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
}

// ------------------------------------------------------------
// Conta i cambi di segno della deviazione perpendicolare
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
  return Math.max(2, Math.floor(chordLen / 100));
}

function validateLineShape(pts, startPt, endPt, chordLen) {
  const rmsDev = perpendicularRmsDeviationSampled(pts, startPt, endPt, 3);
  if (rmsDev === null) return false;
  if (rmsDev > Math.max(LINE_MAX_RMS_BASE, chordLen * LINE_MAX_RMS_FACTOR)) return false;

  const signChanges = countPerpSignChanges(pts, startPt, endPt, LINE_SIGN_HYSTERESIS);
  if (signChanges > maxSignChangesForChord(chordLen)) return false;

  if (pts.length >= 3) {
    const a = pts[pts.length - 3], b = pts[pts.length - 2], c = pts[pts.length - 1];
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 > 0.5 && l2 > 0.5) {
      const chordDx = endPt.x - startPt.x, chordDy = endPt.y - startPt.y;
      const chordL = Math.hypot(chordDx, chordDy);
      if (chordL > 0) {
        const cos1 = (v1x * chordDx + v1y * chordDy) / (l1 * chordL);
        const cos2 = (v2x * chordDx + v2y * chordDy) / (l2 * chordL);
        if (cos1 < LINE_MAX_COS_CONSISTENCY || cos2 < LINE_MAX_COS_CONSISTENCY) return false;
      }
    }
  }
  return true;
}

export function trySnapToLineDuringDraw(pageData, currentPoint) {
  const stroke = state.currentStroke;
  if (!stroke) return false;
  const pts = stroke.points;
  if (pts.length < 6) return false;
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

  // Applica snap angolare iniziale
  const snapRes = applyAngleSnap(
    { x: startPt.x, y: startPt.y },
    { x: endPt.x, y: endPt.y },
    null, false
  );

  state.pendingShape = {
    start: { x: startPt.x, y: startPt.y, pressure: 0.5 },
    end: { x: snapRes.x, y: snapRes.y, pressure: 0.5 },
    tool: stroke.tool, color: stroke.color, size: stroke.size, activeHandle: 'end',
    _snapAxis: snapRes.axis,
    _snapRejected: snapRes.rejected
  };
  state.currentStroke = null;
  clearOverlay(pageData);
  renderPendingShapeOnOverlay(pageData);
  showToast('Linea agganciata — muovi per aggiustare, rilascia per confermare', '📏');
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

export function trySnapToLine(stroke) {
  const pts = stroke.points;
  if (pts.length < 6) return false;
  const startPt = pts[0], endPt = pts[pts.length - 1];
  const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (chordLen < LINE_MIN_CHORD_LEN) return false;
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
  if (chordLen / Math.max(pathLen, 1) < LINE_MIN_PATH_RATIO) return false;

  if (!validateLineShape(pts, startPt, endPt, chordLen)) return false;

  // Snap angolare anche nel fallback (linee corte / no pendingShape)
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

function perpendicularRmsDeviation(points, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len, uy = dy / len;
  let sumSq = 0;
  for (const p of points) {
    const px = p.x - A.x, py = p.y - A.y;
    const along = px * ux + py * uy;
    const perpX = px - along * ux, perpY = py - along * uy;
    sumSq += perpX * perpX + perpY * perpY;
  }
  return Math.sqrt(sumSq / points.length);
}

export function finalizePendingShape() {
  if (!state.pendingShape) return;
  const ps = state.pendingShape;
  const curr = state.pages[state.activePageIndex];
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
    const newStroke = { tool: ps.tool, color: ps.color, size: ps.size, points: straightPts };
    curr.strokes.push(newStroke);
    const pctx = curr.ctx, dpr = curr.dpr || 1;
    pctx.save(); pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderFullStroke(pctx, newStroke, state.isDarkMode);
    pctx.restore();
    clearOverlay(curr);
    scheduleSave();
    pushHistory();
    triggerSnapAnimation(curr);
  }
  state.pendingShape = null;
}

export function detectAndSnapShape(stroke, pageData) {
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
  if (closureDist / Math.max(pathLen, 1) > 0.12) return false;
  const w = bboxW, h = bboxH;
  if (w < 40 || h < 40) return false;
  const aspect = w / h;
  if (aspect < 0.75 || aspect > 1.35) return false;
  const cx = minX + w / 2, cy = minY + h / 2;
  let radiusSum = 0;
  for (const p of pts) radiusSum += Math.hypot(p.x - cx, p.y - cy);
  const avgRadius = radiusSum / pts.length;
  let radiusVariance = 0;
  for (const p of pts) radiusVariance += (Math.hypot(p.x - cx, p.y - cy) - avgRadius) ** 2;
  const radiusStdDev = Math.sqrt(radiusVariance / pts.length);
  const isCircle = radiusStdDev / avgRadius < 0.15;
  const idealRectPerimeter = 2 * (w + h);
  const rectPathRatio = pathLen / idealRectPerimeter;
  const cornerTouchRadius = Math.min(w, h) * 0.35;
  const corners = [{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}];
  const cornersTouched = corners.every(c => pts.some(p => Math.hypot(p.x - c.x, p.y - c.y) < cornerTouchRadius));
  const isRect = cornersTouched && rectPathRatio > 0.85 && rectPathRatio < 1.2;
  if (isCircle && (!isRect || radiusStdDev / avgRadius < 0.08)) {
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
    stroke.points = [
      { x: minX, y: minY, pressure: 0.5 },
      { x: maxX, y: minY, pressure: 0.5 },
      { x: maxX, y: maxY, pressure: 0.5 },
      { x: minX, y: maxY, pressure: 0.5 },
      { x: minX, y: minY, pressure: 0.5 }
    ];
    showToast('Forma: Rettangolo', '⬛');
    triggerSnapAnimation(pageData);
    return true;
  }
  return false;
}

function triggerSnapAnimation(pageData) {
  pageData.wrapper.classList.add('shape-snapped');
  setTimeout(() => pageData.wrapper.classList.remove('shape-snapped'), 250);
}

export function trySnapHighlighter(stroke) {
  const pts = stroke.points;
  if (pts.length < 6) return false;
  const startPt = pts[0], endPt = pts[pts.length - 1];
  const dx = endPt.x - startPt.x, dy = endPt.y - startPt.y;
  const len = Math.hypot(dx, dy);
  if (len < 80) return false;
  const angle = Math.atan2(dy, dx);
  const absCos = Math.abs(Math.cos(angle)), absSin = Math.abs(Math.sin(angle));
  const isHorizontal = absSin < 0.3, isVertical = absCos < 0.3;
  if (!isHorizontal && !isVertical) return false;
  const steps = Math.max(8, Math.floor(len / 4));
  const straightPts = [];
  if (isHorizontal) {
    let sumY = 0;
    for (const p of pts) sumY += p.y;
    const avgY = sumY / pts.length;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      straightPts.push({ x: startPt.x + dx * t, y: avgY, pressure: 0.5 });
    }
  } else {
    let sumX = 0;
    for (const p of pts) sumX += p.x;
    const avgX = sumX / pts.length;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      straightPts.push({ x: avgX, y: startPt.y + dy * t, pressure: 0.5 });
    }
  }
  stroke.points = straightPts;
  return true;
}