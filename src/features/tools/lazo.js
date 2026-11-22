/**
 * @module features/tools/lazo
 *
 * TOOL LAZO UNIFICATO — selezione mista (inchiostro + caselle di testo),
 * modalità mano libera o rettangolo, spostamento via offscreen snapshot + rAF,
 * resize/rotazione coalesced in rAF, copia/taglia/incolla/duplica e barra contestuale GPU.
 *
 * @see core/types.js  — Stroke, BBox
 * @see features/render/render.js  — bbox, handlers, overlay
 * @see features/render/stroke-geometry.js — BBox cache & broad-phase
 * @see features/history/history.js
 */

import { invalidateStrokeBitmap } from '../render/stroke-cache.js';
import {
  setNonEnumerable,
  getRawStrokeBBox,
  invalidateStrokeBBox,
  translateStrokeInPlace,
  bboxesOverlap,
  computePolygonBBox,
  isPointInPolygon as _isPointInPolygonGeom,
  getSelectionBBoxFromItems
} from '../render/stroke-geometry.js';
import { state, viewport } from '../../core/state.js';
import { showToast, PAGE_WIDTH, PAGE_HEIGHT, sliderToBaseSize } from '../../core/utils.js';
import {
  redrawPageCanvas, redrawSelectionOverlay, clearOverlay,
  getSelectionBoundingBox, getVisualBoundingBox, getHandlePositions,
  isPointInBBox, hitTestHandle, findClosestPointInSelection,
  drawLassoIncrementalOnOverlay, drawSelectionBBoxOnOverlay, layoutTextBox
} from '../render/render.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import { markPageDirty } from '../persistence/session.js';
import { pagePool } from '../editor/page-pool.js';
import { getCanvasCoords, getCanvasRect } from './tool-shared.js';

let _clipboard = null; // { strokes: [], textBoxes: [], sourcePageId: string|null, pasteCount: number }

let _cachedMenuWidth = 0;
let _menuInteractingHidden = false;

let _lassoRaf = null;
let _lassoRafPage = null;

function _setCanvasCursor(pageData, cursor) {
  if (!pageData || !pageData.canvas) return;
  if (pageData._lastCursor === cursor) return;
  pageData._lastCursor = cursor;
  pageData.canvas.style.cursor = cursor;
}

export function hasLassoSelection() {
  return (state.selectedStrokes.length > 0) ||
    (Array.isArray(state.selectedTextBoxes) && state.selectedTextBoxes.length > 0);
}

export function hasLassoClipboard() {
  return !!(_clipboard && (
    (_clipboard.strokes && _clipboard.strokes.length > 0) ||
    (_clipboard.textBoxes && _clipboard.textBoxes.length > 0)
  ));
}

function _notifySelectionChanged(activateLasso = false) {
  window.dispatchEvent(new CustomEvent('inknote:selection-changed', {
    detail: { activateLasso }
  }));
}

function _generateTextBoxId() {
  return `tb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function _measureCtx(pageData) {
  return (pageData && (pageData.ctx || pageData.overlayCtx)) ||
    document.createElement('canvas').getContext('2d');
}

function _cloneStrokeData(s) {
  const pts = s.points;
  const n = pts.length;
  const clonedPts = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    clonedPts[i] = {
      x: p.x,
      y: p.y,
      pressure: p.pressure,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      speed: p.speed,
      pointerType: p.pointerType
    };
  }
  return {
    tool: s.tool,
    color: s.color,
    size: s.size,
    opacity: s.opacity != null ? s.opacity : 1.0,
    style: s.style || 'solid',
    points: clonedPts
  };
}

function _cloneTextBoxData(tb, freshId = false) {
  return {
    id: freshId ? _generateTextBoxId() : tb.id,
    x: tb.x,
    y: tb.y,
    width: Math.max(80, tb.width || 240),
    height: Math.max(24, tb.height || 32),
    text: typeof tb.text === 'string' ? tb.text : '',
    fontFamily: tb.fontFamily || 'sans',
    fontSize: Math.max(10, Math.min(72, tb.fontSize || 18)),
    bold: !!tb.bold,
    italic: !!tb.italic,
    align: tb.align === 'center' || tb.align === 'right' ? tb.align : 'left',
    color: tb.color || '#000000'
  };
}

function _formatSelectionLabel(strokesCount, textCount) {
  const parts = [];
  if (strokesCount > 0) parts.push(`${strokesCount} ${strokesCount === 1 ? 'tratto' : 'tratti'}`);
  if (textCount > 0) parts.push(`${textCount} ${textCount === 1 ? 'testo' : 'testi'}`);
  return parts.join(' · ');
}

function _isTextBoxInPolygon(tb, polygon, ctx) {
  if (!tb) return false;
  const layout = layoutTextBox(ctx, tb);
  const w = Math.max(80, tb.width || 240);
  const h = Math.max(24, tb.height || layout.height || 32);
  const x0 = tb.x, x1 = tb.x + w, xm = tb.x + w * 0.5;
  const y0 = tb.y, y1 = tb.y + h, ym = tb.y + h * 0.5;

  const samples = [
    { x: xm, y: ym },
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x0, y: y1 }, { x: x1, y: y1 },
    { x: xm, y: y0 }, { x: xm, y: y1 },
    { x: x0, y: ym }, { x: x1, y: ym }
  ];
  for (let i = 0; i < samples.length; i++) {
    if (_isPointInPolygonGeom(samples[i], polygon)) return true;
  }
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return true;
  }
  return false;
}

function _isTextBoxInRect(tb, rect, ctx) {
  if (!tb) return false;
  const layout = layoutTextBox(ctx, tb);
  const w = Math.max(80, tb.width || 240);
  const h = Math.max(24, tb.height || layout.height || 32);
  return tb.x <= rect.maxX && tb.x + w >= rect.minX &&
    tb.y <= rect.maxY && tb.y + h >= rect.minY;
}

// ============================================================
// SELEZIONE (editing)
// ============================================================

export function selectStrokesInsideLasso(pageData) {
  if (!pageData) return;
  const path = state.lassoPath;
  const selectInk = state.lassoSelectInk !== false;
  const selectText = state.lassoSelectText !== false;
  const ctx = _measureCtx(pageData);

  if (state.lassoMode === 'rect' && path.length >= 2) {
    const p0 = path[0];
    const p1 = path[path.length - 1];
    const rect = {
      minX: Math.min(p0.x, p1.x),
      maxX: Math.max(p0.x, p1.x),
      minY: Math.min(p0.y, p1.y),
      maxY: Math.max(p0.y, p1.y)
    };
    state.selectedStrokes = selectInk
      ? pageData.strokes.filter(stroke => {
          const sb = getRawStrokeBBox(stroke);
          if (!bboxesOverlap(sb, rect)) return false;
          if (sb.minX >= rect.minX && sb.maxX <= rect.maxX &&
              sb.minY >= rect.minY && sb.maxY <= rect.maxY) {
            return true;
          }
          const pts = stroke.points;
          for (let i = 0; i < pts.length; i++) {
            const pt = pts[i];
            if (pt.x >= rect.minX && pt.x <= rect.maxX &&
                pt.y >= rect.minY && pt.y <= rect.maxY) {
              return true;
            }
          }
          return false;
        })
      : [];
    state.selectedTextBoxes = (selectText && Array.isArray(pageData.textBoxes))
      ? pageData.textBoxes.filter(tb => _isTextBoxInRect(tb, rect, ctx))
      : [];
  } else {
    const polyBBox = computePolygonBBox(path);
    state.selectedStrokes = selectInk && polyBBox
      ? pageData.strokes.filter(stroke => {
          const sb = getRawStrokeBBox(stroke);
          if (!bboxesOverlap(sb, polyBBox)) return false;
          const pts = stroke.points;
          for (let i = 0; i < pts.length; i++) {
            if (_isPointInPolygonGeom(pts[i], path)) return true;
          }
          return false;
        })
      : [];
    state.selectedTextBoxes = (selectText && Array.isArray(pageData.textBoxes))
      ? pageData.textBoxes.filter(tb => _isTextBoxInPolygon(tb, path, ctx))
      : [];
  }

  state.lassoPath = [];

  if (hasLassoSelection()) {
    showSelectionMenu();
    const label = _formatSelectionLabel(state.selectedStrokes.length, state.selectedTextBoxes.length);
    showToast(`${label} selezionati`, '✂️');
    if (pageData.canvas) {
      redrawPageCanvas(pageData);
      redrawSelectionOverlay(pageData);
    }
    _notifySelectionChanged();
  } else {
    state.selectedStrokes = [];
    state.selectedTextBoxes = [];
    state.isDraggingSelection = false;
    state.isResizingSelection = false;
    state.resizePivot = null; state.resizeAnchor = null;
    state.resizeOffset = null;
    state.initialStrokesSnapshot = null;
    state.initialTextBoxesSnapshot = null;
    hideSelectionMenu();
    if (pageData.canvas) redrawSelectionOverlay(pageData);
    _notifySelectionChanged();
  }
}

export function clearSelection() {
  const hadSelection = hasLassoSelection();
  const hadLasso = state.lassoPath.length > 0;
  _cancelLassoFrame();
  _cancelResizeFrame();
  state.selectedStrokes = [];
  state.selectedTextBoxes = [];
  state.lassoPath = [];
  state.isDraggingSelection = false;
  state.isResizingSelection = false;
  state.resizeHandle = null;
  state.resizePivot = null; state.resizeAnchor = null;
  state.resizeOffset = null;
  state.initialStrokesSnapshot = null;
  state.initialTextBoxesSnapshot = null;
  state.resizeCurrentAngle = 0;
  state.selectionMoved = false;
  resetSelectionDragState();
  hideSelectionMenu();
  if (hadSelection || hadLasso) {
    const current = state.pages[state.activePageIndex];
    if (current && current.canvas) {
      _setCanvasCursor(current, 'crosshair');
      redrawPageCanvas(current);
      redrawSelectionOverlay(current);
    }
    _notifySelectionChanged();
  }
}

function snapshotSelectedStrokes() {
  return state.selectedStrokes.map(s => ({
    points: s.points.map(p => ({
      x: p.x, y: p.y, pressure: p.pressure,
      tiltX: p.tiltX, tiltY: p.tiltY,
      speed: p.speed, pointerType: p.pointerType
    }))
  }));
}

function snapshotSelectedTextBoxes() {
  return state.selectedTextBoxes.map(tb => ({
    x: tb.x,
    y: tb.y,
    width: Math.max(80, tb.width || 240),
    height: Math.max(24, tb.height || 32),
    fontSize: Math.max(10, Math.min(72, tb.fontSize || 18))
  }));
}

// ============================================================
// RESIZE / ROTAZIONE (coalesced via rAF)
// ============================================================

let _resizeRaf = null;
let _resizePendingPoint = null;
let _resizePage = null;

function _cancelResizeFrame() {
  if (_resizeRaf !== null) {
    cancelAnimationFrame(_resizeRaf);
    _resizeRaf = null;
  }
  _resizePendingPoint = null;
  _resizePage = null;
}

export function startResizeSelection(handle, startPoint) {
  const visualBBox = getVisualBoundingBox();
  if (!visualBBox) return;
  const handles = getHandlePositions(visualBBox);
  const oppositeHandle = handle === 'nw' ? 'se' : 'nw';
  const oppositeCorner = handles[oppositeHandle];
  const draggedCorner = handles[handle];
  const pivot = findClosestPointInSelection(oppositeCorner);
  const anchor = findClosestPointInSelection(draggedCorner);
  if (!pivot || !anchor) return;
  const baseDist = Math.hypot(anchor.x - pivot.x, anchor.y - pivot.y);
  if (baseDist < 1 / viewport.scale) {
    showToast('Selezione troppo piccola per ridimensionare', '⚠️');
    return;
  }
  _cancelResizeFrame();
  const offset = { x: startPoint.x - anchor.x, y: startPoint.y - anchor.y };
  state.isResizingSelection = true;
  state.isDrawing = true;
  state.resizeHandle = handle;
  state.resizePivot = { x: pivot.x, y: pivot.y };
  state.resizeAnchor = { x: anchor.x, y: anchor.y };
  state.resizeOffset = offset;
  state.resizeBaseDist = baseDist;
  state.resizeBaseAngle = Math.atan2(anchor.y - pivot.y, anchor.x - pivot.x);
  state.resizeCurrentAngle = 0;
  state.initialStrokesSnapshot = snapshotSelectedStrokes();
  state.initialTextBoxesSnapshot = snapshotSelectedTextBoxes();
  state.selectionMoved = false;
  _setSelectionMenuInteracting(true);
  const current = state.pages[state.activePageIndex];
  if (current && current.canvas) {
    _setCanvasCursor(current, 'nwse-resize');
    redrawSelectionOverlay(current);
  }
}

function _applyResizeNow(point, targetPage = null) {
  if (!state.isResizingSelection || !state.resizePivot) return;
  const pivot = state.resizePivot;
  const offset = state.resizeOffset || { x: 0, y: 0 };
  const target = { x: point.x - offset.x, y: point.y - offset.y };
  const dx = target.x - pivot.x, dy = target.y - pivot.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2 / viewport.scale) return;
  const angle = Math.atan2(dy, dx);
  const scale = dist / state.resizeBaseDist;
  const deltaAngle = angle - state.resizeBaseAngle;
  const snapThreshold = Math.PI / 90;
  const quarterTurn = Math.PI / 2;
  const nearest = Math.round(deltaAngle / quarterTurn) * quarterTurn;
  let effectiveAngle = deltaAngle;
  if (Math.abs(deltaAngle - nearest) < snapThreshold) effectiveAngle = nearest;
  state.resizeCurrentAngle = effectiveAngle;
  const cos = Math.cos(effectiveAngle), sin = Math.sin(effectiveAngle);

  let minRx = Infinity, maxRx = -Infinity;
  let minRy = Infinity, maxRy = -Infinity;
  const strokeSnap = state.initialStrokesSnapshot || [];
  const textSnap = state.initialTextBoxesSnapshot || [];

  for (let i = 0; i < state.selectedStrokes.length; i++) {
    const snapPts = strokeSnap[i]?.points || [];
    for (let j = 0; j < snapPts.length; j++) {
      const sp = snapPts[j];
      const px = sp.x - pivot.x, py = sp.y - pivot.y;
      const rx = px * cos - py * sin;
      const ry = px * sin + py * cos;
      if (rx < minRx) minRx = rx; if (rx > maxRx) maxRx = rx;
      if (ry < minRy) minRy = ry; if (ry > maxRy) maxRy = ry;
    }
  }
  for (let i = 0; i < state.selectedTextBoxes.length; i++) {
    const stb = textSnap[i];
    if (!stb) continue;
    const corners = [
      { x: stb.x, y: stb.y },
      { x: stb.x + stb.width, y: stb.y },
      { x: stb.x, y: stb.y + stb.height },
      { x: stb.x + stb.width, y: stb.y + stb.height }
    ];
    for (let c = 0; c < corners.length; c++) {
      const px = corners[c].x - pivot.x, py = corners[c].y - pivot.y;
      const rx = px * cos - py * sin;
      const ry = px * sin + py * cos;
      if (rx < minRx) minRx = rx; if (rx > maxRx) maxRx = rx;
      if (ry < minRy) minRy = ry; if (ry > maxRy) maxRy = ry;
    }
  }
  if (minRx === Infinity) return;

  let effectiveScale = scale;
  const spanRx = maxRx - minRx;
  const spanRy = maxRy - minRy;
  if (spanRx > 0 && spanRx * effectiveScale > PAGE_WIDTH) {
    effectiveScale = Math.min(effectiveScale, PAGE_WIDTH / spanRx);
  }
  if (spanRy > 0 && spanRy * effectiveScale > PAGE_HEIGHT) {
    effectiveScale = Math.min(effectiveScale, PAGE_HEIGHT / spanRy);
  }

  const minX = pivot.x + minRx * effectiveScale;
  const maxX = pivot.x + maxRx * effectiveScale;
  const minY = pivot.y + minRy * effectiveScale;
  const maxY = pivot.y + maxRy * effectiveScale;

  let shiftX = 0;
  if (minX < 0) shiftX = -minX;
  else if (maxX > PAGE_WIDTH) shiftX = PAGE_WIDTH - maxX;

  let shiftY = 0;
  if (minY < 0) shiftY = -minY;
  else if (maxY > PAGE_HEIGHT) shiftY = PAGE_HEIGHT - maxY;

  for (let i = 0; i < state.selectedStrokes.length; i++) {
    const stroke = state.selectedStrokes[i];
    const snapPts = strokeSnap[i]?.points || [];
    const pts = stroke.points;
    for (let j = 0; j < snapPts.length; j++) {
      const sp = snapPts[j];
      const px = sp.x - pivot.x, py = sp.y - pivot.y;
      const nx = Math.max(0, Math.min(PAGE_WIDTH, pivot.x + (px * cos - py * sin) * effectiveScale + shiftX));
      const ny = Math.max(0, Math.min(PAGE_HEIGHT, pivot.y + (px * sin + py * cos) * effectiveScale + shiftY));
      if (pts[j]) {
        pts[j].x = nx;
        pts[j].y = ny;
      } else {
        pts[j] = {
          x: nx, y: ny, pressure: sp.pressure,
          tiltX: sp.tiltX, tiltY: sp.tiltY,
          speed: sp.speed, pointerType: sp.pointerType
        };
      }
    }
    invalidateStrokeBBox(stroke);
    if (stroke._cacheCanvas) invalidateStrokeBitmap(stroke);
  }

  const current = targetPage || state.pages[state.activePageIndex];
  const mCtx = _measureCtx(current);
  for (let i = 0; i < state.selectedTextBoxes.length; i++) {
    const tb = state.selectedTextBoxes[i];
    const stb = textSnap[i];
    if (!tb || !stb) continue;
    const origCx = stb.x + stb.width * 0.5;
    const origCy = stb.y + stb.height * 0.5;
    const px = origCx - pivot.x, py = origCy - pivot.y;
    const newCx = pivot.x + (px * cos - py * sin) * effectiveScale + shiftX;
    const newCy = pivot.y + (px * sin + py * cos) * effectiveScale + shiftY;
    tb.width = Math.max(80, Math.min(PAGE_WIDTH - 16, Math.round(stb.width * effectiveScale)));
    tb.fontSize = Math.max(10, Math.min(72, Math.round(stb.fontSize * effectiveScale)));
    tb._layoutCache = null;
    const layout = layoutTextBox(mCtx, tb);
    const h = Math.max(24, tb.height || layout.height || 32);
    tb.x = Math.max(0, Math.min(PAGE_WIDTH - tb.width, Math.round(newCx - tb.width * 0.5)));
    tb.y = Math.max(0, Math.min(PAGE_HEIGHT - h, Math.round(newCy - h * 0.5)));
  }

  state.selectionMoved = true;
  if (current && current.canvas) redrawSelectionOverlay(current);
}

function _flushResizeFrame() {
  _resizeRaf = null;
  const pt = _resizePendingPoint;
  const page = _resizePage;
  _resizePendingPoint = null;
  if (!pt || !state.isResizingSelection) return;
  _applyResizeNow(pt, page);
}

export function applyResizeSelection(point) {
  if (!state.isResizingSelection || !state.resizePivot) return;
  _resizePendingPoint = { x: point.x, y: point.y };
  _resizePage = state.pages[state.activePageIndex];
  if (_resizeRaf === null) {
    _resizeRaf = requestAnimationFrame(_flushResizeFrame);
  }
}

export function endResizeSelection(pageData, wasMoved = false) {
  const pendingPt = _resizePendingPoint;
  const targetPage = pageData || _resizePage || state.pages[state.activePageIndex];
  if (_resizeRaf !== null) {
    cancelAnimationFrame(_resizeRaf);
    _resizeRaf = null;
  }
  _resizePendingPoint = null;
  _resizePage = null;

  if (pendingPt && state.isResizingSelection) {
    _applyResizeNow(pendingPt, targetPage);
  }
  const finalMoved = !!(wasMoved || state.selectionMoved);

  state.isResizingSelection = false;
  state.resizeHandle = null;
  state.resizePivot = null;
  state.resizeAnchor = null;
  state.resizeOffset = null;
  state.resizeCurrentAngle = 0;
  state.initialStrokesSnapshot = null;
  state.initialTextBoxesSnapshot = null;
  state.selectionMoved = false;

  if (targetPage && targetPage.canvas) {
    _setCanvasCursor(targetPage, 'crosshair');
    // Ridisegna overlay per rimuovere il badge dimensionale di resize attivo
    redrawSelectionOverlay(targetPage);
  }
  _setSelectionMenuInteracting(false);
  if (finalMoved) {
    if (targetPage?.pageId) markPageDirty(targetPage.pageId);
    pushHistory();
    scheduleSave();
  }
  resetSelectionDragState();
}

export function previewSelectionColor(newColor) {
  if (state.selectedStrokes.length === 0) return;
  for (let i = 0; i < state.selectedStrokes.length; i++) {
    const s = state.selectedStrokes[i];
    s.color = newColor;
    setNonEnumerable(s, '_styleCache', null);
    invalidateStrokeBitmap(s);
  }
  const current = state.pages[state.activePageIndex];
  if (current && current.canvas) {
    redrawSelectionOverlay(current);
  }
}

export function changeSelectionColor(newColor) {
  if (state.selectedStrokes.length === 0) return;
  previewSelectionColor(newColor);
  const current = state.pages[state.activePageIndex];
  if (current) markPageDirty(current.pageId);
  scheduleSave();
  pushHistory();
  showToast('Colore aggiornato', '🎨');
}

export function previewSelectionWidth(newWidth) {
  if (state.selectedStrokes.length === 0) return;
  const w = parseInt(newWidth, 10);
  for (let i = 0; i < state.selectedStrokes.length; i++) {
    const s = state.selectedStrokes[i];
    s.size = w;
    setNonEnumerable(s, '_styleCache', null);
    invalidateStrokeBBox(s);
    invalidateStrokeBitmap(s);
  }
  const label = document.getElementById('selectionWidthValue');
  if (label) label.innerText = w;
  const current = state.pages[state.activePageIndex];
  if (current && current.canvas) {
    redrawSelectionOverlay(current);
  }
}

export function changeSelectionWidth(newWidth) {
  if (state.selectedStrokes.length === 0) return;
  previewSelectionWidth(newWidth);
  const current = state.pages[state.activePageIndex];
  if (current) markPageDirty(current.pageId);
  scheduleSave();
  pushHistory();
  showToast('Spessore aggiornato', '📏');
}

export function deleteSelection() {
  const current = state.pages[state.activePageIndex];
  if (!current || !hasLassoSelection()) return false;

  _cancelResizeFrame();
  resetSelectionDragState();

  if (state.selectedStrokes.length > 0) {
    const strokeSet = new Set(state.selectedStrokes);
    current.strokes = current.strokes.filter(s => !strokeSet.has(s));
  }
  if (state.selectedTextBoxes.length > 0 && Array.isArray(current.textBoxes)) {
    const textSet = new Set(state.selectedTextBoxes);
    current.textBoxes = current.textBoxes.filter(tb => !textSet.has(tb));
  }

  state.selectedStrokes = [];
  state.selectedTextBoxes = [];
  state.initialStrokesSnapshot = null;
  state.initialTextBoxesSnapshot = null;
  hideSelectionMenu();
  if (current.canvas) {
    redrawPageCanvas(current);
    clearOverlay(current);
  }
  markPageDirty(current.pageId);
  scheduleSave();
  pushHistory();
  _notifySelectionChanged();
  showToast('Elementi eliminati', '🗑️');
  return true;
}

export const deleteSelectedStrokes = deleteSelection;

export function copySelection({ silent = false } = {}) {
  if (!hasLassoSelection()) return false;
  const current = state.pages[state.activePageIndex];
  _clipboard = {
    strokes: state.selectedStrokes.map(_cloneStrokeData),
    textBoxes: state.selectedTextBoxes.map(tb => _cloneTextBoxData(tb, false)),
    sourcePageId: current?.pageId || null,
    pasteCount: 0
  };
  _notifySelectionChanged();
  if (!silent) {
    const label = _formatSelectionLabel(_clipboard.strokes.length, _clipboard.textBoxes.length);
    showToast(`Copiati: ${label}`, '📋');
  }
  return true;
}

export function cutSelection() {
  if (!copySelection({ silent: true })) return false;
  const strokesLen = _clipboard.strokes.length;
  const textLen = _clipboard.textBoxes.length;
  // Dopo un taglia, incollare nella stessa pagina non deve applicare offset eccessivo al primo incolla
  _clipboard.pasteCount = -1;
  _cancelResizeFrame();
  resetSelectionDragState();
  const current = state.pages[state.activePageIndex];
  if (current) {
    if (state.selectedStrokes.length > 0) {
      const strokeSet = new Set(state.selectedStrokes);
      current.strokes = current.strokes.filter(s => !strokeSet.has(s));
    }
    if (state.selectedTextBoxes.length > 0 && Array.isArray(current.textBoxes)) {
      const textSet = new Set(state.selectedTextBoxes);
      current.textBoxes = current.textBoxes.filter(tb => !textSet.has(tb));
    }
    state.selectedStrokes = [];
    state.selectedTextBoxes = [];
    hideSelectionMenu();
    if (current.canvas) {
      redrawPageCanvas(current);
      clearOverlay(current);
    }
    markPageDirty(current.pageId);
    scheduleSave();
    pushHistory();
  }
  _notifySelectionChanged();
  const label = _formatSelectionLabel(strokesLen, textLen);
  showToast(`Tagliati: ${label}`, '✂️');
  return true;
}

function _computeItemsOffsetForPage(strokes, textBoxes, desiredDx, desiredDy) {
  const box = getSelectionBBoxFromItems(strokes, textBoxes, 0);
  if (!box) return { dx: 0, dy: 0 };

  let dx = desiredDx;
  let dy = desiredDy;
  if (box.maxX + dx > PAGE_WIDTH - 8) dx = (PAGE_WIDTH - 8) - box.maxX;
  if (box.minX + dx < 8) dx = 8 - box.minX;
  if (box.maxY + dy > PAGE_HEIGHT - 8) dy = (PAGE_HEIGHT - 8) - box.maxY;
  if (box.minY + dy < 8) dy = 8 - box.minY;
  return { dx, dy };
}

function _pasteItemsIntoPage(pageData, items, dx, dy) {
  if (!pageData || !items) return false;
  if (!pageData.canvas) pagePool.forceAssign(pageData.index, { skipRedraw: true });
  if (!Array.isArray(pageData.textBoxes)) pageData.textBoxes = [];

  _cancelResizeFrame();
  resetSelectionDragState();

  const clonedStrokes = (items.strokes || []).map(_cloneStrokeData);
  const clonedTexts = (items.textBoxes || []).map(tb => _cloneTextBoxData(tb, true));
  const { dx: clampedDx, dy: clampedDy } = _computeItemsOffsetForPage(clonedStrokes, clonedTexts, dx, dy);

  for (let i = 0; i < clonedStrokes.length; i++) {
    const pts = clonedStrokes[i].points;
    for (let j = 0; j < pts.length; j++) {
      pts[j].x = Math.max(0, Math.min(PAGE_WIDTH, pts[j].x + clampedDx));
      pts[j].y = Math.max(0, Math.min(PAGE_HEIGHT, pts[j].y + clampedDy));
    }
    pageData.strokes.push(clonedStrokes[i]);
  }
  for (let i = 0; i < clonedTexts.length; i++) {
    const tb = clonedTexts[i];
    const h = Math.max(24, tb.height || 32);
    tb.x = Math.max(8, Math.min(PAGE_WIDTH - tb.width - 8, tb.x + clampedDx));
    tb.y = Math.max(8, Math.min(PAGE_HEIGHT - h - 8, tb.y + clampedDy));
    pageData.textBoxes.push(tb);
  }

  state.selectedStrokes = clonedStrokes;
  state.selectedTextBoxes = clonedTexts;

  if (pageData.canvas) {
    redrawPageCanvas(pageData);
    redrawSelectionOverlay(pageData);
  }
  showSelectionMenu();
  markPageDirty(pageData.pageId);
  scheduleSave();
  pushHistory();
  _notifySelectionChanged(state.activeTool !== 'lasso');
  return true;
}

export function pasteSelection(targetPage = null) {
  if (!hasLassoClipboard()) return false;
  const pageData = targetPage || state.pages[state.activePageIndex];
  if (!pageData) return false;

  const isSamePage = _clipboard.sourcePageId && _clipboard.sourcePageId === pageData.pageId;
  _clipboard.pasteCount = (_clipboard.pasteCount || 0) + 1;
  const step = isSamePage ? Math.max(0, _clipboard.pasteCount) : Math.max(0, _clipboard.pasteCount - 1);
  const offset = (step % 6) * 20;
  const ok = _pasteItemsIntoPage(pageData, _clipboard, offset, offset);
  if (ok) {
    showToast('Elementi incollati', '📋');
  }
  return ok;
}

export function duplicateSelection() {
  if (!hasLassoSelection()) return false;
  const current = state.pages[state.activePageIndex];
  if (!current) return false;
  const snapshot = {
    strokes: state.selectedStrokes.map(_cloneStrokeData),
    textBoxes: state.selectedTextBoxes.map(tb => _cloneTextBoxData(tb, false))
  };
  const ok = _pasteItemsIntoPage(current, snapshot, 20, 20);
  if (ok) {
    showToast('Selezione duplicata', '⧉');
  }
  return ok;
}

function showSelectionMenu() {
  const menu = document.getElementById('selectionMenu');
  if (!menu) return;
  _menuInteractingHidden = false;
  menu.classList.remove('hidden');

  const hasStrokes = state.selectedStrokes.length > 0;
  menu.querySelectorAll('[data-selection-ink-only]').forEach(el => {
    el.classList.toggle('hidden', !hasStrokes);
  });

  if (hasStrokes) {
    const first = state.selectedStrokes[0];
    const colorPicker = document.getElementById('selectionColorPicker');
    const widthSlider = document.getElementById('selectionWidthSlider');
    const widthValue = document.getElementById('selectionWidthValue');
    if (colorPicker && first.color) colorPicker.value = first.color;
    if (widthSlider) widthSlider.value = first.size || 3;
    if (widthValue) widthValue.innerText = first.size || 3;
  }
  _cachedMenuWidth = menu.offsetWidth || 360;
  updateSelectionMenuPosition();
}

function _setSelectionMenuInteracting(interacting) {
  const menu = document.getElementById('selectionMenu');
  if (!menu) return;
  if (interacting) {
    _menuInteractingHidden = true;
    menu.classList.add('hidden');
  } else {
    _menuInteractingHidden = false;
    if (hasLassoSelection()) {
      menu.classList.remove('hidden');
      if (!_cachedMenuWidth) _cachedMenuWidth = menu.offsetWidth || 360;
      updateSelectionMenuPosition();
    }
  }
}

function hideSelectionMenu() {
  _menuInteractingHidden = false;
  _cachedMenuWidth = 0;
  document.getElementById('selectionMenu')?.classList.add('hidden');
}

export function updateSelectionMenuPosition() {
  const menu = document.getElementById('selectionMenu');
  if (!menu || _menuInteractingHidden || menu.classList.contains('hidden')) return;
  const bbox = getVisualBoundingBox();
  const current = state.pages[state.activePageIndex];
  if (!bbox || !current || !current.canvas) return;
  const rect = getCanvasRect(current.canvas);
  if (!rect || rect.width <= 0) return;
  const scaleRatio = rect.width / PAGE_WIDTH;
  const screenX = rect.left + (bbox.minX + bbox.width / 2) * scaleRatio;
  const screenY = rect.top + bbox.minY * scaleRatio - 52;
  const menuWidth = _cachedMenuWidth || menu.offsetWidth || 360;
  if (!_cachedMenuWidth && menuWidth) _cachedMenuWidth = menuWidth;
  const x = Math.round(Math.max(16, Math.min(window.innerWidth - menuWidth - 16, screenX - menuWidth / 2)));
  const y = Math.round(Math.max(64, screenY));
  menu.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

export function canStartLassoDragOnTouch(e) {
  if (state.activeTool !== 'lasso' || !hasLassoSelection()) return false;
  const current = state.pages[state.activePageIndex];
  if (!current || !current.canvas) return false;
  const visualBBox = getVisualBoundingBox();
  if (!visualBBox) return false;
  const rect = getCanvasRect(current.canvas);
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    return false;
  }
  const pt = getCanvasCoords(e, current.canvas);
  return !!hitTestHandle(pt, visualBBox) || isPointInBBox(pt, visualBBox);
}

export function updateCursorForSelection(e, pageData) {
  if (!pageData || !pageData.canvas) return;
  if (state.activeTool !== 'lasso' || !hasLassoSelection()) {
    _setCanvasCursor(pageData, 'crosshair');
    return;
  }
  const rect = getCanvasRect(pageData.canvas);
  const point = {
    x: (e.clientX - rect.left) * (PAGE_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (PAGE_HEIGHT / rect.height)
  };
  const visualBBox = getVisualBoundingBox();
  const handle = hitTestHandle(point, visualBBox);
  if (handle) _setCanvasCursor(pageData, 'nwse-resize');
  else if (isPointInBBox(point, visualBBox)) _setCanvasCursor(pageData, 'move');
  else _setCanvasCursor(pageData, 'crosshair');
}

// ============================================================
// TOOL LAZO (begin / move / end)
// ============================================================

function _cancelLassoFrame() {
  if (_lassoRaf !== null) {
    cancelAnimationFrame(_lassoRaf);
    _lassoRaf = null;
  }
  _lassoRafPage = null;
}

export function flushLassoFrame(pageData = null) {
  if (_lassoRaf === null) return;
  cancelAnimationFrame(_lassoRaf);
  _lassoRaf = null;
  const target = pageData || _lassoRafPage;
  _lassoRafPage = null;
  if (target && target.canvas && state.lassoPath.length >= 2) {
    drawLassoIncrementalOnOverlay(target);
  }
}

export function beginLasso(pageData, point) {
  const visualBBox = getVisualBoundingBox();
  if (visualBBox) {
    const handle = hitTestHandle(point, visualBBox);
    if (handle) {
      startResizeSelection(handle, point);
      return 'resize';
    }
    if (isPointInBBox(point, visualBBox)) {
      beginSelectionDrag(point, pageData);
      return 'drag';
    }
  }
  clearSelection();
  state.isDrawing = true;
  state.lassoPath = [{ x: point.x, y: point.y, pressure: point.pressure }];
  clearOverlay(pageData);
  return 'lasso';
}

export function moveLasso(pageData, e) {
  if (!pageData || !pageData.canvas) return;
  const lp = getCanvasCoords(e, pageData.canvas);
  if (state.lassoMode === 'rect') {
    if (state.lassoPath.length >= 2) {
      state.lassoPath[1] = { x: lp.x, y: lp.y, pressure: lp.pressure };
    } else {
      state.lassoPath.push({ x: lp.x, y: lp.y, pressure: lp.pressure });
    }
    _lassoRafPage = pageData;
    if (_lassoRaf === null) {
      _lassoRaf = requestAnimationFrame(() => {
        _lassoRaf = null;
        const target = _lassoRafPage;
        _lassoRafPage = null;
        if (target && target.canvas) drawLassoIncrementalOnOverlay(target);
      });
    }
  } else {
    state.lassoPath.push({ x: lp.x, y: lp.y, pressure: lp.pressure });
    drawLassoIncrementalOnOverlay(pageData);
  }
}

export function endLasso(pageData) {
  flushLassoFrame(pageData);
  if (state.lassoMode === 'rect') {
    if (state.lassoPath.length >= 2) {
      const dx = Math.abs(state.lassoPath[1].x - state.lassoPath[0].x);
      const dy = Math.abs(state.lassoPath[1].y - state.lassoPath[0].y);
      if (dx >= 6 || dy >= 6) {
        selectStrokesInsideLasso(pageData);
        return;
      }
    }
    state.lassoPath = [];
    clearOverlay(pageData);
    return;
  }

  if (state.lassoPath.length > 5) selectStrokesInsideLasso(pageData);
  else { state.lassoPath = []; clearOverlay(pageData); }
}

// ============================================================
// SELECTION DRAG (offscreen snapshot + single rAF coalescing)
// ============================================================

let _dragStartPoint = null;
let _dragStartBBox = null;
let _dragStartVisualBBox = null;
let _dragAccX = 0;
let _dragAccY = 0;
let _dragRaf = null;
let _dragPendingPoint = null;
let _dragPage = null;

let _dragSnapshotCanvas = null;
let _dragCropX = 0;
let _dragCropY = 0;
let _dragCropW = 0;
let _dragCropH = 0;

function _freeDragSnapshot() {
  if (_dragSnapshotCanvas) {
    _dragSnapshotCanvas.width = 0;
    _dragSnapshotCanvas.height = 0;
    _dragSnapshotCanvas = null;
  }
  _dragCropX = 0;
  _dragCropY = 0;
  _dragCropW = 0;
  _dragCropH = 0;
}

export function resetSelectionDragState() {
  if (_dragRaf !== null) {
    cancelAnimationFrame(_dragRaf);
    _dragRaf = null;
  }
  _dragPendingPoint = null;
  _dragPage = null;
  _dragStartPoint = null;
  _dragStartBBox = null;
  _dragStartVisualBBox = null;
  _dragAccX = 0;
  _dragAccY = 0;
  _freeDragSnapshot();
}

function _computeClampedDragDelta(rawPoint) {
  if (!_dragStartPoint || !_dragStartBBox) return { dx: 0, dy: 0 };
  let desiredX = rawPoint.x - _dragStartPoint.x;
  let desiredY = rawPoint.y - _dragStartPoint.y;

  if (_dragStartBBox.maxX + desiredX > PAGE_WIDTH)  desiredX = PAGE_WIDTH  - _dragStartBBox.maxX;
  if (_dragStartBBox.minX + desiredX < 0)           desiredX = -_dragStartBBox.minX;
  if (_dragStartBBox.maxY + desiredY > PAGE_HEIGHT) desiredY = PAGE_HEIGHT - _dragStartBBox.maxY;
  if (_dragStartBBox.minY + desiredY < 0)           desiredY = -_dragStartBBox.minY;
  return { dx: desiredX, dy: desiredY };
}

function _buildDragSnapshot(pageData) {
  _freeDragSnapshot();
  if (!pageData || !pageData.overlayCanvas || !_dragStartBBox) return;

  redrawSelectionOverlay(pageData, { skipBBox: true });

  let maxStrokeSize = 4;
  for (let i = 0; i < state.selectedStrokes.length; i++) {
    const s = state.selectedStrokes[i];
    if (s && s.size > maxStrokeSize) maxStrokeSize = s.size;
  }
  const pad = Math.max(48, Math.ceil(sliderToBaseSize(maxStrokeSize) * 4 + 16));
  const minX = Math.max(0, Math.floor(_dragStartBBox.minX - pad));
  const minY = Math.max(0, Math.floor(_dragStartBBox.minY - pad));
  const maxX = Math.min(PAGE_WIDTH, Math.ceil(_dragStartBBox.maxX + pad));
  const maxY = Math.min(PAGE_HEIGHT, Math.ceil(_dragStartBBox.maxY + pad));

  const oDpr = pageData.overlayDpr || pageData.dpr || 1;
  const oCanvas = pageData.overlayCanvas;
  const sx = Math.max(0, Math.floor(minX * oDpr));
  const sy = Math.max(0, Math.floor(minY * oDpr));
  const sw = Math.min(oCanvas.width - sx, Math.ceil((maxX - minX) * oDpr));
  const sh = Math.min(oCanvas.height - sy, Math.ceil((maxY - minY) * oDpr));

  if (sw > 0 && sh > 0) {
    const snap = document.createElement('canvas');
    snap.width = sw;
    snap.height = sh;
    const sctx = snap.getContext('2d');
    if (sctx) {
      sctx.drawImage(oCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      _dragSnapshotCanvas = snap;
      _dragCropX = sx / oDpr;
      _dragCropY = sy / oDpr;
      _dragCropW = sw / oDpr;
      _dragCropH = sh / oDpr;
    }
  }

  drawSelectionBBoxOnOverlay(pageData, _dragStartVisualBBox);
}

function _renderDragPreview(pageData, dx, dy) {
  if (!pageData || !pageData.overlayCtx || !pageData.overlayCanvas) return;
  const octx = pageData.overlayCtx;
  const oCanvas = pageData.overlayCanvas;
  const oDpr = pageData.overlayDpr || pageData.dpr || 1;

  if (_dragSnapshotCanvas && _dragStartVisualBBox) {
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, oCanvas.width, oCanvas.height);
    octx.setTransform(oDpr, 0, 0, oDpr, 0, 0);
    octx.drawImage(
      _dragSnapshotCanvas,
      _dragCropX + dx,
      _dragCropY + dy,
      _dragCropW,
      _dragCropH
    );
    octx.restore();

    const v = _dragStartVisualBBox;
    drawSelectionBBoxOnOverlay(pageData, {
      minX: v.minX + dx,
      maxX: v.maxX + dx,
      minY: v.minY + dy,
      maxY: v.maxY + dy,
      width: v.width,
      height: v.height
    });
  } else {
    redrawSelectionOverlay(pageData);
  }
}

function _flushDragFrame() {
  _dragRaf = null;
  const pt = _dragPendingPoint;
  const page = _dragPage;
  if (!pt || !page || !state.isDraggingSelection) return;

  const { dx, dy } = _computeClampedDragDelta(pt);
  if (dx === _dragAccX && dy === _dragAccY) return;

  state.selectionMoved = true;
  if (!_dragSnapshotCanvas) {
    const incX = dx - _dragAccX;
    const incY = dy - _dragAccY;
    for (let i = 0; i < state.selectedStrokes.length; i++) {
      translateStrokeInPlace(state.selectedStrokes[i], incX, incY);
    }
    if (Array.isArray(state.selectedTextBoxes)) {
      for (let i = 0; i < state.selectedTextBoxes.length; i++) {
        const tb = state.selectedTextBoxes[i];
        if (!tb) continue;
        tb.x += incX;
        tb.y += incY;
      }
    }
  }
  _dragAccX = dx;
  _dragAccY = dy;
  _renderDragPreview(page, dx, dy);
}

export function beginSelectionDrag(point, pageData) {
  resetSelectionDragState();
  state.isDraggingSelection = true;
  _dragStartPoint = { x: point.x, y: point.y };
  _dragStartBBox = getSelectionBoundingBox(false);
  _dragStartVisualBBox = getVisualBoundingBox(_dragStartBBox);
  _dragAccX = 0;
  _dragAccY = 0;
  _dragPage = pageData;
  state.dragStartPoint = _dragStartPoint;
  state.isDrawing = true;
  state.selectionMoved = false;
  _setSelectionMenuInteracting(true);
  _setCanvasCursor(pageData, 'grabbing');
  _buildDragSnapshot(pageData);
}

export function moveSelectionDrag(pageData, rawPoint) {
  if (!_dragStartPoint || !_dragStartBBox) return;
  _dragPage = pageData;
  _dragPendingPoint = { x: rawPoint.x, y: rawPoint.y };
  if (_dragRaf === null) {
    _dragRaf = requestAnimationFrame(_flushDragFrame);
  }
}

export function endSelectionDrag(pageData, wasMoved) {
  const targetPage = pageData || _dragPage || state.pages[state.activePageIndex];
  const hadSnapshot = !!_dragSnapshotCanvas;

  if (_dragRaf !== null) {
    cancelAnimationFrame(_dragRaf);
    _dragRaf = null;
  }

  let finalDx = _dragAccX;
  let finalDy = _dragAccY;
  if (_dragPendingPoint && _dragStartPoint && _dragStartBBox) {
    const clamped = _computeClampedDragDelta(_dragPendingPoint);
    finalDx = clamped.dx;
    finalDy = clamped.dy;
  }
  _dragPendingPoint = null;

  const commitDx = hadSnapshot ? finalDx : (finalDx - _dragAccX);
  const commitDy = hadSnapshot ? finalDy : (finalDy - _dragAccY);

  if (commitDx !== 0 || commitDy !== 0) {
    for (let i = 0; i < state.selectedStrokes.length; i++) {
      translateStrokeInPlace(state.selectedStrokes[i], commitDx, commitDy);
    }
    if (Array.isArray(state.selectedTextBoxes)) {
      for (let i = 0; i < state.selectedTextBoxes.length; i++) {
        const tb = state.selectedTextBoxes[i];
        if (!tb) continue;
        tb.x += commitDx;
        tb.y += commitDy;
      }
    }
    wasMoved = true;
  } else if (finalDx !== 0 || finalDy !== 0) {
    wasMoved = true;
  }

  state.isDraggingSelection = false;
  state.dragStartPoint = null;
  state.selectionMoved = false;

  resetSelectionDragState();

  if (targetPage && targetPage.canvas) {
    _setCanvasCursor(targetPage, 'crosshair');
    redrawSelectionOverlay(targetPage);
  }
  _setSelectionMenuInteracting(false);

  if (wasMoved) {
    if (targetPage?.pageId) markPageDirty(targetPage.pageId);
    pushHistory();
    scheduleSave();
  }
}