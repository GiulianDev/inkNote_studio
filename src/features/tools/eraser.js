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
import { PAGE_WIDTH, sliderToBaseSize } from '../../core/utils.js';
import { invalidateStrokeBitmap } from '../render/stroke-cache.js';
import { getRawStrokeBBox, invalidateStrokeBBox, mergeDirtyBBox } from '../render/stroke-geometry.js';
import { redrawPageCanvas } from '../render/render.js';
import { markPageDirty } from '../persistence/session.js';
import { getEraserRadius } from '../toolbar/toolbar-settings.js';
import { getCanvasCoords, getCanvasRect, isPenEraser, resetPointPool } from './tool-shared.js';
import { cloneInkParams } from './ink-calibration.js';

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

let _eraserRaf = null;
let _eraserRafPage = null;
let _pendingEraserPoints = [];
let _eraserGestureModified = false;

function _flushEraserFrame() {
  _eraserRaf = null;
  const page = _eraserRafPage;
  _eraserRafPage = null;
  if (!page || _pendingEraserPoints.length === 0) return;
  const pts = _pendingEraserPoints;
  _pendingEraserPoints = [];
  performEraserBatch(page, pts);
}

export function flushEraserFrame(pageData = null) {
  if (_eraserRaf !== null) {
    cancelAnimationFrame(_eraserRaf);
    _eraserRaf = null;
  }
  const page = pageData || _eraserRafPage;
  _eraserRafPage = null;
  if (_pendingEraserPoints.length === 0) return;
  const pts = _pendingEraserPoints;
  _pendingEraserPoints = [];
  if (page && page.canvas) {
    performEraserBatch(page, pts);
  }
}

export function cancelEraserFrame() {
  if (_eraserRaf !== null) {
    cancelAnimationFrame(_eraserRaf);
    _eraserRaf = null;
  }
  _eraserRafPage = null;
  _pendingEraserPoints.length = 0;
}

export function consumeEraserModified() {
  const modified = _eraserGestureModified;
  _eraserGestureModified = false;
  return modified;
}

export function beginEraserStroke(point, pageData) {
  cancelEraserFrame();
  _eraserGestureModified = false;
  performEraserBatch(pageData, [{ x: point.x, y: point.y }]);
}

export function moveEraserStroke(pageData, e) {
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const evs = (coalesced && coalesced.length > 0) ? coalesced : [e];
  resetPointPool();
  for (let i = 0; i < evs.length; i++) {
    const p = getCanvasCoords(evs[i], pageData.canvas);
    _pendingEraserPoints.push({ x: p.x, y: p.y });
  }
  if (_pendingEraserPoints.length > 96) {
    _pendingEraserPoints.splice(0, _pendingEraserPoints.length - 96);
  }
  _eraserRafPage = pageData;
  if (_eraserRaf === null) {
    _eraserRaf = requestAnimationFrame(_flushEraserFrame);
  }
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
    ...(stroke.inkParams ? { inkParams: cloneInkParams(stroke.inkParams) } : {}),
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
  let dirtyRect = null;

  const _strokePad = (stroke) => {
    const baseSize = sliderToBaseSize(stroke.size);
    return stroke.tool === 'highlighter'
      ? Math.max(24, baseSize * 2.5 + 12)
      : Math.max(20, baseSize * 2.5 + 14);
  };

  if (mode === 'stroke') {
    const hitSet = new Set();
    for (let sIdx = 0; sIdx < pageData.strokes.length; sIdx++) {
      const stroke = pageData.strokes[sIdx];
      if (!stroke.points || stroke.points.length === 0) {
        hitSet.add(stroke);
        anyChanged = true;
        continue;
      }
      if (!strokeBBoxOverlaps(stroke)) continue;

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
        hitSet.add(stroke);
        modified.add(stroke);
        anyChanged = true;
        const raw = getRawStrokeBBox(stroke);
        if (raw) {
          const pad = _strokePad(stroke);
          dirtyRect = mergeDirtyBBox(
            dirtyRect,
            raw.minX - pad,
            raw.maxX + pad,
            raw.minY - pad,
            raw.maxY + pad
          );
        }
      }
    }
    if (anyChanged) {
      pageData.strokes = pageData.strokes.filter(s => !hitSet.has(s));
    }
  } else {
    const nextStrokes = [];
    const subStep = Math.max(3, radius * 0.35);

    for (let sIdx = 0; sIdx < pageData.strokes.length; sIdx++) {
      const stroke = pageData.strokes[sIdx];
      const pts = stroke.points;
      if (!pts || pts.length === 0) continue;
      if (!strokeBBoxOverlaps(stroke)) {
        nextStrokes.push(stroke);
        continue;
      }

      const sPad = _strokePad(stroke);

      if (pts.length === 1) {
        if (isPointErased(pts[0].x, pts[0].y, points, radiusSq)) {
          modified.add(stroke);
          anyChanged = true;
          dirtyRect = mergeDirtyBBox(
            dirtyRect,
            pts[0].x - sPad,
            pts[0].x + sPad,
            pts[0].y - sPad,
            pts[0].y + sPad
          );
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
        dirtyRect = mergeDirtyBBox(
          dirtyRect,
          pts[0].x - sPad,
          pts[0].x + sPad,
          pts[0].y - sPad,
          pts[0].y + sPad
        );
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!segmentHitsEraser(a.x, a.y, b.x, b.y)) {
          currentSeg.push(b);
          continue;
        }

        strokeTouched = true;
        dirtyRect = mergeDirtyBBox(
          dirtyRect,
          Math.min(a.x, b.x) - sPad,
          Math.max(a.x, b.x) + sPad,
          Math.min(a.y, b.y) - sPad,
          Math.max(a.y, b.y) + sPad
        );
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = segLen > subStep ? Math.ceil(segLen / subStep) : 1;
        const pA = a.pressure ?? 0.5;
        const pB = b.pressure ?? 0.5;
        const txA = a.tiltX || 0;
        const txB = b.tiltX || 0;
        const tyA = a.tiltY || 0;
        const tyB = b.tiltY || 0;
        const spdA = a.speed || 0;
        const spdB = b.speed || 0;
        const ptType = b.pointerType || a.pointerType;

        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const sp = k === steps
            ? b
            : {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                pressure: pA + (pB - pA) * t,
                tiltX: txA + (txB - txA) * t,
                tiltY: tyA + (tyB - tyA) * t,
                speed: spdA + (spdB - spdA) * t,
                ...(ptType ? { pointerType: ptType } : {})
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
        dirtyRect = mergeDirtyBBox(
          dirtyRect,
          batchMinX - sPad,
          batchMaxX + sPad,
          batchMinY - sPad,
          batchMaxY + sPad
        );
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
    _eraserGestureModified = true;
    modified.forEach(s => {
      invalidateStrokeBitmap(s);
      invalidateStrokeBBox(s);
    });
    redrawPageCanvas(pageData, state.isDarkMode, dirtyRect ? { dirtyRect } : {});
    if (pageData.pageId) markPageDirty(pageData.pageId);
  }
}