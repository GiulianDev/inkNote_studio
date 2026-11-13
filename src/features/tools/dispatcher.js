/**
 * @module features/tools/dispatcher
 *
 * POINTER EVENT DISPATCHER — cuore dell'input.
 *
 * Listener sul WRAPPER (non sul canvas) perché il canvas può essere
 * assente finché il pool non assegna uno slot alla pagina.
 *
 * @see core/types.js
 * @see tools/tool-shared.js
 * @see tools/ink.js, tools/eraser.js, tools/lazo.js
 */

import { state, viewport } from '../../core/state.js';
import {
  getCanvasCoords, invalidateStrokeRect, resetPointPool,
  forceFlushNow, cancelFlush, isPenEraser, _useRawPointerUpdate
} from './tool-shared.js';
import { updateEraserCursor, hideEraserCursor, shouldShowEraserCursor,
         beginEraserStroke, moveEraserStroke } from './eraser.js';
import { clearPredictions } from '../render/prediction.js';
import { flushHistory, pushHistory, resetHistory } from '../history/history.js';
import { refreshPageCounter } from '../toolbar/toolbar.js';
import { finalizePendingShape } from './shapes.js';
import { resetScribbleState } from './scribble.js';
import {
  clearSelection, applyResizeSelection,
  beginLasso, moveLasso, endLasso,
  beginSelectionDrag, moveSelectionDrag, endSelectionDrag,
  resetSelectionDragState, updateCursorForSelection
} from './lazo.js';
import {
  redrawPageCanvas, clearOverlay, redrawSelectionOverlay,
  getStrokeBBoxCanvas, clearOverlayBBox
} from '../render/render.js';
import { beginInkStroke, moveInkStroke, endInkStroke } from './ink.js';
import { scheduleSave } from '../persistence/autosave.js';
import { pagePool } from '../editor/page-pool.js';

let _gestureUsedEraser = false;
let _lastGestureWasEraser = false;

export function attachPointerListeners(pageData) {
  const target = pageData.wrapper;

  target.addEventListener('pointerdown', (e) => {
    if (!pageData.canvas) pagePool.forceAssign(pageData.index);
    if (!pageData.canvas) return; // pool esaurito, impossibile
    handlePointerDown(e, pageData);
  });

  if (_useRawPointerUpdate) {
    target.addEventListener('pointerrawupdate', (e) => {
      if (!pageData.canvas) return;
      handlePointerMove(e, pageData);
    }, { passive: false });
  } else {
    target.addEventListener('pointermove', (e) => {
      if (!pageData.canvas) return;
      handlePointerMove(e, pageData);
    }, { passive: false });
  }

  target.addEventListener('pointerup', (e) => {
    if (!pageData.canvas) return;
    handlePointerUp(e, pageData);
  });
  target.addEventListener('pointercancel', (e) => {
    if (!pageData.canvas) return;
    handlePointerUp(e, pageData);
  });
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  target.addEventListener('pointerleave', () => { hideEraserCursor(); });
}

export function handlePointerDown(e, pageData) {
  const penEraser = isPenEraser(e);

  if (penEraser || state.activeTool === 'eraser') {
    updateEraserCursor(e, pageData);
  } else {
    hideEraserCursor();
  }

  const palmCheck = state.palmRejection;
  const isPenLike = e.pointerType === 'pen' || e.pointerType === 'eraser' || penEraser;
  if (palmCheck && !isPenLike) return;
  if (viewport.isPanning || viewport.isPinching) return;
  if (viewport.activePointers.size > 1) return;

  // Fix A.1: chiude stroke orfano
  if (state.isDrawing &&
      state.currentPointerId === e.pointerId &&
      state.currentPageForPointer === pageData) {
    forceFlushNow(pageData);
    endInkStroke(pageData);
    state.isDrawing = false;
    state.currentStroke = null;
    state.currentPointerId = null;
    state.currentPageForPointer = null;
  }

  const isEraserGesture = penEraser || state.activeTool === 'eraser';
  if (isEraserGesture && !_lastGestureWasEraser) flushHistory();
  _gestureUsedEraser = false;

  resetPointPool();
  invalidateStrokeRect();

  const pageChanged = state.activePageIndex !== pageData.index;
  if (pageChanged && state.selectedStrokes.length > 0) clearSelection();

  if (state.pendingShape) finalizePendingShape();
  state.scribbleMode = false;
  state.scribbleTargets = [];
  cancelFlush();

  // Batch B: clear bbox-based
  if (state.currentStroke && state.currentStroke.points.length > 0) {
    clearOverlayBBox(pageData, getStrokeBBoxCanvas(state.currentStroke));
  }

  clearPredictions(pageData);
  try { pageData.wrapper.setPointerCapture(e.pointerId); } catch (err) {}

  state.activePageIndex = pageData.index;
  if (pageChanged) resetHistory();
  state.currentPointerId = e.pointerId;
  state.currentPageForPointer = pageData;
  state._penEraserActive = penEraser;
  refreshPageCounter();

  const point = getCanvasCoords(e, pageData.canvas);
  if (point.pointerType === 'pen') point.pressure = Math.max(point.pressure, 0.2);

  const effectiveTool = penEraser ? 'eraser' : state.activeTool;

  if (effectiveTool === 'lasso') return beginLasso(pageData, point);

  clearSelection();
  state.isDrawing = true;

  if (effectiveTool === 'eraser') {
    _gestureUsedEraser = true;
    return beginEraserStroke(point, pageData);
  }

  return beginInkStroke(point);
}

export function handlePointerMove(e, pageData) {
  if (!pageData.canvas) return;

  if (shouldShowEraserCursor(e)) updateEraserCursor(e, pageData);
  else hideEraserCursor();

  const palmCheck = state.palmRejection;
  const isPenLike = e.pointerType === 'pen' || e.pointerType === 'eraser' || state._penEraserActive;
  if (palmCheck && !isPenLike) return;
  if (viewport.isPanning || viewport.isPinching) return;

  // Fix A.1: ignora hover durante stroke attivo
  if (state.isDrawing && e.pointerType === 'pen' && e.buttons === 0) return;

  if (!state.isDrawing && state.activeTool === 'lasso' && e.pointerType !== 'touch') {
    updateCursorForSelection(e, pageData);
  }
  if (!state.isDrawing) return;
  if (e.pointerId !== state.currentPointerId) return;

  if (state.pendingShape) { moveInkStroke(pageData, e); return; }
  if (state.isResizingSelection) { applyResizeSelection(getCanvasCoords(e, pageData.canvas)); return; }
  if (state.isDraggingSelection) { moveSelectionDrag(pageData, getCanvasCoords(e, pageData.canvas)); return; }
  if (state.activeTool === 'lasso') { moveLasso(pageData, e); return; }
  if (state.activeTool === 'eraser' || state._penEraserActive) {
    _gestureUsedEraser = true;
    moveEraserStroke(pageData, e);
    return;
  }
  if (!state.currentStroke) return;
  moveInkStroke(pageData, e);
}

export function handlePointerUp(e, pageData) {
  if (!pageData.canvas) return;

  const palmCheck = state.palmRejection;
  const isPenLike = e.pointerType === 'pen' || e.pointerType === 'eraser' || state._penEraserActive;
  if (palmCheck && !isPenLike) return;
  if (e.pointerId !== state.currentPointerId) return;

  if (!shouldShowEraserCursor(e)) hideEraserCursor();

  state._penEraserActive = false;
  forceFlushNow(pageData);
  clearPredictions(pageData);

  if (_gestureUsedEraser) {
    pushHistory();
    _gestureUsedEraser = false;
    _lastGestureWasEraser = true;
  } else {
    _lastGestureWasEraser = false;
  }

  if (state.pendingShape) {
    endInkStroke(pageData);
    try { pageData.wrapper.releasePointerCapture(e.pointerId); } catch (err) {}
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    resetSelectionDragState(); resetPointPool(); invalidateStrokeRect();
    return;
  }

  try { pageData.wrapper.releasePointerCapture(e.pointerId); } catch (err) {}

  if (state.scribbleMode) {
    endInkStroke(pageData);
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    resetSelectionDragState(); resetPointPool(); invalidateStrokeRect();
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
    resetSelectionDragState(); resetPointPool(); invalidateStrokeRect();
    return;
  }

  if (state.isDraggingSelection) {
    const wasMoved = state.selectionMoved;
    endSelectionDrag(pageData, wasMoved);
    state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;
    resetPointPool(); invalidateStrokeRect();
    return;
  }

  if (!state.isDrawing) {
    resetSelectionDragState(); resetPointPool(); invalidateStrokeRect();
    return;
  }
  state.isDrawing = false; state.currentPointerId = null; state.currentPageForPointer = null;

  if (state.activeTool === 'lasso') {
    endLasso(pageData);
    resetSelectionDragState(); resetPointPool(); invalidateStrokeRect();
    return;
  }

  endInkStroke(pageData);
  resetSelectionDragState(); resetPointPool(); invalidateStrokeRect();
}

export function abortCurrentDrawing() {
  if (state.pendingShape) finalizePendingShape();
  hideEraserCursor();
  cancelFlush();
  if (state.isDrawing || state.currentStroke) {
    if (_gestureUsedEraser) pushHistory();
    if (state.currentPointerId !== null && state.currentPageForPointer) {
      try { state.currentPageForPointer.wrapper.releasePointerCapture(state.currentPointerId); } catch (err) {}
    }
    state.isDrawing = false;
    state.currentStroke = null;
    state.currentPointerId = null;
    state.currentPageForPointer = null;
    state.lassoPath = [];
    state.selectedStrokes = [];
    resetScribbleState();
    const curr = state.pages[state.activePageIndex];
    if (curr && curr.canvas) {
      if (curr.overlayCanvas) {
        curr.overlayCanvas.style.opacity = '';
        curr.overlayCanvas.style.mixBlendMode = '';
      }
      redrawPageCanvas(curr); clearOverlay(curr); clearPredictions(curr);
    }
  }
  state._penEraserActive = false;
  _gestureUsedEraser = false;
  _lastGestureWasEraser = false;
  resetSelectionDragState();
  resetPointPool();
  invalidateStrokeRect();
}