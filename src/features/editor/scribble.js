// ============================================================
// SCRIBBLE-TO-ERASE
// ============================================================

import { state } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import { redrawPageCanvas, clearOverlay, drawScribbleStroke } from './render.js';
import { pushHistory } from './history.js';
import { scheduleSave } from './autosave.js';

const SCRIBBLE_MIN_POINTS = 12;
const SCRIBBLE_MIN_REVERSALS = 7;
const SCRIBBLE_HIT_RADIUS = 20;
const SCRIBBLE_MAX_DURATION_MS = 1200;
const SCRIBBLE_MAX_BBOX_DIAGONAL = 180;
const SCRIBBLE_MAX_PATH_LEN = 1500;
const SCRIBBLE_MIN_AVG_SPEED = 100;
const SCRIBBLE_MIN_RETURN_RATIO = 0.50;
const SCRIBBLE_MIN_MULTI_RETURN_RATIO = 0.12;
const SCRIBBLE_RETURN_RADIUS = 6;
const SCRIBBLE_RETURN_SKIP = 8;
const SCRIBBLE_MAX_NET_RATIO_2D = 0.38;
const SCRIBBLE_RESAMPLE_DIST = 2.0;

let _lastScribbleTargetCheck = 0;

function resamplePoints(pts) {
  if (pts.length === 0) return [];
  const out = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= SCRIBBLE_RESAMPLE_DIST) {
      out.push(p); last = p;
    }
  }
  const lastOrig = pts[pts.length - 1];
  if (out[out.length - 1] !== lastOrig) out.push(lastOrig);
  return out;
}

function computeReturnRatio(sampled, cellSize, skip) {
  const n = sampled.length;
  if (n < skip + 1) return 0;
  const cells = new Map();
  let returns = 0;
  for (let i = 0; i < n; i++) {
    const p = sampled[i];
    const cx = Math.floor(p.x / cellSize), cy = Math.floor(p.y / cellSize);
    let hasReturn = false;
    for (let dx = -1; dx <= 1 && !hasReturn; dx++) {
      for (let dy = -1; dy <= 1 && !hasReturn; dy++) {
        const key = (cx + dx) + ',' + (cy + dy);
        const prevIdx = cells.get(key);
        if (prevIdx !== undefined && i - prevIdx >= skip) hasReturn = true;
      }
    }
    if (hasReturn) returns++;
    cells.set(cx + ',' + cy, i);
  }
  return returns / n;
}

// Conta la frazione di punti in celle visitate 3+ volte (multi-return).
// Scribble vero: alta densità. Parola: quasi zero.
function computeMultiReturnRatio(sampled, cellSize, skip) {
  const n = sampled.length;
  if (n < skip + 1) return 0;
  const cells = new Map();  // key -> array di indici
  let multiReturns = 0;
  for (let i = 0; i < n; i++) {
    const p = sampled[i];
    const cx = Math.floor(p.x / cellSize), cy = Math.floor(p.y / cellSize);
    const key = cx + ',' + cy;
    const arr = cells.get(key);
    if (arr) {
      let count = 0;
      for (const prevIdx of arr) if (i - prevIdx >= skip) count++;
      if (count >= 2) multiReturns++;
      arr.push(i);
    } else {
      cells.set(key, [i]);
    }
  }
  return multiReturns / n;
}

function computeNetRatio2D(sampled) {
  if (sampled.length < 2) return 1;
  const start = sampled[0], end = sampled[sampled.length - 1];
  let pathLen = 0;
  for (let i = 1; i < sampled.length; i++)
    pathLen += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
  if (pathLen < 1) return 1;
  return Math.hypot(end.x - start.x, end.y - start.y) / pathLen;
}

function isScribbleShape(pts, durationMs) {
  if (pts.length < SCRIBBLE_MIN_POINTS) return false;
  if (!durationMs || durationMs > SCRIBBLE_MAX_DURATION_MS) return false;
  const sampled = resamplePoints(pts);
  if (sampled.length < SCRIBBLE_MIN_POINTS) return false;
  let reversalCount = 0, pathLen = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < sampled.length; i++) {
    const p = sampled[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (i > 0) pathLen += Math.hypot(p.x - sampled[i - 1].x, p.y - sampled[i - 1].y);
    if (i >= 2) {
      const v1x = sampled[i - 1].x - sampled[i - 2].x;
      const v1y = sampled[i - 1].y - sampled[i - 2].y;
      const v2x = sampled[i].x - sampled[i - 1].x;
      const v2y = sampled[i].y - sampled[i - 1].y;
      if (v1x * v2x + v1y * v2y < 0) reversalCount++;
    }
  }
  const bboxW = maxX - minX, bboxH = maxY - minY;
  const bboxDiag = Math.hypot(bboxW, bboxH);
  const avgSpeed = pathLen / (durationMs / 1000);
  const returnRatio = computeReturnRatio(sampled, SCRIBBLE_RETURN_RADIUS, SCRIBBLE_RETURN_SKIP);
  const multiReturnRatio = computeMultiReturnRatio(sampled, SCRIBBLE_RETURN_RADIUS, SCRIBBLE_RETURN_SKIP);
  const netRatio2D = computeNetRatio2D(sampled);
  if (bboxDiag < 15) return false;
  if (bboxDiag > SCRIBBLE_MAX_BBOX_DIAGONAL) return false;
  if (pathLen > SCRIBBLE_MAX_PATH_LEN) return false;
  if (reversalCount < SCRIBBLE_MIN_REVERSALS) return false;
  if (avgSpeed < SCRIBBLE_MIN_AVG_SPEED) return false;
  if (returnRatio < SCRIBBLE_MIN_RETURN_RATIO) return false;
  if (multiReturnRatio < SCRIBBLE_MIN_MULTI_RETURN_RATIO) return false;
  if (netRatio2D > SCRIBBLE_MAX_NET_RATIO_2D) return false;
  return true;
}

export function checkForScribble(pageData) {
  if (!state.currentStroke) return;
  if (state.activeTool === 'eraser' || state.activeTool === 'lasso') return;
  const pts = state.currentStroke.points;
  if (pts.length < SCRIBBLE_MIN_POINTS) return;
  const startTime = state.currentStroke.startTime || performance.now();
  const durationMs = performance.now() - startTime;
  const overlayDpr = pageData.overlayDpr || pageData.dpr || 1;

  if (!state.scribbleMode) {
    if (pts.length % 3 !== 0) return;
    if (!isScribbleShape(pts, durationMs)) return;
    state.scribbleMode = true;
    state.scribbleTargets = findStrokesIntersectingScribble(pts, pageData);
    _lastScribbleTargetCheck = pts.length;
    redrawPageCanvas(pageData);
    // FIX COLORE: l'overlay contiene i primi punti disegnati col colore
    // originale del tool. Cancellalo e ridisegna l'intero stroke in rosso.
    clearOverlay(pageData);
    drawScribbleStroke(pageData.overlayCtx, state.currentStroke, overlayDpr);
  } else {
    if (pts.length - _lastScribbleTargetCheck < 15) return;
    _lastScribbleTargetCheck = pts.length;
    const newTargets = findStrokesIntersectingScribble(pts, pageData);
    if (newTargets.length !== state.scribbleTargets.length) {
      state.scribbleTargets = newTargets;
      redrawPageCanvas(pageData);
      // Coerenza overlay quando cambiano i target
      clearOverlay(pageData);
      drawScribbleStroke(pageData.overlayCtx, state.currentStroke, overlayDpr);
    }
  }
}

function findStrokesIntersectingScribble(scribblePoints, pageData) {
  if (scribblePoints.length === 0 || pageData.strokes.length === 0) return [];
  let sbMinX = Infinity, sbMaxX = -Infinity, sbMinY = Infinity, sbMaxY = -Infinity;
  for (const p of scribblePoints) {
    if (p.x < sbMinX) sbMinX = p.x; if (p.x > sbMaxX) sbMaxX = p.x;
    if (p.y < sbMinY) sbMinY = p.y; if (p.y > sbMaxY) sbMaxY = p.y;
  }
  const pad = SCRIBBLE_HIT_RADIUS;
  sbMinX -= pad; sbMaxX += pad; sbMinY -= pad; sbMaxY += pad;
  const targets = [];
  for (const stroke of pageData.strokes) {
    let stMinX = Infinity, stMaxX = -Infinity, stMinY = Infinity, stMaxY = -Infinity;
    for (const p of stroke.points) {
      if (p.x < stMinX) stMinX = p.x; if (p.x > stMaxX) stMaxX = p.x;
      if (p.y < stMinY) stMinY = p.y; if (p.y > stMaxY) stMaxY = p.y;
    }
    if (stMaxX < sbMinX || stMinX > sbMaxX || stMaxY < sbMinY || stMinY > sbMaxY) continue;
    let hit = false;
    for (const sp of stroke.points) {
      for (const xp of scribblePoints) {
        if (Math.hypot(sp.x - xp.x, sp.y - xp.y) < SCRIBBLE_HIT_RADIUS) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) targets.push(stroke);
  }
  return targets;
}

export function finalizeScribble(pageData) {
  if (!state.scribbleMode) return false;
  const targets = findStrokesIntersectingScribble(
    state.currentStroke ? state.currentStroke.points : [], pageData
  );
  if (targets.length > 0) {
    pageData.strokes = pageData.strokes.filter(s => !targets.includes(s));
    scheduleSave();
    pushHistory();
    showToast(
      targets.length === 1 ? 'Tratto cancellato' : `${targets.length} tratti cancellati`, '🧹'
    );
  }
  state.scribbleMode = false;
  state.scribbleTargets = [];
  _lastScribbleTargetCheck = 0;
  redrawPageCanvas(pageData);
  clearOverlay(pageData);
  return true;
}