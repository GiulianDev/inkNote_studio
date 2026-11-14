/**
 * @module features/editor/page-pool
 *
 * POOL DI SLOT DI RENDERING — virtualizzazione dei canvas.
 *
 * @see features/editor/pages.js — refreshCanvasResolution chiama update
 * @see features/tools/dispatcher.js — forceAssign su pointerdown orfano
 */

import { state } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT } from '../../core/utils.js';
import { redrawPageCanvas, redrawSelectionOverlay } from '../render/render.js';

const POOL_SIZE = 5;
const POOL_RADIUS = 2;
const MAX_RENDER_DPR = 4;
const MAX_ZOOM_DPR_BOOST = 1.3;
const BASE_OVERLAY_DPR = Math.min(window.devicePixelRatio || 1, 1.5);

class PageSlot {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'page-canvas';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'overlay-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.pageIndex = -1;
    this.wrapper = null;
    this.dpr = 0;
    this.overlayDpr = 0;
  }
}

class PageRendererPool {
  constructor() {
    this.slots = Array.from({ length: POOL_SIZE }, () => new PageSlot());
    this._lru = this.slots.slice();
  }

  /**
   * Pulisce esplicitamente i canvas dello slot (main + overlay)
   * e resetta lo stile CSS dell'overlay. Chiamato da reset() e
   * _releaseSlot(): senza, il contenuto precedente resta visibile
   * quando lo slot viene riassegnato a una pagina diversa.
   */
  _clearSlotCanvas(slot) {
    try {
      slot.ctx.save();
      slot.ctx.setTransform(1, 0, 0, 1, 0, 0);
      slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
      slot.ctx.restore();
    } catch (e) {}
    try {
      slot.overlayCtx.save();
      slot.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      slot.overlayCtx.clearRect(0, 0, slot.overlayCanvas.width, slot.overlayCanvas.height);
      slot.overlayCtx.restore();
    } catch (e) {}
    if (slot.overlayCanvas) {
      slot.overlayCanvas.style.opacity = '';
      slot.overlayCanvas.style.mixBlendMode = '';
    }
  }

  reset() {
    for (const slot of this.slots) {
      this._clearSlotCanvas(slot);
      if (slot.wrapper) {
        try { slot.wrapper.removeChild(slot.canvas); } catch (e) {}
        try { slot.wrapper.removeChild(slot.overlayCanvas); } catch (e) {}
      }
      const page = slot.pageIndex >= 0 ? state.pages[slot.pageIndex] : null;
      if (page) {
        page.canvas = null;
        page.ctx = null;
        page.overlayCanvas = null;
        page.overlayCtx = null;
        page.dpr = 0;
        page.overlayDpr = 0;
      }
      slot.pageIndex = -1;
      slot.wrapper = null;
      slot.dpr = 0;
      slot.overlayDpr = 0;
    }
    this._lru = this.slots.slice();
  }

  _slotFor(pageIndex) {
    for (const slot of this.slots) if (slot.pageIndex === pageIndex) return slot;
    return null;
  }

  _evictTarget() {
    const active = state.activePageIndex;
    let victim = null;
    let maxDist = -1;
    for (const slot of this.slots) {
      if (slot.pageIndex < 0) return slot;
      const dist = Math.abs(slot.pageIndex - active);
      if (dist > maxDist) { maxDist = dist; victim = slot; }
    }
    return victim;
  }

  _releaseSlot(slot) {
    if (slot.pageIndex >= 0) {
      const page = state.pages[slot.pageIndex];
      if (page) {
        page.canvas = null;
        page.ctx = null;
        page.overlayCanvas = null;
        page.overlayCtx = null;
        page.dpr = 0;
        page.overlayDpr = 0;
      }
    }
    if (slot.wrapper) {
      try { slot.wrapper.removeChild(slot.canvas); } catch (e) {}
      try { slot.wrapper.removeChild(slot.overlayCanvas); } catch (e) {}
    }
    this._clearSlotCanvas(slot);
    slot.pageIndex = -1;
    slot.wrapper = null;
    slot.dpr = 0;
    slot.overlayDpr = 0;
  }

  _assignSlot(slot, pageIndex) {
    const page = state.pages[pageIndex];
    if (!page) return false;
    this._releaseSlot(slot);
    slot.pageIndex = pageIndex;
    slot.wrapper = page.wrapper;
    page.wrapper.appendChild(slot.canvas);
    page.wrapper.appendChild(slot.overlayCanvas);

    page.canvas = slot.canvas;
    page.ctx = slot.ctx;
    page.overlayCanvas = slot.overlayCanvas;
    page.overlayCtx = slot.overlayCtx;
    page.dpr = 0;
    page.overlayDpr = 0;

    _resizeSlot(slot, page);
    return true;
  }

  updateAround(activeIndex, force = false) {
    if (state.pages.length === 0) return;
    const lo = Math.max(0, activeIndex - POOL_RADIUS);
    const hi = Math.min(state.pages.length - 1, activeIndex + POOL_RADIUS);

    for (const slot of this.slots) {
      if (slot.pageIndex >= 0 && (slot.pageIndex < lo || slot.pageIndex > hi)) {
        this._releaseSlot(slot);
      }
    }

    for (let i = lo; i <= hi; i++) {
      const existing = this._slotFor(i);
      if (existing) {
        if (force) {
          _resizeSlot(existing, state.pages[i]);
          redrawPageCanvas(state.pages[i]);
          if (i === state.activePageIndex && state.selectedStrokes.length > 0) {
            redrawSelectionOverlay(state.pages[i]);
          }
        }
        continue;
      }
      const slot = this._evictTarget();
      if (slot) this._assignSlot(slot, i);
    }
  }

  forceAssign(pageIndex) {
    const page = state.pages[pageIndex];
    if (!page) return false;
    if (page.canvas) return true;
    const slot = this._evictTarget();
    if (!slot) return false;
    return this._assignSlot(slot, pageIndex);
  }
}

// ------------------------------------------------------------
// Utility locali
// ------------------------------------------------------------

function isPageVisible(page) {
  const vp = document.getElementById('viewport');
  if (!vp || !page.wrapper) return true;
  const vpRect = vp.getBoundingClientRect();
  const pRect = page.wrapper.getBoundingClientRect();
  return !(pRect.right < vpRect.left || pRect.left > vpRect.right ||
           pRect.bottom < vpRect.top || pRect.top > vpRect.bottom);
}

function getTargetDpr(page) {
  const deviceDpr = window.devicePixelRatio || 1;
  const { viewport } = window.__inknoteViewport || {};
  const scale = (viewport && viewport.scale) || 1;
  const zoom = Math.max(1, scale);
  const extra = Math.min(zoom, MAX_ZOOM_DPR_BOOST);
  const highDpr = Math.min(deviceDpr * extra, MAX_RENDER_DPR);
  return isPageVisible(page) ? highDpr : deviceDpr;
}

function _resizeSlot(slot, page) {
  const dpr = getTargetDpr(page);
  const newW = Math.floor(PAGE_WIDTH * dpr);
  const newH = Math.floor(PAGE_HEIGHT * dpr);
  if (slot.canvas.width !== newW || slot.canvas.height !== newH) {
    slot.canvas.width = newW;
    slot.canvas.height = newH;
    slot.ctx = slot.canvas.getContext('2d');
  }
  const oDpr = Math.min(dpr, BASE_OVERLAY_DPR);
  const oW = Math.floor(PAGE_WIDTH * oDpr);
  const oH = Math.floor(PAGE_HEIGHT * oDpr);
  if (slot.overlayCanvas.width !== oW || slot.overlayCanvas.height !== oH) {
    slot.overlayCanvas.width = oW;
    slot.overlayCanvas.height = oH;
    slot.overlayCtx = slot.overlayCanvas.getContext('2d');
  }
  slot.dpr = dpr;
  slot.overlayDpr = oDpr;
  page.dpr = dpr;
  page.overlayDpr = oDpr;
  page.ctx = slot.ctx;
  page.overlayCtx = slot.overlayCtx;
  redrawPageCanvas(page);
  if (page.index === state.activePageIndex && state.selectedStrokes.length > 0) {
    redrawSelectionOverlay(page);
  }
}

export function setViewportRef(viewport) {
  window.__inknoteViewport = { viewport };
}

export const pagePool = new PageRendererPool();