// ============================================================
// PAGINE: createNewPageDOM, addNewPage, resize, resolution
// ============================================================

import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, showToast, on } from '../../core/utils.js';
import { redrawPageCanvas, clearOverlay, redrawSelectionOverlay } from './render.js';
import { attachPointerListeners } from './input.js';
import { pushHistory } from './history.js';
import { scheduleSave } from './autosave.js';
import { clearSelection } from './lasso.js';
import { updatePageCounterUI } from './header.js';
import { applyTransform } from './transform.js';

const MAX_RENDER_DPR = 4;
const MAX_ZOOM_DPR_BOOST = 2;

let _resolutionRefreshTimer = null;

export function createNewPageDOM(pageIndex, initialStrokes = []) {
  const container = document.getElementById('canvasContainer');
  const pageWrapper = document.createElement('div');
  pageWrapper.className = 'page-wrapper';
  pageWrapper.dataset.index = pageIndex;

  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'overlay-canvas';

  pageWrapper.appendChild(canvas);
  pageWrapper.appendChild(overlayCanvas);
  container.appendChild(pageWrapper);

  const ctx = canvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');
  const pageData = {
    index: pageIndex, wrapper: pageWrapper,
    canvas, ctx, overlayCanvas, overlayCtx,
    strokes: initialStrokes
  };

  resizeCanvasForHDPI(pageData);
  state.pages.push(pageData);
  attachPointerListeners(pageData);
  redrawPageCanvas(pageData);
  return pageData;
}

export function addNewPage() {
  const newIndex = state.pages.length;
  const newPage = createNewPageDOM(newIndex, []);
  state.activePageIndex = newIndex;
  updatePageCounterUI();
  scheduleSave();
  pushHistory();
  newPage.wrapper.scrollIntoView({ behavior: 'smooth' });
  scheduleResolutionRefresh();
}

export function centerViewport() {
  const vp = document.getElementById('viewport');
  viewport.x = (vp.clientWidth - PAGE_WIDTH) / 2;
  viewport.y = 20;
  applyTransform();
}

export function resetZoom() {
  viewport.scale = 1.0;
  applyTransform();
  showToast('Zoom resettato', '🔍');
}

export function getCurrentRenderDpr(pageData) {
  const deviceDpr = window.devicePixelRatio || 1;
  const zoom = Math.max(1, viewport.scale);
  const extra = Math.min(zoom, MAX_ZOOM_DPR_BOOST);
  const highDpr = Math.min(deviceDpr * extra, MAX_RENDER_DPR);
  const lowDpr = deviceDpr;
  if (pageData && !isPageVisible(pageData)) return lowDpr;
  return highDpr;
}

function isPageVisible(pageData) {
  const vp = document.getElementById('viewport');
  if (!vp) return true;
  const vpRect = vp.getBoundingClientRect();
  const pRect = pageData.wrapper.getBoundingClientRect();
  return !(pRect.right < vpRect.left || pRect.left > vpRect.right ||
           pRect.bottom < vpRect.top || pRect.top > vpRect.bottom);
}

export function resizeCanvasForHDPI(pageData, dprOverride) {
  const dpr = dprOverride || getCurrentRenderDpr(pageData);
  const newW = Math.floor(PAGE_WIDTH * dpr);
  const newH = Math.floor(PAGE_HEIGHT * dpr);
  let changed = false;
  if (pageData.canvas.width !== newW || pageData.canvas.height !== newH) {
    pageData.canvas.width = newW; pageData.canvas.height = newH; changed = true;
  }
  if (pageData.overlayCanvas &&
      (pageData.overlayCanvas.width !== newW || pageData.overlayCanvas.height !== newH)) {
    pageData.overlayCanvas.width = newW;
    pageData.overlayCanvas.height = newH;
    changed = true;
  }
  pageData.dpr = dpr;
  return changed;
}

export function refreshCanvasResolution(force = false) {
  state.pages.forEach(p => {
    const visible = isPageVisible(p);
    const targetDpr = getCurrentRenderDpr(p);
    const dprChanged = Math.abs((p.dpr || 1) - targetDpr) > 0.01;
    const visibilityChanged = p._wasVisible !== visible;
    if (force || dprChanged || visibilityChanged) {
      resizeCanvasForHDPI(p, targetDpr);
      redrawPageCanvas(p);
      if (p.index === state.activePageIndex && state.selectedStrokes.length > 0) {
        redrawSelectionOverlay(p);
      }
      p._wasVisible = visible;
    }
  });
}

export function scheduleResolutionRefresh() {
  if (_resolutionRefreshTimer) clearTimeout(_resolutionRefreshTimer);
  _resolutionRefreshTimer = setTimeout(() => {
    _resolutionRefreshTimer = null;
    refreshCanvasResolution(false);
  }, 200);
}

export function changeBackgroundPattern(pattern) {
  state.bgPattern = pattern;
  scheduleSave();
  state.pages.forEach(p => redrawPageCanvas(p));
  pushHistory();
}

export function clearCurrentPage() {
  const curr = state.pages[state.activePageIndex];
  if (curr && curr.strokes.length > 0) {
    if (!confirm('Vuoi davvero cancellare tutti i tratti di questa pagina? L\'operazione è reversibile con Ctrl+Z.')) return;
    curr.strokes = [];
    clearSelection();
    redrawPageCanvas(curr);
    scheduleSave();
    pushHistory();
    showToast('Pagina pulita', '🧹');
  }
}

export function restorePageFromSnapshot(snap) {
  const pageIndex = snap.pageIndex;
  const container = document.getElementById('canvasContainer');
  const oldWrapper = container.querySelector(`.page-wrapper[data-index="${pageIndex}"]`);
  if (oldWrapper) oldWrapper.remove();
  state.pages.splice(pageIndex, 1);
  createNewPageDOM(snap.pageIndex, snap.strokes);
  state.pages.sort((a, b) => a.index - b.index);
  const wrappers = Array.from(container.querySelectorAll('.page-wrapper'));
  wrappers.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
  wrappers.forEach(w => container.appendChild(w));
  updatePageCounterUI();
  const newPage = state.pages[state.activePageIndex];
  if (newPage) redrawSelectionOverlay(newPage);
}

on('history:restore', restorePageFromSnapshot);