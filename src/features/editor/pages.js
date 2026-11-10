// ============================================================
// PAGINE: createNewPageDOM, addNewPage, resize, resolution
// ============================================================

import { ensurePredictionCanvas } from './prediction.js';
import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, showToast, on } from '../../core/utils.js';
import { redrawPageCanvas, clearOverlay, redrawSelectionOverlay } from './render.js';
import { attachPointerListeners } from './input.js';
import { pushHistory, resetHistory } from './history.js';
import { scheduleSave } from './autosave.js';
import { clearSelection } from './lasso.js';
import { updatePageCounterUI } from './header.js';
import {
  applyTransform, clampViewport, invalidateClampCache
} from './transform.js';

const MAX_RENDER_DPR = 4;
const MAX_ZOOM_DPR_BOOST = 1.3;
const BASE_OVERLAY_DPR = Math.min(window.devicePixelRatio || 1, 1.5);

let _resolutionRefreshTimer = null;
let _activePageRaf = null;

let _viewportResizeObserver = null;
let _lastVpW = 0;
let _lastVpH = 0;

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

  ensurePredictionCanvas(pageData);
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
  scheduleResolutionRefresh();
  // Il contenuto è cresciuto: i bounds sono cambiati
  invalidateClampCache();

  // Porta in vista la nuova pagina via transform (no scrollIntoView:
  // sposta #viewport.scrollTop in modo indipendente dal nostro
  // transform, causando disallineamenti successivi).
  requestAnimationFrame(() => {
    const pageTop = newPage.wrapper.offsetTop;
    const targetY = -pageTop * viewport.scale + 20;
    viewport.y = targetY;
    const c = clampViewport(viewport.x, viewport.y);
    viewport.x = c.x;
    viewport.y = c.y;
    applyTransform(true);
  });
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

export function installViewportResizeObserver() {
  if (_viewportResizeObserver) return;
  const vp = document.getElementById('viewport');
  if (!vp) return;

  _lastVpW = vp.clientWidth;
  _lastVpH = vp.clientHeight;

  _viewportResizeObserver = new ResizeObserver(() => {
    const newW = vp.clientWidth;
    const newH = vp.clientHeight;
    if (newW === _lastVpW && newH === _lastVpH) return;

    const canvasCX = (_lastVpW / 2 - viewport.x) / viewport.scale;
    const canvasCY = (_lastVpH / 2 - viewport.y) / viewport.scale;

    viewport.x = newW / 2 - canvasCX * viewport.scale;
    viewport.y = newH / 2 - canvasCY * viewport.scale;

    _lastVpW = newW;
    _lastVpH = newH;

    applyTransform();
  });

  _viewportResizeObserver.observe(vp);
}

// ------------------------------------------------------------
// Pagina attiva basata sul viewport
// ------------------------------------------------------------

export function getMostCenteredPage() {
  if (state.pages.length === 0) return null;
  const vp = document.getElementById('viewport');
  if (!vp) return state.pages[0];
  const vpRect = vp.getBoundingClientRect();
  const vpCenterX = vpRect.left + vpRect.width / 2;
  const vpCenterY = vpRect.top + vpRect.height / 2;
  let bestPage = null;
  let bestVisibleArea = 0;
  let bestDist = Infinity;
  for (const page of state.pages) {
    const rect = page.wrapper.getBoundingClientRect();
    const visibleW = Math.max(0, Math.min(rect.right, vpRect.right) - Math.max(rect.left, vpRect.left));
    const visibleH = Math.max(0, Math.min(rect.bottom, vpRect.bottom) - Math.max(rect.top, vpRect.top));
    const visibleArea = visibleW * visibleH;
    if (visibleArea <= 0) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(cx - vpCenterX, cy - vpCenterY);
    if (visibleArea > bestVisibleArea || (visibleArea === bestVisibleArea && dist < bestDist)) {
      bestVisibleArea = visibleArea;
      bestDist = dist;
      bestPage = page;
    }
  }
  return bestPage;
}

export function updateActivePageFromViewport() {
  if (_activePageRaf !== null) return;
  _activePageRaf = requestAnimationFrame(() => {
    _activePageRaf = null;
    const page = getMostCenteredPage();
    if (!page || page.index === state.activePageIndex) return;
    if (state.selectedStrokes.length > 0) {
      clearSelection();
    }
    state.activePageIndex = page.index;
    updatePageCounterUI();
    resetHistory();
  });
}

function getCurrentRenderDpr(pageData) {
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
  const overlayDpr = Math.min(dpr, BASE_OVERLAY_DPR);
  const oW = Math.floor(PAGE_WIDTH * overlayDpr);
  const oH = Math.floor(PAGE_HEIGHT * overlayDpr);
  if (pageData.overlayCanvas &&
      (pageData.overlayCanvas.width !== oW || pageData.overlayCanvas.height !== oH)) {
    pageData.overlayCanvas.width = oW;
    pageData.overlayCanvas.height = oH;
    changed = true;
  }
  pageData.dpr = dpr;
  pageData.overlayDpr = overlayDpr;
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
  const page = state.pages[state.activePageIndex];
  if (!page || page.strokes.length === 0) return;
  if (!confirm('Vuoi davvero cancellare tutti i tratti di questa pagina? L\'operazione è reversibile con Ctrl+Z.')) return;
  if (state.selectedStrokes.length > 0) clearSelection();
  page.strokes = [];
  redrawPageCanvas(page);
  scheduleSave();
  pushHistory();
  showToast('Pagina pulita', '🧹');
}

function restorePageFromSnapshot(snap) {
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
  invalidateClampCache();
  const newPage = state.pages[state.activePageIndex];
  if (newPage) redrawSelectionOverlay(newPage);
}

on('history:restore', restorePageFromSnapshot);