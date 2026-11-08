// ============================================================
// LASSO + SELEZIONE + RESIZE + MENU CONTESTUALE
// ============================================================

import { invalidateStrokeBitmap } from './stroke-cache.js';
import { state, viewport } from '../../core/state.js';
import { showToast, PAGE_WIDTH, PAGE_HEIGHT } from '../../core/utils.js';
import {
  redrawPageCanvas, redrawSelectionOverlay, clearOverlay,
  renderFullStroke,
  getSelectionBoundingBox, getVisualBoundingBox, getHandlePositions,
  isPointInBBox, hitTestHandle, findClosestPointInSelection
} from './render.js';
import { pushHistory } from './history.js';
import { scheduleSave } from './autosave.js';

export function selectStrokesInsideLasso(pageData) {
  const polygon = state.lassoPath;
  state.selectedStrokes = pageData.strokes.filter(stroke =>
    stroke.points.some(pt => isPointInPolygon(pt, polygon))
  );
  state.lassoPath = [];
  if (state.selectedStrokes.length > 0) {
    showSelectionMenu();
    showToast(`${state.selectedStrokes.length} elementi selezionati`, '✂️');
    redrawPageCanvas(pageData);
    redrawSelectionOverlay(pageData);
  } else {
    state.selectedStrokes = [];
    state.isDraggingSelection = false;
    state.isResizingSelection = false;
    state.resizePivot = null; state.resizeAnchor = null;
    state.resizeOffset = null; state.initialStrokesSnapshot = null;
    hideSelectionMenu();
    redrawSelectionOverlay(pageData);
  }
}

function isPointInPolygon(point, vs) {
  let x = point.x, y = point.y, inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    let xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
    let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function clearSelection() {
  const hadSelection = state.selectedStrokes.length > 0;
  const hadLasso = state.lassoPath.length > 0;
  state.selectedStrokes = [];
  state.isDraggingSelection = false;
  state.isResizingSelection = false;
  state.resizePivot = null; state.resizeAnchor = null;
  state.resizeOffset = null; state.initialStrokesSnapshot = null;
  hideSelectionMenu();
  if (hadSelection || hadLasso) {
    const current = state.pages[state.activePageIndex];
    if (current) {
      current.canvas.style.cursor = 'crosshair';
      redrawPageCanvas(current);
      redrawSelectionOverlay(current);
    }
  }
}

function snapshotSelectedStrokes() {
  return state.selectedStrokes.map(s => ({
    color: s.color, size: s.size, tool: s.tool,
    points: s.points.map(p => ({ x: p.x, y: p.y, pressure: p.pressure }))
  }));
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
  state.selectionMoved = false;
  const current = state.pages[state.activePageIndex];
  if (current) { current.canvas.style.cursor = 'nwse-resize'; redrawSelectionOverlay(current); }
}

export function applyResizeSelection(point) {
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
  state.selectedStrokes.forEach((stroke, i) => {
    const snap = state.initialStrokesSnapshot[i];
    stroke.points = snap.points.map(p => {
      const px = p.x - pivot.x, py = p.y - pivot.y;
      return {
        x: pivot.x + (px * cos - py * sin) * scale,
        y: pivot.y + (px * sin + py * cos) * scale,
        pressure: p.pressure
      };
    });
    invalidateStrokeBitmap(stroke);
  });
  state.selectionMoved = true;
  const current = state.pages[state.activePageIndex];
  if (current) redrawSelectionOverlay(current);
  updateSelectionMenuPosition();
}

export function previewSelectionColor(newColor) {
  if (state.selectedStrokes.length === 0) return;
  state.selectedStrokes.forEach(s => {
    s.color = newColor;
    s._styleCache = null;
    invalidateStrokeBitmap(s);
  });
  const current = state.pages[state.activePageIndex];
  if (current) { redrawPageCanvas(current); redrawSelectionOverlay(current); }
}

export function changeSelectionColor(newColor) {
  if (state.selectedStrokes.length === 0) return;
  previewSelectionColor(newColor);
  scheduleSave();
  pushHistory();
  showToast('Colore aggiornato', '🎨');
}

export function previewSelectionWidth(newWidth) {
  if (state.selectedStrokes.length === 0) return;
  const w = parseInt(newWidth);
  state.selectedStrokes.forEach(s => {
    s.size = w;
    invalidateStrokeBitmap(s);
  });
  const label = document.getElementById('selectionWidthValue');
  if (label) label.innerText = w;
  const current = state.pages[state.activePageIndex];
  if (current) { redrawPageCanvas(current); redrawSelectionOverlay(current); }
}

export function changeSelectionWidth(newWidth) {
  if (state.selectedStrokes.length === 0) return;
  previewSelectionWidth(newWidth);
  scheduleSave();
  pushHistory();
  showToast('Spessore aggiornato', '📏');
}

export function deleteSelectedStrokes() {
  const current = state.pages[state.activePageIndex];
  if (current && state.selectedStrokes.length > 0) {
    current.strokes = current.strokes.filter(s => !state.selectedStrokes.includes(s));
    state.selectedStrokes = [];
    hideSelectionMenu();
    redrawPageCanvas(current);
    clearOverlay(current);
    scheduleSave();
    pushHistory();
    showToast('Elementi eliminati', '🗑️');
  }
}

function showSelectionMenu() {
  const menu = document.getElementById('selectionMenu');
  menu.classList.remove('hidden');
  if (state.selectedStrokes.length > 0) {
    const first = state.selectedStrokes[0];
    const colorPicker = document.getElementById('selectionColorPicker');
    const widthSlider = document.getElementById('selectionWidthSlider');
    const widthValue = document.getElementById('selectionWidthValue');
    if (colorPicker && first.color) colorPicker.value = first.color;
    if (widthSlider) widthSlider.value = first.size || 3;
    if (widthValue) widthValue.innerText = first.size || 3;
  }
  updateSelectionMenuPosition();
}

function hideSelectionMenu() {
  document.getElementById('selectionMenu').classList.add('hidden');
}

export function updateSelectionMenuPosition() {
  const menu = document.getElementById('selectionMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  const bbox = getVisualBoundingBox();
  const current = state.pages[state.activePageIndex];
  if (!bbox || !current) return;
  const rect = current.canvas.getBoundingClientRect();
  const scaleRatio = rect.width / PAGE_WIDTH;
  const screenX = rect.left + (bbox.minX + bbox.width / 2) * scaleRatio;
  const screenY = rect.top + bbox.minY * scaleRatio - 60;
  const menuWidth = menu.offsetWidth || 320;
  menu.style.left = `${Math.max(20, Math.min(window.innerWidth - menuWidth - 20, screenX - menuWidth / 2))}px`;
  menu.style.top = `${Math.max(60, screenY)}px`;
}

export function updateCursorForSelection(e, pageData) {
  if (state.activeTool !== 'lasso' || state.selectedStrokes.length === 0) {
    pageData.canvas.style.cursor = 'crosshair'; return;
  }
  const rect = pageData.canvas.getBoundingClientRect();
  const point = {
    x: (e.clientX - rect.left) * (PAGE_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (PAGE_HEIGHT / rect.height)
  };
  const visualBBox = getVisualBoundingBox();
  const handle = hitTestHandle(point, visualBBox);
  if (handle) pageData.canvas.style.cursor = 'nwse-resize';
  else if (isPointInBBox(point, visualBBox)) pageData.canvas.style.cursor = 'move';
  else pageData.canvas.style.cursor = 'crosshair';
}