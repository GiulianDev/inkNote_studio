// ============================================================
// PREDICTED EVENTS: maschera la latenza del driver penna.
// Canvas separato, DPR 1, effimero: clear ad ogni frame.
// Solo per pointerType 'pen' e solo se il browser supporta
// PointerEvent.getPredictedEvents().
// ============================================================

import { state } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, sliderToBaseSize, getEffectiveColor } from '../../core/utils.js';

const PREDICTION_ALPHA = 0.40;
const PREDICTION_DPR = 1;
let _lastPredBBox = null;

export function ensurePredictionCanvas(pageData) {
  if (pageData._predCanvas) return;
  const c = document.createElement('canvas');
  c.className = 'prediction-canvas';
  c.width = Math.floor(PAGE_WIDTH * PREDICTION_DPR);
  c.height = Math.floor(PAGE_HEIGHT * PREDICTION_DPR);
  pageData.wrapper.appendChild(c);
  pageData._predCanvas = c;
  pageData._predCtx = c.getContext('2d');
}

export function clearPredictions(pageData) {
  if (!pageData || !pageData._predCtx) return;
  if (_lastPredBBox) {
    const pad = 8;
    pageData._predCtx.clearRect(
      _lastPredBBox.x - pad, _lastPredBBox.y - pad,
      _lastPredBBox.w + pad * 2, _lastPredBBox.h + pad * 2
    );
    _lastPredBBox = null;
  } else {
    pageData._predCtx.clearRect(0, 0, pageData._predCanvas.width, pageData._predCanvas.height);
  }
}

export function drawPredictions(pageData, events) {
  if (!pageData._predCtx || !state.currentStroke) return;
  if (state.currentStroke.points.length === 0) return;
  const ctx = pageData._predCtx;
  const dpr = PREDICTION_DPR;

  // Cancella solo il bbox della predizione precedente
  if (_lastPredBBox) {
    const pad = 8;
    ctx.clearRect(
      _lastPredBBox.x - pad, _lastPredBBox.y - pad,
      _lastPredBBox.w + pad * 2, _lastPredBBox.h + pad * 2
    );
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = PREDICTION_ALPHA;
  ctx.strokeStyle = getEffectiveColor(state.currentColor, state.isDarkMode);
  const strokeW = Math.max(0.5, sliderToBaseSize(state.strokeWidth) * 1.2);
  ctx.lineWidth = strokeW;

  const last = state.currentStroke.points[state.currentStroke.points.length - 1];
  const rect = pageData.canvas.getBoundingClientRect();
  const scaleX = PAGE_WIDTH / rect.width;
  const scaleY = PAGE_HEIGHT / rect.height;

  let minX = last.x, maxX = last.x, minY = last.y, maxY = last.y;
  const pts = [[last.x, last.y]];
  for (const ev of events) {
    const x = (ev.clientX - rect.left) * scaleX;
    const y = (ev.clientY - rect.top) * scaleY;
    pts.push([x, y]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();

  _lastPredBBox = {
    x: minX - strokeW, y: minY - strokeW,
    w: (maxX - minX) + strokeW * 2,
    h: (maxY - minY) + strokeW * 2
  };
}

export function isPredictionSupported(e) {
  return e.pointerType === 'pen' && typeof e.getPredictedEvents === 'function';
}