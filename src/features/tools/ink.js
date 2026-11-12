/**
 * @module features/tools/ink
 *
 * TOOL INK — pen / pencil / marker / highlighter (logica condivisa).
 *
 * Highlighter:
 *   - rendering opaco su overlay (jitter + width variation)
 *   - blit bbox-based con alpha utente + multiply/screen
 *   - alpha dell'overlay in CSS (opacity) per l'anteprima durante stroke
 */

import { state } from '../../core/state.js';
import { SHAPE_CAPABLE_TOOLS, showToast, sliderToBaseSize } from '../../core/utils.js';
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
import { getToolbarSettings } from '../toolbar/toolbar-settings.js';
import {
  getCanvasCoords, getCanvasRect, pushPointsToBatch, scheduleFlush,
  isPredictionSupported, drawPredictions
} from './tool-shared.js';

function _getHLOpacity() {
  const s = getToolbarSettings();
  return s.tools.highlighter.opacity ?? 0.6;
}

export function beginInkStroke(point) {
  state.currentStroke = {
    tool: state.activeTool, color: state.currentColor, size: state.strokeWidth,
    startTime: performance.now(),
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

  let snapped = false;
  if (pts.length > 2 && state.autoShapeEnabled) {
    if (state.activeTool === 'highlighter') {
      if (trySnapHighlighter(stroke)) {
        showToast('Evidenziatore raddrizzato', '🖍️');
        snapped = true;
      }
    } else if (SHAPE_CAPABLE_TOOLS.includes(state.activeTool)) {
      if (trySnapToLine(stroke)) {
        showToast('Linea agganciata', '📏');
        snapped = true;
      } else if (detectAndSnapShape(stroke, pageData)) {
        snapped = true;
      }
    }
  }

  pageData.strokes.push(stroke);
  _renderFinalStroke(pageData, stroke, snapped);
  scheduleSave();
  pushHistory();
  state.currentStroke = null;
  return 'ink';
}

function _renderFinalStroke(pageData, stroke, snapped) {
  const isHL = stroke.tool === 'highlighter';
  const pad = isHL
    ? Math.max(24, sliderToBaseSize(stroke.size) * 4 + 8)
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
    clearOverlayBBox(pageData, getStrokeBBoxCanvas(stroke, pad));
    return;
  }

  const bbox = getStrokeBBoxCanvas(stroke, pad);
  if (isHL) {
    const isDark = state.isDarkMode;
    blitAndClearBBox(pageData, bbox, {
      alpha: _getHLOpacity(),
      compositeOp: isDark ? 'screen' : 'multiply'
    });
  } else {
    blitAndClearBBox(pageData, bbox);
  }
}