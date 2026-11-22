/**
 * @module features/tools/ink
 *
 * TOOL INK — pen / pencil / marker / highlighter unificati.
 */

import { state } from '../../core/state.js';
import { SHAPE_CAPABLE_TOOLS, showToast, isPaperDark } from '../../core/utils.js';
import {
  clearOverlay, renderPendingShapeOnOverlay,
  drawDotOnly, renderFullStroke,
  getStrokeBBoxCanvas, clearOverlayBBox, blitAndClearBBox
} from '../render/render.js';
import {
  finalizePendingShape, applyAngleSnap,
  trySnapToLine, detectAndSnapShape, trySnapHighlighter
} from './shapes.js';
import { finalizeScribble } from './scribble.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import {
  getCanvasCoords, getCanvasRect, pushPointsToBatch, scheduleFlush,
  isPredictionSupported, drawPredictions, clearLineHoldTimer
} from './tool-shared.js';

const LINE_HOLD_RELEASE_MIN_MS = 180;

export function beginInkStroke(point) {
  clearLineHoldTimer();
  const now = performance.now();
  state.currentStroke = {
    tool: state.activeTool,
    color: state.currentColor,
    size: state.strokeWidth,
    opacity: state.currentOpacity != null ? state.currentOpacity : 1.0,
    style: state.currentStyle || 'solid',
    startTime: now,
    _lastMoveTime: now,
    _holdAnchorX: point.x,
    _holdAnchorY: point.y,
    _drawnIdx: 0,
    _lastSnapCheck: 0,
    points: [{
      x: point.x, y: point.y, pressure: point.pressure,
      tiltX: point.tiltX, tiltY: point.tiltY, speed: 0, pointerType: point.pointerType
    }]
  };
}

export function moveInkStroke(pageData, e) {
  if (state.pendingShape) {
    const rawPoint = getCanvasCoords(e, pageData.canvas);
    const ps = state.pendingShape;
    if (ps.activeHandle === 'end') {
      const snapRes = applyAngleSnap(ps.start, rawPoint, ps._snapAxis, ps._snapRejected);
      ps.end = { x: snapRes.x, y: snapRes.y, pressure: 0.5 };
      ps._snapAxis = snapRes.axis;
      ps._snapRejected = snapRes.rejected;
    } else {
      const snapRes = applyAngleSnap(ps.end, rawPoint, ps._snapAxis, ps._snapRejected);
      ps.start = { x: snapRes.x, y: snapRes.y, pressure: 0.5 };
      ps._snapAxis = snapRes.axis;
      ps._snapRejected = snapRes.rejected;
    }
    clearOverlay(pageData);
    renderPendingShapeOnOverlay(pageData);
    return;
  }

  if (!state.currentStroke) return;
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const events = (coalesced && coalesced.length > 0) ? coalesced : [e];

  const points = [];
  for (const ev of events) points.push(getCanvasCoords(ev, pageData.canvas));
  pushPointsToBatch(points);
  scheduleFlush(pageData);

  if (isPredictionSupported(e)) {
    const predicted = e.getPredictedEvents();
    if (predicted && predicted.length > 0) {
      drawPredictions(pageData, predicted, getCanvasRect(pageData.canvas));
    }
  }
}

export function endInkStroke(pageData) {
  clearLineHoldTimer();

  if (!pageData || !pageData.canvas) {
    state.currentStroke = null;
    return 'aborted';
  }

  if (state.pendingShape) {
    finalizePendingShape();
    return 'pendingShape';
  }

  if (state.scribbleMode) {
    finalizeScribble(pageData);
    state.currentStroke = null;
    return 'scribble';
  }

  if (!state.currentStroke || state.currentStroke.points.length < 1) {
    state.currentStroke = null;
    return 'empty';
  }

  const stroke = state.currentStroke;
  const pts = stroke.points;

  const isHL = stroke.tool === 'highlighter';
  const pad = isHL
    ? Math.max(24, (stroke.size * 2) + 8)
    : 24;
  const origBBox = getStrokeBBoxCanvas(stroke, pad);

  const extraStrokes = [];
  let snapped = false;
  if (pts.length > 2) {
    if (state.activeTool === 'highlighter') {
      // Highlighter: invariato (solo snapShapes).
      if (state.snapShapes && trySnapHighlighter(stroke)) {
        showToast('Evidenziatore raddrizzato', '🖍️');
        snapped = true;
      }
    } else if (SHAPE_CAPABLE_TOOLS.includes(state.activeTool)) {
      const heldMs = performance.now() - (stroke._lastMoveTime || stroke.startTime || 0);
      if (state.snapLines && heldMs >= LINE_HOLD_RELEASE_MIN_MS && trySnapToLine(stroke)) {
        showToast('Linea agganciata', '📏');
        snapped = true;
      } else if (state.snapShapes && detectAndSnapShape(stroke, pageData, extraStrokes)) {
        snapped = true;
      }
    }
  }

  pageData.strokes.push(stroke);
  for (let i = 0; i < extraStrokes.length; i++) {
    pageData.strokes.push(extraStrokes[i]);
  }
  _renderFinalStroke(pageData, stroke, snapped, snapped ? origBBox : null);
  for (let i = 0; i < extraStrokes.length; i++) {
    _renderFinalStroke(pageData, extraStrokes[i], true);
  }
  scheduleSave();
  pushHistory();
  state.currentStroke = null;
  return 'ink';
}

function _renderFinalStroke(pageData, stroke, snapped, extraClearBBox = null) {
  if (pageData.overlayCanvas) {
    pageData.overlayCanvas.style.opacity = '';
    pageData.overlayCanvas.style.mixBlendMode = '';
  }

  const isHL = stroke.tool === 'highlighter';
  const pad = isHL
    ? Math.max(24, (stroke.size * 2) + 8)
    : 24;

  if (snapped || stroke.points.length === 1 || stroke.tool === 'pencil') {
    const pctx = pageData.ctx, dpr = pageData.dpr || 1;
    pctx.save();
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (stroke.points.length === 1) {
      drawDotOnly(pageData, stroke);
    } else {
      renderFullStroke(pctx, stroke, state.isDarkMode);
    }
    pctx.restore();
    if (extraClearBBox) clearOverlayBBox(pageData, extraClearBBox);
    clearOverlayBBox(pageData, getStrokeBBoxCanvas(stroke, pad));
    return;
  }

  const bbox = getStrokeBBoxCanvas(stroke, pad);
  const opacity = stroke.opacity != null ? stroke.opacity : 1.0;
  if (isHL) {
    blitAndClearBBox(pageData, bbox, {
      alpha: opacity,
      compositeOp: isPaperDark(state.isDarkMode, state.paperColor) ? 'screen' : 'multiply'
    });
  } else {
    blitAndClearBBox(pageData, bbox, {
      alpha: opacity,
      compositeOp: 'source-over'
    });
  }
}