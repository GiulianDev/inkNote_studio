/**
 * @module features/pages-sidebar/pages-sidebar
 *
 * SIDEBAR PAGINE — thumbnails, riordino via drag (hcg-sortable), eliminazione,
 * scroll nativo touch + drag-scroll con penna (stylus).
 *
 * Identità basata su `pageId` immutabile:
 *   - `_thumbCanvases` e `data-page-id` usano `page.pageId` (non l'indice).
 *   - Dopo un reorder (`inknote:pages-reordered`), aggiorna in place
 *     `data-index` e numeri pagina senza distruggere il DOM né Sortable.
 *   - Rendering thumbnail allineato a `render.js` (pattern, paperColor,
 *     patternColor, Dark Mode via `getEffectiveColor`, tratteggi, pencil
 *     alpha 0.55 ed evidenziatore `baseSize * 4` con multiply/screen).
 *
 * @see features/editor/pages.js — deletePage, movePage, scrollToPage
 * @see features/render/render.js — computeStrokeWidth, _buildLineDash
 * @see core/app-settings.js     — pagesSidebar settings
 */

import './pages-sidebar.css';
import sidebarHtml from './pages-sidebar.html?raw';

import HcgSortable from 'hcg-sortable';
import 'hcg-sortable/hcg-sortable.css';

import { state } from '../../core/state.js';
import {
  showToast, PAGE_WIDTH, PAGE_HEIGHT, on,
  getEffectiveColor, sliderToBaseSize
} from '../../core/utils.js';
import {
  getSettings, updateSettings, onSettingsChanged
} from '../../core/app-settings.js';
import { onToolbarSettingsChanged } from '../toolbar/toolbar-settings.js';
import { computeStrokeWidth, _buildLineDash } from '../render/render.js';
import {
  deletePage, movePage, addNewPage, scrollToPage
} from '../editor/pages.js';

const THUMB_DPR = 2;
const THUMB_CSS_W = 120;
const THUMB_CSS_H = 170;
const THUMB_W = THUMB_CSS_W * THUMB_DPR;
const THUMB_H = THUMB_CSS_H * THUMB_DPR;

const REFRESH_DEBOUNCE_MS = 300;
const PEN_SCROLL_THRESHOLD_PX = 6;

let _mounted = false;
let _isOpen = false;
/** @type {Map<string|number, HTMLCanvasElement>} pageId -> canvas thumb */
const _thumbCanvases = new Map();
/** @type {HcgSortable|null} */
let _sortableInstance = null;
let _redrawAllRaf = null;
let _suppressClickUntil = 0;

// ============================================================
// MOUNT + BOOTSTRAP
// ============================================================

export function mountPagesSidebar() {
  if (_mounted || document.getElementById('pagesSidebar')) {
    _mounted = true;
    return;
  }
  document.body.insertAdjacentHTML('beforeend', sidebarHtml);
  _mounted = true;

  const s = getSettings().pagesSidebar;
  _applyPosition(s.position);
  _updateTabTitle();

  _syncSidebarTop();
  window.addEventListener('resize', _syncSidebarTop);

  _bindUI();

  if (s.open) openPagesSidebar({ silent: true });

  onSettingsChanged(({ changed }) => {
    if (changed.includes('pagesSidebar')) {
      const next = getSettings().pagesSidebar;
      _applyPosition(next.position);
      _updateTabTitle();
      if (next.open !== _isOpen) {
        if (next.open) openPagesSidebar({ silent: true });
        else closePagesSidebar({ silent: true });
      }
    }
    if (_isOpen && (changed.includes('theme') || changed.includes('theme.effective'))) {
      _scheduleRedrawAllThumbs();
    }
  });

  // Colori foglio/pattern o reset toolbar → ridisegna le thumbnail
  onToolbarSettingsChanged(({ changed }) => {
    if (!_isOpen) return;
    if (
      changed.includes('paperColor') ||
      changed.includes('patternColor') ||
      changed.includes('reset') ||
      changed.includes('init')
    ) {
      _scheduleRedrawAllThumbs();
    }
  });

  // Struttura pagine cambiata (add/delete/clear/pattern) → rebuild completo.
  window.addEventListener('inknote:pages-changed', () => {
    if (_isOpen) refreshThumbnails();
  });

  // Riordino (drag): aggiorna solo data-index + numeri in place.
  window.addEventListener('inknote:pages-reordered', () => {
    if (_isOpen) _syncThumbsAfterReorder();
  });

  window.addEventListener('inknote:notebook-opened', () => {
    if (_isOpen) refreshThumbnails();
  });

  window.addEventListener('inknote:notebook-closed', () => {
    _clearThumbnailsDOM();
  });

  window.addEventListener('inknote:active-page-changed', () => {
    if (_isOpen) _highlightActivePage(true);
  });

  on('history:restore', () => {
    queueMicrotask(() => {
      if (_isOpen) refreshThumbnails();
    });
  });

  let _pointerRefreshTimer = null;
  document.addEventListener('pointerup', (e) => {
    if (!_isOpen) return;
    if (e.target && e.target.closest && e.target.closest('#pagesSidebar')) return;

    const wrapper = e.target && e.target.closest ? e.target.closest('.page-wrapper') : null;
    const idxFromTarget = wrapper ? parseInt(wrapper.dataset.index, 10) : NaN;
    const page = Number.isFinite(idxFromTarget)
      ? state.pages[idxFromTarget]
      : state.pages[state.activePageIndex];
    const targetKey = page ? (page.pageId ?? page.index) : null;
    if (targetKey == null) return;

    if (_pointerRefreshTimer) clearTimeout(_pointerRefreshTimer);
    _pointerRefreshTimer = setTimeout(() => {
      _pointerRefreshTimer = null;
      _updateThumbnail(targetKey);
    }, REFRESH_DEBOUNCE_MS);
  }, { passive: true });
}

// ============================================================
// OPEN / CLOSE / TOGGLE
// ============================================================

export function togglePagesSidebar() {
  if (_isOpen) closePagesSidebar();
  else openPagesSidebar();
}

export function openPagesSidebar({ silent = false } = {}) {
  const sidebar = document.getElementById('pagesSidebar');
  if (!sidebar || _isOpen) {
    if (!silent) {
      updateSettings(
        { pagesSidebar: { ...getSettings().pagesSidebar, open: true } },
        { persist: true }
      );
    }
    return;
  }
  sidebar.classList.remove('hidden');
  document.body.classList.add('pages-sidebar-open');
  _isOpen = true;
  _updateTabTitle();
  refreshThumbnails();
  setTimeout(() => _highlightActivePage(true), 80);
  window.dispatchEvent(new Event('resize'));

  if (!silent) {
    updateSettings(
      { pagesSidebar: { ...getSettings().pagesSidebar, open: true } },
      { persist: true }
    );
  }
}

export function closePagesSidebar({ silent = false } = {}) {
  const sidebar = document.getElementById('pagesSidebar');
  if (!sidebar || !_isOpen) {
    if (!silent) {
      updateSettings(
        { pagesSidebar: { ...getSettings().pagesSidebar, open: false } },
        { persist: true }
      );
    }
    return;
  }
  sidebar.classList.add('hidden');
  document.body.classList.remove('pages-sidebar-open');
  _isOpen = false;
  _updateTabTitle();
  window.dispatchEvent(new Event('resize'));

  if (!silent) {
    updateSettings(
      { pagesSidebar: { ...getSettings().pagesSidebar, open: false } },
      { persist: true }
    );
  }
}

// ============================================================
// POSIZIONE + ALTEZZA + TITOLO LINGUETTA
// ============================================================

function _applyPosition(position) {
  const sidebar = document.getElementById('pagesSidebar');
  if (!sidebar) return;
  const pos = position === 'right' ? 'right' : 'left';
  sidebar.dataset.position = pos;

  document.body.classList.toggle('pages-sidebar-left',  pos === 'left');
  document.body.classList.toggle('pages-sidebar-right', pos === 'right');

  window.dispatchEvent(new Event('resize'));
}

function _updateTabTitle() {
  const tab = document.getElementById('pagesSidebarTab');
  if (!tab) return;
  const label = _isOpen ? 'Nascondi pagine' : 'Mostra pagine';
  tab.title = label;
  tab.setAttribute('aria-label', label);
}

function _syncSidebarTop() {
  const header = document.getElementById('mainHeader');
  const sidebar = document.getElementById('pagesSidebar');
  if (!header || !sidebar) return;
  const top = header.getBoundingClientRect().bottom;
  document.documentElement.style.setProperty(
    '--pages-sidebar-header-height', `${top}px`
  );
}

// ============================================================
// BIND UI + SCROLL CON PENNA (STYLUS)
// ============================================================

function _bindUI() {
  document.getElementById('pagesSidebarTab')
    ?.addEventListener('click', togglePagesSidebar);

  document.getElementById('pagesSidebarCloseBtn')
    ?.addEventListener('click', () => closePagesSidebar());

  document.getElementById('pagesSidebarAddBtn')
    ?.addEventListener('click', () => {
      addNewPage();
      setTimeout(() => _highlightActivePage(true), 120);
    });

  _setupThumbDelegation();
  _setupPenScroll();
}

function _resolveThumbIndex(thumb) {
  if (!thumb) return -1;
  const pageId = thumb.dataset.pageId;
  if (pageId) {
    const byId = state.pages.findIndex(p => p.pageId === pageId);
    if (byId !== -1) return byId;
  }
  const idx = parseInt(thumb.dataset.index, 10);
  return Number.isFinite(idx) ? idx : -1;
}

function _setupThumbDelegation() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  list.addEventListener('click', (e) => {
    if (performance.now() < _suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target.closest('.page-thumb-delete')) return;
    if (e.target.closest('.page-thumb-drag-handle')) return;
    const thumb = e.target.closest('.page-thumb');
    const idx = _resolveThumbIndex(thumb);
    if (idx >= 0) scrollToPage(idx);
  });

  list.addEventListener('click', (e) => {
    if (performance.now() < _suppressClickUntil) return;
    const delBtn = e.target.closest('.page-thumb-delete');
    if (!delBtn) return;
    e.stopPropagation();
    const thumb = delBtn.closest('.page-thumb');
    const idx = _resolveThumbIndex(thumb);
    if (idx < 0) return;

    if (state.pages.length <= 1) {
      showToast('Non puoi eliminare l\'unica pagina', '⚠️');
      return;
    }
    if (!confirm(`Eliminare la pagina ${idx + 1}? L'operazione non è reversibile.`)) return;

    const ok = deletePage(idx);
    if (ok) showToast(`Pagina ${idx + 1} eliminata`, '🗑️');
  });
}

/**
 * Permette lo scroll verticale della lista miniature trascinando con la penna
 * (i browser su tablet gestiscono nativamente solo `touch` con `touch-action: pan-y`,
 * non `pointerType === 'pen'`). Ignora maniglia di drag e pulsante elimina.
 */
function _setupPenScroll() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  let penState = null;
  let inertiaRaf = null;
  let inertiaVy = 0;
  let inertiaLastTime = 0;

  const stopInertia = () => {
    if (inertiaRaf !== null) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = null;
    }
    inertiaVy = 0;
  };

  const stepInertia = (now) => {
    inertiaRaf = null;
    if (!inertiaLastTime) inertiaLastTime = now;
    const dt = Math.min(now - inertiaLastTime, 32);
    inertiaLastTime = now;

    const prevTop = list.scrollTop;
    list.scrollTop = prevTop + inertiaVy * dt;
    inertiaVy *= Math.pow(0.995, dt);

    if (Math.abs(inertiaVy) < 0.03 || list.scrollTop === prevTop) {
      stopInertia();
      return;
    }
    inertiaRaf = requestAnimationFrame(stepInertia);
  };

  list.addEventListener('pointerdown', (e) => {
    stopInertia();
    if (e.pointerType !== 'pen') return;
    if (e.target.closest('.page-thumb-drag-handle, .page-thumb-delete')) return;

    penState = {
      id: e.pointerId,
      startY: e.clientY,
      startScrollTop: list.scrollTop,
      lastY: e.clientY,
      lastTime: performance.now(),
      vy: 0,
      dragging: false
    };
  }, { passive: true });

  list.addEventListener('pointermove', (e) => {
    if (!penState || e.pointerId !== penState.id) return;

    const dy = e.clientY - penState.startY;
    if (!penState.dragging) {
      if (Math.abs(dy) < PEN_SCROLL_THRESHOLD_PX) return;
      penState.dragging = true;
      try { list.setPointerCapture(e.pointerId); } catch {}
    }

    const now = performance.now();
    const dt = now - penState.lastTime;
    if (dt > 0) {
      const instVy = -(e.clientY - penState.lastY) / dt;
      penState.vy = penState.vy * 0.5 + instVy * 0.5;
    }
    penState.lastY = e.clientY;
    penState.lastTime = now;

    list.scrollTop = penState.startScrollTop - dy;
    e.preventDefault();
  }, { passive: false });

  const endPen = (e) => {
    if (!penState || e.pointerId !== penState.id) return;
    const wasDragging = penState.dragging;
    const vy = penState.vy;
    const stale = performance.now() - penState.lastTime > 90;
    try {
      if (list.hasPointerCapture && list.hasPointerCapture(e.pointerId)) {
        list.releasePointerCapture(e.pointerId);
      }
    } catch {}
    penState = null;

    if (wasDragging) {
      _suppressClickUntil = performance.now() + 180;
      if (!stale && Math.abs(vy) > 0.12) {
        inertiaVy = vy;
        inertiaLastTime = 0;
        inertiaRaf = requestAnimationFrame(stepInertia);
      }
    }
  };

  list.addEventListener('pointerup', endPen);
  list.addEventListener('pointercancel', endPen);
  list.addEventListener('wheel', stopInertia, { passive: true });
}

// ============================================================
// SORTABLE (hcg-sortable) — riordino con maniglia
// ============================================================

function _setupSortable() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  if (_sortableInstance) {
    try { _sortableInstance.destroy(); } catch (e) {}
    _sortableInstance = null;
  }

  _sortableInstance = new HcgSortable(list, {
    axis: 'y',
    animation: 180,
    handle: '.page-thumb-drag-handle',
    dragThreshold: 3,
    scroll: true,
    onUpdate(detail) {
      if (detail.oldIndex === detail.newIndex) return;
      movePage(detail.oldIndex, detail.newIndex);
    },
  });
}

// ============================================================
// RENDER THUMBNAILS
// ============================================================

function _clearThumbnailsDOM() {
  if (_sortableInstance) {
    try { _sortableInstance.destroy(); } catch (e) {}
    _sortableInstance = null;
  }
  _thumbCanvases.clear();
  const list = document.getElementById('pagesThumbnailsList');
  if (list) list.innerHTML = '';
}

export function refreshThumbnails() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  _clearThumbnailsDOM();

  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    const thumb = _buildThumbElement(page, i);
    frag.appendChild(thumb);
    const canvas = thumb.querySelector('.page-thumb-canvas');
    const key = page.pageId ?? i;
    _thumbCanvases.set(key, canvas);
    _drawThumbnail(page, canvas);
  });
  list.appendChild(frag);

  _setupSortable();
  _highlightActivePage(true);
}

/**
 * Sync leggero dopo un reorder: aggiorna in place `data-index` e numeri
 * sui thumb già nel DOM. Se l'ordine DOM diverge da `state.pages`,
 * pianifica un rebuild asincrono (mai sincrono dentro onUpdate di Sortable).
 */
function _syncThumbsAfterReorder() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  const thumbs = [...list.querySelectorAll('.page-thumb')];
  let outOfSync = thumbs.length !== state.pages.length;

  _thumbCanvases.clear();
  thumbs.forEach((el, i) => {
    el.dataset.index = String(i);
    const num = el.querySelector('.page-thumb-number');
    if (num) num.textContent = String(i + 1);

    const pageId = el.dataset.pageId;
    const expectedId = state.pages[i]?.pageId;
    if (expectedId && pageId !== expectedId) {
      outOfSync = true;
    }

    const canvas = el.querySelector('.page-thumb-canvas');
    if (canvas) _thumbCanvases.set(pageId || i, canvas);
  });

  if (outOfSync) {
    requestAnimationFrame(() => {
      if (_isOpen) refreshThumbnails();
    });
    return;
  }

  _highlightActivePage(true);
}

function _buildThumbElement(pageData, index) {
  const div = document.createElement('div');
  div.className = 'page-thumb';
  div.dataset.index = String(index);
  if (pageData && pageData.pageId) {
    div.dataset.pageId = pageData.pageId;
  }

  const handle = document.createElement('div');
  handle.className = 'page-thumb-drag-handle';
  handle.title = 'Trascina per riordinare';
  handle.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/>
      <circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>
      <circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>
    </svg>`;
  div.appendChild(handle);

  const preview = document.createElement('div');
  preview.className = 'page-thumb-preview';
  const canvas = document.createElement('canvas');
  canvas.className = 'page-thumb-canvas';
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  preview.appendChild(canvas);

  const footer = document.createElement('div');
  footer.className = 'page-thumb-footer';
  const num = document.createElement('span');
  num.className = 'page-thumb-number';
  num.textContent = String(index + 1);
  footer.appendChild(num);

  const del = document.createElement('button');
  del.className = 'page-thumb-delete';
  del.title = 'Elimina pagina';
  del.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>`;

  div.appendChild(preview);
  div.appendChild(footer);
  div.appendChild(del);
  return div;
}

function _updateThumbnail(pageKey) {
  let page = null;
  let canvas = null;

  if (typeof pageKey === 'string') {
    page = state.pages.find(p => p.pageId === pageKey) || null;
    canvas = _thumbCanvases.get(pageKey) || null;
  } else if (typeof pageKey === 'number') {
    page = state.pages[pageKey] || null;
    const key = page ? (page.pageId ?? pageKey) : pageKey;
    canvas = _thumbCanvases.get(key) || _thumbCanvases.get(pageKey) || null;
  }

  if (!page || !canvas) return;
  _drawThumbnail(page, canvas);
}

function _scheduleRedrawAllThumbs() {
  if (_redrawAllRaf !== null) return;
  _redrawAllRaf = requestAnimationFrame(() => {
    _redrawAllRaf = null;
    if (_isOpen) _redrawAllThumbCanvases();
  });
}

function _redrawAllThumbCanvases() {
  state.pages.forEach((page, i) => {
    const canvas = _thumbCanvases.get(page.pageId ?? i) || _thumbCanvases.get(i);
    if (canvas) _drawThumbnail(page, canvas);
  });
}

function _drawThumbnail(pageData, canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const isDark = !!state.isDarkMode;
  const cssW = THUMB_W / THUMB_DPR;
  const cssH = THUMB_H / THUMB_DPR;
  const scaleX = cssW / PAGE_WIDTH;
  const scaleY = cssH / PAGE_HEIGHT;
  const scale = scaleX;

  ctx.setTransform(THUMB_DPR, 0, 0, THUMB_DPR, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.save();
  ctx.scale(scaleX, scaleY);

  // 1. Sfondo carta e pattern (allineato a render.js::getBackgroundCanvas)
  const bgFill    = state.paperColor   || (isDark ? '#1E293B' : '#FFFFFF');
  const lineColor = state.patternColor || (isDark ? '#334155' : '#E2E8F0');
  const dotColor  = state.patternColor || (isDark ? '#475569' : '#94A3B8');

  ctx.fillStyle = bgFill;
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

  const pattern = state.bgPattern || 'ruled';
  if (pattern === 'ruled') {
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(1, 0.55 / scale);
    ctx.beginPath();
    for (let y = 60; y < PAGE_HEIGHT; y += 32) {
      ctx.moveTo(0, y);
      ctx.lineTo(PAGE_WIDTH, y);
    }
    ctx.stroke();
  } else if (pattern === 'grid') {
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(1, 0.55 / scale);
    ctx.beginPath();
    for (let x = 0; x < PAGE_WIDTH; x += 25) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, PAGE_HEIGHT);
    }
    for (let y = 0; y < PAGE_HEIGHT; y += 25) {
      ctx.moveTo(0, y);
      ctx.lineTo(PAGE_WIDTH, y);
    }
    ctx.stroke();
  } else if (pattern === 'dots') {
    ctx.fillStyle = dotColor;
    const r = Math.max(1.2, 0.48 / scale);
    ctx.beginPath();
    for (let x = 20; x < PAGE_WIDTH; x += 20) {
      for (let y = 20; y < PAGE_HEIGHT; y += 24) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  // 2. Tratti (strokes)
  if (pageData.strokes && pageData.strokes.length > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of pageData.strokes) {
      if (!stroke || !stroke.points || stroke.points.length === 0) continue;

      const tool = stroke.tool || 'pen';
      const baseOpacity = stroke.opacity != null ? stroke.opacity : 1.0;
      const baseSize = sliderToBaseSize(stroke.size);

      let color;
      let alpha = baseOpacity;
      let gco = 'source-over';
      let lineWidth;

      if (tool === 'highlighter') {
        color = stroke.color || '#FFEB3B';
        gco = isDark ? 'screen' : 'multiply';
        lineWidth = Math.max(1.2 / scale, baseSize * 4.0);
      } else {
        color = getEffectiveColor(stroke.color || '#000000', isDark);
        if (tool === 'pencil') alpha *= 0.55;
        const realW = computeStrokeWidth(tool, stroke.size, 0.5, 0, 0, 1.0, baseSize);
        lineWidth = Math.max(0.55 / scale, realW);
      }

      ctx.save();
      ctx.globalCompositeOperation = gco;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineWidth;

      if (tool !== 'highlighter') {
        const lineDash = _buildLineDash(stroke.style, Math.max(baseSize, lineWidth * 0.8));
        if (lineDash) {
          ctx.setLineDash(lineDash);
          ctx.lineDashOffset = 0;
        }
      }

      const pts = stroke.points;
      if (pts.length === 1) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  ctx.restore();
}

// ============================================================
// HIGHLIGHT + SCROLL TO ACTIVE
// ============================================================

function _highlightActivePage(scrollIntoView) {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;
  const activeIndex = state.activePageIndex;
  const activePageId = state.pages[activeIndex]?.pageId;

  let activeEl = null;
  list.querySelectorAll('.page-thumb').forEach((el) => {
    const isMatch = activePageId
      ? el.dataset.pageId === activePageId
      : parseInt(el.dataset.index, 10) === activeIndex;
    el.classList.toggle('active', isMatch);
    if (isMatch) activeEl = el;
  });

  if (scrollIntoView && activeEl) {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}