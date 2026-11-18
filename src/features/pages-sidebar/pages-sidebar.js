/**
 * @module features/pages-sidebar/pages-sidebar
 *
 * SIDEBAR PAGINE — thumbnails ancorate a `pageId`, riordino via drag,
 * eliminazione e riallineamento garantito su `state.pages`.
 */

import './pages-sidebar.css';
import sidebarHtml from './pages-sidebar.html?raw';

import HcgSortable from 'hcg-sortable';
import 'hcg-sortable/hcg-sortable.css';

import { state } from '../../core/state.js';
import { showToast, PAGE_WIDTH, on } from '../../core/utils.js';
import {
  getSettings, updateSettings, onSettingsChanged
} from '../../core/app-settings.js';
import {
  deletePage, movePage, addNewPage, scrollToPage
} from '../editor/pages.js';

const THUMB_DPR = 2;
const THUMB_CSS_W = 120;
const THUMB_CSS_H = 170;
const THUMB_W = THUMB_CSS_W * THUMB_DPR;
const THUMB_H = THUMB_CSS_H * THUMB_DPR;

const REFRESH_DEBOUNCE_MS = 300;

let _mounted = false;
let _isOpen = false;
/** @type {Map<string, HTMLCanvasElement>} pageId -> canvas thumb */
const _thumbCanvases = new Map();
/** @type {HcgSortable|null} */
let _sortableInstance = null;

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
    if (!changed.includes('pagesSidebar')) return;
    const next = getSettings().pagesSidebar;
    _applyPosition(next.position);
    _updateTabTitle();
    if (next.open !== _isOpen) {
      if (next.open) openPagesSidebar({ silent: true });
      else closePagesSidebar({ silent: true });
    }
  });

  window.addEventListener('inknote:pages-changed', () => {
    if (_isOpen) refreshThumbnails();
  });

  window.addEventListener('inknote:pages-reordered', () => {
    if (_isOpen) _syncThumbsAfterReorder();
  });

  window.addEventListener('inknote:notebook-opened', () => {
    if (_isOpen) refreshThumbnails();
  });

  window.addEventListener('inknote:notebook-closed', () => {
    _clearThumbnails();
  });

  window.addEventListener('inknote:active-page-changed', () => {
    if (_isOpen) _highlightActivePage(true);
  });

  on('history:restore', () => {
    if (_isOpen) refreshThumbnails();
  });

  onSettingsChanged(({ changed }) => {
    if (!_isOpen) return;
    if (changed.includes('theme') || changed.includes('theme.effective')) {
      _redrawAllThumbCanvases();
    }
  });

  let _pointerRefreshTimer = null;
  document.addEventListener('pointerup', () => {
    if (!_isOpen) return;
    if (_pointerRefreshTimer) clearTimeout(_pointerRefreshTimer);
    _pointerRefreshTimer = setTimeout(() => {
      _pointerRefreshTimer = null;
      _updateThumbnail(state.pages[state.activePageIndex]);
    }, REFRESH_DEBOUNCE_MS);
  }, { passive: true });
}

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
}

function _resolvePageIndexFromThumb(thumb) {
  const pid = thumb?.dataset?.pageId;
  if (pid) {
    const idx = state.pages.findIndex(p => p && p.pageId === pid);
    if (idx !== -1) return idx;
  }
  const parsed = parseInt(thumb?.dataset?.index);
  return Number.isFinite(parsed) ? parsed : -1;
}

function _setupThumbDelegation() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  list.addEventListener('click', (e) => {
    if (e.target.closest('.page-thumb-delete')) return;
    if (e.target.closest('.page-thumb-drag-handle')) return;
    const thumb = e.target.closest('.page-thumb');
    if (!thumb) return;
    const idx = _resolvePageIndexFromThumb(thumb);
    if (idx >= 0) scrollToPage(idx);
  });

  list.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.page-thumb-delete');
    if (!delBtn) return;
    e.stopPropagation();
    const thumb = delBtn.closest('.page-thumb');
    if (!thumb) return;
    const idx = _resolvePageIndexFromThumb(thumb);
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

function _clearThumbnails() {
  const list = document.getElementById('pagesThumbnailsList');
  if (_sortableInstance) {
    try { _sortableInstance.destroy(); } catch (e) {}
    _sortableInstance = null;
  }
  _thumbCanvases.clear();
  if (list) list.innerHTML = '';
}

export function refreshThumbnails() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  _clearThumbnails();

  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    const thumb = _buildThumbElement(i, page.pageId);
    frag.appendChild(thumb);
    const canvas = thumb.querySelector('.page-thumb-canvas');
    if (page.pageId) _thumbCanvases.set(page.pageId, canvas);
    _drawThumbnail(page, canvas);
  });
  list.appendChild(frag);

  _setupSortable();
  _highlightActivePage(true);
}

function _syncThumbsAfterReorder() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  const indexById = new Map();
  state.pages.forEach((p, i) => {
    if (p && p.pageId) indexById.set(p.pageId, i);
  });

  const thumbs = [...list.querySelectorAll('.page-thumb')];
  let orderMatches = thumbs.length === state.pages.length;

  _thumbCanvases.clear();
  thumbs.forEach((el, domIdx) => {
    const pid = el.dataset.pageId;
    const realIdx = pid && indexById.has(pid) ? indexById.get(pid) : domIdx;
    if (!pid || realIdx !== domIdx) orderMatches = false;

    el.dataset.index = String(realIdx);
    const num = el.querySelector('.page-thumb-number');
    if (num) num.textContent = String(realIdx + 1);

    const canvas = el.querySelector('.page-thumb-canvas');
    if (pid && canvas) _thumbCanvases.set(pid, canvas);
  });

  _highlightActivePage(true);

  if (!orderMatches) {
    requestAnimationFrame(() => {
      if (_isOpen) refreshThumbnails();
    });
  }
}

function _buildThumbElement(index, pageId) {
  const div = document.createElement('div');
  div.className = 'page-thumb';
  div.dataset.index = String(index);
  if (pageId) div.dataset.pageId = pageId;

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

function _updateThumbnail(page) {
  if (!page || !page.pageId) return;
  const canvas = _thumbCanvases.get(page.pageId);
  if (!canvas) return;
  _drawThumbnail(page, canvas);
}

function _redrawAllThumbCanvases() {
  state.pages.forEach((page) => {
    const canvas = page && page.pageId ? _thumbCanvases.get(page.pageId) : null;
    if (canvas) _drawThumbnail(page, canvas);
  });
}

function _drawThumbnail(pageData, canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cssW = THUMB_W / THUMB_DPR;
  const cssH = THUMB_H / THUMB_DPR;
  const scale = cssW / PAGE_WIDTH;

  ctx.setTransform(THUMB_DPR, 0, 0, THUMB_DPR, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.fillStyle = state.isDarkMode ? '#1e293b' : '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  if (!pageData.strokes || pageData.strokes.length === 0) return;

  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of pageData.strokes) {
    if (!stroke || !stroke.points || stroke.points.length === 0) continue;

    const color = stroke.color || '#000000';
    const alpha = stroke.opacity != null ? stroke.opacity : 1.0;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.5 / scale, (stroke.size || 3) * 0.6);

    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      const r = ctx.lineWidth / 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function _highlightActivePage(scrollIntoView) {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;
  const activePage = state.pages[state.activePageIndex];
  const activePageId = activePage ? activePage.pageId : null;

  list.querySelectorAll('.page-thumb').forEach((el) => {
    const isMatch = activePageId
      ? el.dataset.pageId === activePageId
      : parseInt(el.dataset.index) === state.activePageIndex;
    el.classList.toggle('active', isMatch);
  });

  if (!scrollIntoView) return;
  const escapedId = activePageId && typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(activePageId)
    : activePageId;
  const selector = activePageId
    ? `.page-thumb[data-page-id="${escapedId}"]`
    : `.page-thumb[data-index="${state.activePageIndex}"]`;
  const activeEl = list.querySelector(selector);
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}