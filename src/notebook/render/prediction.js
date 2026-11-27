// ============================================================
// PREDICTED EVENTS: maschera la latenza del driver penna.
// Canvas separato, DPR 1, effimero: clear ad ogni frame.
// Solo per pointerType 'pen' e solo se il browser supporta
// PointerEvent.getPredictedEvents().
// ============================================================

import { state } from '../../shared/core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, sliderToBaseSize, getEffectiveColor, isPaperDark } from '../../shared/core/utils.js';
import { getDeviceProfile } from '../platform/profiles/index.js';
import { getPressureParams, computePredictionWidth } from '../tools/ink-calibration.js';

const PREDICTION_ALPHA = 0.40;

function _getPredictionDpr() {
  return getDeviceProfile(state.platform?.family).rendering.predictionDpr || 1;
}

export function ensurePredictionCanvas(pageData) {
  const dpr = _getPredictionDpr();
  if (pageData._predCanvas) {
    if (pageData._predDpr !== dpr) {
      pageData._predCanvas.width = Math.floor(PAGE_WIDTH * dpr);
      pageData._predCanvas.height = Math.floor(PAGE_HEIGHT * dpr);
      pageData._predDpr = dpr;
      pageData._lastPredBBox = null;
    }
    return;
  }
  const c = document.createElement('canvas');
  c.className = 'prediction-canvas';
  c.width = Math.floor(PAGE_WIDTH * dpr);
  c.height = Math.floor(PAGE_HEIGHT * dpr);
  pageData.wrapper.appendChild(c);
  pageData._predCanvas = c;
  pageData._predCtx = c.getContext('2d');
  pageData._predDpr = dpr;
}

/**
 * Pulisce le predizioni precedenti.
 *
 * Se pageData._lastPredBBox è null, significa che non c'è nulla da
 * pulire (canvas appena creato o appena pulito). Il vecchio fallback
 * a clearRect full-canvas (794×1123 = ~890k px) costava 5-10ms su
 * Surface Go 1, ed era chiamato ad ogni flush quando la penna non
 * emetteva predizioni (o con touch). Ora è O(1).
 *
 * NOTA: pageData._lastPredBBox è PER-PAGE. Prima era una variabile
 * module-level condivisa, con rischio di clearRect su coordinate
 * sbagliate quando si cambiava pagina.
 */
export function clearPredictions(pageData, forceFull = false) {
  if (!pageData || !pageData._predCtx) return;
  const ctx = pageData._predCtx;
  if (forceFull) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pageData._predCanvas.width, pageData._predCanvas.height);
    ctx.restore();
    pageData._lastPredBBox = null;
    return;
  }
  if (!pageData._lastPredBBox) return;
  const dpr = pageData._predDpr || _getPredictionDpr();
  const pad = 12;
  const b = pageData._lastPredBBox;
  const x = Math.max(0, Math.floor((b.x - pad) * dpr));
  const y = Math.max(0, Math.floor((b.y - pad) * dpr));
  const r = Math.min(pageData._predCanvas.width, Math.ceil((b.x + b.w + pad) * dpr));
  const bt = Math.min(pageData._predCanvas.height, Math.ceil((b.y + b.h + pad) * dpr));
  if (r > x && bt > y) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(x, y, r - x, bt - y);
    ctx.restore();
  }
  pageData._lastPredBBox = null;
}

/**
 * Disegna le predizioni.
 *
 * @param {Object} pageData
 * @param {PointerEvent[]} events  — eventi predetti da getPredictedEvents()
 * @param {DOMRect} [rect]         — rect del canvas, passato da getCanvasRect()
 *                                   per riusare la cache di tool-shared.js.
 *                                   Se omesso, fallback a getBoundingClientRect
 *                                   (retrocompat, ma 1-3ms su canvas con scale).
 */
export function drawPredictions(pageData, events, rect) {
  const stroke = state.currentStroke;
  if (!pageData._predCtx || !stroke) return;
  if (stroke.points.length === 0) return;
  const ctx = pageData._predCtx;
  const dpr = pageData._predDpr || _getPredictionDpr();

  // Cancella solo il bbox della predizione precedente (per-page)
  if (pageData._lastPredBBox) {
    const pad = 12;
    const b = pageData._lastPredBBox;
    const cx = Math.max(0, Math.floor((b.x - pad) * dpr));
    const cy = Math.max(0, Math.floor((b.y - pad) * dpr));
    const cr = Math.min(pageData._predCanvas.width, Math.ceil((b.x + b.w + pad) * dpr));
    const cb = Math.min(pageData._predCanvas.height, Math.ceil((b.y + b.h + pad) * dpr));
    if (cr > cx && cb > cy) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(cx, cy, cr - cx, cb - cy);
      ctx.restore();
    }
  }

  const last = stroke.points[stroke.points.length - 1];
  const pressureParams = getPressureParams();
  const baseSize = sliderToBaseSize(stroke.size != null ? stroke.size : state.strokeWidth);
  const strokeW = computePredictionWidth({
    tool: stroke.tool || state.activeTool,
    baseSize,
    lastPoint: last,
    predictedEvents: events,
    inkParams: stroke.inkParams || pressureParams,
    platform: state.platform.family,
    sensitivity: pressureParams.sensitivity
  });
  const inkDark = isPaperDark(state.isDarkMode, state.paperColor);
  const strokeOpacity = stroke.opacity != null ? stroke.opacity : 1.0;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = PREDICTION_ALPHA * strokeOpacity;
  ctx.strokeStyle = getEffectiveColor(stroke.color || state.currentColor, inkDark);
  ctx.lineWidth = strokeW;

  const r = rect || pageData.canvas.getBoundingClientRect();
  const scaleX = PAGE_WIDTH / r.width;
  const scaleY = PAGE_HEIGHT / r.height;

  let minX = last.x, maxX = last.x, minY = last.y, maxY = last.y;
  const pts = [[last.x, last.y]];
  for (const ev of events) {
    const x = (ev.clientX - r.left) * scaleX;
    const y = (ev.clientY - r.top) * scaleY;
    pts.push([x, y]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();

  const bboxPad = Math.max(12, strokeW + 6);
  pageData._lastPredBBox = {
    x: minX - bboxPad, y: minY - bboxPad,
    w: (maxX - minX) + bboxPad * 2,
    h: (maxY - minY) + bboxPad * 2
  };
}

export function isPredictionSupported(e) {
  return e.pointerType === 'pen' && typeof e.getPredictedEvents === 'function';
}