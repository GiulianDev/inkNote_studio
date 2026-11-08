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
  pageData._predCtx.clearRect(0, 0, pageData._predCanvas.width, pageData._predCanvas.height);
}

export function drawPredictions(pageData, events) {
  if (!pageData._predCtx || !state.currentStroke) return;
  if (state.currentStroke.points.length === 0) return;
  const ctx = pageData._predCtx;
  const dpr = PREDICTION_DPR;
  ctx.clearRect(0, 0, pageData._predCanvas.width, pageData._predCanvas.height);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = PREDICTION_ALPHA;
  ctx.strokeStyle = getEffectiveColor(state.currentColor, state.isDarkMode);
  // Spessore predittivo: base fissa (pressure predetta è rumorosa, la ignoro)
  ctx.lineWidth = Math.max(0.5, sliderToBaseSize(state.strokeWidth) * 1.2);

  const last = state.currentStroke.points[state.currentStroke.points.length - 1];
  const rect = pageData.canvas.getBoundingClientRect();
  const scaleX = PAGE_WIDTH / rect.width;
  const scaleY = PAGE_HEIGHT / rect.height;
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  for (const ev of events) {
    const x = (ev.clientX - rect.left) * scaleX;
    const y = (ev.clientY - rect.top) * scaleY;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

export function isPredictionSupported(e) {
  return e.pointerType === 'pen' && typeof e.getPredictedEvents === 'function';
}