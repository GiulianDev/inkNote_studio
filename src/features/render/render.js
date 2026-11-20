/**
 * @module features/render/render
 *
 * RENDERING CANVAS — stili stroke, tapered path, selection overlay,
 * background patterns, pending shape, bbox-based blit/clear.
 *
 * Highlighter unificato a pen/marker:
 *   - jitter perpendicolare ±1.2px (bordo "ruvido")
 *   - width variation con pressione/velocità
 *   - rendering OPACO su overlay (alpha + multiply/screen al blit)
 *   - nessun campo `_lastHighlighterBBox` (era per-page, causava bleed)
 *
 * Pencil:
 *   - alpha interna 0.55 (grana grafite) × opacity utente
 *   - rende su main canvas (drawIncrementalBatch → drawFullStroke)
 *
 * Opacity:
 *   - applicata al BLIT (non al disegno) per evitare accumulo alpha
 *     tra segmenti adiacenti
 *
 * @see core/types.js  — Stroke, PageData, BBox
 * @see render/stroke-cache.js
 * @see render/prediction.js
 */

import { getStrokeBitmap, buildStrokeBitmap } from './stroke-cache.js';
import { state, viewport } from '../../core/state.js';
import {
  PAGE_WIDTH, PAGE_HEIGHT, hexToRgbA, getEffectiveColor,
  roundRect, sliderToBaseSize, fastHypot
} from '../../core/utils.js';
import { getPressureParams } from '../../core/app-settings.js';

const SCRIBBLE_ERASE_COLOR  = 'rgba(220, 38, 38, 0.6)';
const SCRIBBLE_TARGET_COLOR = 'rgba(239, 68, 68, 0.75)';
const HL_JITTER_MAG = 1.2;

let _bgCache = { key: null, canvas: null };
const BACKGROUND_DPR = 2;

const _ptA = { x: 0, y: 0 };
const _ptB = { x: 0, y: 0 };

// ============================================================
// GEOMETRY (usata da render e lazo)
// ============================================================

export function getSelectionBoundingBox(includePad = true) {
  if (state.selectedStrokes.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  state.selectedStrokes.forEach(stroke => {
    stroke.points.forEach(p => {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
  });
  const pad = includePad ? 12 / viewport.scale : 0;
  return {
    minX: minX - pad, maxX: maxX + pad,
    minY: minY - pad, maxY: maxY + pad,
    width: (maxX - minX) + pad * 2,
    height: (maxY - minY) + pad * 2
  };
}

export function getVisualBoundingBox() {
  const real = getSelectionBoundingBox(false);
  if (!real) return null;
  const minSize = 40 / viewport.scale;
  const cx = (real.minX + real.maxX) / 2;
  const cy = (real.minY + real.maxY) / 2;
  let { minX, maxX, minY, maxY } = real;
  if (real.width < minSize)  { minX = cx - minSize / 2; maxX = cx + minSize / 2; }
  if (real.height < minSize) { minY = cy - minSize / 2; maxY = cy + minSize / 2; }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

export function isPointInBBox(pt, bbox) {
  if (!bbox) return false;
  return pt.x >= bbox.minX && pt.x <= bbox.maxX && pt.y >= bbox.minY && pt.y <= bbox.maxY;
}

export function getHandlePositions(bbox) {
  return {
    nw: { x: bbox.minX, y: bbox.minY },
    se: { x: bbox.maxX, y: bbox.maxY }
  };
}

export function hitTestHandle(point, visualBBox) {
  if (!visualBBox) return null;
  const handles = getHandlePositions(visualBBox);
  const hitRadius = 16 / viewport.scale;
  for (const name of ['nw', 'se']) {
    const h = handles[name];
    if (Math.hypot(point.x - h.x, point.y - h.y) < hitRadius) return name;
  }
  return null;
}

export function findClosestPointInSelection(target) {
  let closest = null;
  let minDist = Infinity;
  state.selectedStrokes.forEach(stroke => {
    stroke.points.forEach(p => {
      const d = Math.hypot(p.x - target.x, p.y - target.y);
      if (d < minDist) { minDist = d; closest = { x: p.x, y: p.y }; }
    });
  });
  return closest;
}

// ============================================================
// STYLE HELPERS
// ============================================================

function getTiltNorm(pt) {
  if (!pt || (!pt.tiltX && !pt.tiltY)) return 0;
  return Math.min(1, fastHypot(pt.tiltX || 0, pt.tiltY || 0) / 30);
}
function getSpeedNorm(pt) {
  if (!pt || !pt.speed) return 0;
  return Math.min(1, pt.speed / 8);
}
function getTaper(idx, tool) {
  if (tool !== 'pen' && tool !== 'pencil') return 1.0;
  if (idx === 0) return 1.4;
  if (idx === 1) return 1.15;
  return 1.0;
}

// ============================================================
// HIGHLIGHTER HELPERS (jitter perpendicolare + width)
// ============================================================

function _strokeSeed(stroke) {
  const p0 = stroke.points && stroke.points[0];
  if (!p0) return 0x5F3759DF;
  return (((p0.x * 100) | 0) ^ ((p0.y * 100) | 0) ^ ((stroke.size * 97) | 0) ^ 0x5F3759DF) >>> 0;
}

function _jitterAt(seed, i) {
  let s = (seed + i * 2654435761) >>> 0;
  s = (s * 1664525 + 1013904223) >>> 0;
  return (s / 0xFFFFFFFF) * 2 - 1; // [-1, 1]
}

function _ensureJitterCache(stroke) {
  const n = stroke.points.length;
  if (!stroke._jitterOffsets || stroke._jitterOffsets.length < n) {
    const old = stroke._jitterOffsets || new Float32Array(0);
    const size = Math.max(n, old.length * 2 || 64);
    const next = new Float32Array(size);
    next.set(old);
    const seed = _strokeSeed(stroke);
    for (let i = old.length; i < size; i++) {
      next[i] = _jitterAt(seed, i);
    }
    stroke._jitterOffsets = next;
  }
  return stroke._jitterOffsets;
}

/**
 * Ritorna array di {x, y} con jitter perpendicolare applicato per
 * highlighter. Per gli altri tool ritorna i punti originali.
 * Il jitter è deterministico per stroke (stesso stroke → stesso pattern).
 */
export function getDisplayPoints(stroke) {
  const pts = stroke.points;
  if (stroke.tool !== 'highlighter' || pts.length < 2) return pts;
  const n = pts.length;
  const jitter = _ensureJitterCache(stroke);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let dx, dy;
    if (i === 0) { dx = pts[1].x - p.x; dy = pts[1].y - p.y; }
    else if (i === n - 1) { dx = p.x - pts[i - 1].x; dy = p.y - pts[i - 1].y; }
    else { dx = pts[i + 1].x - pts[i - 1].x; dy = pts[i + 1].y - pts[i - 1].y; }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) { out[i] = { x: p.x, y: p.y }; continue; }
    const nx = -dy / len, ny = dx / len;
    const mag = jitter[i] * HL_JITTER_MAG;
    out[i] = { x: p.x + nx * mag, y: p.y + ny * mag };
  }
  return out;
}

function _computeHighlighterWidth(baseSize, pressure, speedNorm) {
  const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));
  const w = baseSize * 4.0;
  const pressureMul = 0.85 + p * 0.30;
  const speedMul = 1 - Math.min(1, (speedNorm || 0)) * 0.15;
  return w * pressureMul * speedMul;
}

// ============================================================
// COMPUTE STROKE WIDTH
// ============================================================

export function computeStrokeWidth(tool, rawSize, pressure, tiltNorm = 0, speedNorm = 0, taper = 1.0, precomputedBaseSize = null) {
  const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));
  const baseSize = precomputedBaseSize !== null ? precomputedBaseSize : sliderToBaseSize(rawSize);
  let w = baseSize;
  if (tool === 'pen' || tool === 'pencil') {
    const params = getPressureParams();
    const range = params.heavyMul - params.lightMul;
    w = baseSize * (params.lightMul + Math.pow(p, params.curve) * range);
    if (tool === 'pen') { w *= (1 + tiltNorm * 0.15); w *= (1 - speedNorm * 0.25); }
    else                { w *= (1 + tiltNorm * 1.5);  w *= (1 - speedNorm * 0.4); }
  } else if (tool === 'marker') {
    w = baseSize * (1.2 + p * 1.0);
    w *= (1 + tiltNorm * 0.50);
    w *= (1 - speedNorm * 0.15);
  } else if (tool === 'highlighter') {
    w = _computeHighlighterWidth(baseSize, pressure, speedNorm);
  }
  w *= taper;
  return w;
}

// ============================================================
// STROKE STYLE (con cache)
// ============================================================

function getStrokeStyle(stroke, isDark) {
  const key = isDark ? 'dark' : 'light';
  const cache = stroke._styleCache;
  if (cache && cache.key === key) return cache;

  let strokeStyle, fillStyle, gco;
  if (stroke.tool === 'highlighter') {
    gco = 'source-over';
    strokeStyle = stroke.color;
    fillStyle = stroke.color;
  } else if (stroke.tool === 'pencil') {
    gco = 'source-over';
    const c = hexToRgbA(getEffectiveColor(stroke.color, isDark), 0.55);
    strokeStyle = c; fillStyle = c;
  } else {
    gco = 'source-over';
    const c = getEffectiveColor(stroke.color, isDark);
    strokeStyle = c; fillStyle = c;
  }

  // lineDash per lo stile del tratto (calcolato sulla size dello stroke)
  const lineDash = _buildLineDash(stroke.style, sliderToBaseSize(stroke.size));

  const result = { key, strokeStyle, fillStyle, gco, lineDash };
  stroke._styleCache = result;
  return result;
}

export function _buildLineDash(style, baseSize) {
  if (!style || style === 'solid') return null;
  const s = Math.max(0.8, baseSize);
  if (style === 'dashed')        return [s * 4, s * 3];
  if (style === 'dashed-large')  return [s * 9, s * 6];   // ← nuovo
  if (style === 'dotted')        return [0.1, s * 3];
  if (style === 'dash-dot')      return [s * 4, s * 2, 0.1, s * 2];
  return null;
}

function setupStrokeStyle(ctx, stroke, forceTargetDark) {
  const s = getStrokeStyle(stroke, forceTargetDark);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = s.gco;
  ctx.strokeStyle = s.strokeStyle;
  ctx.fillStyle = s.fillStyle;
}

function canUnifyFill(tool) { return tool === 'pen' || tool === 'marker'; }
function canUnifyFillIncremental(tool) { return tool === 'pen' || tool === 'marker' || tool === 'pencil'; }

function addTaperedSegmentPolygon(ctx, p0, p1, w0, w1) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = fastHypot(dx, dy);
  if (len < 0.01) return;
  const nx = -dy / len, ny = dx / len;
  const hw0 = Math.max(w0, 0.5) / 2, hw1 = Math.max(w1, 0.5) / 2;
  ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
  ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
  ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
  ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
  ctx.closePath();
}

function addTaperedSegmentCircle(ctx, p0, w0) {
  const hw0 = Math.max(w0, 0.5) / 2;
  ctx.moveTo(p0.x + hw0, p0.y);
  ctx.arc(p0.x, p0.y, hw0, 0, Math.PI * 2);
}

function interpolatePointInto(out, p0, p1, p2, p3, t, smoothness) {
  const lx = p1.x + (p2.x - p1.x) * t;
  const ly = p1.y + (p2.y - p1.y) * t;
  if (smoothness <= 0.01) { out.x = lx; out.y = ly; return; }
  const t2 = t * t, t3 = t2 * t;
  const cx = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const cy = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.x = lx + (cx - lx) * smoothness;
  out.y = ly + (cy - ly) * smoothness;
}

function drawTaperedSegment(ctx, p0, p1, w0, w1) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = fastHypot(dx, dy);
  if (len < 0.01) {
    const w = Math.max((w0 + w1) / 2, 0.5);
    ctx.beginPath(); ctx.arc(p0.x, p0.y, w / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  const nx = -dy / len, ny = dx / len;
  const hw0 = Math.max(w0, 0.5) / 2, hw1 = Math.max(w1, 0.5) / 2;
  ctx.beginPath();
  ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
  ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
  ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
  ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath(); ctx.arc(p0.x, p0.y, hw0, 0, Math.PI * 2); ctx.fill();
}

// ============================================================
// BBOX HELPERS (used by ink.js, dispatcher.js)
// ============================================================

export function getStrokeBBoxCanvas(stroke, pad = 24) {
  const pts = stroke && stroke.points;
  if (!pts || pts.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return {
    minX: minX - pad, maxX: maxX + pad,
    minY: minY - pad, maxY: maxY + pad
  };
}

export function clearOverlayBBox(pageData, bbox) {
  if (!pageData || !pageData.overlayCtx || !bbox) return;
  const dpr = pageData.overlayDpr || pageData.dpr || 1;
  const octx = pageData.overlayCtx;
  const x = Math.max(0, Math.floor(bbox.minX * dpr));
  const y = Math.max(0, Math.floor(bbox.minY * dpr));
  const w = Math.ceil((bbox.maxX - bbox.minX) * dpr);
  const h = Math.ceil((bbox.maxY - bbox.minY) * dpr);
  if (w > 0 && h > 0) {
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(x, y, w, h);
    octx.restore();
  }
  // Reset CSS preview (necessario per pencil/pen/marker: dopo il render
  // finale il blit o il full redraw hanno già scritto su main, ma
  // l'overlay può avere ancora opacity/mixBlendMode attivi durante
  // lo stroke successivo).
  if (pageData.overlayCanvas) {
    pageData.overlayCanvas.style.opacity = '';
    pageData.overlayCanvas.style.mixBlendMode = '';
  }
}

/**
 * Copia il bbox dell'overlay sulla main canvas, poi pulisce la stessa
 * area dall'overlay e RESETTA lo stile CSS di preview (mixBlendMode +
 * opacity). Il reset CSS è necessario perché durante lo stroke
 * highlighter l'overlay ha `mix-blend-mode: multiply; opacity: X` via
 * CSS, e va pulito per evitare bleed visivo sulla main.
 *
 * opts.alpha        — globalAlpha al blit (default 1.0)
 * opts.compositeOp  — globalCompositeOperation al blit (default 'source-over')
 */
export function blitAndClearBBox(pageData, bbox, opts = {}) {
  if (!pageData || !bbox) return;
  const pctx = pageData.ctx;
  const octx = pageData.overlayCtx;
  if (!pctx || !octx) return;
  const pDpr = pageData.dpr || 1;
  const oDpr = pageData.overlayDpr || pDpr;

  const px = Math.max(0, Math.floor(bbox.minX * pDpr));
  const py = Math.max(0, Math.floor(bbox.minY * pDpr));
  const pw = Math.ceil((bbox.maxX - bbox.minX) * pDpr);
  const ph = Math.ceil((bbox.maxY - bbox.minY) * pDpr);

  const ox = Math.floor(bbox.minX * oDpr);
  const oy = Math.floor(bbox.minY * oDpr);
  const ow = Math.ceil((bbox.maxX - bbox.minX) * oDpr);
  const oh = Math.ceil((bbox.maxY - bbox.minY) * oDpr);

  if (pw > 0 && ph > 0 && ow > 0 && oh > 0) {
    const alpha = opts.alpha != null ? opts.alpha : 1;
    const compositeOp = opts.compositeOp || 'source-over';

    pctx.save();
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.globalCompositeOperation = compositeOp;
    pctx.globalAlpha = alpha;
    pctx.drawImage(pageData.overlayCanvas, ox, oy, ow, oh, px, py, pw, ph);
    pctx.restore();

    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(ox, oy, ow, oh);
    octx.restore();
  }

  // Reset CSS preview (mixBlendMode + opacity) sull'overlay.
  if (pageData.overlayCanvas) {
    pageData.overlayCanvas.style.opacity = '';
    pageData.overlayCanvas.style.mixBlendMode = '';
  }
}

// ============================================================
// REDRAW PAGE
// ============================================================

export function redrawPageCanvas(pageData, forceTargetDark = state.isDarkMode) {
  const ctx = pageData.ctx;
  const dpr = pageData.dpr || 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pageData.canvas.width, pageData.canvas.height);
  ctx.scale(dpr, dpr);

  drawPaperBackground(ctx, forceTargetDark);

  const targetSet = (state.scribbleMode && state.scribbleTargets)
    ? new Set(state.scribbleTargets) : null;
  const selectedSet = (state.selectedStrokes && state.selectedStrokes.length > 0)
    ? new Set(state.selectedStrokes) : null;

  pageData.strokes.forEach(stroke => {
    if (selectedSet && selectedSet.has(stroke)) return;
    const isTarget = targetSet && targetSet.has(stroke);

    if (stroke.tool === 'pencil' && !isTarget && (stroke.style || 'solid') === 'solid') {
      let cached = getStrokeBitmap(stroke, dpr, forceTargetDark);
      if (!cached) cached = buildStrokeBitmap(stroke, dpr, forceTargetDark);
      if (cached) {
        ctx.drawImage(
          cached.canvas,
          cached.bbox.x, cached.bbox.y,
          cached.bbox.w, cached.bbox.h
        );
        return;
      }
    }

    renderFullStroke(ctx, stroke, forceTargetDark, isTarget ? SCRIBBLE_TARGET_COLOR : null);
  });

  if (Array.isArray(pageData.textBoxes) && pageData.textBoxes.length > 0) {
    const isExport = !!pageData._isExport;
    for (let i = 0; i < pageData.textBoxes.length; i++) {
      const tb = pageData.textBoxes[i];
      if (!tb) continue;
      if (!isExport && (tb.id === state.editingTextBoxId || tb.id === state._draggingTextBoxId)) {
        continue;
      }
      drawTextBoxOnCanvas(ctx, tb, forceTargetDark);
    }
  }

  ctx.restore();
}

// ============================================================
// DOT (single point)
// ============================================================

export function drawDotOnly(pageData, stroke) {
  const pts = stroke.points;
  if (pts.length === 0) return;
  const pt = pts[0];
  const ctx = pageData.ctx;
  const dpr = pageData.dpr || 1;
  const opacity = stroke.opacity != null ? stroke.opacity : 1.0;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (stroke.tool === 'highlighter') {
    ctx.globalCompositeOperation = state.isDarkMode ? 'screen' : 'multiply';
    ctx.globalAlpha = opacity;
    ctx.fillStyle = stroke.color;
    const baseSize = sliderToBaseSize(stroke.size);
    const w = baseSize * 4.0;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2); ctx.fill();
  } else {
    // Pencil: colore ha già alpha interna 0.55 in getStrokeStyle.
    // Pen/marker: colore pieno.
    // In entrambi i casi applichiamo opacity utente via globalAlpha.
    setupStrokeStyle(ctx, stroke, state.isDarkMode);
    ctx.globalAlpha = opacity;
    const baseSize = sliderToBaseSize(stroke.size);
    const w = computeStrokeWidth(stroke.tool, stroke.size, pt.pressure, getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize);
    ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ============================================================
// RENDER FULL STROKE
// ============================================================

export function renderFullStroke(ctx, stroke, forceTargetDark, overrideColor = null) {
  const pts = stroke.points;
  const n = pts.length;
  if (n < 1) return;

  const opacity = stroke.opacity != null ? stroke.opacity : 1.0;
  // Tratteggio: bypassa il path poligonale (fill) e usa ctx.stroke()
  // con setLineDash. Perde la taper della pressione ma rende il pattern.
  const styleInfo = getStrokeStyle(stroke, forceTargetDark);
  if (styleInfo.lineDash && stroke.tool !== 'highlighter' && !overrideColor) {
    _renderDashedStroke(ctx, stroke, styleInfo, forceTargetDark, opacity);
    return;
  }

  // Highlighter: jitter + alpha + multiply/screen (path unico, branch separato).
  if (stroke.tool === 'highlighter' && !overrideColor) {
    const jittered = getDisplayPoints(stroke);
    const baseSize = sliderToBaseSize(stroke.size);
    const lineWidth = Math.max(1, baseSize * 4.0);
    ctx.save();
    ctx.globalCompositeOperation = forceTargetDark ? 'screen' : 'multiply';
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(jittered[0].x, jittered[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(jittered[i].x, jittered[i].y);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (n === 1) {
    ctx.save();
    if (overrideColor) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = overrideColor; ctx.fillStyle = overrideColor;
    } else {
      setupStrokeStyle(ctx, stroke, forceTargetDark);
      ctx.globalAlpha = opacity;
    }
    const baseSize = sliderToBaseSize(stroke.size);
    const pt = pts[0];
    const w = computeStrokeWidth(stroke.tool, stroke.size, pt.pressure, getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize);
    ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }

  ctx.save();
  if (overrideColor) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = overrideColor; ctx.fillStyle = overrideColor;
  } else {
    setupStrokeStyle(ctx, stroke, forceTargetDark);
    // Applica opacity utente. Pencil ha colore con alpha interna
    // 0.55, quindi risultato = 0.55 × opacity. Pen/marker colore
    // pieno, risultato = opacity.
    ctx.globalAlpha = opacity;
  }

  const smoothness = state.smoothing;
  const baseSize = sliderToBaseSize(stroke.size);
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const pt = pts[i];
    widths[i] = computeStrokeWidth(stroke.tool, stroke.size, pt.pressure,
      getTiltNorm(pt), getSpeedNorm(pt), getTaper(i, stroke.tool), baseSize);
  }

  const unified = overrideColor != null || canUnifyFill(stroke.tool);
  if (unified) {
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = widths[i - 1], w2 = widths[i];
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
      const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
        interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
        addTaperedSegmentPolygon(ctx, _ptA, _ptB, w1 + (w2 - w1) * t0, w1 + (w2 - w1) * t1);
      }
    }
    ctx.fill();
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = widths[i - 1], w2 = widths[i];
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
      const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
        addTaperedSegmentCircle(ctx, _ptA, w1 + (w2 - w1) * t0);
      }
    }
    ctx.fill();
  } else {
    for (let i = 1; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = widths[i - 1], w2 = widths[i];
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
      const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
        interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
        drawTaperedSegment(ctx, _ptA, _ptB, w1 + (w2 - w1) * t0, w1 + (w2 - w1) * t1);
      }
    }
  }

  const lastW = Math.max(widths[n - 1], 0.5);
  ctx.beginPath(); ctx.arc(pts[n - 1].x, pts[n - 1].y, lastW / 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ============================================================
// INCREMENTAL DRAWING
// ============================================================

export function drawIncrementalBatch(ctx, stroke, fromIdx, dpr = 1) {
  const pts = stroke.points;
  const n = pts.length;
  if (n < 2) return;
  const firstSegEnd = Math.max(fromIdx || 0, 1);
  if (firstSegEnd >= n) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Style info (lineDash, strokeStyle, gco). Va calcolato prima
  // dei branch tratteggio/highlighter/solido.
  const styleInfo = getStrokeStyle(stroke, state.isDarkMode);

  // Tratteggio: stroke incrementale con setLineDash.
  //
  // PROBLEMA: se chiamiamo setLineDash ad ogni batch senza accumulare
  // l'offset, il pattern riparte da capo ogni volta → disegnando piano
  // (batch piccoli < periodo del pattern) si vede solo "il primo
  // trattino ripetuto". Inoltre la preview "sembra" proporzionale alla
  // velocità perché batch più grandi mostrano più trattini.
  //
  // FIX: accumuliamo la lunghezza del path già percorso in
  // `stroke._dashOffset` e impostiamo `lineDashOffset = -length`.
  // Il pattern continua esattamente da dove era rimasto.
  if (styleInfo.lineDash && stroke.tool !== 'highlighter') {
    const baseSize = sliderToBaseSize(stroke.size);
    let sumW = 0;
    for (let i = 0; i < n; i++) {
      const pt = pts[i];
      sumW += computeStrokeWidth(stroke.tool, stroke.size, pt.pressure,
        getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize);
    }
    const avgW = Math.max(0.6, sumW / n);

    // Init: al primo batch accumula la lunghezza fino a firstSegEnd - 1
    // (dovrebbe essere 0, ma per sicurezza). Nei batch successivi
    // _dashOffset è già aggiornato.
    if (stroke._dashOffset == null) {
      let len = 0;
      for (let i = 1; i < firstSegEnd; i++) {
        len += fastHypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      stroke._dashOffset = len;
    }

    ctx.setLineDash(styleInfo.lineDash);
    ctx.lineDashOffset = -stroke._dashOffset;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = styleInfo.gco;
    ctx.strokeStyle = styleInfo.strokeStyle;
    ctx.lineWidth = avgW;
    ctx.beginPath();
    ctx.moveTo(pts[firstSegEnd - 1].x, pts[firstSegEnd - 1].y);
    for (let i = firstSegEnd; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // Accumula lunghezza dei nuovi segmenti per il prossimo batch
    for (let i = firstSegEnd; i < n; i++) {
      stroke._dashOffset += fastHypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }

    ctx.restore();
    return;
  }

  // Highlighter: disegna OPACO sull'overlay (alpha al blit).
  // CSS mixBlendMode + opacity sull'overlay canvas fa l'anteprima.
  if (stroke.tool === 'highlighter') {
    const jittered = getDisplayPoints(stroke);
    const baseSize = sliderToBaseSize(stroke.size);
    const lineWidth = Math.max(1, baseSize * 4.0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(jittered[firstSegEnd - 1].x, jittered[firstSegEnd - 1].y);
    for (let i = firstSegEnd; i < n; i++) ctx.lineTo(jittered[i].x, jittered[i].y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  setupStrokeStyle(ctx, stroke, state.isDarkMode);

  const smoothness = state.smoothing;
  const baseSize = sliderToBaseSize(stroke.size);
  const unified = canUnifyFillIncremental(stroke.tool);

  if (unified) {
    ctx.beginPath();
    for (let i = firstSegEnd; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure,
        getTiltNorm(p1), getSpeedNorm(p1), getTaper(i - 1, stroke.tool), baseSize);
      const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure,
        getTiltNorm(p2), getSpeedNorm(p2), getTaper(i, stroke.tool), baseSize);
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
      const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
        interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
        addTaperedSegmentPolygon(ctx, _ptA, _ptB,
          w1 + (w2 - w1) * t0, w1 + (w2 - w1) * t1);
      }
    }
    ctx.fill();

    ctx.beginPath();
    for (let i = firstSegEnd; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure,
        getTiltNorm(p1), getSpeedNorm(p1), getTaper(i - 1, stroke.tool), baseSize);
      const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure,
        getTiltNorm(p2), getSpeedNorm(p2), getTaper(i, stroke.tool), baseSize);
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
      const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
        addTaperedSegmentCircle(ctx, _ptA, w1 + (w2 - w1) * t0);
      }
    }
    ctx.fill();

    if (smoothness <= 0.01 && n >= 2) {
      const tipP1 = pts[n - 2], tipP2 = pts[n - 1];
      const tipW1 = computeStrokeWidth(stroke.tool, stroke.size, tipP1.pressure,
        getTiltNorm(tipP1), getSpeedNorm(tipP1), 1.0, baseSize);
      const tipW2 = computeStrokeWidth(stroke.tool, stroke.size, tipP2.pressure,
        getTiltNorm(tipP2), getSpeedNorm(tipP2), 1.0, baseSize);
      ctx.beginPath();
      addTaperedSegmentPolygon(ctx, tipP1, tipP2, tipW1, tipW2);
      ctx.fill();
      ctx.beginPath();
      addTaperedSegmentCircle(ctx, tipP1, tipW1);
      ctx.fill();
    }
  } else {
    for (let i = firstSegEnd; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure,
        getTiltNorm(p1), getSpeedNorm(p1), getTaper(i - 1, stroke.tool), baseSize);
      const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure,
        getTiltNorm(p2), getSpeedNorm(p2), getTaper(i, stroke.tool), baseSize);
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
      const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
        interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
        drawTaperedSegment(ctx, _ptA, _ptB,
          w1 + (w2 - w1) * t0, w1 + (w2 - w1) * t1);
      }
    }
  }

  ctx.restore();
}

// ============================================================
// SCRIBBLE HELPERS
// ============================================================

export function drawScribbleSegment(ctx, stroke, dpr = 1) {
  const pts = stroke.points;
  const n = pts.length;
  if (n < 2) return;
  const p1 = pts[n - 2], p2 = pts[n - 1];
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = SCRIBBLE_ERASE_COLOR;
  ctx.fillStyle = SCRIBBLE_ERASE_COLOR;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(stroke.size * 2, 4);
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  ctx.restore();
}

export function drawScribbleStroke(ctx, stroke, dpr = 1) {
  const pts = stroke.points;
  if (pts.length < 2) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = SCRIBBLE_ERASE_COLOR;
  ctx.fillStyle = SCRIBBLE_ERASE_COLOR;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(stroke.size * 2, 4);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.restore();
}

// ============================================================
// PENDING SHAPE
// ============================================================

export function drawPendingShape(ctx, forceTargetDark) {
  const ps = state.pendingShape;
  if (!ps) return;

  const startPt = ps.start, endPt = ps.end;
  const effectiveColor = getEffectiveColor(ps.color, forceTargetDark);

  // Opacità visiva della linea di preview:
  //   - opacity utente dal popover (0.1..1.0)
  //   - pencil: grana interna 0.55 → moltiplicata
  //   - highlighter non entra mai in pendingShape (usa trySnapHighlighter
  //     che modifica in-place), quindi non serve gestirlo qui.
  const userOpacity = ps.opacity != null ? ps.opacity : 1.0;
  const pencilFactor = ps.tool === 'pencil' ? 0.55 : 1.0;
  const lineOpacity = userOpacity * pencilFactor;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = effectiveColor;
  ctx.lineWidth = computeStrokeWidth(ps.tool, ps.size, 0.5);
  ctx.globalAlpha = lineOpacity;

  // Mostra il pattern anche durante lo snap (prima era solo solido)
  const pendingDash = _buildLineDash(ps.style || 'solid', sliderToBaseSize(ps.size));
  if (pendingDash) {
    ctx.setLineDash(pendingDash);
    ctx.lineDashOffset = 0;
  }

  ctx.beginPath();
  ctx.moveTo(startPt.x, startPt.y);
  ctx.lineTo(endPt.x, endPt.y);
  ctx.stroke();
  ctx.globalAlpha = 1;                          // ← reset per maniglie/badge opachi

  const handleRadius = 8;
  [startPt, endPt].forEach(pt => {
    ctx.beginPath();
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 2.5;
    ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  });

  const midX = (startPt.x + endPt.x) / 2;
  const midY = (startPt.y + endPt.y) / 2;
  const len = fastHypot(endPt.x - startPt.x, endPt.y - startPt.y);
  const angle = Math.atan2(endPt.y - startPt.y, endPt.x - startPt.x);
  const angleDeg = Math.round((angle * 180 / Math.PI + 360) % 360);
  const label = `${Math.round(len)}px · ${angleDeg}°`;
  ctx.font = '600 13px Inter, sans-serif';
  const textW = ctx.measureText(label).width;
  const padX = 8, badgeW = textW + padX * 2, badgeH = 22;
  const bx = midX - badgeW / 2, by = midY - 36;
  const isSnapped = ps._snapAxis != null;

  ctx.save();
  ctx.fillStyle = isSnapped ? 'rgba(16, 185, 129, 0.95)' : 'rgba(79, 70, 229, 0.95)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, bx, by, badgeW, badgeH, 11);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, midX, by + badgeH / 2 + 0.5);
  ctx.restore();

  ctx.restore();
}

// ============================================================
// BACKGROUND (con colori custom del foglio)
//
// Legge `state.paperColor` e `state.patternColor`:
//   - null  → default del tema (dark ? slate : white/slate)
//   - hex   → override dell'utente
//
// La cache include i colori nella key: quando cambiano, la cache
// missa e il background viene ricostruito.
// ============================================================

function getBackgroundCanvas(patternName, isDark, paperColor, patternColor) {
  const key = `${patternName}|${isDark ? 'dark' : 'light'}|${paperColor || 'auto'}|${patternColor || 'auto'}`;
  if (_bgCache.key === key) return _bgCache.canvas;

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(PAGE_WIDTH * BACKGROUND_DPR);
  canvas.height = Math.floor(PAGE_HEIGHT * BACKGROUND_DPR);
  const bctx = canvas.getContext('2d');
  bctx.scale(BACKGROUND_DPR, BACKGROUND_DPR);

  // Colori effettivi
  const bgFill     = paperColor   || (isDark ? '#1E293B' : '#FFFFFF');
  const lineColor  = patternColor || (isDark ? '#334155' : '#E2E8F0');
  const dotColor   = patternColor || (isDark ? '#475569' : '#94A3B8');

  bctx.fillStyle = bgFill;
  bctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  bctx.strokeStyle = lineColor;
  bctx.lineWidth = 1;

  if (patternName === 'ruled') {
    for (let y = 60; y < PAGE_HEIGHT; y += 32) {
      bctx.beginPath(); bctx.moveTo(0, y); bctx.lineTo(PAGE_WIDTH, y); bctx.stroke();
    }
  } else if (patternName === 'grid') {
    for (let x = 0; x < PAGE_WIDTH; x += 25) {
      bctx.beginPath(); bctx.moveTo(x, 0); bctx.lineTo(x, PAGE_HEIGHT); bctx.stroke();
    }
    for (let y = 0; y < PAGE_HEIGHT; y += 25) {
      bctx.beginPath(); bctx.moveTo(0, y); bctx.lineTo(PAGE_WIDTH, y); bctx.stroke();
    }
  } else if (patternName === 'dots') {
    bctx.fillStyle = dotColor;
    for (let x = 20; x < PAGE_WIDTH; x += 20) {
      for (let y = 20; y < PAGE_HEIGHT; y += 24) {
        bctx.beginPath(); bctx.arc(x, y, 1.2, 0, Math.PI * 2); bctx.fill();
      }
    }
  }

  _bgCache = { key, canvas };
  return canvas;
}

export function drawPaperBackground(ctx, isDark) {
  const bg = getBackgroundCanvas(
    state.bgPattern,
    isDark,
    state.paperColor,
    state.patternColor
  );
  ctx.drawImage(bg, 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
}

// ============================================================
// SELECTION OVERLAY
// ============================================================

export function drawSelectionHandles(ctx, visualBBox) {
  const scale = viewport.scale;
  const handles = getHandlePositions(visualBBox);
  const r = 4.5 / scale;
  const accent = state.isDarkMode ? '#818cf8' : '#4f46e5';
  ctx.save();
  ['nw', 'se'].forEach(name => {
    const p = handles[name];
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5 / scale;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  if (state.isResizingSelection) {
    const realBBox = getSelectionBoundingBox(false);
    const deg = Math.round(state.resizeCurrentAngle * 180 / Math.PI);
    const dimLabel = realBBox
      ? `${Math.round(realBBox.width)} × ${Math.round(realBBox.height)} px` : '';
    const label = deg !== 0 ? `${dimLabel}  ·  ${deg}°` : dimLabel;
    drawSelectionBadge(ctx, visualBBox, label);
  }
  ctx.restore();
}

export function drawSelectionBadge(ctx, bbox, label) {
  if (!label) return;
  const scale = viewport.scale;
  const midX = bbox.minX + bbox.width / 2;
  const by = bbox.minY - 32 / scale;
  ctx.save();
  ctx.font = `600 ${12 / scale}px Inter, system-ui, sans-serif`;
  const textW = ctx.measureText(label).width;
  const padX = 8 / scale;
  const badgeW = textW + padX * 2;
  const badgeH = 22 / scale;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1 / scale;
  roundRect(ctx, midX - badgeW / 2, by, badgeW, badgeH, 8 / scale);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, midX, by + badgeH / 2 + 0.5 / scale);
  ctx.restore();
}

/**
 * Pulisce TUTTO l'overlay (contenuto + CSS preview).
 * Chiamata da lazo.js (beginLasso, endLasso), scribble.js,
 * shapes.js, ink.js per reset completo prima di un nuovo disegno.
 */
export function clearOverlay(pageData) {
  if (!pageData || !pageData.overlayCtx) return;
  const octx = pageData.overlayCtx;
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, pageData.overlayCanvas.width, pageData.overlayCanvas.height);
  octx.restore();
  // Reset CSS preview (highlighter): durante lo stroke settiamo
  // mixBlendMode + opacity sull'overlay, e va pulito quando
  // l'overlay viene svuotato per evitare bleed visivo.
  if (pageData.overlayCanvas) {
    pageData.overlayCanvas.style.opacity = '';
    pageData.overlayCanvas.style.mixBlendMode = '';
  }
}

export function renderPendingShapeOnOverlay(pageData) {
  if (!pageData.overlayCtx) return;
  const octx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr || 1;
  octx.save();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPendingShape(octx, state.isDarkMode);
  octx.restore();
}

export function drawLassoIncrementalOnOverlay(pageData) {
  if (!pageData.overlayCtx) return;
  if (state.activeTool !== 'lasso') return;
  const n = state.lassoPath.length;
  if (n < 2) return;
  const p1 = state.lassoPath[n - 2];
  const p2 = state.lassoPath[n - 1];
  const octx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr || 1;
  octx.save();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.strokeStyle = state.isDarkMode ? 'rgba(129, 140, 248, 0.85)' : 'rgba(79, 70, 229, 0.78)';
  octx.lineWidth = 1.25;
  octx.lineCap = 'round';
  octx.setLineDash([4, 4]);
  octx.beginPath(); octx.moveTo(p1.x, p1.y); octx.lineTo(p2.x, p2.y); octx.stroke();
  octx.restore();
}

export function drawSelectionBBoxOnOverlay(pageData) {
  if (!pageData.overlayCtx) return;
  if (state.selectedStrokes.length === 0) return;
  const visualBBox = getVisualBoundingBox();
  if (!visualBBox) return;
  const octx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr || 1;
  const scale = viewport.scale;
  const strokeCol = state.isDarkMode ? 'rgba(129, 140, 248, 0.78)' : 'rgba(79, 70, 229, 0.65)';
  const fillCol = state.isDarkMode ? 'rgba(129, 140, 248, 0.045)' : 'rgba(79, 70, 229, 0.03)';
  octx.save();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.fillStyle = fillCol;
  octx.strokeStyle = strokeCol;
  octx.lineWidth = 1 / scale;
  roundRect(octx, visualBBox.minX, visualBBox.minY, visualBBox.width, visualBBox.height, 4 / scale);
  octx.fill();
  octx.stroke();
  drawSelectionHandles(octx, visualBBox);
  octx.restore();
}

export function redrawSelectionOverlay(pageData) {
  clearOverlay(pageData);
  if (state.selectedStrokes.length === 0) return;
  const octx = pageData.overlayCtx;
  if (octx) {
    const dpr = pageData.overlayDpr || pageData.dpr || 1;
    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.selectedStrokes.forEach(stroke => {
      renderFullStroke(octx, stroke, state.isDarkMode);
    });
    octx.restore();
  }
  drawSelectionBBoxOnOverlay(pageData);
}

function _renderDashedStroke(ctx, stroke, styleInfo, isDark, opacity) {
  const pts = stroke.points;
  const n = pts.length;
  if (n < 2) return;

  const baseSize = sliderToBaseSize(stroke.size);

  // Larghezza: media dei width per-punto (la taper si perde, ma il
  // pattern resta leggibile). Un minimo di 0.6 evita linee invisibili.
  let sumW = 0;
  for (let i = 0; i < n; i++) {
    const pt = pts[i];
    sumW += computeStrokeWidth(stroke.tool, stroke.size, pt.pressure,
      getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize);
  }
  const avgW = Math.max(0.6, sumW / n);

  ctx.save();
  ctx.setLineDash(styleInfo.lineDash);
  ctx.lineDashOffset = 0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = styleInfo.gco;
  ctx.strokeStyle = styleInfo.strokeStyle;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = avgW;

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.restore();
}

// ============================================================
// TEXT BOXES (layout + rendering canvas + overlay selezione)
// ============================================================

export const TEXT_FONTS = {
  sans: 'Inter, system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive'
};

export const TEXT_LINE_HEIGHT_MULT = 1.35;
export const TEXT_PAD_X = 6;
export const TEXT_PAD_Y = 4;

export function buildTextCanvasFont(tb) {
  const family = TEXT_FONTS[tb?.fontFamily] || TEXT_FONTS.sans;
  const size = Math.max(10, Math.min(72, tb?.fontSize || 18));
  const italic = tb?.italic ? 'italic ' : '';
  const bold = tb?.bold ? 'bold ' : '';
  return `${italic}${bold}${size}px ${family}`;
}

export function layoutTextBox(ctx, tb) {
  const text = typeof tb.text === 'string' ? tb.text : '';
  const width = Math.max(80, tb.width || 240);
  const fontSize = Math.max(10, Math.min(72, tb.fontSize || 18));
  const fontFamily = tb.fontFamily || 'sans';
  const bold = !!tb.bold;
  const italic = !!tb.italic;

  const key = `${text}|${width}|${fontFamily}|${fontSize}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
  if (tb._layoutCache && tb._layoutCache.key === key) {
    return tb._layoutCache;
  }

  ctx.save();
  ctx.font = buildTextCanvasFont(tb);

  const maxTextW = Math.max(20, width - TEXT_PAD_X * 2);
  const paragraphs = text.split(/\r?\n/);
  const lines = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    if (para === '') {
      lines.push('');
      continue;
    }

    const words = para.split(' ');
    let currentLine = '';

    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      const candidate = currentLine === '' ? word : `${currentLine} ${word}`;
      if (ctx.measureText(candidate).width <= maxTextW) {
        currentLine = candidate;
      } else {
        if (currentLine !== '') {
          lines.push(currentLine);
          currentLine = '';
        }
        // Parola più larga del box → spezza per carattere
        if (ctx.measureText(word).width <= maxTextW) {
          currentLine = word;
        } else {
          let chunk = '';
          for (let c = 0; c < word.length; c++) {
            const ch = word[c];
            const nextChunk = chunk + ch;
            if (chunk !== '' && ctx.measureText(nextChunk).width > maxTextW) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk = nextChunk;
            }
          }
          currentLine = chunk;
        }
      }
    }
    lines.push(currentLine);
  }

  ctx.restore();

  if (lines.length === 0) lines.push('');
  const lineHeight = fontSize * TEXT_LINE_HEIGHT_MULT;
  const height = Math.ceil(Math.max(lineHeight + TEXT_PAD_Y * 2, lines.length * lineHeight + TEXT_PAD_Y * 2));
  tb.height = height;

  const result = { key, lines, lineHeight, height };
  Object.defineProperty(tb, '_layoutCache', {
    value: result,
    enumerable: false,
    configurable: true,
    writable: true
  });
  return result;
}

export function drawTextBoxOnCanvas(ctx, tb, forceTargetDark = state.isDarkMode) {
  if (!tb || !ctx) return;
  const layout = layoutTextBox(ctx, tb);
  const { lines, lineHeight } = layout;
  const fontSize = Math.max(10, Math.min(72, tb.fontSize || 18));
  const align = tb.align === 'center' || tb.align === 'right' ? tb.align : 'left';
  const width = Math.max(80, tb.width || 240);

  let drawX = tb.x + TEXT_PAD_X;
  if (align === 'center') drawX = tb.x + width / 2;
  else if (align === 'right') drawX = tb.x + width - TEXT_PAD_X;

  const topOffset = (lineHeight - fontSize) * 0.5;

  ctx.save();
  ctx.font = buildTextCanvasFont(tb);
  ctx.fillStyle = getEffectiveColor(tb.color || '#000000', forceTargetDark);
  ctx.textBaseline = 'top';
  ctx.textAlign = align;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    ctx.fillText(lines[i], drawX, tb.y + TEXT_PAD_Y + topOffset + i * lineHeight);
  }
  ctx.restore();
}

export function drawTextBoxSelectionOnOverlay(pageData, tb, opts = {}) {
  clearOverlay(pageData);
  if (!pageData || !pageData.overlayCtx || !tb) return;

  const octx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr || 1;
  const scale = viewport.scale || 1;
  const w = Math.max(80, tb.width || 240);
  const layout = layoutTextBox(octx, tb);
  const h = tb.height || layout.height;
  const strokeCol = state.isDarkMode ? 'rgba(129, 140, 248, 0.78)' : 'rgba(79, 70, 229, 0.65)';
  const fillCol = state.isDarkMode ? 'rgba(129, 140, 248, 0.045)' : 'rgba(79, 70, 229, 0.028)';
  const handleAccent = state.isDarkMode ? '#818cf8' : '#4f46e5';

  octx.save();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (opts.drawBox) {
    drawTextBoxOnCanvas(octx, tb, state.isDarkMode);
  }

  octx.fillStyle = fillCol;
  octx.strokeStyle = strokeCol;
  octx.lineWidth = 1 / scale;
  roundRect(octx, tb.x, tb.y, w, h, 4 / scale);
  octx.fill();
  octx.stroke();

  // Maniglie laterali sottili (w / e) per ridimensionare larghezza
  const handleW = 5 / scale;
  const handleH = Math.min(h * 0.52, 18 / scale);
  const midY = tb.y + h / 2;

  [tb.x, tb.x + w].forEach(hx => {
    octx.fillStyle = '#ffffff';
    octx.strokeStyle = handleAccent;
    octx.lineWidth = 1.25 / scale;
    roundRect(octx, hx - handleW / 2, midY - handleH / 2, handleW, handleH, handleW / 2);
    octx.fill();
    octx.stroke();
  });

  octx.restore();
}