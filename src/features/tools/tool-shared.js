// ============================================================
// TOOLS COMMON — helper condivisi.
//
// Highlighter è trattato come pen/marker in _renderBatchTarget:
// l'overlay è disegnato opaco, mix-blend-mode CSS si occupa
// dell'anteprima durante stroke.
// ============================================================

import { drawPredictions, clearPredictions, isPredictionSupported } from '../render/prediction.js';
import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, SHAPE_CAPABLE_TOOLS, fastHypot } from '../../core/utils.js';
import {
  drawIncrementalBatch, drawScribbleSegment
} from '../render/render.js';
import { checkForScribble } from './scribble.js';
import { trySnapToLineDuringDraw } from './shapes.js';
import { getToolbarSettings } from '../toolbar/toolbar-settings.js';

const MAX_BATCH_POINTS = 16;

export const _useRawPointerUpdate =
  typeof window !== 'undefined' && 'onpointerrawupdate' in window;

export function isPenEraser(e) {
  if (!e) return false;
  if (e.pointerType === 'eraser') return true;
  if (e.button === 5) return true;
  if (typeof e.buttons === 'number' && (e.buttons & 32) !== 0) return true;
  return false;
}

const _pointPool = [];
let _pointPoolIdx = 0;

export function resetPointPool() { _pointPoolIdx = 0; }

let _strokeRect = null;
let _strokeRectCanvas = null;
let _strokeRectScale = 0;
let _strokeRectX = 0;
let _strokeRectY = 0;

export function invalidateStrokeRect() {
  _strokeRect = null;
  _strokeRectCanvas = null;
  _strokeRectScale = 0;
  _strokeRectX = 0;
  _strokeRectY = 0;
}

export function getCanvasRect(canvas) {
  if (_strokeRect &&
      _strokeRectCanvas === canvas &&
      _strokeRectScale === viewport.scale &&
      _strokeRectX === viewport.x &&
      _strokeRectY === viewport.y) {
    return _strokeRect;
  }
  _strokeRect = canvas.getBoundingClientRect();
  _strokeRectCanvas = canvas;
  _strokeRectScale = viewport.scale;
  _strokeRectX = viewport.x;
  _strokeRectY = viewport.y;
  return _strokeRect;
}

export function getCanvasCoords(e, canvas) {
  const rect = getCanvasRect(canvas);
  let p;
  if (_pointPoolIdx < _pointPool.length) {
    p = _pointPool[_pointPoolIdx++];
  } else {
    p = { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 0, pointerType: 'pen' };
    _pointPool.push(p);
    _pointPoolIdx++;
  }
  p.x = (e.clientX - rect.left) * (PAGE_WIDTH / rect.width);
  p.y = (e.clientY - rect.top) * (PAGE_HEIGHT / rect.height);
  p.pressure = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
  p.tiltX = e.tiltX || 0;
  p.tiltY = e.tiltY || 0;
  p.speed = 0;
  p.pointerType = e.pointerType;
  return p;
}

function smoothPressure(points, newPressure) {
  const n = points.length;
  if (n === 0) return newPressure;
  const wNew = 0.6, count = Math.min(3, n), wOld = 0.4 / count;
  let acc = newPressure * wNew;
  for (let i = n - count; i < n; i++) acc += (points[i].pressure || 0.5) * wOld;
  return Math.max(0.05, Math.min(1, acc));
}

function smoothRawPoint(rawPoint, prevSmoothed) {
  const smoothness = Math.max(0, Math.min(1, state.smoothing));
  if (!prevSmoothed || smoothness <= 0.01) return rawPoint;
  const dx = rawPoint.x - prevSmoothed.x;
  const dy = rawPoint.y - prevSmoothed.y;
  const speed = fastHypot(dx, dy);
  const minAlpha = 0.85 - smoothness * 0.55;
  const alpha = Math.min(1.0, minAlpha + speed * 0.05);
  rawPoint.x = prevSmoothed.x + dx * alpha;
  rawPoint.y = prevSmoothed.y + dy * alpha;
  return rawPoint;
}

const _flushState = { points: [], rafId: null, pageData: null };

export function pushPointsToBatch(points) {
  for (let i = 0; i < points.length; i++) _flushState.points.push(points[i]);
}

function _processPointerPoint(rawPoint, pageData) {
  if (state.pendingShape) return;
  if (!state.currentStroke || !state.isDrawing) return;
  const prevSmoothed = state.currentStroke.points[state.currentStroke.points.length - 1];
  const smoothedPos = smoothRawPoint(rawPoint, prevSmoothed);
  let smoothedPressure = rawPoint.pressure;
  if (rawPoint.pointerType === 'pen' && state.currentStroke.points.length > 0) {
    smoothedPressure = smoothPressure(state.currentStroke.points, rawPoint.pressure);
  }
  const minDist = state.smoothing <= 0.01 ? 0.01 : 0.4;
  if (prevSmoothed && fastHypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y) < minDist) return;
  const speedPx = prevSmoothed ? fastHypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y) : 0;
  const smoothedPoint = {
    x: smoothedPos.x, y: smoothedPos.y, pressure: smoothedPressure,
    tiltX: rawPoint.tiltX, tiltY: rawPoint.tiltY, speed: speedPx, pointerType: rawPoint.pointerType
  };
  state.currentStroke.points.push(smoothedPoint);
  if (state.currentStroke._pathLen === undefined) state.currentStroke._pathLen = 0;
  if (state.currentStroke.points.length >= 2) {
    const prev = state.currentStroke.points[state.currentStroke.points.length - 2];
    state.currentStroke._pathLen += fastHypot(smoothedPoint.x - prev.x, smoothedPoint.y - prev.y);
  }
  if (state.scribbleMode) {
    drawScribbleSegment(pageData.overlayCtx, state.currentStroke,
                        pageData.overlayDpr || pageData.dpr);
  }
}

function _runPostBatchChecks(pageData) {
  if (!state.currentStroke || !state.isDrawing) return;
  if (state.pendingShape) return;
  const pts = state.currentStroke.points;
  if (pts.length === 0) return;

  if (state.scribbleEnabled === true) {
    checkForScribble(pageData);
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;
  }

  if (!state.scribbleMode && state.autoShapeEnabled &&
      SHAPE_CAPABLE_TOOLS.includes(state.activeTool) &&
      pts.length >= 6 && pts.length < 200) {
    const lastCheck = state.currentStroke._lastSnapCheck || 0;
    if (pts.length - lastCheck >= 10) {
      state.currentStroke._lastSnapCheck = pts.length;
      trySnapToLineDuringDraw(pageData, pts[pts.length - 1]);
    }
  }
}

function _renderBatchTarget(pageData, drawnIdx) {
  if (!state.currentStroke) return;

  // Highlighter: disegna opaco sull'overlay, mix-blend-mode CSS
  // fa l'anteprima semitrasparente.
  if (state.currentStroke.tool === 'highlighter') {
    const opacity = getToolbarSettings().tools.highlighter.opacity ?? 0.6;
    const oc = pageData.overlayCanvas;
    if (oc) {
      oc.style.opacity = String(opacity);
      oc.style.mixBlendMode = state.isDarkMode ? 'screen' : 'multiply';
    }
  } else {
    const oc = pageData.overlayCanvas;
    if (oc && oc.style.opacity) {
      oc.style.opacity = '';
      oc.style.mixBlendMode = '';
    }
  }

  const targetCtx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr;
  drawIncrementalBatch(targetCtx, state.currentStroke, drawnIdx, dpr);
  state.currentStroke._drawnIdx = state.currentStroke.points.length;
}

export function scheduleFlush(pageData) {
  _flushState.pageData = pageData;
  if (_flushState.points.length >= MAX_BATCH_POINTS) {
    if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
    _doFlush(); return;
  }
  if (_flushState.rafId !== null) return;
  _flushState.rafId = requestAnimationFrame(_doFlush);
}

function _doFlush() {
  _flushState.rafId = null;
  const pageData = _flushState.pageData;
  const batch = _flushState.points;
  _flushState.points = [];
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;
    clearPredictions(pageData);

    const drawnIdx = state.currentStroke._drawnIdx || 0;

    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }

    if (state.currentStroke && state.isDrawing &&
        !state.pendingShape && !state.scribbleMode) {
      _renderBatchTarget(pageData, drawnIdx);
    }

    _runPostBatchChecks(pageData);
  } finally {
    resetPointPool();
  }
}

export function cancelFlush() {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  _flushState.points = [];
  _flushState.pageData = null;
  resetPointPool();
}

export function forceFlushNow(pageData) {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  const batch = _flushState.points;
  _flushState.points = [];
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;

    const drawnIdx = state.currentStroke._drawnIdx || 0;

    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }

    if (state.currentStroke && state.isDrawing &&
        !state.pendingShape && !state.scribbleMode) {
      _renderBatchTarget(pageData, drawnIdx);
    }

    if (!state.currentStroke || !state.isDrawing) return;
    checkForScribble(pageData);
  } finally {
    resetPointPool();
  }
}

export { isPredictionSupported, drawPredictions };