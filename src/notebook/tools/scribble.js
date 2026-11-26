// ============================================================
// SCRIBBLE-TO-ERASE
// ============================================================

import { state } from '../../shared/core/state.js';
import { showToast, sliderToBaseSize, fastHypot } from '../../shared/core/utils.js';
import { redrawPageCanvas, clearOverlay, drawScribbleStroke } from '../render/render.js';
import { invalidateStrokeBitmap } from '../render/stroke-cache.js';
import { getRawStrokeBBox, invalidateStrokeBBox } from '../render/stroke-geometry.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../../shared/persistence/autosave.js';

const SCRIBBLE_MIN_POINTS = 12;
const SCRIBBLE_MIN_REVERSALS = 7;
const SCRIBBLE_HIT_RADIUS = 6;
const SCRIBBLE_BBOX_PAD = 16;
const SCRIBBLE_STROKE_WEIGHT = 0.6;

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

// Throttle temporale: invece di controllare ogni 3 punti (che con la
// penna a 240Hz significa ogni 12ms — troppo frequente — e con batch
// grandi da 8-16 punti significa mai), controlliamo al massimo 1 volta
// ogni SCRIBBLE_CHECK_INTERVAL_MS. Indipendente dal rate di input.
const SCRIBBLE_CHECK_INTERVAL_MS = 30;

// Throttle temporale per l'aggiornamento dei target in scribble mode.
// Prima era basato su 15 punti, che con la penna significava ~10ms
// (troppo frequente) e con il mouse ~75ms (troppo diradato).
const SCRIBBLE_TARGET_INTERVAL_MS = 40;

let _lastScribbleTargetCheckTime = 0;
let _lastScribbleCheckTime = 0;

export function resetScribbleState() {
  state.scribbleMode = false;
  state.scribbleTargets = [];
  _lastScribbleTargetCheckTime = 0;
  _lastScribbleCheckTime = 0;
}

function resamplePoints(pts) {
  if (pts.length === 0) return [];
  const out = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (fastHypot(p.x - last.x, p.y - last.y) >= SCRIBBLE_RESAMPLE_DIST) {
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

function computeMultiReturnRatio(sampled, cellSize, skip) {
  const n = sampled.length;
  if (n < skip + 1) return 0;
  const cells = new Map();
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
    pathLen += fastHypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
  if (pathLen < 1) return 1;
  return fastHypot(end.x - start.x, end.y - start.y) / pathLen;
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
    if (i > 0) pathLen += fastHypot(p.x - sampled[i - 1].x, p.y - sampled[i - 1].y);
    if (i >= 2) {
      const v1x = sampled[i - 1].x - sampled[i - 2].x;
      const v1y = sampled[i - 1].y - sampled[i - 2].y;
      const v2x = sampled[i].x - sampled[i - 1].x;
      const v2y = sampled[i].y - sampled[i - 1].y;
      if (v1x * v2x + v1y * v2y < 0) reversalCount++;
    }
  }
  const bboxW = maxX - minX, bboxH = maxY - minY;
  const bboxDiag = fastHypot(bboxW, bboxH);
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

  // Cutoff temporale (non su pts.length): se lo stroke dura già più di
  // SCRIBBLE_MAX_DURATION_MS, non può essere uno scribble (isScribbleShape
  // lo rifiuterebbe comunque). Indipendente dal rate di input:
  //   - Mouse (60-240 pt/s): 100pt = 500-1500ms → cutoff a 100pt ~ 1200ms ✓
  //   - Penna (960-1920 pt/s): 100pt = 50-100ms → cutoff a 100pt blocca
  //     il check prima che l'utente abbia finito lo scribble ✗
  if (!state.scribbleMode && durationMs > SCRIBBLE_MAX_DURATION_MS) return;

  // Throttle temporale per la fase di rilevamento iniziale. Prima era
  // `pts.length % 3 === 0`, ma con la penna (batch da 8-16 punti) il
  // check può essere sistematicamente skippato (es. 100 → 108 → 116 →
  // 124: nessuno è multiplo di 3). Ora throttle a 1 check / 30ms.
  if (!state.scribbleMode) {
    const now = performance.now();
    if (now - _lastScribbleCheckTime < SCRIBBLE_CHECK_INTERVAL_MS) return;
    _lastScribbleCheckTime = now;
  }

  const overlayDpr = pageData.overlayDpr || pageData.dpr || 1;

  if (!state.scribbleMode) {
    if (!isScribbleShape(pts, durationMs)) return;
    state.scribbleMode = true;
    state.scribbleTargets = findStrokesIntersectingScribble(pts, pageData);
    _lastScribbleTargetCheckTime = performance.now();
    redrawPageCanvas(pageData);
    clearOverlay(pageData);
    drawScribbleStroke(pageData.overlayCtx, state.currentStroke, overlayDpr);
  } else {
    // Throttle temporale per l'aggiornamento dei target in scribble mode.
    // Prima era `pts.length - _lastScribbleTargetCheck < 15`, che con
    // la penna significava aggiornamenti ogni ~10ms (inutili e costosi)
    // e con il mouse ogni ~75ms (troppo diradato).
    const now = performance.now();
    if (now - _lastScribbleTargetCheckTime < SCRIBBLE_TARGET_INTERVAL_MS) return;
    _lastScribbleTargetCheckTime = now;
    const newTargets = findStrokesIntersectingScribble(pts, pageData);
    if (newTargets.length !== state.scribbleTargets.length) {
      state.scribbleTargets = newTargets;
      redrawPageCanvas(pageData);
      clearOverlay(pageData);
      drawScribbleStroke(pageData.overlayCtx, state.currentStroke, overlayDpr);
    }
  }
}

function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) {
    const ex = px - ax, ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

function findStrokesIntersectingScribble(scribblePoints, pageData) {
  if (scribblePoints.length === 0 || pageData.strokes.length === 0) return [];

  let sbMinX = Infinity, sbMaxX = -Infinity, sbMinY = Infinity, sbMaxY = -Infinity;
  for (const p of scribblePoints) {
    if (p.x < sbMinX) sbMinX = p.x; if (p.x > sbMaxX) sbMaxX = p.x;
    if (p.y < sbMinY) sbMinY = p.y; if (p.y > sbMaxY) sbMaxY = p.y;
  }
  sbMinX -= SCRIBBLE_BBOX_PAD; sbMaxX += SCRIBBLE_BBOX_PAD;
  sbMinY -= SCRIBBLE_BBOX_PAD; sbMaxY += SCRIBBLE_BBOX_PAD;

  const targets = [];
  for (const stroke of pageData.strokes) {
    const raw = getRawStrokeBBox(stroke);
    if (!raw) continue;
    if (raw.maxX < sbMinX || raw.minX > sbMaxX || raw.maxY < sbMinY || raw.minY > sbMaxY) continue;

    const strokeR = sliderToBaseSize(stroke.size) * SCRIBBLE_STROKE_WEIGHT;
    const threshold = SCRIBBLE_HIT_RADIUS + strokeR;
    const thresholdSq = threshold * threshold;

    let hit = false;
    for (const sp of stroke.points) {
      for (let i = 1; i < scribblePoints.length; i++) {
        const a = scribblePoints[i - 1];
        const b = scribblePoints[i];
        const abLen = fastHypot(b.x - a.x, b.y - a.y);
        const midX = (a.x + b.x) * 0.5;
        const midY = (a.y + b.y) * 0.5;
        const quickR = abLen * 0.5 + threshold;
        const dmx = sp.x - midX, dmy = sp.y - midY;
        if (dmx * dmx + dmy * dmy > quickR * quickR) continue;

        const dSq = pointToSegmentDistSq(sp.x, sp.y, a.x, a.y, b.x, b.y);
        if (dSq < thresholdSq) { hit = true; break; }
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
    for (const t of targets) {
      invalidateStrokeBitmap(t);
      invalidateStrokeBBox(t);
    }
    pageData.strokes = pageData.strokes.filter(s => !targets.includes(s));
    scheduleSave({ pageId: pageData?.pageId });
    pushHistory();
    showToast(
      targets.length === 1 ? 'Tratto cancellato' : `${targets.length} tratti cancellati`, '🧹'
    );
  }
  state.scribbleMode = false;
  state.scribbleTargets = [];
  _lastScribbleTargetCheckTime = 0;
  _lastScribbleCheckTime = 0;
  redrawPageCanvas(pageData);
  clearOverlay(pageData);
  return true;
}