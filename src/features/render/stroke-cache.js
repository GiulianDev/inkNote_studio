// ============================================================
// CACHE BITMAP PER STROKE (pen, pencil, marker, highlighter)
// Supporta tratti solidi e tratteggiati >= 10 punti.
// Eviction LRU O(1) basata su Set con cap su entry e pixel totali.
// ============================================================

import { renderFullStroke } from './render.js';
import { state } from '../../core/state.js';
import { sliderToBaseSize } from '../../core/utils.js';
import { getStrokeBBoxRect, setNonEnumerable } from './stroke-geometry.js';

const MAX_CACHE_ENTRIES = 900;
const MAX_CACHE_PIXELS = 36_000_000;
const MAX_SINGLE_STROKE_PIXELS = 4_000_000;
const MIN_CACHE_POINTS = 10;
const CACHEABLE_TOOLS = new Set(['pen', 'pencil', 'marker', 'highlighter']);

const _lruSet = new Set();
let _totalPixels = 0;

function _releaseCanvasBacking(entry) {
  if (!entry) return;
  if (entry.pixels) {
    _totalPixels = Math.max(0, _totalPixels - entry.pixels);
    entry.pixels = 0;
  }
  if (entry.canvas) {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
  }
}

export function isStrokeCacheable(stroke) {
  return Boolean(
    stroke &&
    CACHEABLE_TOOLS.has(stroke.tool) &&
    Array.isArray(stroke.points) &&
    stroke.points.length >= MIN_CACHE_POINTS
  );
}

function _buildKey(stroke, dpr, isDark, smoothKey) {
  const dprKey = Math.round(dpr * 100);
  if (stroke.tool === 'highlighter') {
    return `hl|${dprKey}`;
  }
  return `${stroke.tool}|${dprKey}|${isDark ? 'd' : 'l'}|${smoothKey}`;
}

export function getStrokeBitmap(stroke, dpr, isDark, smoothness = state.smoothing) {
  if (!isStrokeCacheable(stroke)) return null;
  const entry = stroke._cacheCanvas;
  if (!entry || !entry.canvas) return null;

  const n = stroke.points.length;
  if (entry.len !== n) return null;
  if (entry.dpr < dpr * 0.9) return null;

  if (stroke.tool !== 'highlighter') {
    const smoothKey = Math.round((smoothness != null ? smoothness : state.smoothing) * 100);
    if (entry.isDark !== !!isDark || entry.smoothKey !== smoothKey) return null;
  }

  // LRU touch O(1)
  if (_lruSet.has(stroke)) {
    _lruSet.delete(stroke);
  } else {
    _totalPixels += entry.pixels || 0;
  }
  _lruSet.add(stroke);
  return entry;
}

export function buildStrokeBitmap(stroke, dpr, isDark, smoothness = state.smoothing) {
  if (!isStrokeCacheable(stroke)) return null;

  const pad = Math.max(28, Math.ceil(sliderToBaseSize(stroke.size) * 4 + 12));
  const bbox = getStrokeBBoxRect(stroke, pad);
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return null;

  const pxW = Math.max(1, Math.ceil(bbox.w * dpr));
  const pxH = Math.max(1, Math.ceil(bbox.h * dpr));
  const pixels = pxW * pxH;
  if (pixels > MAX_SINGLE_STROKE_PIXELS) return null;

  if (stroke._cacheCanvas) {
    invalidateStrokeBitmap(stroke);
  }

  // Evict oldest entries finché rientriamo nei limiti
  while (_lruSet.size > 0 && (_lruSet.size >= MAX_CACHE_ENTRIES || _totalPixels + pixels > MAX_CACHE_PIXELS)) {
    const evicted = _lruSet.values().next().value;
    _lruSet.delete(evicted);
    const oldEntry = evicted._cacheCanvas;
    if (oldEntry) _releaseCanvasBacking(oldEntry);
    setNonEnumerable(evicted, '_cacheCanvas', null);
    setNonEnumerable(evicted, '_cacheKey', null);
  }

  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.scale(pxW / bbox.w, pxH / bbox.h);
  ctx.translate(-bbox.x, -bbox.y);

  const isOpaqueUnified = (stroke.tool === 'pen' || stroke.tool === 'marker') && (!stroke.style || stroke.style === 'solid');
  if (stroke.tool === 'highlighter') {
    renderFullStroke(ctx, stroke, isDark, null, { opaqueHighlighter: true });
  } else if (isOpaqueUnified) {
    renderFullStroke(ctx, stroke, isDark, null, { opaqueStroke: true });
  } else {
    renderFullStroke(ctx, stroke, isDark);
  }

  const smoothKey = Math.round((smoothness != null ? smoothness : state.smoothing) * 100);
  const key = _buildKey(stroke, dpr, isDark, smoothKey);
  const entry = {
    canvas,
    bbox,
    key,
    dpr,
    isDark: !!isDark,
    smoothKey,
    len: stroke.points.length,
    pixels,
    opaqueAlpha: isOpaqueUnified
  };

  setNonEnumerable(stroke, '_cacheCanvas', entry);
  setNonEnumerable(stroke, '_cacheKey', key);
  _lruSet.add(stroke);
  _totalPixels += pixels;

  return entry;
}

export function invalidateStrokeBitmap(stroke) {
  if (!stroke || typeof stroke !== 'object') return;
  _lruSet.delete(stroke);
  const entry = stroke._cacheCanvas;
  if (entry) {
    _releaseCanvasBacking(entry);
    setNonEnumerable(stroke, '_cacheCanvas', null);
  }
  if (stroke._cacheKey !== undefined && stroke._cacheKey !== null) {
    setNonEnumerable(stroke, '_cacheKey', null);
  }
}

export function clearStrokeCache() {
  for (const stroke of _lruSet) {
    const entry = stroke._cacheCanvas;
    if (entry) _releaseCanvasBacking(entry);
    setNonEnumerable(stroke, '_cacheCanvas', null);
    setNonEnumerable(stroke, '_cacheKey', null);
  }
  _lruSet.clear();
  _totalPixels = 0;
}