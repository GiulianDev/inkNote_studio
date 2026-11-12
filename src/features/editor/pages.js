/**
 * @module features/editor/pages
 *
 * PAGINE — creazione wrapper DOM, gestione canvas via pool, pagina attiva.
 *
 * Con il pool, `createNewPageDOM` crea SOLO il wrapper (niente canvas).
 * I canvas vengono creati e riassegnati dal PageRendererPool in base
 * alla pagina attiva e alle pagine vicine.
 *
 * `refreshCanvasResolution` ora delega al pool.
 *
 * @see features/editor/page-pool.js
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
import { pagePool, setViewportRef } from './page-pool.js';

setViewportRef(viewport);

let _resolutionRefreshTimer = null;
let _viewportResizeObserver = null;
let _lastVpW = 0;
let _lastVpH = 0;

export function createNewPageDOM(pageIndex, initialStrokes = []) {
  const container = document.getElementById('canvasContainer');
  const pageWrapper = document.createElement('div');
  pageWrapper.className = 'page-wrapper';
  pageWrapper.dataset.index = pageIndex;

  container.appendChild(pageWrapper);

  const pageData = {
    index: pageIndex,
    wrapper: pageWrapper,
    canvas: null,
    ctx: null,
    overlayCanvas: null,
    overlayCtx: null,
    strokes: initialStrokes,
    dpr: 0,
    overlayDpr: 0
  };

  state.pages.push(pageData);
  attachPointerListeners(pageData);
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
// Pagina attiva
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
    let bestPage = null, bestVisibleArea = 0, bestDist = Infinity;
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
        bestVisibleArea = visibleArea; bestDist = dist; bestPage = page;
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
    if (state.selectedStrokes.length > 0) clearSelection();
    state.activePageIndex = page.index;
    refreshPageCounter();
    resetHistory();
    // Aggiorna subito il pool: le pagine vicine devono avere uno slot
    pagePool.updateAround(state.activePageIndex);
  }, ACTIVE_PAGE_CHECK_INTERVAL);
}

export function refreshCanvasResolution(force = false) {
  pagePool.updateAround(state.activePageIndex, force);
}

export function scheduleResolutionRefresh() {
  if (_resolutionRefreshTimer) clearTimeout(_resolutionRefreshTimer);
  _resolutionRefreshTimer = setTimeout(() => {
    _resolutionRefreshTimer = null;
    refreshCanvasResolution(false);
  }, 200);
}

/**
 * resizeCanvasForHDPI è mantenuta per compatibilità (export-pdf.js, ecc.)
 * ma è un no-op con il pool: il resize avviene internamente per slot.
 * L'unico caso residuo è quando un consumatore ha bisogno di forzare
 * il DPR per la stampa: usare il canvas offscreen locale.
 */
export function resizeCanvasForHDPI(pageData, dprOverride) {
  // No-op: il pool gestisce il resize. Se serve un DPR custom (stampa),
  // il chiamante deve creare un canvas offscreen separato.
  if (typeof dprOverride === 'number' && pageData && pageData.canvas) {
    // caso limite: forziamo un redraw (non cambiamo DPR)
    redrawPageCanvas(pageData);
  }
}

export function changeBackgroundPattern(pattern) {
  state.bgPattern = pattern;
  scheduleSave();
  state.pages.forEach(p => { if (p.canvas) redrawPageCanvas(p); });
  pushHistory();
}

export function clearCurrentPage() {
  const page = state.pages[state.activePageIndex];
  if (!page || page.strokes.length === 0) return;
  if (!confirm('Vuoi davvero cancellare tutti i tratti di questa pagina? L\'operazione è reversibile con Ctrl+Z.')) return;
  if (state.selectedStrokes.length > 0) clearSelection();
  page.strokes = [];
  if (page.canvas) redrawPageCanvas(page);
  scheduleSave();
  pushHistory();
  showToast('Pagina pulita', '🧹');
}

function restorePageFromSnapshot(snap) {
  const pageIndex = snap.pageIndex;
  const container = document.getElementById('canvasContainer');
  const oldWrapper = container.querySelector(`.page-wrapper[data-index="${pageIndex}"]`);
  if (oldWrapper) oldWrapper.remove();
  pagePool.reset();
  state.pages.splice(pageIndex, 1);
  createNewPageDOM(snap.pageIndex, snap.strokes);
  state.pages.sort((a, b) => a.index - b.index);
  const wrappers = Array.from(container.querySelectorAll('.page-wrapper'));
  wrappers.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
  wrappers.forEach(w => container.appendChild(w));
  refreshPageCounter();
  invalidateClampCache();
  refreshCanvasResolution(true);
}

on('history:restore', restorePageFromSnapshot);