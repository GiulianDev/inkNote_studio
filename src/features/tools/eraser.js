// ============================================================
// ERASER TOOL + CURSORE GOMMA
// Cancellazione batch (stroke o point) + cursore tratteggiato.
// ============================================================

import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH } from '../../core/utils.js';
import { invalidateStrokeBitmap } from '../editor/stroke-cache.js';
import { redrawPageCanvas } from '../editor/render.js';
import { scheduleSave } from '../editor/autosave.js';
import { getEraserRadius } from '../toolbar/toolbar-state.js';
import { getCanvasCoords, isPenEraser, resetPointPool } from './common.js';

// ============================================================
// CURSORE GOMMA
// ============================================================

let _eraserCursorEl = null;
let _eraserCursorRaf = null;
let _eraserCursorLastX = 0;
let _eraserCursorLastY = 0;
let _eraserCursorPageData = null;

let _cursorRect = null;
let _cursorRectScale = 0;
let _cursorRectX = 0;
let _cursorRectY = 0;

function ensureEraserCursor() {
  if (_eraserCursorEl) return _eraserCursorEl;
  let el = document.getElementById('eraserCursor');
  if (!el) {
    el = document.createElement('div');
    el.id = 'eraserCursor';
    el.className = 'eraser-cursor';
    document.body.appendChild(el);
  }
  _eraserCursorEl = el;
  return el;
}

function _applyEraserCursorFrame() {
  _eraserCursorRaf = null;
  const el = _eraserCursorEl;
  const pageData = _eraserCursorPageData;
  if (!el || !pageData) return;

  let rect = _cursorRect;
  if (!rect ||
      _cursorRectScale !== viewport.scale ||
      _cursorRectX !== viewport.x ||
      _cursorRectY !== viewport.y) {
    rect = pageData.canvas.getBoundingClientRect();
    _cursorRect = rect;
    _cursorRectScale = viewport.scale;
    _cursorRectX = viewport.x;
    _cursorRectY = viewport.y;
  }

  const radiusCanvas = getEraserRadius();
  const radiusScreen = radiusCanvas * (rect.width / PAGE_WIDTH);
  const diameter = Math.max(3, radiusScreen * 2);

  el.style.width = `${diameter}px`;
  el.style.height = `${diameter}px`;
  el.style.left = `${_eraserCursorLastX}px`;
  el.style.top = `${_eraserCursorLastY}px`;
  el.classList.add('visible');
}

export function updateEraserCursor(e, pageData) {
  ensureEraserCursor();
  _eraserCursorLastX = e.clientX;
  _eraserCursorLastY = e.clientY;
  _eraserCursorPageData = pageData;
  if (_eraserCursorRaf === null) {
    _eraserCursorRaf = requestAnimationFrame(_applyEraserCursorFrame);
  }
}

export function hideEraserCursor() {
  if (_eraserCursorRaf !== null) {
    cancelAnimationFrame(_eraserCursorRaf);
    _eraserCursorRaf = null;
  }
  if (_eraserCursorEl) _eraserCursorEl.classList.remove('visible');
}

export function shouldShowEraserCursor(e) {
  if (state.scribbleMode) return false;
  if (state._penEraserActive) return true;
  if (state.activeTool === 'eraser') return true;
  if (isPenEraser(e)) return true;
  return false;
}

// Quando l'utente cambia tool non-eraser, nascondi il cursore.
document.addEventListener('inknote:tool-changed', () => {
  if (state.activeTool !== 'eraser' && !state._penEraserActive) {
    hideEraserCursor();
  }
});

// ============================================================
// TOOL ERASER
// ============================================================

export function beginEraserStroke(point, pageData) {
  performEraserBatch(pageData, [point]);
}

export function moveEraserStroke(pageData, e) {
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const evs = (coalesced && coalesced.length > 0) ? coalesced.slice(-15) : [e];
  resetPointPool();
  const points = [];
  for (const ev of evs) points.push(getCanvasCoords(ev, pageData.canvas));
  performEraserBatch(pageData, points);
}

function performEraserBatch(pageData, points) {
  if (!points || points.length === 0) return;
  const mode = state.eraserMode;
  const radius = getEraserRadius();
  const radiusSq = radius * radius;

  let batchMinX = Infinity, batchMaxX = -Infinity, batchMinY = Infinity, batchMaxY = -Infinity;
  for (const p of points) {
    if (p.x < batchMinX) batchMinX = p.x; if (p.x > batchMaxX) batchMaxX = p.x;
    if (p.y < batchMinY) batchMinY = p.y; if (p.y > batchMaxY) batchMaxY = p.y;
  }
  batchMinX -= radius; batchMaxX += radius;
  batchMinY -= radius; batchMaxY += radius;

  const modified = new Set();

  if (mode === 'stroke') {
    pageData.strokes = pageData.strokes.filter(stroke => {
      let stMinX = Infinity, stMaxX = -Infinity, stMinY = Infinity, stMaxY = -Infinity;
      for (const p of stroke.points) {
        if (p.x < stMinX) stMinX = p.x; if (p.x > stMaxX) stMaxX = p.x;
        if (p.y < stMinY) stMinY = p.y; if (p.y > stMaxY) stMaxY = p.y;
      }
      if (stMaxX < batchMinX || stMinX > batchMaxX || stMaxY < batchMinY || stMinY > batchMaxY) {
        return true;
      }
      let hit = false;
      for (const sp of stroke.points) {
        for (const bp of points) {
          const dx = sp.x - bp.x, dy = sp.y - bp.y;
          if (dx * dx + dy * dy < radiusSq) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) modified.add(stroke);
      return !hit;
    });
  } else {
    pageData.strokes.forEach(stroke => {
      const before = stroke.points.length;
      stroke.points = stroke.points.filter(p => {
        for (const bp of points) {
          const dx = p.x - bp.x, dy = p.y - bp.y;
          if (dx * dx + dy * dy < radiusSq) return false;
        }
        return true;
      });
      if (stroke.points.length !== before) modified.add(stroke);
    });
    pageData.strokes = pageData.strokes.filter(s => s.points.length > 1);
  }

  if (modified.size > 0) {
    modified.forEach(invalidateStrokeBitmap);
    redrawPageCanvas(pageData);
    scheduleSave();
  }
}