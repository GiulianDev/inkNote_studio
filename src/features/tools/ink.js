/**
 * @module features/tools/ink
 *
 * TOOL INK — pen / pencil / marker / highlighter unificati.
 */

import { state, viewport } from '../../core/state.js';
import { getPressureParams } from '../../core/app-settings.js';
import { SHAPE_CAPABLE_TOOLS, showToast, isPaperDark } from '../../core/utils.js';
import {
  clearOverlay, renderPendingShapeOnOverlay,
  drawDotOnly, renderFullStroke,
  getStrokeBBoxCanvas, clearOverlayBBox
} from '../render/render.js';
import {
  finalizePendingShape, applyAngleSnap,
  detectReleaseShapeOrSymbol, trySnapHighlighter,
  scaleShapePointsFromCenter
} from './shapes.js';
import {
  cloneInkParams,
  createStrokeStabilizer
} from './ink-calibration.js';
import { finalizeScribble } from './scribble.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import {
  getCanvasCoords, getCanvasRect, pushPointsToBatch, scheduleFlush,
  isPredictionSupported, drawPredictions, clearLineHoldTimer,
  resetLastValidPenPressure
} from './tool-shared.js';

export function beginInkStroke(point) {
  clearLineHoldTimer();
  resetLastValidPenPressure();
  const now = performance.now();
  const initialPt = {
    x: point.x, y: point.y, pressure: point.pressure,
    tiltX: point.tiltX, tiltY: point.tiltY, speed: 0, pointerType: point.pointerType,
    timeStamp: point.timeStamp || 0
  };
  state.currentStroke = {
    tool: state.activeTool,
    color: state.currentColor,
    size: state.strokeWidth,
    opacity: state.currentOpacity != null ? state.currentOpacity : 1.0,
    style: state.currentStyle || 'solid',
    inkParams: cloneInkParams(getPressureParams()),
    startTime: now,
    _lastMoveTime: now,
    _holdAnchorX: point.x,
    _holdAnchorY: point.y,
    _stabilizer: createStrokeStabilizer(initialPt),
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
    if (Array.isArray(ps.basePoints) && ps.center && ps.holdAnchor) {
      const dragDeadzone = 10 / Math.max(0.25, viewport.scale);
      const dragDist = Math.hypot(rawPoint.x - ps.holdAnchor.x, rawPoint.y - ps.holdAnchor.y);
      if (dragDist >= dragDeadzone) {
        const baseR = Math.max(12, Math.hypot(ps.holdAnchor.x - ps.center.x, ps.holdAnchor.y - ps.center.y));
        const currR = Math.hypot(rawPoint.x - ps.center.x, rawPoint.y - ps.center.y);
        const factor = Math.max(0.25, Math.min(4.0, currR / baseR));
        ps.points = scaleShapePointsFromCenter(ps.basePoints, ps.center, factor);
        clearOverlay(pageData);
        renderPendingShapeOnOverlay(pageData);
      }
      return;
    }
    if (ps.start && ps.end) {
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
    }
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
  const pad = (isHL || stroke.tool === 'pencil')
    ? Math.max(28, Math.ceil((stroke.size * 2) + 12))
    : 24;
  const origBBox = getStrokeBBoxCanvas(stroke, pad);

  const extraStrokes = [];
  let snapped = false;
  if (pts.length > 2) {
    if (state.activeTool === 'highlighter') {
      if (state.snapShapes && trySnapHighlighter(stroke)) {
        showToast('Evidenziatore raddrizzato', '🖍️');
        snapped = true;
      }
    } else if (SHAPE_CAPABLE_TOOLS.includes(state.activeTool)) {
      if (detectReleaseShapeOrSymbol(stroke, pageData, extraStrokes)) {
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
  scheduleSave({ pageId: pageData.pageId });
  pushHistory();
  state.currentStroke = null;
  return 'ink';
}

function _renderFinalStroke(pageData, stroke, _snapped, extraClearBBox = null) {
  if (pageData.overlayCanvas) {
    pageData.overlayCanvas.style.opacity = '';
    pageData.overlayCanvas.style.mixBlendMode = '';
  }

  const isHL = stroke.tool === 'highlighter';
  const pad = (isHL || stroke.tool === 'pencil')
    ? Math.max(28, Math.ceil((stroke.size * 2) + 12))
    : 24;

  // Ridisegna sempre in piena risoluzione sul canvas principale evitando blit 1.5x sfocati
  // (Android/Surface Go 1 con zoom) e garantendo coerenza su punta finale e trasparenza.
  const pctx = pageData.ctx;
  const dpr = pageData.dpr || 1;
  if (pctx) {
    pctx.save();
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (stroke.points.length === 1) {
      drawDotOnly(pageData, stroke);
    } else {
      renderFullStroke(pctx, stroke, state.isDarkMode);
    }
    pctx.restore();
  }
  if (extraClearBBox) clearOverlayBBox(pageData, extraClearBBox);
  clearOverlayBBox(pageData, getStrokeBBoxCanvas(stroke, pad));
}