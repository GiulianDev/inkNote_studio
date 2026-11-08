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
import { pushHistory } from './history.js';
import {
  selectStrokesInsideLasso, clearSelection,
  startResizeSelection, applyResizeSelection,
  updateCursorForSelection, updateSelectionMenuPosition
} from './lasso.js';
import { updatePageCounterUI } from './header.js';

const MAX_BATCH_POINTS = 8;
const _useRawPointerUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

const _flushState = { points: [], rafId: null, pageData: null };

export function getCanvasCoords(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  let pressure = 0.5;
  if (e.pointerType === 'pen') pressure = (e.pressure && e.pressure > 0) ? e.pressure : 0.5;
  return {
    x: (e.clientX - rect.left) * (PAGE_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (PAGE_HEIGHT / rect.height),
    pressure, tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, pointerType: e.pointerType
  };
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
                        pageData.overlayDpr || pageData.dpr);   // ← mod
  } else if (state.activeTool === 'highlighter') {
    drawIncrementalSegment(pageData.ctx, state.currentStroke, pageData.dpr);  // main: OK invariato
  } else {
    drawIncrementalSegment(pageData.overlayCtx, state.currentStroke,
                           pageData.overlayDpr || pageData.dpr);   // ← mod
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
}

function _cancelFlush() {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  _flushState.points = [];
  _flushState.pageData = null;
}

function _forceFlushNow(pageData) {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  const batch = _flushState.points;
  _flushState.points = [];
  _flushState.pageData = null;
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
}

// --- pointer handlers ---

export function handlePointerDown(e, pageData) {
  const palmCheck = document.getElementById('palmRejectionCheck').checked;
  if (palmCheck && e.pointerType !== 'pen') return;
  if (viewport.isPanning || viewport.isPinching) return;
  if (viewport.activePointers.size > 1) return;

  if (state.pendingShape) finalizePendingShape();
  state.scribbleMode = false;
  state.scribbleTargets = [];
  _cancelFlush();
  clearOverlay(pageData);
  clearPredictions(pageData);
  try { pageData.canvas.setPointerCapture(e.pointerId); } catch (err) {}

  state.activePageIndex = pageData.index;
  state.currentPointerId = e.pointerId;
  state.currentPageForPointer = pageData;
  updatePageCounterUI();

  const point = getCanvasCoords(e, pageData.canvas);
  if (point.pointerType === 'pen') point.pressure = Math.max(point.pressure, 0.2);

  if (state.activeTool === 'lasso') {
    const visualBBox = getVisualBoundingBox();
    if (visualBBox) {
      const handle = hitTestHandle(point, visualBBox);
      if (handle) { startResizeSelection(handle, point); return; }
      if (isPointInBBox(point, visualBBox)) {
        state.isDraggingSelection = true;
        state.dragStartPoint = point;
        state.isDrawing = true;
        state.selectionMoved = false;
        pageData.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    clearSelection();
    state.isDrawing = true;
    state.lassoPath = [point];
    clearOverlay(pageData);
    return;
  }

  clearSelection();
  state.isDrawing = true;
  if (state.activeTool === 'eraser') { performEraserAt(pageData, point); return; }

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
  if (palmCheck && e.pointerType !== 'pen') return;
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

  if (state.isDraggingSelection && state.dragStartPoint) {
    const rawPoint = getCanvasCoords(e, pageData.canvas);
    const dx = rawPoint.x - state.dragStartPoint.x;
    const dy = rawPoint.y - state.dragStartPoint.y;
    if (dx !== 0 || dy !== 0) {
      state.selectionMoved = true;
      state.selectedStrokes.forEach(stroke => {
        stroke.points.forEach(p => { p.x += dx; p.y += dy; });
      });
      redrawSelectionOverlay(pageData);
      updateSelectionMenuPosition();
    }
    state.dragStartPoint = rawPoint;
    return;
  }

  if (state.activeTool === 'lasso') {
    state.lassoPath.push(getCanvasCoords(e, pageData.canvas));
    drawLassoIncrementalOnOverlay(pageData);
    return;
  }

  if (state.activeTool === 'eraser') {
    performEraserAt(pageData, getCanvasCoords(e, pageData.canvas));
    return;
  }

  if (!state.currentStroke) return;
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const events = (coalesced && coalesced.length > 0) ? coalesced : [e];
  for (const ev of events) _flushState.points.push(getCanvasCoords(ev, pageData.canvas));
  _scheduleFlush(pageData);

  // Predizioni: solo pen e solo se supportate. Disegna "fantasma"
  // avanti rispetto al punto reale, sostituito al prossimo frame.
  if (isPredictionSupported(e)) {
    const predicted = e.getPredictedEvents();
    if (predicted && predicted.length > 0) {
      drawPredictions(pageData, predicted);
    }
  }
}

export function handlePointerUp(e, pageData) {
  const palmCheck = document.getElementById('palmRejectionCheck').checked;
  if (palmCheck && e.pointerType !== 'pen') return;
  if (e.pointerId !== state.currentPointerId) return;

  _forceFlushNow(pageData);
  clearPredictions(pageData);

  if (state.pendingShape) {
    finalizePendingShape();
    try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    return;
  }

  try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}

  if (state.scribbleMode) {
    finalizeScribble(pageData);
    state.isDrawing = false; state.currentPointerId = null;
    state.currentPageForPointer = null; state.currentStroke = null;
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
    return;
  }

  if (!state.isDrawing) return;
  state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;

  if (state.activeTool === 'lasso') {
    if (state.lassoPath.length > 5) selectStrokesInsideLasso(pageData);
    else { state.lassoPath = []; clearOverlay(pageData); }
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
      // Overlay è a DPR ridotta: niente drawImage, ridisegna l'intero stroke
      // sul main. Costo O(n) una volta per stroke, compensato dai fill
      // incrementali più leggeri durante il disegno.
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
}

function performEraserAt(pageData, point) {
  const mode = document.getElementById('eraserModeSelect').value;
  const radius = (0.5 * Math.pow(Math.max(1, Math.min(25, state.strokeWidth || 3)), 0.75)) * 12;
  const initCount = pageData.strokes.length;
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