// ============================================================
// TOOLS COMMON — helper condivisi fra tutti i tool:
// coordinate, smoothing, batching rAF, prediction clear, hold snap.
// ============================================================

import { drawPredictions, clearPredictions, isPredictionSupported } from '../render/prediction.js';
import { drawIncrementalBatch, drawScribbleSegment, clearOverlay, renderFullStroke } from '../render/render.js';
import { getRawStrokeBBox, setNonEnumerable } from '../render/stroke-geometry.js';
import { state, viewport } from '../../shared/core/state.js';
import {
  PAGE_WIDTH, PAGE_HEIGHT, SHAPE_CAPABLE_TOOLS, fastHypot,
  isPaperDark, sliderToBaseSize
} from '../../shared/core/utils.js';
import { getDeviceProfile } from '../platform/profiles/index.js';
import { checkForScribble } from './scribble.js';
import { trySnapLineDuringDraw, trySnapGeometricShapeDuringDraw } from './shapes.js';
import {
  getPressureParams,
  normalizePenPressure,
  createStrokeStabilizer,
  getHoldMoveTolerancePx,
  extractEventTilt
} from './ink-calibration.js';

const MAX_BATCH_POINTS = 16;
const MAX_POOL_SIZE = 2000;

// Hold-to-snap stile GoodNotes SOLO per forme geometriche (cerchi, ellissi, rettangoli, triangoli)
const HOLD_SNAP_DELAY_MS = 320;

let _lastValidPenPressure = 0;

export function resetLastValidPenPressure() {
  _lastValidPenPressure = 0;
}

export function seedLastValidPenPressure(pressure) {
  if (Number.isFinite(pressure) && pressure > 0) {
    _lastValidPenPressure = Math.max(0.02, Math.min(1.0, pressure));
  }
}

// pointermove + getCoalescedEvents() + getPredictedEvents() garantisce
// predizione attiva e minor carico CPU su Surface Go 1 / Android / WebView.
export const _useRawPointerUpdate = false;

let _holdSnapTimer = null;
let _holdPageData = null;

export function clearLineHoldTimer() {
  if (_holdSnapTimer !== null) {
    clearTimeout(_holdSnapTimer);
    _holdSnapTimer = null;
  }
  _holdPageData = null;
}

function _hasGeometricHoldShapesEnabled() {
  if (!state.snapShapes) return false;
  return state.snapCircles !== false ||
         state.snapRectangles !== false ||
         state.snapTriangles !== false;
}

function _hasHoldSnapEnabled() {
  return state.snapLines !== false || _hasGeometricHoldShapesEnabled();
}

function _armShapeHoldTimer(pageData, stroke, delayMs) {
  clearLineHoldTimer();
  _holdPageData = pageData;
  _holdSnapTimer = setTimeout(() => {
    _holdSnapTimer = null;
    const targetPage = _holdPageData;
    _holdPageData = null;
    if (!targetPage || !state.isDrawing || state.pendingShape || state.scribbleMode) return;
    if (state.currentStroke !== stroke) return;
    if (!_hasHoldSnapEnabled() || !SHAPE_CAPABLE_TOOLS.includes(state.activeTool)) return;
    const pts = stroke.points;
    if (!pts || pts.length < 4) return;
    if (state.snapLines !== false && trySnapLineDuringDraw(targetPage, stroke)) {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
      return;
    }
    if (_hasGeometricHoldShapesEnabled() && pts.length >= 8 && trySnapGeometricShapeDuringDraw(targetPage, stroke)) {
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
    }
  }, delayMs);
}

// ------------------------------------------------------------
// Riconoscimento pen-eraser (tasto laterale penna)
// ------------------------------------------------------------
export function isPenEraser(e) {
  if (!e) return false;
  if (e.pointerType === 'eraser') return true;
  if (e.button === 5) return true;
  if (typeof e.buttons === 'number' && (e.buttons & 32) !== 0) return true;
  return false;
}

// ------------------------------------------------------------
// Pool di punti (evita allocazioni nel hot path)
// ------------------------------------------------------------
const _pointPool = [];
let _pointPoolIdx = 0;

export function resetPointPool() {
  _pointPoolIdx = 0;
  if (_pointPool.length > MAX_POOL_SIZE) {
    _pointPool.length = MAX_POOL_SIZE;
  }
}

// ------------------------------------------------------------
// Cache rect canvas
// ------------------------------------------------------------
let _strokeRect = null;

export function invalidateStrokeRect() {
  _strokeRect = null;
}

export function getCanvasRect(canvas) {
  if (_strokeRect &&
      _strokeRect._cacheCanvas === canvas &&
      _strokeRect._cacheVpScale === viewport.scale &&
      _strokeRect._cacheVpX === viewport.x &&
      _strokeRect._cacheVpY === viewport.y) {
    return _strokeRect;
  }
  const r = canvas.getBoundingClientRect();
  const w = r.width > 0 ? r.width : 1;
  const h = r.height > 0 ? r.height : 1;
  _strokeRect = {
    left: r.left, top: r.top,
    width: r.width, height: r.height,
    right: r.right, bottom: r.bottom,
    x: r.x, y: r.y,
    scaleX: PAGE_WIDTH / w,
    scaleY: PAGE_HEIGHT / h,
    _cacheCanvas: canvas,
    _cacheVpScale: viewport.scale,
    _cacheVpX: viewport.x,
    _cacheVpY: viewport.y
  };
  return _strokeRect;
}

export function getCanvasCoords(e, canvas, fallbackPointerType = null) {
  const rect = getCanvasRect(canvas);

  let p;
  if (_pointPoolIdx < _pointPool.length) {
    p = _pointPool[_pointPoolIdx++];
  } else {
    p = {
      x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 0,
      pointerType: 'pen', timeStamp: 0, _pressureFallback: false
    };
    _pointPool.push(p);
    _pointPoolIdx++;
  }
  p.x = (e.clientX - rect.left) * rect.scaleX;
  p.y = (e.clientY - rect.top) * rect.scaleY;

  const ptrType = e.pointerType || fallbackPointerType || '';
  p._pressureFallback = false;

  if (ptrType === 'pen') {
    const sens = getPressureParams().sensitivity;
    const rawP = Number.isFinite(e.pressure) ? e.pressure : 0;
    const isFallback = rawP <= 0;
    const norm = normalizePenPressure(rawP, {
      platform: state.platform.family,
      sensitivity: sens,
      isDrawing: state.isDrawing,
      lastValidPressure: state.isDrawing ? _lastValidPenPressure : 0
    });
    p._pressureFallback = isFallback;
    if (state.isDrawing && !isFallback) {
      _lastValidPenPressure = norm;
    }
    p.pressure = norm;
  } else {
    p.pressure = 0.5;
  }

  if (e.tiltX || e.tiltY) {
    p.tiltX = e.tiltX || 0;
    p.tiltY = e.tiltY || 0;
  } else if (Number.isFinite(e.altitudeAngle) && e.altitudeAngle < Math.PI / 2) {
    const t = extractEventTilt(e);
    p.tiltX = t.tiltX;
    p.tiltY = t.tiltY;
  } else {
    p.tiltX = 0;
    p.tiltY = 0;
  }
  p.speed = 0;
  p.pointerType = ptrType;
  p.timeStamp = e.timeStamp || 0;
  return p;
}

// ------------------------------------------------------------
// Batching rAF con buffer swap preallocato
// ------------------------------------------------------------
let _bufferA = [];
let _bufferB = [];
let _activeBuffer = _bufferA;

const _flushState = { rafId: null, pageData: null };

function _takeBuffer() {
  const batch = _activeBuffer;
  _activeBuffer = (_activeBuffer === _bufferA) ? _bufferB : _bufferA;
  _activeBuffer.length = 0;
  return batch;
}

export function pushPointsToBatch(points) {
  for (let i = 0; i < points.length; i++) _activeBuffer.push(points[i]);
}

function _processPointerPoint(rawPoint, pageData) {
  if (state.pendingShape) return;
  if (!state.currentStroke || !state.isDrawing) return;
  const stroke = state.currentStroke;

  if (!stroke._stabilizer) {
    const firstPt = stroke.points[0] || rawPoint;
    stroke._stabilizer = createStrokeStabilizer(firstPt, { platform: state.platform.family });
  }

  if (rawPoint.pointerType === 'pen' && !rawPoint._pressureFallback) {
    stroke._hasSeenRealPressure = true;
  }

  // iPadOS Apple Pencil a volte emette pressure=0 sul pointerdown iniziale prima
  // del primo valore reale su pointermove: sostituisce retroattivamente il fallback 0.28
  // per evitare il pallino spesso in testa ai tratti leggeri.
  if (stroke._pendingInitialPressure && rawPoint.pointerType === 'pen' && !rawPoint._pressureFallback) {
    const synCount = Math.min(stroke.points.length, stroke._syntheticPointCount || 1);
    for (let i = 0; i < synCount; i++) {
      stroke.points[i].pressure = rawPoint.pressure;
    }
    stroke._pendingInitialPressure = false;
    stroke._syntheticPointCount = 0;
    if (typeof stroke._stabilizer.seedInitialPressure === 'function') {
      stroke._stabilizer.seedInitialPressure(rawPoint.pressure);
    }
    seedLastValidPenPressure(rawPoint.pressure);
    if ((stroke._drawnIdx || 0) > 0) {
      stroke._needsOverlayRebase = true;
    }
  }

  const filt = stroke._stabilizer.filterPoint(rawPoint, {
    smoothing: state.smoothing,
    scale: viewport.scale
  });
  if (!filt.accepted) return;

  const prevSmoothed = stroke.points[stroke.points.length - 1];
  let speedPx = 0;
  if (prevSmoothed) {
    const dist = filt.distFromAccepted;
    const rawDt = filt.dtMs || 8.33;
    const instantSpeed = (dist / Math.max(2, rawDt)) * 16.67;
    const ema = stroke._emaSpeed !== undefined
      ? stroke._emaSpeed * 0.65 + instantSpeed * 0.35
      : instantSpeed;
    stroke._emaSpeed = ema;
    speedPx = ema;
  }
  if (rawPoint.timeStamp > 0) stroke._lastPointTs = rawPoint.timeStamp;

  const smoothedPoint = {
    x: filt.x,
    y: filt.y,
    pressure: rawPoint.pointerType === 'pen' ? filt.pressure : rawPoint.pressure,
    tiltX: rawPoint.tiltX,
    tiltY: rawPoint.tiltY,
    speed: speedPx,
    pointerType: rawPoint.pointerType
  };
  stroke.points.push(smoothedPoint);
  const profile = getDeviceProfile(state.platform?.family);
  const landingRadius = profile.input.landingStabilizePx || 0;
  if (landingRadius > 0 && stroke.points.length === 3) {
    const p0 = stroke.points[0];
    const p1 = stroke.points[1];
    const p2 = stroke.points[2];
    const d01 = fastHypot(p1.x - p0.x, p1.y - p0.y);
    const d12 = fastHypot(p2.x - p1.x, p2.y - p1.y);
    if (d01 > 0.05 && d01 <= landingRadius * 1.4 && d12 >= 3.0) {
      const dot = ((p1.x - p0.x) * (p2.x - p1.x) + (p1.y - p0.y) * (p2.y - p1.y)) / (d01 * d12);
      if (dot < 0.35) {
        const ux = (p2.x - p1.x) / d12;
        const uy = (p2.y - p1.y) / d12;
        const back = Math.min(1.0, d01 * 0.4);
        p0.x = p1.x - ux * back;
        p0.y = p1.y - uy * back;
        p0.pressure = p1.pressure;
        stroke._pathLen = fastHypot(p1.x - p0.x, p1.y - p0.y) + d12;
        stroke._needsOverlayRebase = true;
      }
    }
  }
  if (stroke._pendingInitialPressure && rawPoint.pointerType === 'pen' && rawPoint._pressureFallback) {
    stroke._syntheticPointCount = (stroke._syntheticPointCount || 1) + 1;
  }
  if (stroke._pathLen === undefined) stroke._pathLen = 0;
  if (stroke.points.length >= 2) {
    const prev = stroke.points[stroke.points.length - 2];
    stroke._pathLen += fastHypot(smoothedPoint.x - prev.x, smoothedPoint.y - prev.y);
  }

  // Aggiorna ancora "hold" solo se la punta filtrata si sposta oltre la tolleranza zoom-aware
  const holdTol = getHoldMoveTolerancePx(viewport.scale, state.platform?.family);
  if (stroke._holdAnchorX === undefined) {
    stroke._holdAnchorX = smoothedPoint.x;
    stroke._holdAnchorY = smoothedPoint.y;
    stroke._lastMoveTime = performance.now();
  } else {
    const hdx = smoothedPoint.x - stroke._holdAnchorX;
    const hdy = smoothedPoint.y - stroke._holdAnchorY;
    if (fastHypot(hdx, hdy) > holdTol) {
      stroke._holdAnchorX = smoothedPoint.x;
      stroke._holdAnchorY = smoothedPoint.y;
      stroke._lastMoveTime = performance.now();
      clearLineHoldTimer();
    }
  }

  if (state.scribbleMode) {
    drawScribbleSegment(pageData.overlayCtx, stroke,
                        pageData.overlayDpr || pageData.dpr);
  }
}

function _runPostBatchChecks(pageData) {
  if (!state.currentStroke || !state.isDrawing) {
    clearLineHoldTimer();
    return;
  }
  if (state.pendingShape) {
    clearLineHoldTimer();
    return;
  }
  const pts = state.currentStroke.points;
  if (pts.length === 0) return;
  checkForScribble(pageData);
  if (!state.currentStroke || !state.isDrawing || state.pendingShape || state.scribbleMode) {
    clearLineHoldTimer();
    return;
  }

  // Snap live dopo breve pausa con punta ferma:
  //   - linee dritte (4+ punti) con maniglie e snap H/V
  //   - forme geometriche (8+ punti): cerchi, ellissi, rettangoli, triangoli
  const minHoldPts = (state.snapLines !== false) ? 4 : 8;
  if (_hasHoldSnapEnabled() &&
      SHAPE_CAPABLE_TOOLS.includes(state.activeTool) &&
      pts.length >= minHoldPts) {
    if (_holdSnapTimer === null || _holdPageData !== pageData) {
      const stroke = state.currentStroke;
      const elapsed = performance.now() - (stroke._lastMoveTime || stroke.startTime || performance.now());
      const remaining = Math.max(16, HOLD_SNAP_DELAY_MS - elapsed);
      _armShapeHoldTimer(pageData, stroke, remaining);
    }
  } else {
    clearLineHoldTimer();
  }
}

function _renderBatchTarget(pageData, drawnIdx) {
  if (!state.currentStroke) return;

  const oc = pageData.overlayCanvas;
  const stroke = state.currentStroke;
  const opacity = stroke.opacity != null ? stroke.opacity : 1.0;

  if (oc) {
    if (opacity < 1.0) {
      oc.style.opacity = String(opacity);
    } else {
      oc.style.opacity = '';
    }
    if (stroke.tool === 'highlighter') {
      oc.style.mixBlendMode = state.isDarkMode ? 'screen' : 'multiply';
    } else {
      oc.style.mixBlendMode = '';
    }
  }

  const targetCtx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr;
  const profile = getDeviceProfile(state.platform?.family);
  if (profile.rendering.redrawActiveStrokeOnOverlay &&
      (stroke.tool === 'pen' || stroke.tool === 'marker') &&
      (!stroke.style || stroke.style === 'solid') &&
      stroke.points.length >= 2 &&
      stroke.points.length <= 1200) {
    const rawBBox = getRawStrokeBBox(stroke);
    if (oc && targetCtx && rawBBox) {
      const pad = Math.max(24, sliderToBaseSize(stroke.size) * 3.5 + 16);
      const prevBox = stroke._prevOverlayBBox;
      const cMinX = prevBox ? Math.min(prevBox.minX, rawBBox.minX - pad) : (rawBBox.minX - pad);
      const cMinY = prevBox ? Math.min(prevBox.minY, rawBBox.minY - pad) : (rawBBox.minY - pad);
      const cMaxX = prevBox ? Math.max(prevBox.maxX, rawBBox.maxX + pad) : (rawBBox.maxX + pad);
      const cMaxY = prevBox ? Math.max(prevBox.maxY, rawBBox.maxY + pad) : (rawBBox.maxY + pad);
      const px0 = Math.max(0, Math.floor(cMinX * dpr));
      const py0 = Math.max(0, Math.floor(cMinY * dpr));
      const px1 = Math.min(oc.width, Math.ceil(cMaxX * dpr));
      const py1 = Math.min(oc.height, Math.ceil(cMaxY * dpr));
      if (px1 > px0 && py1 > py0) {
        targetCtx.save();
        targetCtx.setTransform(1, 0, 0, 1, 0, 0);
        targetCtx.clearRect(px0, py0, px1 - px0, py1 - py0);
        targetCtx.restore();
      }
      setNonEnumerable(stroke, '_prevOverlayBBox', {
        minX: rawBBox.minX - pad,
        minY: rawBBox.minY - pad,
        maxX: rawBBox.maxX + pad,
        maxY: rawBBox.maxY + pad
      });
    }
    targetCtx.save();
    targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderFullStroke(targetCtx, stroke, isPaperDark(state.isDarkMode, state.paperColor), null, { opaqueStroke: true });
    targetCtx.restore();
    stroke._drawnIdx = stroke.points.length;
    return;
  }
  drawIncrementalBatch(targetCtx, stroke, drawnIdx, dpr);
  stroke._drawnIdx = stroke.points.length;
}

export function scheduleFlush(pageData) {
  _flushState.pageData = pageData;
  if (_activeBuffer.length >= MAX_BATCH_POINTS) {
    if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
    _doFlush(); return;
  }
  if (_flushState.rafId !== null) return;
  _flushState.rafId = requestAnimationFrame(_doFlush);
}

function _doFlush() {
  _flushState.rafId = null;
  const pageData = _flushState.pageData;
  const batch = _takeBuffer();
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;
    clearPredictions(pageData);

    let drawnIdx = state.currentStroke._drawnIdx || 0;

    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }

    if (state.currentStroke && state.isDrawing &&
        !state.pendingShape && !state.scribbleMode) {
      if (state.currentStroke._needsOverlayRebase) {
        state.currentStroke._needsOverlayRebase = false;
        state.currentStroke._dashOffset = null;
        clearOverlay(pageData);
        drawnIdx = 0;
      }
      _renderBatchTarget(pageData, drawnIdx);
    }

    _runPostBatchChecks(pageData);
  } finally {
    batch.length = 0;
    resetPointPool();
  }
}

export function cancelFlush() {
  clearLineHoldTimer();
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  _activeBuffer.length = 0;
  _flushState.pageData = null;
  resetPointPool();
}

export function forceFlushNow(pageData) {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  const batch = _takeBuffer();
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;

    let drawnIdx = state.currentStroke._drawnIdx || 0;

    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }

    if (state.currentStroke && state.isDrawing &&
        !state.pendingShape && !state.scribbleMode) {
      if (state.currentStroke._needsOverlayRebase) {
        state.currentStroke._needsOverlayRebase = false;
        state.currentStroke._dashOffset = null;
        clearOverlay(pageData);
        drawnIdx = 0;
      }
      _renderBatchTarget(pageData, drawnIdx);
    }

    if (!state.currentStroke || !state.isDrawing) return;
    checkForScribble(pageData);
  } finally {
    batch.length = 0;
    resetPointPool();
  }
}

export { isPredictionSupported, drawPredictions };