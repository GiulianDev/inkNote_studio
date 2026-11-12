/**
 * @module features/editor/pages
 *
 * PAGINE — creazione DOM, gestione canvas, risoluzione HDPI, pagina attiva.
 *
 * createNewPageDOM(index, strokes):
 *   crea wrapper + canvas principale + overlay canvas + prediction canvas,
 *   aggancia pointer listeners, chiama redrawPageCanvas.
 *
 * addNewPage():
 *   crea pagina, la rende attiva, scrolla in cima, resetta history.
 *
 * HDPI / DPR:
 *   - DPR massimo 4 (perf)
 *   - overlay limitato a 1.5 (bassa risoluzione basta per feedback)
 *   - refreshCanvasResolution(): salta pagine invisibili (fix perf)
 *
 * Pagina attiva:
 *   - getMostCenteredPage(): scansione ±3 pagine (fix perf: 7 reflow vs 100)
 *   - updateActivePageFromViewport(): throttle 100ms
 *
 * Restore da history:
 *   ascolta `history:restore` e ricrea il DOM della pagina.
 *
 * @see core/types.js  — PageData, BgPattern
 * @see features/render/render.js
 * @see features/tools/dispatcher.js  — attachPointerListeners
 * @see features/history/history.js  — event history:restore
 */

import { ensurePredictionCanvas } from '../render/prediction.js';
import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, showToast, on } from '../../core/utils.js';
import { redrawPageCanvas, clearOverlay, redrawSelectionOverlay } from '../render/render.js';
import { attachPointerListeners } from '../tools/dispatcher.js';
import { pushHistory, resetHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import { clearSelection } from '../tools/lazo.js';
import { refreshPageCounter } from '../toolbar/toolbar.js';
import {
  applyTransform, clampViewport, invalidateClampCache
} from '../viewport/transform.js';

const MAX_RENDER_DPR = 4;
const MAX_ZOOM_DPR_BOOST = 1.3;
const BASE_OVERLAY_DPR = Math.min(window.devicePixelRatio || 1, 1.5);

let _resolutionRefreshTimer = null;

let _viewportResizeObserver = null;
let _lastVpW = 0;
let _lastVpH = 0;

// ============================================================
// BATCH A.2 — CANVAS RELEASE
// ------------------------------------------------------------
// Le pagine lontane dal viewport non hanno bisogno di canvas
// "reali": gli stroke sono dati JS, il canvas è solo la cache di
// rendering. Rilasciare la memoria GPU dei canvas invisibili
// riduce da N×20 MB a ~6×20 MB su notebook grandi (30+ pagine).
//
// Il wrapper resta nel DOM (layout invariato), ma con
// visibility:hidden finché la pagina non torna visibile.
// Al ritorno: resizeCanvasForHDPI + redrawPageCanvas ricostruiscono
// tutto dagli stroke (nessun dato perso, è già così che funziona
// il restore da history).
// ============================================================

const RELEASE_DISTANCE_PAGES = 4;  // oltre ±4 pagine dall'active → release

function releaseCanvasMemory(pageData) {
  if (pageData._released) return;

  // 1×1 = dimensione minima che forza il browser a liberare la
  // texture GPU associata al canvas. Non è "distruzione": è un
  // resize a dimensione trascurabile.
  const sz = 1;
  if (pageData.canvas)        { pageData.canvas.width = sz;        pageData.canvas.height = sz; }
  if (pageData.overlayCanvas) { pageData.overlayCanvas.width = sz; pageData.overlayCanvas.height = sz; }
  if (pageData._predCanvas)   { pageData._predCanvas.width = sz;   pageData._predCanvas.height = sz; }

  // Reset cache di rendering (invalidata dal resize)
  pageData.dpr = 0;
  pageData.overlayDpr = 0;
  pageData._lastHighlighterBBox = null;
  pageData._lastPredBBox = null;

  // Nasconde visivamente il wrapper (senza rimuoverlo dal layout)
  pageData.wrapper.style.visibility = 'hidden';

  pageData._released = true;
}

function restoreCanvasMemory(pageData) {
  if (!pageData._released) return;

  pageData.wrapper.style.visibility = '';
  pageData._released = false;

  resizeCanvasForHDPI(pageData);
  redrawPageCanvas(pageData);
  if (pageData.index === state.activePageIndex && state.selectedStrokes.length > 0) {
    redrawSelectionOverlay(pageData);
  }
  if (pageData._predCtx) {
    // ensurePredictionCanvas già fatto; basta ridimensionare
    pageData._predCanvas.width = Math.floor(PAGE_WIDTH * 1);
    pageData._predCanvas.height = Math.floor(PAGE_HEIGHT * 1);
  }
}

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
  refreshPageCounter();
  scheduleSave();
  pushHistory();
  scheduleResolutionRefresh();
  invalidateClampCache();

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
const ACTIVE_PAGE_SCAN_RADIUS = 3;

export function getMostCenteredPage() {
  if (state.pages.length === 0) return null;
  const vp = document.getElementById('viewport');
  if (!vp) return state.pages[0];
  const vpRect = vp.getBoundingClientRect();
  const vpCenterX = vpRect.left + vpRect.width / 2;
  const vpCenterY = vpRect.top + vpRect.height / 2;

  const tryRange = (start, end) => {
    let bestPage = null;
    let bestVisibleArea = 0;
    let bestDist = Infinity;
    for (let i = start; i < end; i++) {
      const page = state.pages[i];
      if (!page) continue;
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
  };

  const start = Math.max(0, state.activePageIndex - ACTIVE_PAGE_SCAN_RADIUS);
  const end = Math.min(state.pages.length, state.activePageIndex + ACTIVE_PAGE_SCAN_RADIUS + 1);
  const ranged = tryRange(start, end);
  if (ranged) return ranged;

  return tryRange(0, state.pages.length);
}

let _activePageCheckTimer = null;
const ACTIVE_PAGE_CHECK_INTERVAL = 100;

export function updateActivePageFromViewport() {
  if (_activePageCheckTimer !== null) return;
  _activePageCheckTimer = setTimeout(() => {
    _activePageCheckTimer = null;
    const page = getMostCenteredPage();
    if (!page || page.index === state.activePageIndex) return;
    if (state.selectedStrokes.length > 0) {
      clearSelection();
    }
    state.activePageIndex = page.index;
    refreshPageCounter();
    resetHistory();
  }, ACTIVE_PAGE_CHECK_INTERVAL);
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

    // ---- PAGINA INVISIBILE ----
    if (!visible) {
      p._wasVisible = false;

      // Release solo se è LONTANA dall'active (margine di sicurezza
      // per evitare flash durante scroll veloce).
      const dist = Math.abs(p.index - state.activePageIndex);
      if (dist > RELEASE_DISTANCE_PAGES) {
        releaseCanvasMemory(p);
      }
      return;
    }

    // ---- PAGINA VISIBILE ----
    // Se era stata "released", ricostruisci da zero.
    if (p._released) {
      restoreCanvasMemory(p);
      p._wasVisible = true;
      return;
    }

    const targetDpr = getCurrentRenderDpr(p);
    const dprChanged = Math.abs((p.dpr || 1) - targetDpr) > 0.01;
    const wasVisible = p._wasVisible !== false;

    if (force || dprChanged || !wasVisible) {
      resizeCanvasForHDPI(p, targetDpr);
      redrawPageCanvas(p);
      if (p.index === state.activePageIndex && state.selectedStrokes.length > 0) {
        redrawSelectionOverlay(p);
      }
    }
    p._wasVisible = true;
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
  refreshPageCounter();
  invalidateClampCache();
  const newPage = state.pages[state.activePageIndex];
  if (newPage) redrawSelectionOverlay(newPage);
}

on('history:restore', restorePageFromSnapshot);