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
import {
  clearOverlay, renderPendingShapeOnOverlay,
  renderFullStroke, redrawPageCanvas
} from '../render/render.js';
import { invalidateStrokeBitmap } from '../render/stroke-cache.js';
import { invalidateStrokeBBox } from '../render/stroke-geometry.js';

function _invalidateStrokeCaches(stroke) {
  if (!stroke) return;
  invalidateStrokeBBox(stroke);
  invalidateStrokeBitmap(stroke);
}
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import {
  findArrowTipTarget,
  findImplicationArrowTarget,
  buildImplicationArrowGeometry,
  analyzeSingleStrokeArrow
} from './arrow-recognition.js';
import {
  recognizeMathSymbolSingleStroke,
  matchSummationOrUpperSigma,
  recognizeGreekSingleStroke,
  recognizeGreekMultiStroke
} from './math-greek-recognition.js';
import {
  detectGeometricShape,
  scaleShapePointsFromCenter
} from './geometric-shapes.js';
import {
  applyAngleSnap,
  evaluateLineHoldCandidate,
  evaluateUltraStraightLineCandidate,
  buildStraightLinePoints
} from './line-snap.js';
import { trimStationaryTail, cloneInkParams } from './ink-calibration.js';

export { scaleShapePointsFromCenter, applyAngleSnap };

// ------------------------------------------------------------
// trySnapLineDuringDraw — hold-to-snap linea interattiva con
// maniglie e snap orizzontale / verticale
// ------------------------------------------------------------
export function trySnapLineDuringDraw(pageData, stroke) {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 4) return false;
  if (state.snapLines === false) return false;

  const cand = evaluateLineHoldCandidate(stroke.points);
  if (!cand) return false;

  const snapRes = applyAngleSnap(cand.start, cand.end, null, false);
  state.pendingShape = {
    start: { x: cand.start.x, y: cand.start.y },
    end: { x: snapRes.x, y: snapRes.y },
    activeHandle: 'end',
    _snapAxis: snapRes.axis,
    _snapRejected: false,
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    opacity: stroke.opacity != null ? stroke.opacity : 1.0,
    style: stroke.style || 'solid',
    inkParams: stroke.inkParams ? cloneInkParams(stroke.inkParams) : null,
    pageId: pageData.pageId,
    pageIndex: pageData.index
  };
  state.currentStroke = null;
  clearOverlay(pageData);
  renderPendingShapeOnOverlay(pageData);
  return true;
}

// ------------------------------------------------------------
// trySnapGeometricShapeDuringDraw — hold-to-snap SOLO forme geometriche
// (cerchio, ellisse, rettangolo, triangolo)
// ------------------------------------------------------------
export function trySnapGeometricShapeDuringDraw(pageData, stroke) {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 8) return false;
  if (!state.snapShapes) return false;

  const allowCircle   = state.snapCircles !== false;
  const allowRect     = state.snapRectangles !== false;
  const allowTriangle = state.snapTriangles !== false;
  if (!allowCircle && !allowRect && !allowTriangle) return false;

  const match = detectGeometricShape(stroke.points, {
    allowCircle,
    allowRect,
    allowTriangle
  });
  if (!match) return false;

  const lastPt = stroke.points[stroke.points.length - 1];
  state.pendingShape = {
    kind: match.kind,
    label: match.label,
    icon: match.icon,
    center: match.center,
    basePoints: match.points,
    points: match.points,
    holdAnchor: { x: lastPt.x, y: lastPt.y },
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    opacity: stroke.opacity != null ? stroke.opacity : 1.0,
    style: stroke.style || 'solid',
    inkParams: stroke.inkParams ? cloneInkParams(stroke.inkParams) : null,
    pageId: pageData.pageId,
    pageIndex: pageData.index
  };
  state.currentStroke = null;
  clearOverlay(pageData);
  renderPendingShapeOnOverlay(pageData);
  showToast(match.label, match.icon);
  return true;
}

// ------------------------------------------------------------
// trySnapToLine — auto-snap al rilascio SOLO per linee già quasi
// perfettamente dritte e regolari (altrimenti usare hold-to-snap)
// ------------------------------------------------------------
export function trySnapToLine(stroke, cleanPts = null) {
  const cand = evaluateUltraStraightLineCandidate(cleanPts || stroke.points);
  if (!cand) return false;
  stroke.points = buildStraightLinePoints(cand.start, cand.end);
  _invalidateStrokeCaches(stroke);
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
    let finalPts = null;
    if (Array.isArray(ps.points) && ps.points.length >= 2) {
      finalPts = ps.points.map(p => ({
        x: p.x,
        y: p.y,
        pressure: p.pressure != null ? p.pressure : 0.5
      }));
    } else if (ps.start && ps.end) {
      const startPt = { x: ps.start.x, y: ps.start.y, pressure: 0.5 };
      const endPt = { x: ps.end.x, y: ps.end.y, pressure: 0.5 };
      const steps = Math.max(8, Math.floor(Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) / 4));
      finalPts = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        finalPts.push({
          x: startPt.x + (endPt.x - startPt.x) * t,
          y: startPt.y + (endPt.y - startPt.y) * t,
          pressure: 0.5
        });
      }
    }

    if (finalPts) {
      const newStroke = {
        tool: ps.tool,
        color: ps.color,
        size: ps.size,
        opacity: ps.opacity != null ? ps.opacity : 1.0,
        style: ps.style || 'solid',
        points: finalPts
      };
      if (ps.inkParams) newStroke.inkParams = ps.inkParams;
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
  }
  state.pendingShape = null;
}

function buildOpenPolylineStrokePoints(vertices, step = 8) {
  const out = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
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
  const last = vertices[vertices.length - 1];
  out.push({ x: last.x, y: last.y, pressure: 0.5 });
  return out;
}

function buildSymmetricArrowHeadPoints(tip, dirX, dirY, wingLen, halfAngleDeg = 28) {
  const halfAngle = halfAngleDeg * Math.PI / 180;
  const cosA = Math.cos(halfAngle);
  const sinA = Math.sin(halfAngle);
  const px = -dirY;
  const py = dirX;
  const w1 = {
    x: tip.x - dirX * wingLen * cosA + px * wingLen * sinA,
    y: tip.y - dirY * wingLen * cosA + py * wingLen * sinA
  };
  const w2 = {
    x: tip.x - dirX * wingLen * cosA - px * wingLen * sinA,
    y: tip.y - dirY * wingLen * cosA - py * wingLen * sinA
  };
  return buildOpenPolylineStrokePoints([w1, tip, w2], 6);
}

function detectImplicationArrow(stroke, pageData, cleanPts) {
  if (!pageData || !Array.isArray(pageData.strokes) || pageData.strokes.length < 2) return false;
  const match = findImplicationArrowTarget(cleanPts || stroke.points, pageData.strokes);
  if (!match) return false;

  const geom = buildImplicationArrowGeometry(match, { snapAxis: !!state.snapLines });
  const barAStroke = pageData.strokes[match.barAIndex];
  const barBStroke = pageData.strokes[match.barBIndex];
  if (barAStroke) {
    barAStroke.points = buildOpenPolylineStrokePoints(geom.barAEndpoints, 4);
    _invalidateStrokeCaches(barAStroke);
  }
  if (barBStroke) {
    barBStroke.points = buildOpenPolylineStrokePoints(geom.barBEndpoints, 4);
    _invalidateStrokeCaches(barBStroke);
  }
  if (pageData.canvas && pageData.ctx) {
    redrawPageCanvas(pageData);
  }

  stroke.points = buildSymmetricArrowHeadPoints(
    geom.tip,
    geom.dirX,
    geom.dirY,
    geom.wingLen,
    geom.halfAngleDeg
  );
  _invalidateStrokeCaches(stroke);
  showToast('Forma: Di conseguenza (⇒)', '⇒');
  triggerSnapAnimation(pageData);
  return true;
}

function detectArrowTipOnLine(stroke, pageData, cleanPts) {
  if (!pageData || !Array.isArray(pageData.strokes) || pageData.strokes.length === 0) return false;
  const match = findArrowTipTarget(cleanPts || stroke.points, pageData.strokes);
  if (!match) return false;

  stroke.points = buildSymmetricArrowHeadPoints(
    match.target.end,
    match.target.dirX,
    match.target.dirY,
    match.wingLen
  );
  _invalidateStrokeCaches(stroke);
  showToast('Forma: Punta freccia', '➡️');
  triggerSnapAnimation(pageData);
  return true;
}

function detectSingleStrokeArrow(stroke, pageData, extraStrokes, cleanPts) {
  if (!Array.isArray(extraStrokes)) return false;
  const match = analyzeSingleStrokeArrow(cleanPts || stroke.points);
  if (!match) return false;

  const { tail, rawTip, minAlong, avgSide } = match;
  let finalTip = { x: rawTip.x, y: rawTip.y };
  if (state.snapLines) {
    const snapped = applyAngleSnap(tail, rawTip, null, false);
    finalTip = { x: snapped.x, y: snapped.y };
  }
  const finalDx = finalTip.x - tail.x;
  const finalDy = finalTip.y - tail.y;
  const finalLen = Math.hypot(finalDx, finalDy);
  if (finalLen < 35) return false;
  const fux = finalDx / finalLen;
  const fuy = finalDy / finalLen;

  const rawWingLen = Math.hypot(minAlong, avgSide);
  const wingLen = Math.max(10, Math.min(48, finalLen * 0.42, rawWingLen * 0.95));

  stroke.points = buildOpenPolylineStrokePoints([{ x: tail.x, y: tail.y }, finalTip], 4);
  _invalidateStrokeCaches(stroke);
  const headStroke = {
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    opacity: stroke.opacity != null ? stroke.opacity : 1.0,
    style: stroke.style || 'solid',
    points: buildSymmetricArrowHeadPoints(finalTip, fux, fuy, wingLen)
  };
  if (stroke.inkParams) headStroke.inkParams = cloneInkParams(stroke.inkParams);
  extraStrokes.push(headStroke);

  showToast('Forma: Freccia', '➡️');
  triggerSnapAnimation(pageData);
  return true;
}

// ------------------------------------------------------------
// detectReleaseShapeOrSymbol — riconoscimento AL SOLO RILASCIO:
//   linee dritte, frecce, simboli matematici, lettere greche
//   (cerchi/ellissi/rettangoli/triangoli si attivano solo con hold)
// ------------------------------------------------------------
export function detectReleaseShapeOrSymbol(stroke, pageData, extraStrokes = []) {
  const allowLines  = state.snapLines !== false;
  const allowArrow  = state.snapShapes && state.snapArrows !== false;
  const allowMath   = state.snapShapes && state.snapMathSymbols !== false;
  const allowGreek  = state.snapShapes && state.snapGreekLetters !== false;
  if (!allowLines && !allowArrow && !allowMath && !allowGreek) {
    return false;
  }

  const pts = trimStationaryTail(stroke.points, 5.5);
  if (pts.length < 4) return false;

  // 1. Simbolo "di conseguenza" (=> / ⇒): 2 linee parallele + punta >
  if ((allowArrow || allowMath) && pts.length >= 5 && detectImplicationArrow(stroke, pageData, pts)) {
    return true;
  }

  // 2. Freccia 2 tratti: punta a V disegnata sull'estremità di una linea esistente
  if (allowArrow && pts.length >= 5 && detectArrowTipOnLine(stroke, pageData, pts)) {
    return true;
  }

  // 3. Lettere greche multi-tratto (θ, φ, ψ, π, λ)
  if (allowGreek && pageData && Array.isArray(pageData.strokes) && pageData.strokes.length > 0) {
    const greekMulti = recognizeGreekMultiStroke(pts, pageData.strokes);
    if (greekMulti) {
      if (Array.isArray(greekMulti.updates) && greekMulti.updates.length > 0) {
        for (const upd of greekMulti.updates) {
          const targetStroke = pageData.strokes[upd.strokeIndex];
          if (targetStroke && Array.isArray(upd.points)) {
            targetStroke.points = upd.points;
            _invalidateStrokeCaches(targetStroke);
          }
        }
        if (pageData.canvas && pageData.ctx) {
          redrawPageCanvas(pageData);
        }
      }
      stroke.points = greekMulti.points;
      _invalidateStrokeCaches(stroke);
      showToast(greekMulti.label, greekMulti.icon);
      triggerSnapAnimation(pageData);
      return true;
    }
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const bboxDiag = Math.hypot(maxX - minX, maxY - minY);

  // 4. Freccia 1 tratto continuo (asta + 2 alette alla fine)
  if (allowArrow && pts.length >= 10 && bboxDiag >= 55 && detectSingleStrokeArrow(stroke, pageData, extraStrokes, pts)) {
    return true;
  }

  // 5. Linea dritta al rilascio
  if (allowLines && trySnapToLine(stroke, pts)) {
    showToast('Linea agganciata', '📏');
    triggerSnapAnimation(pageData);
    return true;
  }

  if (pts.length < 6 || bboxDiag < 22) return false;

  // 6. Simboli matematici a 1 tratto: (), [], {}, ∑
  if (allowMath) {
    const mathMatch = recognizeMathSymbolSingleStroke(pts);
    if (mathMatch) {
      stroke.points = mathMatch.points;
      _invalidateStrokeCaches(stroke);
      showToast(`Simbolo: ${mathMatch.label}`, mathMatch.icon);
      triggerSnapAnimation(pageData);
      return true;
    }
  }

  // 7. Lettere greche a 1 tratto (inclusa Σ maiuscola se math disattivato)
  if (allowGreek) {
    const upperSigma = !allowMath ? matchSummationOrUpperSigma(pts) : null;
    if (upperSigma) {
      stroke.points = upperSigma.points;
      _invalidateStrokeCaches(stroke);
      showToast('Lettera greca: Σ', 'Σ');
      triggerSnapAnimation(pageData);
      return true;
    }
    const greekMatch = recognizeGreekSingleStroke(pts);
    if (greekMatch) {
      stroke.points = greekMatch.points;
      _invalidateStrokeCaches(stroke);
      showToast(greekMatch.label, greekMatch.icon);
      triggerSnapAnimation(pageData);
      return true;
    }
  }

  return false;
}

export const detectAndSnapShape = detectReleaseShapeOrSymbol;

function triggerSnapAnimation(pageData) {
  if (!pageData?.wrapper) return;
  pageData.wrapper.classList.add('shape-snapped');
  setTimeout(() => {
    if (pageData?.wrapper) pageData.wrapper.classList.remove('shape-snapped');
  }, 250);
}

// ------------------------------------------------------------
// trySnapHighlighter — raddrizza mantenendo l'angolo
// ------------------------------------------------------------
export function trySnapHighlighter(stroke) {
  const cand = evaluateLineHoldCandidate(stroke.points);
  if (!cand || cand.chordLen < 80) return false;
  stroke.points = buildStraightLinePoints(cand.start, cand.end);
  _invalidateStrokeCaches(stroke);
  return true;
}