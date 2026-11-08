// ============================================================
// INPUT CANVAS + BATCHING rAF (in un unico file)
// ============================================================

import { drawPredictions, clearPredictions, isPredictionSupported } from './prediction.js';
import { invalidateStrokeBitmap } from './stroke-cache.js';
import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, SHAPE_CAPABLE_TOOLS, showToast } from '../../core/utils.js';
import {
  drawIncrementalSegment, drawScribbleSegment, clearOverlay,
  redrawPageCanvas, redrawSelectionOverlay,
  renderPendingShapeOnOverlay, drawLassoIncrementalOnOverlay,
  drawFinalSegmentOnly, drawDotOnly, renderFullStroke,
  getVisualBoundingBox, hitTestHandle, isPointInBBox
} from './render.js';
import { checkForScribble, finalizeScribble } from './scribble.js';
import {
  trySnapToLine, trySnapToLineDuringDraw,
  detectAndSnapShape, finalizePendingShape, trySnapHighlighter
} from './shapes.js';
import { scheduleSave } from './autosave.js';
import { pushHistory, resetHistory } from './history.js';
import {
  selectStrokesInsideLasso, clearSelection,
  startResizeSelection, applyResizeSelection,
  updateCursorForSelection, updateSelectionMenuPosition
} from './lasso.js';
import { updatePageCounterUI } from './header.js';

const MAX_BATCH_POINTS = 16;
const _useRawPointerUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

// Riconosce il tasto eraser della penna (Surface Pen, Wacom, ecc.).
// Su Windows/Chromium: pointerType 'pen' + button 5 / buttons bit 32.
// Su alcuni browser: pointerType 'eraser'.
function isPenEraser(e) {
  if (!e) return false;
  if (e.pointerType === 'eraser') return true;
  if (e.button === 5) return true;
  if (typeof e.buttons === 'number' && (e.buttons & 32) !== 0) return true;
  return false;
}

const _flushState = { points: [], rafId: null, pageData: null };

// --- Priorità 4+8: cache rect + pool oggetti ---
let _strokeRect = null;
let _strokeRectScale = 0;
let _strokeRectX = 0;
let _strokeRectY = 0;
const _pointPool = [];
let _pointPoolIdx = 0;

// --- Drag selezione: delta cumulativo per clipping pagina ---
let _dragStartPoint = null;
let _dragStartBBox = null;
let _dragAccX = 0;
let _dragAccY = 0;

function resetPointPool() { _pointPoolIdx = 0; }
function invalidateStrokeRect() {
  _strokeRect = null;
  _strokeRectScale = 0;
  _strokeRectX = 0;
  _strokeRectY = 0;
}

function _getSelectedBBox() {
  if (state.selectedStrokes.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const stroke of state.selectedStrokes) {
    for (const p of stroke.points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, maxX, minY, maxY };
}

export function getCanvasCoords(e, canvas) {
  let rect;
  if (_strokeRect &&
      _strokeRectScale === viewport.scale &&
      _strokeRectX === viewport.x &&
      _strokeRectY === viewport.y) {
    rect = _strokeRect;
  } else {
    rect = canvas.getBoundingClientRect();
    _strokeRect = rect;
    _strokeRectScale = viewport.scale;
    _strokeRectX = viewport.x;
    _strokeRectY = viewport.y;
  }

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
  const speed = Math.hypot(dx, dy);
  const minAlpha = 0.85 - smoothness * 0.55;
  const alpha = Math.min(1.0, minAlpha + speed * 0.05);
  rawPoint.x = prevSmoothed.x + dx * alpha;
  rawPoint.y = prevSmoothed.y + dy * alpha;
  return rawPoint;
}

export function attachPointerListeners(pageData) {
  const canvas = pageData.canvas;
  canvas.addEventListener('pointerdown', (e) => handlePointerDown(e, pageData));
  if (_useRawPointerUpdate) {
    canvas.addEventListener('pointerrawupdate', (e) => handlePointerMove(e, pageData), { passive: false });
  } else {
    canvas.addEventListener('pointermove', (e) => handlePointerMove(e, pageData), { passive: false });
  }
  canvas.addEventListener('pointerup', (e) => handlePointerUp(e, pageData));
  canvas.addEventListener('pointercancel', (e) => handlePointerUp(e, pageData));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// --- batch pipeline ---

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
  if (prevSmoothed && Math.hypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y) < minDist) return;
  const speedPx = prevSmoothed ? Math.hypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y) : 0;
  const smoothedPoint = {
    x: smoothedPos.x, y: smoothedPos.y, pressure: smoothedPressure,
    tiltX: rawPoint.tiltX, tiltY: rawPoint.tiltY, speed: speedPx, pointerType: rawPoint.pointerType
  };
  state.currentStroke.points.push(smoothedPoint);
  if (state.currentStroke._pathLen === undefined) state.currentStroke._pathLen = 0;
  if (state.currentStroke.points.length >= 2) {
    const prev = state.currentStroke.points[state.currentStroke.points.length - 2];
    state.currentStroke._pathLen += Math.hypot(smoothedPoint.x - prev.x, smoothedPoint.y - prev.y);
  }
  if (state.scribbleMode) {
    drawScribbleSegment(pageData.overlayCtx, state.currentStroke,
                        pageData.overlayDpr || pageData.dpr);
  } else if (state.activeTool === 'highlighter') {
    drawIncrementalSegment(pageData.ctx, state.currentStroke, pageData.dpr);
  } else {
    drawIncrementalSegment(pageData.overlayCtx, state.currentStroke,
                           pageData.overlayDpr || pageData.dpr);
  }
}

function _runPostBatchChecks(pageData) {
  if (!state.currentStroke || !state.isDrawing) return;
  if (state.pendingShape) return;
  const pts = state.currentStroke.points;
  if (pts.length === 0) return;
  checkForScribble(pageData);
  if (!state.currentStroke || !state.isDrawing) return;
  if (state.pendingShape) return;
  if (!state.scribbleMode && state.autoShapeEnabled &&
      SHAPE_CAPABLE_TOOLS.includes(state.activeTool) && pts.length >= 6) {
    trySnapToLineDuringDraw(pageData, pts[pts.length - 1]);
  }
}

function _scheduleFlush(pageData) {
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
    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }
    _runPostBatchChecks(pageData);
  } finally {
    resetPointPool();
  }
}

function _cancelFlush() {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  _flushState.points = [];
  _flushState.pageData = null;
  resetPointPool();
}

function _forceFlushNow(pageData) {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  const batch = _flushState.points;
  _flushState.points = [];
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;
    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }
    if (!state.currentStroke || !state.isDrawing) return;
    checkForScribble(pageData);
  } finally {
    resetPointPool();
  }
}

// --- abort ---

export function abortCurrentDrawing() {
  if (state.pendingShape) finalizePendingShape();
  _cancelFlush();
  if (state.isDrawing || state.currentStroke) {
    if (state.currentPointerId !== null && state.currentPageForPointer) {
      try { state.currentPageForPointer.canvas.releasePointerCapture(state.currentPointerId); } catch (err) {}
    }
    state.isDrawing = false;
    state.currentStroke = null;
    state.currentPointerId = null;
    state.currentPageForPointer = null;
    state.scribbleMode = false;
    state.scribbleTargets = [];
    state.lassoPath = [];
    state.selectedStrokes = [];
    const curr = state.pages[state.activePageIndex];
    if (curr) { redrawPageCanvas(curr); clearOverlay(curr); clearPredictions(curr); }
  }
  state._penEraserActive = false;
  _dragStartPoint = null;
  _dragStartBBox = null;
  _dragAccX = 0;
  _dragAccY = 0;
  resetPointPool();
  invalidateStrokeRect();
}

// --- pointer handlers ---

export function handlePointerDown(e, pageData) {
  const penEraser = isPenEraser(e);
  const palmCheck = document.getElementById('palmRejectionCheck').checked;
  const isPenLike = e.pointerType === 'pen' || e.pointerType === 'eraser' || penEraser;
  if (palmCheck && !isPenLike) return;
  if (viewport.isPanning || viewport.isPinching) return;
  if (viewport.activePointers.size > 1) return;

  resetPointPool();
  invalidateStrokeRect();

  // BUG FIX: se stiamo cambiando pagina con una selezione attiva,
  // consolidiamo la selezione sulla pagina precedente (main canvas)
  // PRIMA di cambiare activePageIndex.
  const pageChanged = state.activePageIndex !== pageData.index;
  if (pageChanged && state.selectedStrokes.length > 0) {
    clearSelection();
  }

  if (state.pendingShape) finalizePendingShape();
  state.scribbleMode = false;
  state.scribbleTargets = [];
  _cancelFlush();
  clearOverlay(pageData);
  clearPredictions(pageData);
  try { pageData.canvas.setPointerCapture(e.pointerId); } catch (err) {}

  state.activePageIndex = pageData.index;
  if (pageChanged) resetHistory();
  state.currentPointerId = e.pointerId;
  state.currentPageForPointer = pageData;
  state._penEraserActive = penEraser;
  updatePageCounterUI();

  const point = getCanvasCoords(e, pageData.canvas);
  if (point.pointerType === 'pen') point.pressure = Math.max(point.pressure, 0.2);

  const effectiveTool = penEraser ? 'eraser' : state.activeTool;

  if (effectiveTool === 'lasso') {
    const visualBBox = getVisualBoundingBox();
    if (visualBBox) {
      const handle = hitTestHandle(point, visualBBox);
      if (handle) { startResizeSelection(handle, point); return; }
      if (isPointInBBox(point, visualBBox)) {
        state.isDraggingSelection = true;
        _dragStartPoint = { x: point.x, y: point.y };
        _dragStartBBox = _getSelectedBBox();
        _dragAccX = 0;
        _dragAccY = 0;
        state.dragStartPoint = _dragStartPoint;
        state.isDrawing = true;
        state.selectionMoved = false;
        pageData.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    clearSelection();
    state.isDrawing = true;
    state.lassoPath = [{ x: point.x, y: point.y, pressure: point.pressure }];
    clearOverlay(pageData);
    return;
  }

  clearSelection();
  state.isDrawing = true;
  if (effectiveTool === 'eraser') { performEraserAt(pageData, point); return; }

  state.currentStroke = {
    tool: state.activeTool, color: state.currentColor, size: state.strokeWidth,
    startTime: performance.now(),
    points: [{
      x: point.x, y: point.y, pressure: point.pressure,
      tiltX: point.tiltX, tiltY: point.tiltY, speed: 0, pointerType: point.pointerType
    }]
  };
}

export function handlePointerMove(e, pageData) {
  const palmCheck = document.getElementById('palmRejectionCheck').checked;
  const isPenLike = e.pointerType === 'pen' || e.pointerType === 'eraser' || state._penEraserActive;
  if (palmCheck && !isPenLike) return;
  if (viewport.isPanning || viewport.isPinching) return;

  if (!state.isDrawing && state.activeTool === 'lasso' && e.pointerType !== 'touch') {
    updateCursorForSelection(e, pageData);
  }
  if (!state.isDrawing) return;
  if (e.pointerId !== state.currentPointerId) return;

  if (state.pendingShape) {
    const rawPoint = getCanvasCoords(e, pageData.canvas);
    const ps = state.pendingShape;
    if (ps.activeHandle === 'end') ps.end = { x: rawPoint.x, y: rawPoint.y, pressure: 0.5 };
    else ps.start = { x: rawPoint.x, y: rawPoint.y, pressure: 0.5 };
    clearOverlay(pageData);
    renderPendingShapeOnOverlay(pageData);
    return;
  }

  if (state.isResizingSelection) { applyResizeSelection(getCanvasCoords(e, pageData.canvas)); return; }

  if (state.isDraggingSelection && _dragStartPoint && _dragStartBBox) {
    const rawPoint = getCanvasCoords(e, pageData.canvas);
    let desiredX = rawPoint.x - _dragStartPoint.x;
    let desiredY = rawPoint.y - _dragStartPoint.y;

    // CLIPPING: gli oggetti selezionati non possono uscire dalla pagina
    if (_dragStartBBox.maxX + desiredX > PAGE_WIDTH)  desiredX = PAGE_WIDTH  - _dragStartBBox.maxX;
    if (_dragStartBBox.minX + desiredX < 0)           desiredX = -_dragStartBBox.minX;
    if (_dragStartBBox.maxY + desiredY > PAGE_HEIGHT) desiredY = PAGE_HEIGHT - _dragStartBBox.maxY;
    if (_dragStartBBox.minY + desiredY < 0)           desiredY = -_dragStartBBox.minY;

    const incX = desiredX - _dragAccX;
    const incY = desiredY - _dragAccY;
    if (incX !== 0 || incY !== 0) {
      state.selectionMoved = true;
      state.selectedStrokes.forEach(stroke => {
        stroke.points.forEach(p => { p.x += incX; p.y += incY; });
      });
      _dragAccX = desiredX;
      _dragAccY = desiredY;
      redrawSelectionOverlay(pageData);
      updateSelectionMenuPosition();
    }
    return;
  }

  if (state.activeTool === 'lasso') {
    const lp = getCanvasCoords(e, pageData.canvas);
    state.lassoPath.push({ x: lp.x, y: lp.y, pressure: lp.pressure });
    drawLassoIncrementalOnOverlay(pageData);
    return;
  }

  if (state.activeTool === 'eraser' || state._penEraserActive) {
    performEraserAt(pageData, getCanvasCoords(e, pageData.canvas));
    return;
  }

  if (!state.currentStroke) return;
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const events = (coalesced && coalesced.length > 0) ? coalesced : [e];
  for (const ev of events) _flushState.points.push(getCanvasCoords(ev, pageData.canvas));
  _scheduleFlush(pageData);

  if (isPredictionSupported(e)) {
    const predicted = e.getPredictedEvents();
    if (predicted && predicted.length > 0) {
      drawPredictions(pageData, predicted);
    }
  }
}

export function handlePointerUp(e, pageData) {
  const palmCheck = document.getElementById('palmRejectionCheck').checked;
  const isPenLike = e.pointerType === 'pen' || e.pointerType === 'eraser' || state._penEraserActive;
  if (palmCheck && !isPenLike) return;
  if (e.pointerId !== state.currentPointerId) return;

  state._penEraserActive = false;
  _forceFlushNow(pageData);
  clearPredictions(pageData);

  if (state.pendingShape) {
    finalizePendingShape();
    try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
    resetPointPool(); invalidateStrokeRect();
    return;
  }

  try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}

  if (state.scribbleMode) {
    finalizeScribble(pageData);
    state.isDrawing = false; state.currentPointerId = null;
    state.currentPageForPointer = null; state.currentStroke = null;
    _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
    resetPointPool(); invalidateStrokeRect();
    return;
  }

  if (state.isResizingSelection) {
    const wasMoved = state.selectionMoved;
    state.isResizingSelection = false;
    state.resizeHandle = null; state.resizePivot = null;
    state.resizeAnchor = null; state.resizeOffset = null;
    state.resizeCurrentAngle = 0; state.initialStrokesSnapshot = null;
    state.selectionMoved = false;
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    pageData.canvas.style.cursor = 'crosshair';
    if (wasMoved) { pushHistory(); scheduleSave(); }
    _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
    resetPointPool(); invalidateStrokeRect();
    return;
  }

  if (state.isDraggingSelection) {
    const wasMoved = state.selectionMoved;
    state.isDraggingSelection = false; state.dragStartPoint = null;
    state.selectionMoved = false;
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    pageData.canvas.style.cursor = 'crosshair';
    if (wasMoved) pushHistory();
    scheduleSave();
    _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
    resetPointPool(); invalidateStrokeRect();
    return;
  }

  if (!state.isDrawing) {
    _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
    resetPointPool(); invalidateStrokeRect();
    return;
  }
  state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;

  if (state.activeTool === 'lasso') {
    if (state.lassoPath.length > 5) selectStrokesInsideLasso(pageData);
    else { state.lassoPath = []; clearOverlay(pageData); }
    _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
    resetPointPool(); invalidateStrokeRect();
    return;
  }

  if (state.currentStroke && state.currentStroke.points.length >= 1) {
    let snapped = false;
    if (state.currentStroke.points.length > 2 && state.autoShapeEnabled) {
      if (state.activeTool === 'highlighter') {
        if (trySnapHighlighter(state.currentStroke)) {
          showToast('Evidenziatore raddrizzato', '🖍️');
          snapped = true;
        }
      } else if (SHAPE_CAPABLE_TOOLS.includes(state.activeTool)) {
        if (trySnapToLine(state.currentStroke)) {
          showToast('Linea agganciata', '📏');
          snapped = true;
        } else if (detectAndSnapShape(state.currentStroke, pageData)) {
          snapped = true;
        }
      }
    }
    pageData.strokes.push(state.currentStroke);
    if (snapped) {
      const pctx = pageData.ctx, dpr = pageData.dpr || 1;
      pctx.save(); pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderFullStroke(pctx, state.currentStroke, state.isDarkMode);
      pctx.restore();
    } else if (state.currentStroke.points.length === 1) {
      drawDotOnly(pageData, state.currentStroke);
    } else if (state.activeTool === 'highlighter') {
      drawFinalSegmentOnly(pageData, state.currentStroke);
    } else {
      const pctx = pageData.ctx, dpr = pageData.dpr || 1;
      pctx.save(); pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderFullStroke(pctx, state.currentStroke, state.isDarkMode);
      pctx.restore();
    }
    clearOverlay(pageData);
    scheduleSave();
    pushHistory();
  }
  state.currentStroke = null;
  _dragStartPoint = null; _dragStartBBox = null; _dragAccX = 0; _dragAccY = 0;
  resetPointPool();
  invalidateStrokeRect();
}

function performEraserAt(pageData, point) {
  const mode = document.getElementById('eraserModeSelect').value;
  const radius = (0.5 * Math.pow(Math.max(1, Math.min(25, state.strokeWidth || 3)), 0.75)) * 12;
  const modified = new Set();
  if (mode === 'stroke') {
    pageData.strokes = pageData.strokes.filter(stroke => {
      const hit = stroke.points.some(p => Math.hypot(p.x - point.x, p.y - point.y) < radius);
      if (hit) modified.add(stroke);
      return !hit;
    });
  } else {
    pageData.strokes.forEach(stroke => {
      const before = stroke.points.length;
      stroke.points = stroke.points.filter(p => Math.hypot(p.x - point.x, p.y - point.y) >= radius);
      if (stroke.points.length !== before) modified.add(stroke);
    });
    pageData.strokes = pageData.strokes.filter(s => s.points.length > 1);
  }
  if (modified.size > 0) {
    modified.forEach(invalidateStrokeBitmap);
    redrawPageCanvas(pageData);
    scheduleSave();
    pushHistory();
  }
}