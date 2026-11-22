/**
 * @module features/tools/eraser
 *
 * TOOL ERASER + CURSORE GOMMA.
 *
 * @see core/types.js
 * @see tools/tool-shared.js
 * @see features/toolbar/toolbar-settings.js  — getEraserRadius
 */

import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH } from '../../core/utils.js';
import { invalidateStrokeBitmap } from '../render/stroke-cache.js';
import { getRawStrokeBBox, invalidateStrokeBBox } from '../render/stroke-geometry.js';
import { redrawPageCanvas } from '../render/render.js';
import { scheduleSave } from '../persistence/autosave.js';
import { getEraserRadius } from '../toolbar/toolbar-settings.js';
import { getCanvasCoords, getCanvasRect, isPenEraser, resetPointPool } from './tool-shared.js';

// ============================================================
// CURSORE GOMMA
// ============================================================

let _eraserCursorEl = null;
let _eraserCursorRaf = null;
let _eraserCursorLastX = 0;
let _eraserCursorLastY = 0;
let _eraserCursorPageData = null;

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

  const rect = getCanvasRect(pageData.canvas);

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

function distSqPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

function isPointErased(px, py, eraserPoints, radiusSq) {
  for (let i = 0; i < eraserPoints.length; i++) {
    const bp = eraserPoints[i];
    const dx = px - bp.x;
    const dy = py - bp.y;
    if (dx * dx + dy * dy < radiusSq) return true;
  }
  return false;
}

function cloneStrokeSegment(stroke, points) {
  return {
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    ...(stroke.opacity !== undefined ? { opacity: stroke.opacity } : {}),
    ...(stroke.style !== undefined ? { style: stroke.style } : {}),
    points
  };
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

  const segmentHitsEraser = (ax, ay, bx, by) => {
    if (Math.max(ax, bx) < batchMinX || Math.min(ax, bx) > batchMaxX ||
        Math.max(ay, by) < batchMinY || Math.min(ay, by) > batchMaxY) {
      return false;
    }
    for (let i = 0; i < points.length; i++) {
      const bp = points[i];
      if (distSqPointToSegment(bp.x, bp.y, ax, ay, bx, by) < radiusSq) return true;
    }
    return false;
  };

  const strokeBBoxOverlaps = (stroke) => {
    const raw = getRawStrokeBBox(stroke);
    if (!raw) return false;
    return !(raw.maxX < batchMinX || raw.minX > batchMaxX || raw.maxY < batchMinY || raw.minY > batchMaxY);
  };

  const modified = new Set();
  let anyChanged = false;

  if (mode === 'stroke') {
    pageData.strokes = pageData.strokes.filter(stroke => {
      if (!stroke.points || stroke.points.length === 0) return false;
      if (!strokeBBoxOverlaps(stroke)) return true;

      let hit = false;
      if (stroke.points.length === 1) {
        hit = isPointErased(stroke.points[0].x, stroke.points[0].y, points, radiusSq);
      } else {
        for (let i = 0; i < stroke.points.length - 1; i++) {
          const a = stroke.points[i];
          const b = stroke.points[i + 1];
          if (segmentHitsEraser(a.x, a.y, b.x, b.y)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        modified.add(stroke);
        anyChanged = true;
      }
      return !hit;
    });
  } else {
    const nextStrokes = [];
    const subStep = Math.max(3, radius * 0.35);

    for (const stroke of pageData.strokes) {
      const pts = stroke.points;
      if (!pts || pts.length === 0) continue;
      if (!strokeBBoxOverlaps(stroke)) {
        nextStrokes.push(stroke);
        continue;
      }

      if (pts.length === 1) {
        if (isPointErased(pts[0].x, pts[0].y, points, radiusSq)) {
          modified.add(stroke);
          anyChanged = true;
        } else {
          nextStrokes.push(stroke);
        }
        continue;
      }

      let strokeTouched = false;
      const segments = [];
      let currentSeg = [];

      if (!isPointErased(pts[0].x, pts[0].y, points, radiusSq)) {
        currentSeg.push(pts[0]);
      } else {
        strokeTouched = true;
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!segmentHitsEraser(a.x, a.y, b.x, b.y)) {
          currentSeg.push(b);
          continue;
        }

        strokeTouched = true;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = segLen > subStep ? Math.ceil(segLen / subStep) : 1;
        const pA = a.pressure ?? 0.5;
        const pB = b.pressure ?? 0.5;

        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const sp = k === steps
            ? b
            : {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                pressure: pA + (pB - pA) * t
              };

          if (isPointErased(sp.x, sp.y, points, radiusSq)) {
            if (currentSeg.length > 1) segments.push(currentSeg);
            currentSeg = [];
          } else {
            currentSeg.push(sp);
          }
        }
      }

      if (currentSeg.length > 1) segments.push(currentSeg);

      if (!strokeTouched) {
        nextStrokes.push(stroke);
      } else {
        anyChanged = true;
        modified.add(stroke);
        for (const segPts of segments) {
          const segStroke = cloneStrokeSegment(stroke, segPts);
          nextStrokes.push(segStroke);
          modified.add(segStroke);
        }
      }
    }

    if (anyChanged) {
      pageData.strokes = nextStrokes;
    }
  }

  if (anyChanged) {
    modified.forEach(s => {
      invalidateStrokeBitmap(s);
      invalidateStrokeBBox(s);
    });
    redrawPageCanvas(pageData);
    scheduleSave({ pageId: pageData.pageId });
  }
}