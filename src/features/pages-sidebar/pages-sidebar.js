/**
 * @module features/pages-sidebar/pages-sidebar
 *
 * SIDEBAR PAGINE — thumbnails, riordino via drag, eliminazione.
 *
 * Comportamento:
 *   - La sidebar si apre/chiude tramite la linguetta laterale
 *     (#pagesSidebarTab) o dal pulsante X interno.
 *   - La linguetta resta sempre visibile (tranne in compact mode)
 *     e si sposta col bordo della sidebar quando questa è aperta.
 *   - Posizione left/right da settings (app-settings.pagesSidebar.position)
 *   - Aperta/chiusa persiste in settings (pagesSidebar.open)
 *   - Thumbnails: canvas 240×340 fisici (120×170 CSS @ 2x)
 *   - Render: stroke semplificati (no pressure), pattern non disegnato
 *   - Refresh:
 *       - Full rebuild su pages-changed / notebook-opened / theme change
 *       - Per-pagina (debounced) su pointerup del canvas
 *   - Sync: highlight pagina attiva + scroll into view
 *
 * @see features/editor/pages.js — deletePage, movePage, scrollToPage
 * @see core/app-settings.js     — pagesSidebar settings
 */

import './pages-sidebar.css';
import sidebarHtml from './pages-sidebar.html?raw';

import { state } from '../../core/state.js';
import { showToast, PAGE_WIDTH, PAGE_HEIGHT, on } from '../../core/utils.js';
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
/** @type {Map<number, HTMLCanvasElement>} pageIndex -> canvas thumb */
const _thumbCanvases = new Map();

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

  // Applica subito la posizione (prima di open) per evitare flash.
  const s = getSettings().pagesSidebar;
  _applyPosition(s.position);
  _updateTabTitle();

  // Allinea top: header height (misurata).
  _syncSidebarTop();
  window.addEventListener('resize', _syncSidebarTop);

  _bindUI();

  if (s.open) openPagesSidebar({ silent: true });

  // Reagisce a cambi impostazioni (posizione, apertura).
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

  // Refresh completo quando cambiano le pagine.
  window.addEventListener('inknote:pages-changed', () => {
    if (_isOpen) refreshThumbnails();
  });

  // Refresh completo quando si apre un quaderno.
  window.addEventListener('inknote:notebook-opened', () => {
    if (_isOpen) refreshThumbnails();
  });

  // Highlight pagina attiva.
  window.addEventListener('inknote:active-page-changed', () => {
    if (_isOpen) _highlightActivePage(true);
  });

  // History restore (undo/redo) → ricostruisce DOM pagine.
  on('history:restore', () => {
    if (_isOpen) refreshThumbnails();
  });

  // Tema cambiato → ridisegna thumbnails (sfondo + colori).
  onSettingsChanged(({ changed }) => {
    if (!_isOpen) return;
    if (changed.includes('theme') || changed.includes('theme.effective')) {
      _redrawAllThumbCanvases();
    }
  });

  // Aggiorna la thumb della pagina attiva dopo ogni interazione
  // (draw, erase, lasso delete, …). Debounced.
  let _pointerRefreshTimer = null;
  document.addEventListener('pointerup', () => {
    if (!_isOpen) return;
    if (_pointerRefreshTimer) clearTimeout(_pointerRefreshTimer);
    _pointerRefreshTimer = setTimeout(() => {
      _pointerRefreshTimer = null;
      _updateThumbnail(state.activePageIndex);
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

/**
 * Aggiorna il title/aria-label della linguetta in base allo stato.
 * L'icona è gestita via CSS (body classi + stato), qui cambia solo
 * il testo accessibile per hover e screen reader.
 */
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
// BIND UI
// ============================================================

function _bindUI() {
  // Linguetta laterale: toggle open/close
  document.getElementById('pagesSidebarTab')
    ?.addEventListener('click', togglePagesSidebar);

  // Bottone X nella sidebar
  document.getElementById('pagesSidebarCloseBtn')
    ?.addEventListener('click', () => closePagesSidebar());

  // Bottone + nella sidebar (aggiunge pagina)
  document.getElementById('pagesSidebarAddBtn')
    ?.addEventListener('click', () => {
      addNewPage();
      setTimeout(() => _highlightActivePage(true), 120);
    });

  _setupThumbDelegation();
  _setupDragReorder();
}

function _setupThumbDelegation() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  list.addEventListener('click', (e) => {
    if (e.target.closest('.page-thumb-delete')) return;
    const thumb = e.target.closest('.page-thumb');
    if (!thumb) return;
    const idx = parseInt(thumb.dataset.index);
    if (Number.isFinite(idx)) scrollToPage(idx);
  });

  list.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.page-thumb-delete');
    if (!delBtn) return;
    e.stopPropagation();
    const thumb = delBtn.closest('.page-thumb');
    if (!thumb) return;
    const idx = parseInt(thumb.dataset.index);
    if (!Number.isFinite(idx)) return;

    if (state.pages.length <= 1) {
      showToast('Non puoi eliminare l\'unica pagina', '⚠️');
      return;
    }
    if (!confirm(`Eliminare la pagina ${idx + 1}? L'operazione non è reversibile.`)) return;

    const ok = deletePage(idx);
    if (ok) showToast(`Pagina ${idx + 1} eliminata`, '🗑️');
  });
}

// ============================================================
// RENDER THUMBNAILS
// ============================================================

export function refreshThumbnails() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  _thumbCanvases.clear();
  list.innerHTML = '';

  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    const thumb = _buildThumbElement(i);
    frag.appendChild(thumb);
    const canvas = thumb.querySelector('.page-thumb-canvas');
    _thumbCanvases.set(i, canvas);
    _drawThumbnail(page, canvas);
  });
  list.appendChild(frag);

  _highlightActivePage(true);
}

function _buildThumbElement(index) {
  const div = document.createElement('div');
  div.className = 'page-thumb';
  div.dataset.index = String(index);

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

function _updateThumbnail(pageIndex) {
  const page = state.pages[pageIndex];
  const canvas = _thumbCanvases.get(pageIndex);
  if (!page || !canvas) return;
  _drawThumbnail(page, canvas);
}

function _redrawAllThumbCanvases() {
  state.pages.forEach((page, i) => {
    const canvas = _thumbCanvases.get(i);
    if (canvas) _drawThumbnail(page, canvas);
  });
}

/**
 * Disegno semplificato dello stroke (senza pressure/tilt).
 * Sufficiente per una thumbnail di 120×170 CSS.
 */
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

// ============================================================
// HIGHLIGHT + SCROLL TO ACTIVE
// ============================================================

function _highlightActivePage(scrollIntoView) {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;
  const activeIndex = state.activePageIndex;

  list.querySelectorAll('.page-thumb').forEach((el) => {
    const idx = parseInt(el.dataset.index);
    el.classList.toggle('active', idx === activeIndex);
  });

  if (!scrollIntoView) return;
  const activeEl = list.querySelector(`.page-thumb[data-index="${activeIndex}"]`);
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ============================================================
// DRAG REORDER
// ============================================================

function _setupDragReorder() {
  const list = document.getElementById('pagesThumbnailsList');
  if (!list) return;

  let dragState = null;

  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.page-thumb-delete')) return;

    const thumb = e.target.closest('.page-thumb');
    if (!thumb) return;

    dragState = {
      thumb,
      startIndex: parseInt(thumb.dataset.index),
      startY: e.clientY,
      dragging: false,
      pointerId: e.pointerId
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });

  function onMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    const dy = e.clientY - dragState.startY;
    if (!dragState.dragging) {
      if (Math.abs(dy) < 8) return;
      dragState.dragging = true;
      dragState.thumb.classList.add('dragging');
    }

    e.preventDefault();

    const thumbs = [...list.querySelectorAll('.page-thumb')];
    const currentIdx = thumbs.indexOf(dragState.thumb);
    if (currentIdx < 0) return;

    // Trova la posizione di drop in base al centro verticale.
    let targetIdx = currentIdx;
    for (let i = 0; i < thumbs.length; i++) {
      if (i === currentIdx) continue;
      const rect = thumbs[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) { targetIdx = i; break; }
      targetIdx = i;
    }
    if (targetIdx === currentIdx) return;

    // Riordina in DOM.
    if (targetIdx < currentIdx) {
      list.insertBefore(dragState.thumb, thumbs[targetIdx]);
    } else {
      list.insertBefore(dragState.thumb, thumbs[targetIdx].nextSibling);
    }
  }

  function onUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const st = dragState;
    dragState = null;

    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);

    st.thumb.classList.remove('dragging');
    if (!st.dragging) return;

    const finalIndex = [...list.querySelectorAll('.page-thumb')]
      .indexOf(st.thumb);
    if (finalIndex < 0 || finalIndex === st.startIndex) return;

    movePage(st.startIndex, finalIndex);
  }
}