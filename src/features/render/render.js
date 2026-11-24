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
import {
  setNonEnumerable, getRawStrokeBBox,
  getSelectionBBoxFromItems, computeSegmentSteps,
  prepareSegmentCurve, evalSegmentCurveInto, buildRelaxedPoints,
  bboxesOverlap, clampDirtyRect
} from './stroke-geometry.js';
import { state, viewport } from '../../core/state.js';
import {
  PAGE_WIDTH, PAGE_HEIGHT, hexToRgbA, parseHexRgb, getEffectiveColor, isPaperDark,
  roundRect, sliderToBaseSize, fastHypot
} from '../../core/utils.js';
import { getPressureParams } from '../../core/app-settings.js';
import {
  computeInkStrokeWidth,
  computeTiltNorm,
  LEGACY_PRESSURE_PARAMS
} from '../tools/ink-calibration.js';

const SCRIBBLE_ERASE_COLOR  = 'rgba(220, 38, 38, 0.6)';
const SCRIBBLE_TARGET_COLOR = 'rgba(239, 68, 68, 0.75)';
const HL_JITTER_MAG = 1.2;

let _bgCache = { key: null, canvas: null };
const BACKGROUND_DPR = 2;

const _ptA = { x: 0, y: 0 };
const _ptB = { x: 0, y: 0 };
const _segCurve = { linear: false, m1x: 0, m1y: 0, m2x: 0, m2y: 0 };

let _circleBuf = new Float32Array(6144); // 2048 * (x, y, r)
function _ensureCircleBuf(neededFloats) {
  if (neededFloats <= _circleBuf.length) return _circleBuf;
  let nextLen = _circleBuf.length * 2;
  while (nextLen < neededFloats) nextLen *= 2;
  _circleBuf = new Float32Array(nextLen);
  return _circleBuf;
}

let _strokeScratchCanvas = null;
let _strokeScratchCtx = null;
function _getStrokeScratch(reqW, reqH) {
  if (typeof document === 'undefined') return null;
  if (reqW <= 0 || reqH <= 0 || reqW > 2048 || reqH > 2048) return null;
  if (!_strokeScratchCanvas) {
    _strokeScratchCanvas = document.createElement('canvas');
    _strokeScratchCanvas.width = Math.max(256, reqW);
    _strokeScratchCanvas.height = Math.max(256, reqH);
    _strokeScratchCtx = _strokeScratchCanvas.getContext('2d');
  } else if (_strokeScratchCanvas.width < reqW || _strokeScratchCanvas.height < reqH) {
    _strokeScratchCanvas.width = Math.max(_strokeScratchCanvas.width, reqW);
    _strokeScratchCanvas.height = Math.max(_strokeScratchCanvas.height, reqH);
    _strokeScratchCtx = _strokeScratchCanvas.getContext('2d');
  }
  return _strokeScratchCtx ? { canvas: _strokeScratchCanvas, ctx: _strokeScratchCtx } : null;
}

// ============================================================
// GEOMETRY (usata da render e lazo)
// ============================================================

export function getSelectionBoundingBox(includePad = true) {
  const pad = includePad ? 12 / viewport.scale : 0;
  return getSelectionBBoxFromItems(state.selectedStrokes, state.selectedTextBoxes, pad);
}

export function getVisualBoundingBox(realBBox = null) {
  const real = realBBox || getSelectionBoundingBox(false);
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
  if (Array.isArray(state.selectedTextBoxes)) {
    state.selectedTextBoxes.forEach(tb => {
      if (!tb) return;
      const w = Math.max(80, tb.width || 240);
      const h = Math.max(24, tb.height || 32);
      const corners = [
        { x: tb.x, y: tb.y },
        { x: tb.x + w, y: tb.y },
        { x: tb.x, y: tb.y + h },
        { x: tb.x + w, y: tb.y + h }
      ];
      for (let i = 0; i < corners.length; i++) {
        const c = corners[i];
        const d = Math.hypot(c.x - target.x, c.y - target.y);
        if (d < minDist) { minDist = d; closest = c; }
      }
    });
  }
  return closest;
}

// ============================================================
// STYLE HELPERS
// ============================================================

function getTiltNorm(pt) {
  return computeTiltNorm(pt);
}
function getSpeedNorm(pt) {
  if (!pt || !pt.speed) return 0;
  return Math.min(1, pt.speed / 8);
}
function getTaper() {
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
    setNonEnumerable(stroke, '_jitterOffsets', next);
  }
  return stroke._jitterOffsets;
}

/**
 * Ritorna array di {x, y} con jitter perpendicolare applicato per
 * highlighter. Per gli altri tool ritorna i punti originali.
 * Il jitter è deterministico per stroke (stesso stroke → stesso pattern)
 * e memorizzato in cache incrementale non-enumerabile `_hlPts`.
 */
export function getDisplayPoints(stroke) {
  const pts = stroke.points;
  if (stroke.tool !== 'highlighter' || pts.length < 2) return pts;
  const n = pts.length;
  const prevLen = stroke._hlPtsLen || 0;
  let out = stroke._hlPts;
  if (Array.isArray(out) && prevLen === n && out.length === n) {
    return out;
  }

  const jitter = _ensureJitterCache(stroke);
  let startIdx = 0;
  if (Array.isArray(out) && prevLen >= 2 && n > prevLen && out.length === prevLen) {
    // Ricalcola solo l'ultimo punto precedente (la sua tangente diventa centrale) e i nuovi
    startIdx = prevLen - 1;
    out.length = n;
  } else {
    out = new Array(n);
    setNonEnumerable(stroke, '_hlPts', out);
  }

  for (let i = startIdx; i < n; i++) {
    const p = pts[i];
    let dx, dy;
    if (i === 0) { dx = pts[1].x - p.x; dy = pts[1].y - p.y; }
    else if (i === n - 1) { dx = p.x - pts[i - 1].x; dy = p.y - pts[i - 1].y; }
    else { dx = pts[i + 1].x - pts[i - 1].x; dy = pts[i + 1].y - pts[i - 1].y; }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) {
      if (out[i]) { out[i].x = p.x; out[i].y = p.y; }
      else out[i] = { x: p.x, y: p.y };
      continue;
    }
    const nx = -dy / len, ny = dx / len;
    const mag = jitter[i] * HL_JITTER_MAG;
    if (out[i]) {
      out[i].x = p.x + nx * mag;
      out[i].y = p.y + ny * mag;
    } else {
      out[i] = { x: p.x + nx * mag, y: p.y + ny * mag };
    }
  }
  setNonEnumerable(stroke, '_hlPtsLen', n);
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

export function computeStrokeWidth(
  tool,
  rawSize,
  pressure,
  tiltNorm = 0,
  speedNorm = 0,
  taper = 1.0,
  precomputedBaseSize = null,
  inkParams = null
) {
  const baseSize = precomputedBaseSize !== null ? precomputedBaseSize : sliderToBaseSize(rawSize);
  return computeInkStrokeWidth(
    tool,
    baseSize,
    pressure,
    tiltNorm,
    speedNorm,
    taper,
    inkParams || getPressureParams()
  );
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
  setNonEnumerable(stroke, '_styleCache', result);
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

function _getStrokeSmoothness(stroke) {
  return (stroke && Number.isFinite(stroke.smoothing)) ? stroke.smoothing : state.smoothing;
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
// GRAPHITE / PASTEL GRAIN ENGINE (Matita)
// ============================================================

const _graphiteTileCache = new Map();

function _getGraphiteTileCanvas(hexColor) {
  const key = (hexColor || '#000000').toLowerCase();
  if (_graphiteTileCache.has(key)) return _graphiteTileCache.get(key);
  if (typeof document === 'undefined') return null;

  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const gctx = canvas.getContext('2d');
  if (!gctx) return null;

  const rgb = parseHexRgb(key) || { r: 15, g: 23, b: 42 };
  const img = gctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Hash deterministico multi-frequenza (grana fine + trama carta + fibra leggera)
      let h1 = (((x * 374761393) + (y * 668265263)) ^ 0x5bf03635) >>> 0;
      h1 = ((h1 ^ (h1 >> 13)) * 1274126177) >>> 0;
      const fine = ((h1 >>> 24) & 255) / 255;

      const cx = x >> 1;
      const cy = y >> 1;
      let h2 = (((cx * 1597334677) + (cy * 3812015801)) ^ 0x9e3779b9) >>> 0;
      h2 = ((h2 ^ (h2 >> 15)) * 2246822519) >>> 0;
      const coarse = ((h2 >>> 24) & 255) / 255;

      // Trama incrociata leggera della carta (evita buchi binari su tratti sottili)
      const tooth = 0.5 + 0.25 * Math.sin(x * 0.65 + y * 0.35) + 0.25 * Math.cos(x * 0.38 - y * 0.72);
      const grain = fine * 0.48 + coarse * 0.30 + tooth * 0.22;

      // Valli porose morbide (alpha >= 0.26) + picchi di grafite granulosa (fino a 0.96)
      // Mantiene continuità anche nei tratti sottili a matita verticale
      const shaped = Math.pow(grain, 1.35);
      const alpha = Math.round((0.26 + shaped * 0.70) * 255);

      const idx = (y * size + x) * 4;
      data[idx] = rgb.r;
      data[idx + 1] = rgb.g;
      data[idx + 2] = rgb.b;
      data[idx + 3] = alpha;
    }
  }
  gctx.putImageData(img, 0, 0);

  if (_graphiteTileCache.size >= 24) {
    const oldest = _graphiteTileCache.keys().next().value;
    _graphiteTileCache.delete(oldest);
  }
  _graphiteTileCache.set(key, canvas);
  return canvas;
}

function _graphitePatternFor(ctx, resolvedColor) {
  const tile = _getGraphiteTileCanvas(resolvedColor);
  if (!tile) return null;
  try { return ctx.createPattern(tile, 'repeat'); } catch { return null; }
}

function _traceSinglePassRibbon(ctx, spine) {
  const m = spine.length;
  if (m === 0) return;
  if (m === 1) {
    const s = spine[0];
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(s.w, 0.8) * 0.5, 0, Math.PI * 2);
    return;
  }

  const leftX = new Float32Array(m);
  const leftY = new Float32Array(m);
  const rightX = new Float32Array(m);
  const rightY = new Float32Array(m);

  let lastNx = 0, lastNy = 1;
  for (let i = 0; i < m; i++) {
    const prev = spine[i > 0 ? i - 1 : 0];
    const next = spine[i < m - 1 ? i + 1 : m - 1];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tLen = fastHypot(tx, ty);
    let nx = lastNx, ny = lastNy;
    if (tLen > 0.01) {
      nx = -ty / tLen;
      ny = tx / tLen;
      lastNx = nx;
      lastNy = ny;
    }
    const hw = Math.max(spine[i].w, 0.8) * 0.5;
    leftX[i] = spine[i].x + nx * hw;
    leftY[i] = spine[i].y + ny * hw;
    rightX[i] = spine[i].x - nx * hw;
    rightY[i] = spine[i].y - ny * hw;
  }

  ctx.beginPath();
  ctx.moveTo(leftX[0], leftY[0]);
  for (let i = 1; i < m; i++) {
    ctx.lineTo(leftX[i], leftY[i]);
  }
  const tail = spine[m - 1];
  const tailPrev = spine[m - 2];
  const endAng = Math.atan2(tail.y - tailPrev.y, tail.x - tailPrev.x);
  ctx.arc(tail.x, tail.y, Math.max(tail.w, 0.8) * 0.5, endAng + Math.PI * 0.5, endAng - Math.PI * 0.5, true);
  for (let i = m - 1; i >= 0; i--) {
    ctx.lineTo(rightX[i], rightY[i]);
  }
  const head = spine[0];
  const headNext = spine[1];
  const startAng = Math.atan2(headNext.y - head.y, headNext.x - head.x);
  ctx.arc(head.x, head.y, Math.max(head.w, 0.8) * 0.5, startAng - Math.PI * 0.5, startAng + Math.PI * 0.5, true);
  ctx.closePath();
}

function _drawPencilFlakesFromSpine(ctx, spine, resolvedColor, opacity, baseSeed, stepStartIdx = 0) {
  const m = spine.length;
  if (m === 0) return;

  // 3 bande alpha morbide per effetto polvere/grafite che si sfalda senza puntinature scure
  const bandCoords = [[], [], []];
  let accumDist = 0;
  let lastAnchorIdx = 0;
  let burstIdx = stepStartIdx;

  for (let i = 0; i < m; i++) {
    const s = spine[i];
    if (i > 0) {
      accumDist += fastHypot(s.x - spine[i - 1].x, s.y - spine[i - 1].y);
      if (accumDist < 2.0 && i < m - 1) continue;
    }

    const anchor = spine[lastAnchorIdx];
    const spanLen = Math.max(2.0, fastHypot(s.x - anchor.x, s.y - anchor.y));
    const midX = i > 0 ? (anchor.x + s.x) * 0.5 : s.x;
    const midY = i > 0 ? (anchor.y + s.y) * 0.5 : s.y;
    lastAnchorIdx = i;
    accumDist = 0;

    const prev = spine[i > 0 ? i - 1 : 0];
    const next = spine[i < m - 1 ? i + 1 : m - 1];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tLen = fastHypot(tx, ty) || 1;
    const ux = tx / tLen;
    const uy = ty / tLen;
    const nx = -uy;
    const ny = ux;

    const hw = Math.max(s.w, 1.0) * 0.5;
    const p = s.p != null ? s.p : 0.5;
    const t = s.t != null ? s.t : 0;

    let rng = (baseSeed ^ ((burstIdx++) * 2654435761)) >>> 0;
    const nextRand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 0xFFFFFFFF;
    };

    // Grani interni distribuiti lungo l'intero segmento (zero "grappoli" periodici)
    const innerCount = Math.max(2, Math.round((spanLen / 2.2) * (1.2 + p * 1.8 + t * 2.2)));
    for (let k = 0; k < innerCount; k++) {
      const alongOff = (nextRand() - 0.5) * spanLen * 1.1;
      const perpOff = (nextRand() - 0.5) * 1.9 * hw;
      const gx = midX + ux * alongOff + nx * perpOff;
      const gy = midY + uy * alongOff + ny * perpOff;
      const gW = 0.55 + nextRand() * (0.65 + Math.min(0.85, hw * 0.14));
      const gH = gW * (0.65 + nextRand() * 0.55);
      const band = p > 0.65 ? (nextRand() > 0.45 ? 2 : 1) : (p > 0.30 ? (nextRand() > 0.5 ? 1 : 0) : 0);
      bandCoords[band].push(gx - gW * 0.5, gy - gH * 0.5, gW, gH);
    }

    // Scaglie esterne ("effetto pastello/grafite che si sfalda sul foglio", accentuate dall'inclinazione)
    const outerCount = Math.max(1, Math.round((spanLen / 2.4) * (0.6 + p * 0.9 + t * 3.4)));
    for (let k = 0; k < outerCount; k++) {
      const side = nextRand() > 0.5 ? 1 : -1;
      const spread = 0.80 + nextRand() * (0.45 + t * 0.82);
      const alongOff = (nextRand() - 0.5) * spanLen * 1.15;
      const gx = midX + ux * alongOff + nx * (side * hw * spread);
      const gy = midY + uy * alongOff + ny * (side * hw * spread);
      const fW = 0.45 + nextRand() * (0.75 + t * 0.45);
      const fH = fW * (0.65 + nextRand() * 0.6);
      const band = nextRand() > 0.72 ? 1 : 0;
      bandCoords[band].push(gx - fW * 0.5, gy - fH * 0.5, fW, fH);
    }
  }

  const bandAlphas = [0.13, 0.26, 0.42];
  ctx.fillStyle = resolvedColor;
  for (let b = 0; b < 3; b++) {
    const arr = bandCoords[b];
    if (arr.length === 0) continue;
    ctx.globalAlpha = opacity * bandAlphas[b];
    ctx.beginPath();
    for (let j = 0; j < arr.length; j += 4) {
      ctx.rect(arr[j], arr[j + 1], arr[j + 2], arr[j + 3]);
    }
    ctx.fill();
  }
}

function _renderPencilDot(ctx, pt, w, resolvedColor, opacity, seed) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  const pattern = _graphitePatternFor(ctx, resolvedColor);
  const p = pt.pressure != null ? pt.pressure : 0.5;
  const r = Math.max(w * 0.5, 0.75);
  ctx.fillStyle = pattern || resolvedColor;
  ctx.globalAlpha = opacity * (pattern ? (0.58 + p * 0.25) : 0.48);
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
  ctx.fill();

  const tilt = getTiltNorm(pt);
  _drawPencilFlakesFromSpine(ctx, [{ x: pt.x, y: pt.y, w, p, t: tilt }], resolvedColor, opacity, seed, 0);
  ctx.restore();
}

function _buildPencilSpine(pts, widths, fromIdx, toIdx, smoothness) {
  const spine = [];
  for (let i = Math.max(1, fromIdx); i <= toIdx; i++) {
    const p0 = pts[i >= 2 ? i - 2 : 0];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[i + 1 < pts.length ? i + 1 : pts.length - 1];
    const w1 = widths[i - 1], w2 = widths[i];
    const pr1 = p1.pressure != null ? p1.pressure : 0.5;
    const pr2 = p2.pressure != null ? p2.pressure : 0.5;
    const t1Norm = getTiltNorm(p1), t2Norm = getTiltNorm(p2);
    const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
    const steps = computeSegmentSteps(segLen, smoothness);
    if (spine.length === 0) {
      spine.push({ x: p1.x, y: p1.y, w: w1, p: pr1, t: t1Norm });
    }
    if (steps === 1) {
      spine.push({ x: p2.x, y: p2.y, w: w2, p: pr2, t: t2Norm });
      continue;
    }
    prepareSegmentCurve(_segCurve, p0, p1, p2, p3, segLen, smoothness);
    for (let s = 0; s < steps; s++) {
      const f = (s + 1) / steps;
      evalSegmentCurveInto(_ptB, p1, p2, _segCurve, f);
      spine.push({
        x: _ptB.x,
        y: _ptB.y,
        w: w1 + (w2 - w1) * f,
        p: pr1 + (pr2 - pr1) * f,
        t: t1Norm + (t2Norm - t1Norm) * f
      });
    }
  }
  return spine;
}

function _renderPencilGraphiteStroke(ctx, stroke, pts, widths, smoothness, resolvedColor, opacity) {
  const spine = _buildPencilSpine(pts, widths, 1, pts.length - 1, smoothness);
  if (spine.length === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  const pattern = _graphitePatternFor(ctx, resolvedColor);
  let sumP = 0;
  for (let i = 0; i < spine.length; i++) sumP += spine[i].p;
  const avgP = sumP / spine.length;

  // 1. Corpo poroso con pattern carta/grafite (single-pass per zero accumulo alpha sulle curve)
  _traceSinglePassRibbon(ctx, spine);
  ctx.fillStyle = pattern || resolvedColor;
  ctx.globalAlpha = opacity * (pattern ? (0.48 + avgP * 0.28) : 0.42);
  ctx.fill();

  // 2. Scaglie di grafite / effetto pastello sui bordi e nel tratto
  _drawPencilFlakesFromSpine(ctx, spine, resolvedColor, opacity, _strokeSeed(stroke), 0);
  ctx.restore();
}

export function renderPencilPreviewStroke(ctx, pts, widths, resolvedColor, opacity = 1.0) {
  if (!pts || pts.length === 0) return;
  if (pts.length === 1) {
    _renderPencilDot(ctx, pts[0], widths[0], resolvedColor, opacity, 0x5F3759DF);
    return;
  }
  const spine = pts.map((pt, idx) => ({
    x: pt.x,
    y: pt.y,
    w: widths[idx] != null ? widths[idx] : 3,
    p: pt.pressure != null ? pt.pressure : 0.5,
    t: getTiltNorm(pt)
  }));
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  const pattern = _graphitePatternFor(ctx, resolvedColor);
  let sumP = 0;
  for (let i = 0; i < spine.length; i++) sumP += spine[i].p;
  const avgP = sumP / spine.length;
  _traceSinglePassRibbon(ctx, spine);
  ctx.fillStyle = pattern || resolvedColor;
  ctx.globalAlpha = opacity * (pattern ? (0.48 + avgP * 0.28) : 0.42);
  ctx.fill();
  _drawPencilFlakesFromSpine(ctx, spine, resolvedColor, opacity, 0x5F3759DF, 0);
  ctx.restore();
}

// ============================================================
// BBOX HELPERS (used by ink.js, dispatcher.js)
// ============================================================

export function getStrokeBBoxCanvas(stroke, pad = 24) {
  const raw = getRawStrokeBBox(stroke);
  if (!raw) return null;
  return {
    minX: raw.minX - pad, maxX: raw.maxX + pad,
    minY: raw.minY - pad, maxY: raw.maxY + pad
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

function drawStrokeWithCache(ctx, stroke, drawDpr, inkDark, isTarget = false, buildDpr = drawDpr) {
  if (!isTarget) {
    const strokeSmooth = _getStrokeSmoothness(stroke);
    let cached = getStrokeBitmap(stroke, drawDpr, inkDark, strokeSmooth);
    if (!cached) {
      cached = buildStrokeBitmap(stroke, buildDpr, inkDark, strokeSmooth);
    }
    if (cached) {
      if (stroke.tool === 'highlighter') {
        const opacity = stroke.opacity != null ? stroke.opacity : 1.0;
        ctx.save();
        ctx.globalCompositeOperation = inkDark ? 'screen' : 'multiply';
        ctx.globalAlpha = opacity;
        ctx.drawImage(
          cached.canvas,
          cached.bbox.x, cached.bbox.y,
          cached.bbox.w, cached.bbox.h
        );
        ctx.restore();
      } else if (cached.opaqueAlpha) {
        const opacity = stroke.opacity != null ? stroke.opacity : 1.0;
        if (opacity < 0.999) {
          ctx.save();
          ctx.globalAlpha = opacity;
          ctx.drawImage(
            cached.canvas,
            cached.bbox.x, cached.bbox.y,
            cached.bbox.w, cached.bbox.h
          );
          ctx.restore();
        } else {
          ctx.drawImage(
            cached.canvas,
            cached.bbox.x, cached.bbox.y,
            cached.bbox.w, cached.bbox.h
          );
        }
      } else {
        ctx.drawImage(
          cached.canvas,
          cached.bbox.x, cached.bbox.y,
          cached.bbox.w, cached.bbox.h
        );
      }
      return;
    }
  }
  renderFullStroke(ctx, stroke, inkDark, isTarget ? SCRIBBLE_TARGET_COLOR : null);
}

export function redrawPageCanvas(pageData, forceTargetDark = state.isDarkMode, opts = {}) {
  const ctx = pageData.ctx;
  if (!ctx || !pageData.canvas) return;
  const dpr = pageData.dpr || 1;
  const skipBackground = !!opts.skipBackground;
  const skipTextBoxes = !!opts.skipTextBoxes;
  const textBoxFilter = typeof opts.textBoxFilter === 'function' ? opts.textBoxFilter : null;
  const inkDark = opts.inkDark != null
    ? !!opts.inkDark
    : isPaperDark(forceTargetDark, skipBackground ? null : state.paperColor);

  const dirtyRect = opts.dirtyRect
    ? clampDirtyRect(opts.dirtyRect, PAGE_WIDTH, PAGE_HEIGHT)
    : null;
  if (opts.dirtyRect && !dirtyRect) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (dirtyRect) {
    const px = Math.max(0, Math.floor(dirtyRect.minX * dpr));
    const py = Math.max(0, Math.floor(dirtyRect.minY * dpr));
    const pw = Math.min(pageData.canvas.width - px, Math.ceil(dirtyRect.maxX * dpr) - px);
    const ph = Math.min(pageData.canvas.height - py, Math.ceil(dirtyRect.maxY * dpr) - py);
    if (pw <= 0 || ph <= 0) {
      ctx.restore();
      return;
    }
    ctx.clearRect(px, py, pw, ph);
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();
  } else {
    ctx.clearRect(0, 0, pageData.canvas.width, pageData.canvas.height);
  }
  ctx.scale(dpr, dpr);

  if (!skipBackground) {
    drawPaperBackground(ctx, forceTargetDark);
  }

  const isExport = !!pageData._isExport;
  const targetSet = (!isExport && state.scribbleMode && state.scribbleTargets)
    ? new Set(state.scribbleTargets) : null;
  const selectedSet = (!isExport && state.selectedStrokes && state.selectedStrokes.length > 0)
    ? new Set(state.selectedStrokes) : null;

  for (let i = 0; i < pageData.strokes.length; i++) {
    const stroke = pageData.strokes[i];
    if (selectedSet && selectedSet.has(stroke)) continue;
    if (dirtyRect) {
      const raw = getRawStrokeBBox(stroke);
      if (!raw) continue;
      const baseSize = sliderToBaseSize(stroke.size);
      const pad = stroke.tool === 'highlighter'
        ? Math.max(24, baseSize * 2.5 + 10)
        : Math.max(20, baseSize * 2 + 12);
      if (!bboxesOverlap(raw, dirtyRect, pad)) continue;
    }
    const isTarget = !!(targetSet && targetSet.has(stroke));
    if (isExport) {
      renderFullStroke(ctx, stroke, inkDark, null);
    } else {
      drawStrokeWithCache(ctx, stroke, dpr, inkDark, isTarget, dpr);
    }
  }

  if (!skipTextBoxes && Array.isArray(pageData.textBoxes) && pageData.textBoxes.length > 0) {
    const selectedTextSet = (!isExport && Array.isArray(state.selectedTextBoxes) && state.selectedTextBoxes.length > 0)
      ? new Set(state.selectedTextBoxes) : null;
    for (let i = 0; i < pageData.textBoxes.length; i++) {
      const tb = pageData.textBoxes[i];
      if (!tb) continue;
      if (textBoxFilter && !textBoxFilter(tb)) continue;
      if (selectedTextSet && selectedTextSet.has(tb)) continue;
      if (!isExport && (tb.id === state.editingTextBoxId || tb.id === state._draggingTextBoxId)) {
        continue;
      }
      if (dirtyRect) {
        const w = Math.max(80, tb.width || 240);
        const hEst = Math.max(48, tb.height || (tb._layoutCache && tb._layoutCache.height) || 400);
        const tbBox = { minX: tb.x - 8, maxX: tb.x + w + 8, minY: tb.y - 8, maxY: tb.y + hEst + 12 };
        if (!bboxesOverlap(tbBox, dirtyRect, 0)) continue;
      }
      drawTextBoxOnCanvas(ctx, tb, inkDark);
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
  const inkDark = isPaperDark(state.isDarkMode, state.paperColor);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (stroke.tool === 'highlighter') {
    ctx.globalCompositeOperation = inkDark ? 'screen' : 'multiply';
    ctx.globalAlpha = opacity;
    ctx.fillStyle = stroke.color;
    const baseSize = sliderToBaseSize(stroke.size);
    const w = baseSize * 4.0;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2); ctx.fill();
  } else if (stroke.tool === 'pencil') {
    const baseSize = sliderToBaseSize(stroke.size);
    const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;
    const w = computeStrokeWidth('pencil', stroke.size, pt.pressure, getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize, inkParams);
    _renderPencilDot(ctx, pt, w, getEffectiveColor(stroke.color, inkDark), opacity, _strokeSeed(stroke));
  } else {
    setupStrokeStyle(ctx, stroke, inkDark);
    ctx.globalAlpha = opacity;
    const baseSize = sliderToBaseSize(stroke.size);
    const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;
    const w = computeStrokeWidth(stroke.tool, stroke.size, pt.pressure, getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize, inkParams);
    ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ============================================================
// RENDER FULL STROKE
// ============================================================

export function renderFullStroke(ctx, stroke, forceTargetDark, overrideColor = null, opts = null) {
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
    const opaqueHL = !!(opts && opts.opaqueHighlighter);
    ctx.save();
    ctx.globalCompositeOperation = opaqueHL ? 'source-over' : (forceTargetDark ? 'screen' : 'multiply');
    ctx.globalAlpha = opaqueHL ? 1.0 : opacity;
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
    const baseSize = sliderToBaseSize(stroke.size);
    const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;
    const pt = pts[0];
    const w = computeStrokeWidth(stroke.tool, stroke.size, pt.pressure, getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize, inkParams);
    if (stroke.tool === 'pencil' && !overrideColor) {
      _renderPencilDot(ctx, pt, w, getEffectiveColor(stroke.color, forceTargetDark), opacity, _strokeSeed(stroke));
      return;
    }
    ctx.save();
    if (overrideColor) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = overrideColor; ctx.fillStyle = overrideColor;
    } else {
      setupStrokeStyle(ctx, stroke, forceTargetDark);
      ctx.globalAlpha = opacity;
    }
    ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }

  const smoothness = _getStrokeSmoothness(stroke);
  const renderPts = buildRelaxedPoints(pts, smoothness);
  const baseSize = sliderToBaseSize(stroke.size);
  const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const pt = renderPts[i];
    widths[i] = computeStrokeWidth(stroke.tool, stroke.size, pt.pressure,
      getTiltNorm(pt), getSpeedNorm(pt), getTaper(i, stroke.tool), baseSize, inkParams);
  }

  if (stroke.tool === 'pencil' && !overrideColor) {
    _renderPencilGraphiteStroke(ctx, stroke, renderPts, widths, smoothness, getEffectiveColor(stroke.color, forceTargetDark), opacity);
    return;
  }

  const opaqueStroke = !!(opts && opts.opaqueStroke);

  ctx.save();
  if (overrideColor) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = overrideColor; ctx.fillStyle = overrideColor;
  } else {
    setupStrokeStyle(ctx, stroke, forceTargetDark);
    ctx.globalAlpha = opaqueStroke ? 1.0 : opacity;
  }

  const unified = overrideColor != null || canUnifyFill(stroke.tool);
  if (unified) {
    const _fillUnifiedPath = (targetCtx) => {
      let cIdx = 0;
      let buf = _circleBuf;
      let prevDx = 0, prevDy = 0, prevLen = 0;

      targetCtx.beginPath();
      for (let i = 1; i < n; i++) {
        const p0 = renderPts[i >= 2 ? i - 2 : 0];
        const p1 = renderPts[i - 1];
        const p2 = renderPts[i];
        const p3 = renderPts[i + 1 < n ? i + 1 : n - 1];
        const w1 = widths[i - 1], w2 = widths[i];
        const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
        const steps = computeSegmentSteps(segLen, smoothness);
        if (cIdx + steps * 3 + 3 > buf.length) {
          buf = _ensureCircleBuf(cIdx + steps * 3 + 3);
        }

        _ptA.x = p1.x;
        _ptA.y = p1.y;
        let wa = w1;
        if (steps === 1) {
          addTaperedSegmentPolygon(targetCtx, _ptA, p2, wa, w2);
          buf[cIdx++] = _ptA.x;
          buf[cIdx++] = _ptA.y;
          buf[cIdx++] = Math.max(wa, 0.5) * 0.5;
          prevDx = p2.x - _ptA.x;
          prevDy = p2.y - _ptA.y;
          prevLen = segLen;
          continue;
        }
        prepareSegmentCurve(_segCurve, p0, p1, p2, p3, segLen, smoothness);
        for (let s = 0; s < steps; s++) {
          const t1 = (s + 1) / steps;
          const wb = w1 + (w2 - w1) * t1;
          evalSegmentCurveInto(_ptB, p1, p2, _segCurve, t1);
          const sdx = _ptB.x - _ptA.x;
          const sdy = _ptB.y - _ptA.y;
          const sLen = fastHypot(sdx, sdy);
          addTaperedSegmentPolygon(targetCtx, _ptA, _ptB, wa, wb);
          const needJoint = s === 0 || (wa > 1.8 && prevLen > 0.01 && sLen > 0.01 &&
            ((prevDx * sdx + prevDy * sdy) / (prevLen * sLen) < 0.99));
          if (needJoint) {
            buf[cIdx++] = _ptA.x;
            buf[cIdx++] = _ptA.y;
            buf[cIdx++] = Math.max(wa, 0.5) * 0.5;
          }
          prevDx = sdx;
          prevDy = sdy;
          prevLen = sLen;
          _ptA.x = _ptB.x;
          _ptA.y = _ptB.y;
          wa = wb;
        }
      }
      targetCtx.fill();

      // Include last tip cap in single arc fill pass
      if (cIdx + 3 > buf.length) buf = _ensureCircleBuf(cIdx + 3);
      buf[cIdx++] = renderPts[n - 1].x;
      buf[cIdx++] = renderPts[n - 1].y;
      buf[cIdx++] = Math.max(widths[n - 1], 0.5) * 0.5;

      targetCtx.beginPath();
      for (let k = 0; k < cIdx; k += 3) {
        const cx = buf[k];
        const cy = buf[k + 1];
        const r = buf[k + 2];
        targetCtx.moveTo(cx + r, cy);
        targetCtx.arc(cx, cy, r, 0, Math.PI * 2);
      }
      targetCtx.fill();
    };

    // Per tratti semi-trasparenti (es. marker opaco 0.9) evita doppio accumulo alpha sui giunti
    if (!overrideColor && !opaqueStroke && opacity < 0.999) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxW = 1;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (widths[i] > maxW) maxW = widths[i];
      }
      const pad = Math.ceil(maxW * 0.75 + 4);
      const bx = minX - pad;
      const by = minY - pad;
      const bw = Math.max(1, (maxX - minX) + pad * 2);
      const bh = Math.max(1, (maxY - minY) + pad * 2);
      const tr = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1, b: 0 };
      const scale = Math.max(1, Math.min(4, Math.hypot(tr.a || 1, tr.b || 0) || 1));
      const pxW = Math.ceil(bw * scale);
      const pxH = Math.ceil(bh * scale);
      const scratch = _getStrokeScratch(pxW, pxH);
      if (scratch) {
        const sctx = scratch.ctx;
        sctx.save();
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, pxW, pxH);
        sctx.setTransform(scale, 0, 0, scale, -bx * scale, -by * scale);
        setupStrokeStyle(sctx, stroke, forceTargetDark);
        sctx.globalAlpha = 1.0;
        _fillUnifiedPath(sctx);
        sctx.restore();

        ctx.globalAlpha = opacity;
        ctx.drawImage(scratch.canvas, 0, 0, pxW, pxH, bx, by, bw, bh);
        ctx.restore();
        return;
      }
    }

    _fillUnifiedPath(ctx);
    ctx.restore();
    return;
  }

  for (let i = 1; i < n; i++) {
    const p0 = renderPts[i >= 2 ? i - 2 : 0];
    const p1 = renderPts[i - 1];
    const p2 = renderPts[i];
    const p3 = renderPts[i + 1 < n ? i + 1 : n - 1];
    const w1 = widths[i - 1], w2 = widths[i];
    const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
    const steps = computeSegmentSteps(segLen, smoothness);
    _ptA.x = p1.x;
    _ptA.y = p1.y;
    let wa = w1;
    if (steps === 1) {
      drawTaperedSegment(ctx, _ptA, p2, wa, w2);
      continue;
    }
    prepareSegmentCurve(_segCurve, p0, p1, p2, p3, segLen, smoothness);
    for (let s = 0; s < steps; s++) {
      const t1 = (s + 1) / steps;
      const wb = w1 + (w2 - w1) * t1;
      evalSegmentCurveInto(_ptB, p1, p2, _segCurve, t1);
      drawTaperedSegment(ctx, _ptA, _ptB, wa, wb);
      _ptA.x = _ptB.x;
      _ptA.y = _ptB.y;
      wa = wb;
    }
  }

  const lastW = Math.max(widths[n - 1], 0.5);
  ctx.beginPath(); ctx.arc(renderPts[n - 1].x, renderPts[n - 1].y, lastW / 2, 0, Math.PI * 2); ctx.fill();
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
  const inkDark = isPaperDark(state.isDarkMode, state.paperColor);
  const styleInfo = getStrokeStyle(stroke, inkDark);

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
    const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;
    let sumW = 0;
    for (let i = 0; i < n; i++) {
      const pt = pts[i];
      sumW += computeStrokeWidth(stroke.tool, stroke.size, pt.pressure,
        getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize, inkParams);
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

  const smoothness = _getStrokeSmoothness(stroke);
  const baseSize = sliderToBaseSize(stroke.size);
  const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;

  if (stroke.tool === 'pencil') {
    const startIdx = Math.max(0, firstSegEnd - 1);
    const batchWidths = new Array(n);
    for (let i = startIdx; i < n; i++) {
      const pt = pts[i];
      batchWidths[i] = computeStrokeWidth('pencil', stroke.size, pt.pressure,
        getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize, inkParams);
    }
    const spine = _buildPencilSpine(pts, batchWidths, firstSegEnd, n - 1, smoothness);
    if (spine.length > 0) {
      const resolved = getEffectiveColor(stroke.color, inkDark);
      const pattern = _graphitePatternFor(ctx, resolved);
      ctx.globalCompositeOperation = 'source-over';
      _traceSinglePassRibbon(ctx, spine);
      ctx.fillStyle = pattern || resolved;
      ctx.globalAlpha = pattern ? 0.56 : 0.42;
      ctx.fill();
      _drawPencilFlakesFromSpine(ctx, spine, resolved, 1.0, _strokeSeed(stroke), firstSegEnd * 4);
    }
    ctx.restore();
    return;
  }

  setupStrokeStyle(ctx, stroke, inkDark);
  const unified = canUnifyFillIncremental(stroke.tool);

  if (unified) {
    let cIdx = 0;
    let buf = _circleBuf;
    let prevDx = 0, prevDy = 0, prevLen = 0;

    ctx.beginPath();
    for (let i = firstSegEnd; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure,
        getTiltNorm(p1), getSpeedNorm(p1), getTaper(i - 1, stroke.tool), baseSize, inkParams);
      const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure,
        getTiltNorm(p2), getSpeedNorm(p2), getTaper(i, stroke.tool), baseSize, inkParams);
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const steps = computeSegmentSteps(segLen, smoothness);
      if (cIdx + steps * 3 > buf.length) {
        buf = _ensureCircleBuf(cIdx + steps * 3);
      }

      _ptA.x = p1.x;
      _ptA.y = p1.y;
      let wa = w1;
      if (steps === 1) {
        addTaperedSegmentPolygon(ctx, _ptA, p2, wa, w2);
        buf[cIdx++] = _ptA.x;
        buf[cIdx++] = _ptA.y;
        buf[cIdx++] = Math.max(wa, 0.5) * 0.5;
        prevDx = p2.x - _ptA.x;
        prevDy = p2.y - _ptA.y;
        prevLen = segLen;
        continue;
      }
      prepareSegmentCurve(_segCurve, p0, p1, p2, p3, segLen, smoothness);
      for (let s = 0; s < steps; s++) {
        const t1 = (s + 1) / steps;
        const wb = w1 + (w2 - w1) * t1;
        evalSegmentCurveInto(_ptB, p1, p2, _segCurve, t1);
        const sdx = _ptB.x - _ptA.x;
        const sdy = _ptB.y - _ptA.y;
        const sLen = fastHypot(sdx, sdy);
        addTaperedSegmentPolygon(ctx, _ptA, _ptB, wa, wb);
        const needJoint = s === 0 || (wa > 1.8 && prevLen > 0.01 && sLen > 0.01 &&
          ((prevDx * sdx + prevDy * sdy) / (prevLen * sLen) < 0.99));
        if (needJoint) {
          buf[cIdx++] = _ptA.x;
          buf[cIdx++] = _ptA.y;
          buf[cIdx++] = Math.max(wa, 0.5) * 0.5;
        }
        prevDx = sdx;
        prevDy = sdy;
        prevLen = sLen;
        _ptA.x = _ptB.x;
        _ptA.y = _ptB.y;
        wa = wb;
      }
    }
    ctx.fill();

    if (cIdx > 0) {
      ctx.beginPath();
      for (let k = 0; k < cIdx; k += 3) {
        const cx = buf[k];
        const cy = buf[k + 1];
        const r = buf[k + 2];
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    if (n >= 2) {
      const tipP2 = pts[n - 1];
      const tipW2 = computeStrokeWidth(stroke.tool, stroke.size, tipP2.pressure,
        getTiltNorm(tipP2), getSpeedNorm(tipP2), 1.0, baseSize, inkParams);
      ctx.beginPath();
      addTaperedSegmentCircle(ctx, tipP2, tipW2);
      ctx.fill();
    }
  } else {
    for (let i = firstSegEnd; i < n; i++) {
      const p0 = pts[i >= 2 ? i - 2 : 0];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[i + 1 < n ? i + 1 : n - 1];
      const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure,
        getTiltNorm(p1), getSpeedNorm(p1), getTaper(i - 1, stroke.tool), baseSize, inkParams);
      const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure,
        getTiltNorm(p2), getSpeedNorm(p2), getTaper(i, stroke.tool), baseSize, inkParams);
      const segLen = fastHypot(p2.x - p1.x, p2.y - p1.y);
      const steps = computeSegmentSteps(segLen, smoothness);
      _ptA.x = p1.x;
      _ptA.y = p1.y;
      let wa = w1;
      if (steps === 1) {
        drawTaperedSegment(ctx, _ptA, p2, wa, w2);
        continue;
      }
      prepareSegmentCurve(_segCurve, p0, p1, p2, p3, segLen, smoothness);
      for (let s = 0; s < steps; s++) {
        const t1 = (s + 1) / steps;
        const wb = w1 + (w2 - w1) * t1;
        evalSegmentCurveInto(_ptB, p1, p2, _segCurve, t1);
        drawTaperedSegment(ctx, _ptA, _ptB, wa, wb);
        _ptA.x = _ptB.x;
        _ptA.y = _ptB.y;
        wa = wb;
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

  if (Array.isArray(ps.points) && ps.points.length >= 2) {
    renderFullStroke(ctx, {
      tool: ps.tool,
      color: ps.color,
      size: ps.size,
      opacity: ps.opacity != null ? ps.opacity : 1.0,
      style: ps.style || 'solid',
      inkParams: ps.inkParams,
      points: ps.points
    }, forceTargetDark);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < ps.points.length; i++) {
      const p = ps.points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const w = Math.round(maxX - minX);
    const h = Math.round(maxY - minY);
    const midX = (minX + maxX) / 2;
    const label = `${(ps.label || 'Forma').replace(/^Forma:\s*/, '')} · ${w}×${h}px`;

    ctx.save();
    ctx.font = '600 12px Inter, sans-serif';
    const textW = ctx.measureText(label).width;
    const badgeW = textW + 16;
    const badgeH = 22;
    const bx = midX - badgeW / 2;
    const by = Math.max(8, minY - 30);
    ctx.fillStyle = 'rgba(79, 70, 229, 0.94)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, bx, by, badgeW, badgeH, 11);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, by + badgeH / 2 + 0.5);
    ctx.restore();
    return;
  }

  const startPt = ps.start, endPt = ps.end;
  if (!startPt || !endPt) return;
  const effectiveColor = getEffectiveColor(ps.color, forceTargetDark);

  // Opacità visiva della linea di preview:
  //   - opacity utente dal popover (0.1..1.0)
  //   - pencil: grana interna 0.55 → moltiplicata
  //   - highlighter non entra mai in pendingShape (usa trySnapHighlighter
  //     che modifica in-place), quindi non serve gestirlo qui.
  const userOpacity = ps.opacity != null ? ps.opacity : 1.0;
  const pencilFactor = ps.tool === 'pencil' ? 0.65 : 1.0;
  const lineOpacity = userOpacity * pencilFactor;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = effectiveColor;
  ctx.lineWidth = computeStrokeWidth(ps.tool, ps.size, 0.5, 0, 0, 1.0, null, ps.inkParams);
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
  drawPendingShape(octx, isPaperDark(state.isDarkMode, state.paperColor));
  octx.restore();
}

export function drawLassoIncrementalOnOverlay(pageData) {
  if (!pageData.overlayCtx) return;
  if (state.activeTool !== 'lasso') return;
  const n = state.lassoPath.length;
  if (n < 2) return;
  const octx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr || 1;

  if (state.lassoMode === 'rect') {
    const p0 = state.lassoPath[0];
    const p1 = state.lassoPath[n - 1];
    const minX = Math.min(p0.x, p1.x);
    const minY = Math.min(p0.y, p1.y);
    const w = Math.abs(p1.x - p0.x);
    const h = Math.abs(p1.y - p0.y);
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, pageData.overlayCanvas.width, pageData.overlayCanvas.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.fillStyle = state.isDarkMode ? 'rgba(129, 140, 248, 0.08)' : 'rgba(79, 70, 229, 0.06)';
    octx.strokeStyle = state.isDarkMode ? 'rgba(129, 140, 248, 0.9)' : 'rgba(79, 70, 229, 0.85)';
    octx.lineWidth = 1.35;
    octx.setLineDash([5, 4]);
    octx.fillRect(minX, minY, w, h);
    octx.strokeRect(minX, minY, w, h);
    octx.restore();
    return;
  }

  const p1 = state.lassoPath[n - 2];
  const p2 = state.lassoPath[n - 1];
  octx.save();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.strokeStyle = state.isDarkMode ? 'rgba(129, 140, 248, 0.85)' : 'rgba(79, 70, 229, 0.78)';
  octx.lineWidth = 1.25;
  octx.lineCap = 'round';
  octx.setLineDash([4, 4]);
  octx.beginPath(); octx.moveTo(p1.x, p1.y); octx.lineTo(p2.x, p2.y); octx.stroke();
  octx.restore();
}

export function drawSelectionBBoxOnOverlay(pageData, overrideVisualBBox = null) {
  if (!pageData.overlayCtx) return;
  let visualBBox = overrideVisualBBox;
  if (!visualBBox) {
    const hasStrokes = state.selectedStrokes.length > 0;
    const hasText = Array.isArray(state.selectedTextBoxes) && state.selectedTextBoxes.length > 0;
    if (!hasStrokes && !hasText) return;
    visualBBox = getVisualBoundingBox();
  }
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

export function redrawSelectionOverlay(pageData, opts = null) {
  clearOverlay(pageData);
  const hasStrokes = state.selectedStrokes.length > 0;
  const hasText = Array.isArray(state.selectedTextBoxes) && state.selectedTextBoxes.length > 0;
  if (!hasStrokes && !hasText) return;
  const octx = pageData.overlayCtx;
  if (octx) {
    const dpr = pageData.overlayDpr || pageData.dpr || 1;
    const targetBuildDpr = Math.max(dpr, pageData.dpr || 1);
    const inkDark = isPaperDark(state.isDarkMode, state.paperColor);
    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (hasStrokes) {
      for (let i = 0; i < state.selectedStrokes.length; i++) {
        drawStrokeWithCache(octx, state.selectedStrokes[i], dpr, inkDark, false, targetBuildDpr);
      }
    }
    if (hasText) {
      for (let i = 0; i < state.selectedTextBoxes.length; i++) {
        const tb = state.selectedTextBoxes[i];
        if (tb) drawTextBoxOnCanvas(octx, tb, inkDark);
      }
    }
    octx.restore();
  }
  if (!opts || !opts.skipBBox) {
    drawSelectionBBoxOnOverlay(pageData);
  }
}

function _renderDashedStroke(ctx, stroke, styleInfo, isDark, opacity) {
  const pts = stroke.points;
  const n = pts.length;
  if (n < 2) return;

  const baseSize = sliderToBaseSize(stroke.size);
  const inkParams = stroke.inkParams || LEGACY_PRESSURE_PARAMS;

  // Larghezza: media dei width per-punto (la taper si perde, ma il
  // pattern resta leggibile). Un minimo di 0.6 evita linee invisibili.
  let sumW = 0;
  for (let i = 0; i < n; i++) {
    const pt = pts[i];
    sumW += computeStrokeWidth(stroke.tool, stroke.size, pt.pressure,
      getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize, inkParams);
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
    drawTextBoxOnCanvas(octx, tb, isPaperDark(state.isDarkMode, state.paperColor));
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