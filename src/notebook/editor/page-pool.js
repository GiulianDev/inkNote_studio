/**
 * @module features/editor/page-pool
 *
 * POOL DI SLOT DI RENDERING — virtualizzazione dei canvas.
 *
 * @see features/editor/pages.js — refreshCanvasResolution chiama update
 * @see features/tools/dispatcher.js — forceAssign su pointerdown orfano
 */

import { state, viewport } from '../../shared/core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT } from '../../shared/core/utils.js';
import { getDeviceProfile } from '../platform/profiles/index.js';
import { redrawPageCanvas, redrawSelectionOverlay } from '../render/render.js';
import { hasLassoSelection } from '../tools/lazo.js';

const POOL_SIZE = 5;
const POOL_RADIUS = 2;
const DEFAULT_MAX_RENDER_DPR = 4;
const DEFAULT_MAX_ZOOM_DPR_BOOST = 1.3;
const IOS_MAX_CANVAS_PIXELS = 13_500_000;

function _getBaseOverlayDpr() {
  const deviceDpr = state.platform.dpr || window.devicePixelRatio || 1;
  const rendering = getDeviceProfile(state.platform?.family).rendering;
  const maxOverlay = rendering.maxOverlayDpr != null
    ? rendering.maxOverlayDpr
    : (state.platform.isIOS ? 2 : 1.5);
  return Math.min(deviceDpr, maxOverlay);
}

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
  }

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

  _assignSlot(slot, pageIndex, opts = {}) {
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

    _resizeSlot(slot, page, null, opts);
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

    const vpRect = _getViewportRect();
    for (let i = lo; i <= hi; i++) {
      const existing = this._slotFor(i);
      if (existing) {
        if (force) {
          _resizeSlot(existing, state.pages[i], vpRect);
        }
        continue;
      }
      const slot = this._evictTarget();
      if (slot) this._assignSlot(slot, i, { vpRect });
    }
  }

  forceAssign(pageIndex, opts = {}) {
    const page = state.pages[pageIndex];
    if (!page) return false;
    if (page.canvas) return true;
    const slot = this._evictTarget();
    if (!slot) return false;
    return this._assignSlot(slot, pageIndex, opts);
  }
}

// ------------------------------------------------------------
// Utility locali
// ------------------------------------------------------------

function _getViewportRect() {
  const vp = document.getElementById('viewport');
  return vp ? vp.getBoundingClientRect() : null;
}

function isPageVisible(page, cachedVpRect = null) {
  if (!page.wrapper) return true;
  const vpRect = cachedVpRect || _getViewportRect();
  if (!vpRect) return true;
  const pRect = page.wrapper.getBoundingClientRect();
  return !(pRect.right < vpRect.left || pRect.left > vpRect.right ||
           pRect.bottom < vpRect.top || pRect.top > vpRect.bottom);
}

function getTargetDpr(page, cachedVpRect = null) {
  const deviceDpr = state.platform.dpr || window.devicePixelRatio || 1;
  const rendering = getDeviceProfile(state.platform?.family).rendering;
  const maxBoost = rendering.maxZoomDprBoost != null ? rendering.maxZoomDprBoost : DEFAULT_MAX_ZOOM_DPR_BOOST;
  const maxRender = rendering.maxRenderDpr != null ? rendering.maxRenderDpr : DEFAULT_MAX_RENDER_DPR;
  const scale = viewport?.scale || 1;
  const zoom = Math.max(1, scale);
  const extra = Math.min(zoom, maxBoost);
  let highDpr = Math.min(deviceDpr * extra, maxRender);
  if (state.platform?.family === 'ios') {
    const safeMaxDpr = Math.sqrt(IOS_MAX_CANVAS_PIXELS / (PAGE_WIDTH * PAGE_HEIGHT));
    highDpr = Math.min(highDpr, safeMaxDpr);
  }
  return isPageVisible(page, cachedVpRect) ? highDpr : deviceDpr;
}

function _resizeSlot(slot, page, cachedVpRect = null, opts = {}) {
  const dpr = getTargetDpr(page, cachedVpRect || opts.vpRect || null);
  const newW = Math.floor(PAGE_WIDTH * dpr);
  const newH = Math.floor(PAGE_HEIGHT * dpr);
  const rendering = getDeviceProfile(state.platform?.family).rendering;
  const maxOverlay = rendering.maxOverlayDpr != null
    ? rendering.maxOverlayDpr
    : (state.platform.isIOS ? 2 : 1.5);
  const oDpr = state.platform?.family === 'ios'
    ? Math.min(dpr, maxOverlay)
    : Math.min(dpr, _getBaseOverlayDpr());
  const oW = Math.floor(PAGE_WIDTH * oDpr);
  const oH = Math.floor(PAGE_HEIGHT * oDpr);

  if (!opts.forceRedraw &&
      slot.dpr === dpr &&
      slot.overlayDpr === oDpr &&
      slot.canvas.width === newW &&
      slot.canvas.height === newH &&
      slot.overlayCanvas.width === oW &&
      slot.overlayCanvas.height === oH &&
      page.ctx === slot.ctx &&
      page.overlayCtx === slot.overlayCtx) {
    return;
  }

  if (slot.canvas.width !== newW || slot.canvas.height !== newH) {
    slot.canvas.width = newW;
    slot.canvas.height = newH;
    slot.ctx = slot.canvas.getContext('2d');
  }
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
  if (opts && opts.skipRedraw) return;
  redrawPageCanvas(page);
  if (page.index === state.activePageIndex && hasLassoSelection()) {
    redrawSelectionOverlay(page);
  }
}

export const pagePool = new PageRendererPool();