// ============================================================
// INK TOOLS — pen / pencil / marker / highlighter.
// Logica condivisa: begin/move/end. Le differenze per tool sono
// isolate in helper (_finalizeForTool).
// ============================================================

import { state } from '../../core/state.js';
import { SHAPE_CAPABLE_TOOLS, showToast } from '../../core/utils.js';
import {
  clearOverlay, renderPendingShapeOnOverlay,
  drawFinalSegmentOnly, drawDotOnly, renderFullStroke
} from '../render/render.js';
import {
  finalizePendingShape, applyAngleSnap,
  trySnapToLine, detectAndSnapShape, trySnapHighlighter
} from './shapes.js';
import { finalizeScribble } from './scribble.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import {
  getCanvasCoords, pushPointsToBatch, scheduleFlush,
  isPredictionSupported, drawPredictions
} from './tool-shared.js';

export function beginInkStroke(point) {
  state.currentStroke = {
    tool: state.activeTool, color: state.currentColor, size: state.strokeWidth,
    startTime: performance.now(),
    _drawnIdx: 0,
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
      drawPredictions(pageData, predicted);
    }
  }
}

/**
 * Finalizza lo stroke ink al pointerup.
 * Ritorna una stringa che descrive il caso gestito (per debug/log).
 */
export function endInkStroke(pageData) {
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

  // Snap forme (solo se auto-shape attivo e stroke sufficientemente lungo)
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
  clearOverlay(pageData);
  scheduleSave();
  pushHistory();
  state.currentStroke = null;
  return 'ink';
}

/**
 * Render finale per tool. Preserva il comportamento originale:
 * - snapped: renderFullStroke (post-shape recognition)
 * - 1 punto: drawDotOnly
 * - highlighter: drawFinalSegmentOnly
 * - pencil: renderFullStroke (darkening per-step, no blit)
 * - pen/marker: blit overlay → main (O(1))
 */
function _renderFinalStroke(pageData, stroke, snapped) {
  if (snapped) {
    const pctx = pageData.ctx, dpr = pageData.dpr || 1;
    pctx.save(); pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderFullStroke(pctx, stroke, state.isDarkMode);
    pctx.restore();
    return;
  }
  if (stroke.points.length === 1) {
    drawDotOnly(pageData, stroke);
    return;
  }
  if (state.activeTool === 'highlighter') {
    drawFinalSegmentOnly(pageData, stroke);
    return;
  }
  if (state.activeTool === 'pencil') {
    const pctx = pageData.ctx, dpr = pageData.dpr || 1;
    pctx.save(); pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderFullStroke(pctx, stroke, state.isDarkMode);
    pctx.restore();
    return;
  }
  // pen / marker: overlay ha già lo stroke con unify → blit O(1)
  const pctx = pageData.ctx;
  pctx.save();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.globalCompositeOperation = 'source-over';
  pctx.globalAlpha = 1;
  pctx.drawImage(
    pageData.overlayCanvas,
    0, 0,
    pageData.canvas.width,
    pageData.canvas.height
  );
  pctx.restore();
}