/**
 * @module features/editor/pages
 *
 * PAGINE — creazione wrapper DOM, gestione canvas via pool, pagina attiva,
 * eliminazione/riordino/scroll.
 *
 * @see features/editor/page-pool.js
 * @see features/persistence/serialization.js
 * @see features/pages-sidebar/pages-sidebar.js — consuma gli eventi
 *      `inknote:pages-changed` e `inknote:active-page-changed`
 */

import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, showToast, on } from '../../core/utils.js';
import { redrawPageCanvas, redrawSelectionOverlay } from '../render/render.js';
import { attachPointerListeners } from '../tools/dispatcher.js';
import { pushHistory, resetHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
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

// ============================================================
// CREAZIONE PAGINA
// ============================================================

export function createNewPageDOM(pageIndex, initialStrokes = []) {
  const container = document.getElementById('canvasContainer');
  const pageWrapper = document.createElement('div');
  pageWrapper.className = 'page-wrapper';
  pageWrapper.dataset.index = pageIndex;

  container.appendChild(pageWrapper);

  const strokes = unpackStrokes(initialStrokes);

  const pageData = {
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

  // Notifica la sidebar pagine (per refresh thumbnails + scroll)
  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index: newIndex }
  }));
}

// ============================================================
// VIEWPORT (centratura, zoom, resize observer)
// ============================================================

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
    pagePool.updateAround(state.activePageIndex);
    // Salva solo il metadata (lastPageIndex) — niente dirty page,
    // niente badge "Salvataggio...". Debounce 500ms.
    scheduleSave({ markDirty: false, silent: true });

    // Notifica la sidebar pagine (highlight)
    window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
      detail: { index: page.index }
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
  scheduleSave();
  state.pages.forEach(p => {
    if (p.canvas) redrawPageCanvas(p);
  });
  pushHistory();

  // Notifica la sidebar (le thumbnails andrebbero ridisegnate
  // se in futuro includeranno il pattern; oggi è comunque
  // corretto emettere per coerenza).
  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
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

  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
}

// ============================================================
// ELIMINA / RIORDINA / SCROLL-TO-PAGE
// ============================================================

/**
 * Elimina la pagina all'indice `index`.
 * Non elimina l'ultima pagina. Reset della history perché
 * gli snapshot sono per-index e diventerebbero invalidi.
 * @param {number} index
 * @returns {boolean} true se eliminata
 */
export function deletePage(index) {
  if (state.pages.length <= 1) return false;
  if (index < 0 || index >= state.pages.length) return false;

  const page = state.pages[index];
  if (!page) return false;

  // 1. Pool reset PRIMA di modificare state.pages:
  //    pagePool._releaseSlot usa state.pages[slot.pageIndex] e
  //    gli indici sono ancora coerenti.
  pagePool.reset();

  // 2. Se la pagina attiva è quella eliminata, libera la selezione.
  if (state.activePageIndex === index) {
    clearSelection();
  }

  // 3. Rimuovi wrapper DOM e slice state.pages.
  page.wrapper.remove();
  state.pages.splice(index, 1);

  // 4. Reindex + aggiorna dataset (ordine DOM invariato per i superstiti).
  state.pages.forEach((p, i) => {
    p.index = i;
    p.wrapper.dataset.index = String(i);
  });

  // 5. Aggiusta activePageIndex.
  if (state.activePageIndex >= state.pages.length) {
    state.activePageIndex = state.pages.length - 1;
  } else if (state.activePageIndex > index) {
    state.activePageIndex--;
  }

  // 6. Refresh + save.
  refreshPageCounter();
  pagePool.updateAround(state.activePageIndex);
  invalidateClampCache();
  resetHistory();
  scheduleSave();

  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index: state.activePageIndex }
  }));

  return true;
}

/**
 * Sposta la pagina da `from` a `to`.
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
export function movePage(from, to) {
  if (from === to) return false;
  if (from < 0 || from >= state.pages.length) return false;
  if (to < 0 || to >= state.pages.length) return false;

  const container = document.getElementById('canvasContainer');

  // 1. Pool reset PRIMA (indici coerenti con state.pages).
  pagePool.reset();

  // 2. Riordina state.pages.
  const [moved] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, moved);

  // 3. Reindex + riordina DOM wrappers.
  state.pages.forEach((p, i) => {
    p.index = i;
    p.wrapper.dataset.index = String(i);
    container.appendChild(p.wrapper); // appendChild sposta (idempotente se già ultimo)
  });

  // 4. Aggiusta activePageIndex.
  if (state.activePageIndex === from) {
    state.activePageIndex = to;
  } else if (from < state.activePageIndex && to >= state.activePageIndex) {
    state.activePageIndex--;
  } else if (from > state.activePageIndex && to <= state.activePageIndex) {
    state.activePageIndex++;
  }

  refreshPageCounter();
  pagePool.updateAround(state.activePageIndex);
  invalidateClampCache();
  resetHistory();
  scheduleSave();

  window.dispatchEvent(new CustomEvent('inknote:pages-changed'));
  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index: state.activePageIndex }
  }));

  return true;
}

/**
 * Porta la pagina `index` in cima al viewport e la rende attiva.
 * @param {number} index
 */
export function scrollToPage(index) {
  const page = state.pages[index];
  if (!page) return;
  const vp = document.getElementById('viewport');
  if (!vp) return;

  const targetY = -page.wrapper.offsetTop * viewport.scale + 20;
  viewport.x = (vp.clientWidth - PAGE_WIDTH) / 2;
  viewport.y = targetY;
  const c = clampViewport(viewport.x, viewport.y);
  viewport.x = c.x;
  viewport.y = c.y;
  applyTransform(true);

  state.activePageIndex = index;
  refreshPageCounter();
  pagePool.updateAround(index);
  scheduleSave({ markDirty: false, silent: true });

  window.dispatchEvent(new CustomEvent('inknote:active-page-changed', {
    detail: { index }
  }));
}

// ============================================================
// RESTORE DA HISTORY
// ============================================================

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