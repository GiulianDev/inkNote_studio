/**
 * @module features/editor/pages
 *
 * PAGINE — creazione wrapper DOM, gestione canvas via pool, pagina attiva,
 * eliminazione/riordino/scroll con identità immutabile `pageId`.
 *
 * @see features/editor/page-pool.js
 * @see features/persistence/session.js
 * @see features/pages-sidebar/pages-sidebar.js
 */

import { state, viewport } from '../../core/state.js';
import {
  PAGE_WIDTH, PAGE_HEIGHT, showToast, showConfirmDialog, on, generatePageId
} from '../../core/utils.js';
import { redrawPageCanvas, redrawSelectionOverlay } from '../render/render.js';
import { attachPointerListeners } from '../tools/dispatcher.js';
import { pushHistory, resetHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import {
  markPageDirty, markPageDeleted, markOrderDirty
} from '../persistence/session.js';
import { clearSelection } from '../tools/lazo.js';
import { refreshPageCounter } from '../toolbar/toolbar.js';
import {
  applyTransform, clampViewport, invalidateClampCache
} from '../viewport/transform.js';
import { pagePool, setViewportRef } from './page-pool.js';
import { unpackStrokes } from '../persistence/serialization.js';

setViewportRef(viewport);

let _resolutionRefreshTimer = null;
let _viewportResizeObserver = null;
let _lastVpW = 0;
let _lastVpH = 0;
let _programmaticScrollUntil = 0;

// ============================================================
// CREAZIONE PAGINA
// ============================================================

export function createNewPageDOM(pageIndex, initialStrokes = [], pageId = null) {
  const container = document.getElementById('canvasContainer');
  const pid = (typeof pageId === 'string' && pageId) ? pageId : generatePageId();

  const pageWrapper = document.createElement('div');
  pageWrapper.className = 'page-wrapper';
  pageWrapper.dataset.index = String(pageIndex);
  pageWrapper.dataset.pageId = pid;

  container.appendChild(pageWrapper);

  const strokes = unpackStrokes(initialStrokes);

  const pageData = {
    pageId: pid,
    index: pageIndex,
    wrapper: pageWrapper,
    canvas: null,
    ctx: null,
    overlayCanvas: null,
    overlayCtx: null,
    strokes,
    dpr: 0,
    overlayDpr: 0
  };

  state.pages.push(pageData);
  attachPointerListeners(pageData);
  return pageData;
}

export function addNewPage() {
  if (state.selectedStrokes.length > 0) clearSelection();
  const newIndex = state.pages.length;
  const newPage = createNewPageDOM(newIndex, []);
  state.activePageIndex = newIndex;

  markPageDirty(newPage.pageId);
  markOrderDirty();

  refreshPageCounter();
  scheduleSave({ markDirty: false, immediate: true });
  resetHistory();
  scheduleResolutionRefresh();
  invalidateClampCache();

  _programmaticScrollUntil = performance.now() + 420;
  if (_activePageCheckTimer !== null) {
    clearTimeout(_activePageCheckTimer);
    _activePageCheckTimer = null;
  }

  requestAnimationFrame(() => {
    const vp = document.getElementById('viewport');
    const pageTop = newPage.wrapper.offsetTop;
    if (vp) {
      const pageLeft = newPage.wrapper.offsetLeft;
      const pageW = newPage.wrapper.offsetWidth || PAGE_WIDTH;
      viewport.x = vp.clientWidth / 2 - (pageLeft + pageW / 2) * viewport.scale;
    }
    viewport.y = -pageTop * viewport.scale + 20;
    const c = clampViewport(viewport.x, viewport.y);
    viewport.x = c.x;
    viewport.y = c.y;
    applyTransform(true);
  });

  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index: newIndex, pageId: newPage.pageId }
  }));
}

// ============================================================
// VIEWPORT (centratura, zoom, resize observer)
// ============================================================

export function centerViewport() {
  const vp = document.getElementById('viewport');
  if (!vp) return;
  const firstPage = state.pages[0];
  if (firstPage && firstPage.wrapper) {
    const pageLeft = firstPage.wrapper.offsetLeft;
    const pageW = firstPage.wrapper.offsetWidth || PAGE_WIDTH;
    viewport.x = vp.clientWidth / 2 - (pageLeft + pageW / 2) * viewport.scale;
  } else {
    viewport.x = (vp.clientWidth - PAGE_WIDTH) / 2;
  }
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

    invalidateClampCache();
    applyTransform();
  });

  _viewportResizeObserver.observe(vp);
}

// ============================================================
// PAGINA ATTIVA (basata sul viewport)
// ============================================================

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
  if (performance.now() < _programmaticScrollUntil) return;
  if (_activePageCheckTimer !== null) return;
  _activePageCheckTimer = setTimeout(() => {
    _activePageCheckTimer = null;
    if (performance.now() < _programmaticScrollUntil) return;
    const page = getMostCenteredPage();
    if (!page || page.index === state.activePageIndex) return;
    if (state.selectedStrokes.length > 0) {
      clearSelection();
    }
    state.activePageIndex = page.index;
    refreshPageCounter();
    resetHistory();
    pagePool.updateAround(state.activePageIndex);
    scheduleSave({ markDirty: false, silent: true });

    window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
      detail: { index: page.index, pageId: page.pageId }
    }));
  }, ACTIVE_PAGE_CHECK_INTERVAL);
}

// ============================================================
// POOL — delega
// ============================================================

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

// ============================================================
// AZIONI PAGINA
// ============================================================

export function changeBackgroundPattern(pattern) {
  state.bgPattern = pattern;
  scheduleSave({ markDirty: false });
  state.pages.forEach(p => {
    if (p.canvas) redrawPageCanvas(p);
  });
  pushHistory();

  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
}

export async function clearCurrentPage() {
  const initialPage = state.pages[state.activePageIndex];
  if (!initialPage || initialPage.strokes.length === 0) return;

  const targetPageId = initialPage.pageId;
  const confirmed = await showConfirmDialog({
    title: 'Pulisci pagina',
    message: 'Vuoi davvero cancellare tutti i tratti di questa pagina? L\'operazione è reversibile con Annulla (Ctrl+Z).',
    confirmText: 'Pulisci',
    cancelText: 'Annulla',
    danger: true
  });
  if (!confirmed) return;

  const page = state.pages.find(p => p.pageId === targetPageId);
  if (!page || page.strokes.length === 0) return;

  const isActive = page.index === state.activePageIndex;
  if (isActive) {
    if (state.pendingShape) state.pendingShape = null;
    if (state.selectedStrokes.length > 0) clearSelection();
  }
  page.strokes = [];
  if (page.canvas) redrawPageCanvas(page);
  markPageDirty(page.pageId);
  scheduleSave({ markDirty: false });
  if (isActive) pushHistory();
  showToast('Pagina pulita', '🧹');

  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
}

// ============================================================
// ELIMINA / RIORDINA / SCROLL-TO-PAGE
// ============================================================

export function deletePage(index) {
  if (state.pages.length <= 1) return false;
  if (index < 0 || index >= state.pages.length) return false;

  const page = state.pages[index];
  if (!page) return false;

  if (state.activePageIndex === index) {
    state.pendingShape = null;
    if (state.selectedStrokes.length > 0) clearSelection();
  }

  pagePool.reset();

  page.wrapper.remove();
  state.pages.splice(index, 1);

  state.pages.forEach((p, i) => {
    p.index = i;
    p.wrapper.dataset.index = String(i);
  });

  if (state.activePageIndex >= state.pages.length) {
    state.activePageIndex = state.pages.length - 1;
  } else if (state.activePageIndex > index) {
    state.activePageIndex--;
  }

  markPageDeleted(page.pageId);
  markOrderDirty();

  invalidateClampCache();
  const c = clampViewport(viewport.x, viewport.y);
  if (c.x !== viewport.x || c.y !== viewport.y) {
    viewport.x = c.x;
    viewport.y = c.y;
    applyTransform(false);
  }

  refreshPageCounter();
  pagePool.updateAround(state.activePageIndex);
  resetHistory();
  scheduleSave({ markDirty: false, immediate: true });

  const activePage = state.pages[state.activePageIndex];
  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index: state.activePageIndex, pageId: activePage?.pageId }
  }));

  return true;
}

export function movePage(from, to) {
  if (from === to) return false;
  if (from < 0 || from >= state.pages.length) return false;
  if (to < 0 || to >= state.pages.length) return false;

  const container = document.getElementById('canvasContainer');

  pagePool.reset();

  const [moved] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, moved);

  state.pages.forEach((p, i) => {
    p.index = i;
    p.wrapper.dataset.index = String(i);
    container.appendChild(p.wrapper);
  });

  if (state.activePageIndex === from) {
    state.activePageIndex = to;
  } else if (from < state.activePageIndex && to >= state.activePageIndex) {
    state.activePageIndex--;
  } else if (from > state.activePageIndex && to <= state.activePageIndex) {
    state.activePageIndex++;
  }

  markOrderDirty();

  refreshPageCounter();
  pagePool.updateAround(state.activePageIndex);
  invalidateClampCache();
  resetHistory();
  scheduleSave({ markDirty: false, immediate: true });

  const activePage = state.pages[state.activePageIndex];
  window.dispatchEvent(new CustomEvent('inknote:pages-reordered'));
  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index: state.activePageIndex, pageId: activePage?.pageId }
  }));

  return true;
}

/**
 * Porta la pagina `index` centrata nel viewport e la rende attiva.
 * @param {number} index
 */
export function scrollToPage(index) {
  const page = state.pages[index];
  if (!page) return;
  const vp = document.getElementById('viewport');
  if (!vp) return;

  // Evita che updateActivePageFromViewport() sovrascriva activePageIndex
  // durante i 300ms della transizione CSS di applyTransform(true).
  _programmaticScrollUntil = performance.now() + 420;
  if (_activePageCheckTimer !== null) {
    clearTimeout(_activePageCheckTimer);
    _activePageCheckTimer = null;
  }

  const scale = viewport.scale || 1;
  const pageLeft = page.wrapper.offsetLeft;
  const pageTop = page.wrapper.offsetTop;
  const pageW = page.wrapper.offsetWidth || PAGE_WIDTH;
  const pageH = page.wrapper.offsetHeight || PAGE_HEIGHT;

  // Centra orizzontalmente tenendo conto di zoom e padding di #canvasContainer
  const targetX = vp.clientWidth / 2 - (pageLeft + pageW / 2) * scale;

  // Se la pagina entra interamente in altezza, centrala; altrimenti mostra la cima (+20px)
  const scaledH = pageH * scale;
  const targetY = scaledH <= vp.clientHeight
    ? vp.clientHeight / 2 - (pageTop + pageH / 2) * scale
    : -pageTop * scale + 20;

  viewport.x = targetX;
  viewport.y = targetY;
  const c = clampViewport(viewport.x, viewport.y);
  viewport.x = c.x;
  viewport.y = c.y;

  const pageChanged = state.activePageIndex !== index;
  if (state.selectedStrokes.length > 0 && pageChanged) {
    clearSelection();
  }

  state.activePageIndex = index;
  refreshPageCounter();
  if (pageChanged) resetHistory();
  applyTransform(true);
  pagePool.updateAround(index);
  scheduleSave({ markDirty: false, silent: true });

  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index, pageId: page.pageId }
  }));
}

// ============================================================
// RESTORE DA HISTORY
// ============================================================

function restorePageFromSnapshot(snap) {
  if (!snap) return;
  let page = snap.pageId
    ? state.pages.find(p => p.pageId === snap.pageId)
    : null;
  if (!page && typeof snap.pageIndex === 'number') {
    page = state.pages[snap.pageIndex] || null;
  }
  if (!page) return;

  page.strokes = unpackStrokes(snap.strokes || []);
  markPageDirty(page.pageId);

  if (page.canvas) {
    redrawPageCanvas(page);
    if (page.index === state.activePageIndex && state.selectedStrokes.length > 0) {
      redrawSelectionOverlay(page);
    }
  }

  refreshPageCounter();
  invalidateClampCache();
  refreshCanvasResolution(true);
}

on('history:restore', restorePageFromSnapshot);