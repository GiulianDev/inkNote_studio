// ============================================================
// CACHE BITMAP PER STROKE PENCIL
// Pen/marker/highlighter sono già veloci con unify: no cache.
// Pencil è l'unico che beneficia (darkening = fill per step).
// Bitmap limitato al bbox dello stroke per contenere la memoria.
// ============================================================

import { renderFullStroke } from './render.js';

const MAX_CACHE_ENTRIES = 150;
const _lru = [];

function computeStrokeBBox(stroke, pad) {
  if (!stroke.points || stroke.points.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const px = pad || 32;
  return {
    x: Math.max(0, Math.floor(minX - px)),
    y: Math.max(0, Math.floor(minY - px)),
    w: Math.ceil(maxX - minX + px * 2),
    h: Math.ceil(maxY - minY + px * 2)
  };
}

function cacheKey(dpr, isDark) {
  return `${Math.floor(dpr * 100)}|${isDark ? 'd' : 'l'}`;
}

export function getStrokeBitmap(stroke, dpr, isDark) {
  if (stroke.tool !== 'pencil') return null;
  if (stroke.points.length < 30) return null;
  const key = cacheKey(dpr, isDark);
  if (stroke._cacheKey === key && stroke._cacheCanvas) {
    return stroke._cacheCanvas;
  }
  return null;
}

export function buildStrokeBitmap(stroke, dpr, isDark) {
  if (stroke.tool !== 'pencil') return null;
  if (stroke.points.length < 30) return null;

  const bbox = computeStrokeBBox(stroke, 32);
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bbox.w * dpr);
  canvas.height = Math.ceil(bbox.h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(-bbox.x, -bbox.y);
  renderFullStroke(ctx, stroke, isDark);

  const entry = { canvas, bbox, key: cacheKey(dpr, isDark) };
  stroke._cacheCanvas = entry;
  stroke._cacheKey = entry.key;

  // LRU eviction
  _lru.push(stroke);
  if (_lru.length > MAX_CACHE_ENTRIES) {
    const evicted = _lru.shift();
    evicted._cacheCanvas = null;
    evicted._cacheKey = null;
  }
  return entry;
}

export function invalidateStrokeBitmap(stroke) {
  if (!stroke) return;
  stroke._cacheCanvas = null;
  stroke._cacheKey = null;
  const idx = _lru.indexOf(stroke);
  if (idx >= 0) _lru.splice(idx, 1);
}