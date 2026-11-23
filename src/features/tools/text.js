/**
 * @module features/tools/text
 *
 * TOOL TESTO — caselle di testo da tastiera.
 *
 * Architettura leggera (Surface Go 1):
 *   - A riposo: `pageData.textBoxes[]` renderizzato su canvas insieme agli stroke.
 *   - In modifica: un solo `<textarea>` overlay montato dentro `pageData.wrapper`
 *     (scala e trasla in GPU con #canvasContainer senza calcoli per-frame).
 *   - In drag/resize: la casella attiva viene sollevata sull'overlayCanvas
 *     (zero redraw del mainCanvas ad ogni pointermove).
 *
 * @see features/render/render.js — TEXT_FONTS, layoutTextBox, drawTextBoxSelectionOnOverlay
 */

import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, showToast, getEffectiveColor, isPaperDark } from '../../core/utils.js';
import {
  TEXT_FONTS, TEXT_LINE_HEIGHT_MULT, TEXT_PAD_X, TEXT_PAD_Y,
  redrawPageCanvas, clearOverlay, drawTextBoxSelectionOnOverlay, layoutTextBox
} from '../render/render.js';
import { getCanvasCoords, getCanvasRect } from './tool-shared.js';
import { updateToolbarSettings } from '../toolbar/toolbar-settings.js';
import { pushHistory } from '../history/history.js';
import { scheduleSave } from '../persistence/autosave.js';
import { markPageDirty } from '../persistence/session.js';
import { pagePool } from '../editor/page-pool.js';

const DEFAULT_BOX_WIDTH = 260;
const MIN_BOX_WIDTH = 80;
const DOUBLE_TAP_MS = 380;
const DOUBLE_TAP_DIST_PX = 20;

// --- Stato locale editor singolo ---
let _editorWrap = null;
let _editorTextarea = null;
let _editorActions = null;
let _selectionMenuEl = null;
let _cachedTextMenuW = 0;

function _setCanvasCursor(pageData, cursor) {
  if (!pageData || !pageData.canvas) return;
  if (pageData._lastCursor === cursor) return;
  pageData._lastCursor = cursor;
  pageData.canvas.style.cursor = cursor;
}

// --- Stato drag / resize / doppio-tap ---
let _interactionMode = null; // 'drag' | 'resize-w' | 'resize-e' | null
let _interactionPage = null;
let _interactionBox = null;
let _startPoint = null;
let _origBox = null;
let _hasMoved = false;

let _lastTapTime = 0;
let _lastTapBoxId = null;
let _lastTapPt = null;

// ============================================================
// HELPERS
// ============================================================

function _generateTextBoxId() {
  return `tb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function _notifyTextSelectionChanged() {
  window.dispatchEvent(new CustomEvent('inknote:text-selection-changed'));
}

function _notifyPageContentDirty(pageData) {
  if (!pageData) return;
  markPageDirty(pageData.pageId);
  const key = pageData.pageId ?? pageData.index;
  window.dispatchEvent(new CustomEvent('inknote:page-content-dirty', { detail: { key } }));
}

function _findBoxById(boxId) {
  if (!boxId) return null;
  for (let i = 0; i < state.pages.length; i++) {
    const p = state.pages[i];
    if (!Array.isArray(p.textBoxes)) continue;
    const tb = p.textBoxes.find(item => item && item.id === boxId);
    if (tb) return { pageData: p, textBox: tb };
  }
  return null;
}

function _measureCanvasCtx(pageData) {
  return (pageData && (pageData.ctx || pageData.overlayCtx)) ||
    document.createElement('canvas').getContext('2d');
}

export function getActiveTextBox() {
  const id = state.editingTextBoxId || state.selectedTextBoxId;
  return _findBoxById(id);
}

export function getActiveTextStyle() {
  const found = getActiveTextBox();
  if (found && found.textBox) {
    const tb = found.textBox;
    return {
      fontFamily: tb.fontFamily || 'sans',
      fontSize: tb.fontSize || 18,
      bold: !!tb.bold,
      italic: !!tb.italic,
      align: tb.align || 'left',
      color: tb.color || '#000000'
    };
  }
  return { ...state.textStyle };
}

export function hitTestTextBox(pageData, point) {
  if (!pageData || !Array.isArray(pageData.textBoxes) || pageData.textBoxes.length === 0) {
    return null;
  }
  const ctx = _measureCanvasCtx(pageData);
  // Cerca dall'ultima (sopra) alla prima
  for (let i = pageData.textBoxes.length - 1; i >= 0; i--) {
    const tb = pageData.textBoxes[i];
    if (!tb) continue;
    const layout = layoutTextBox(ctx, tb);
    const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
    const h = tb.height || layout.height;
    if (point.x >= tb.x && point.x <= tb.x + w && point.y >= tb.y && point.y <= tb.y + h) {
      return tb;
    }
  }
  return null;
}

export function hitTestTextBoxHandle(pageData, tb, point) {
  if (!tb) return null;
  const ctx = _measureCanvasCtx(pageData);
  const layout = layoutTextBox(ctx, tb);
  const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
  const h = tb.height || layout.height;
  const scale = viewport.scale || 1;
  const midY = tb.y + h / 2;
  const hitR = 16 / scale;
  const halfH = Math.max(hitR, Math.min(h * 0.45, 22 / scale));
  const edgeOut = 12 / scale;
  const edgeIn = Math.min(8 / scale, w * 0.2);
  const edgePadY = 4 / scale;
  const inYRange = point.y >= tb.y - edgePadY && point.y <= tb.y + h + edgePadY;
  const inHandleY = Math.abs(point.y - midY) <= halfH;

  if ((inHandleY && Math.abs(point.x - tb.x) <= hitR) ||
      (inYRange && point.x >= tb.x - edgeOut && point.x <= tb.x + edgeIn)) {
    return 'resize-w';
  }
  if ((inHandleY && Math.abs(point.x - (tb.x + w)) <= hitR) ||
      (inYRange && point.x >= tb.x + w - edgeIn && point.x <= tb.x + w + edgeOut)) {
    return 'resize-e';
  }
  return null;
}

export function updateCursorForText(e, pageData) {
  if (!pageData || !pageData.canvas) return;
  if (state.activeTool !== 'text') {
    _setCanvasCursor(pageData, 'crosshair');
    return;
  }
  if (state.editingTextBoxId) {
    _setCanvasCursor(pageData, 'text');
    return;
  }

  const rect = getCanvasRect(pageData.canvas);
  const point = {
    x: (e.clientX - rect.left) * (PAGE_WIDTH / rect.width),
    y: (e.clientY - rect.top) * (PAGE_HEIGHT / rect.height)
  };

  if (state.selectedTextBoxId) {
    const sel = (pageData.textBoxes || []).find(b => b && b.id === state.selectedTextBoxId);
    if (sel) {
      const handle = hitTestTextBoxHandle(pageData, sel, point);
      if (handle === 'resize-w' || handle === 'resize-e') {
        _setCanvasCursor(pageData, 'ew-resize');
        return;
      }
      if (hitTestTextBox(pageData, point) === sel) {
        _setCanvasCursor(pageData, 'move');
        return;
      }
    }
  }

  if (hitTestTextBox(pageData, point)) {
    _setCanvasCursor(pageData, 'move');
    return;
  }

  _setCanvasCursor(pageData, 'text');
}

export function canStartTextDragOnTouch(e) {
  if (state.activeTool !== 'text') return false;
  if (e.target && e.target.closest && e.target.closest('.text-box-editor-wrap')) return false;
  if (!state.selectedTextBoxId || state.editingTextBoxId) return false;

  const found = _findBoxById(state.selectedTextBoxId);
  if (!found || !found.pageData || !found.pageData.canvas) return false;

  const point = getCanvasCoords(e, found.pageData.canvas);
  if (hitTestTextBoxHandle(found.pageData, found.textBox, point)) return true;

  const ctx = _measureCanvasCtx(found.pageData);
  const layout = layoutTextBox(ctx, found.textBox);
  const tb = found.textBox;
  const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
  const h = tb.height || layout.height;
  return point.x >= tb.x && point.x <= tb.x + w && point.y >= tb.y && point.y <= tb.y + h;
}

// ============================================================
// FLOATING ACTION MENU (#textSelectionMenu)
// ============================================================

function _ensureSelectionMenu() {
  if (_selectionMenuEl) return _selectionMenuEl;
  const el = document.createElement('div');
  el.id = 'textSelectionMenu';
  el.className = 'text-selection-menu floating-selector-bar fixed hidden z-[25]';
  el.innerHTML = `
    <button type="button" data-action="edit" class="selector-icon-btn primary" title="Modifica testo" aria-label="Modifica testo">
      <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
      <span>Modifica</span>
    </button>
    <div class="selector-bar-divider"></div>
    <button type="button" data-action="delete" class="selector-icon-btn danger" title="Elimina casella" aria-label="Elimina casella">
      <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
    </button>
    <button type="button" data-action="close" class="selector-icon-btn" title="Deseleziona" aria-label="Deseleziona">
      <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  `;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'edit') editSelectedTextBox();
    else if (action === 'delete') deleteSelectedTextBox();
    else if (action === 'close') clearTextBoxSelection();
  });
  document.body.appendChild(el);
  _selectionMenuEl = el;
  return el;
}

function _showSelectionMenu() {
  if (state.editingTextBoxId || !state.selectedTextBoxId) {
    _hideSelectionMenu();
    return;
  }
  const el = _ensureSelectionMenu();
  el.classList.remove('hidden');
  _cachedTextMenuW = el.offsetWidth || 180;
  updateTextSelectionMenuPosition();
}

function _hideSelectionMenu() {
  if (_selectionMenuEl) _selectionMenuEl.classList.add('hidden');
}

export function updateTextSelectionMenuPosition() {
  if (!_selectionMenuEl || _selectionMenuEl.classList.contains('hidden')) return;
  const found = _findBoxById(state.selectedTextBoxId);
  if (!found || !found.pageData || !found.pageData.canvas) {
    _hideSelectionMenu();
    return;
  }
  const tb = found.textBox;
  const rect = getCanvasRect(found.pageData.canvas);
  if (!rect || rect.width <= 0) return;
  const scaleRatio = rect.width / PAGE_WIDTH;
  const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
  const screenX = rect.left + (tb.x + w / 2) * scaleRatio;
  const screenY = rect.top + tb.y * scaleRatio - 48;
  const menuW = _cachedTextMenuW || _selectionMenuEl.offsetWidth || 180;
  if (!_cachedTextMenuW && menuW) _cachedTextMenuW = menuW;
  const x = Math.round(Math.max(12, Math.min(window.innerWidth - menuW - 12, screenX - menuW / 2)));
  const y = Math.round(Math.max(64, screenY));
  _selectionMenuEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

// ============================================================
// SINGLE <textarea> OVERLAY EDITOR
// ============================================================

function _ensureEditorDOM() {
  if (_editorWrap) return;

  const wrap = document.createElement('div');
  wrap.className = 'text-box-editor-wrap';
  wrap.innerHTML = `
    <div class="text-box-editor-actions floating-selector-bar compact">
      <button type="button" class="selector-icon-btn primary" data-action="confirm" title="Conferma (Ctrl+Invio / Esc)" aria-label="Conferma testo">
        <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      </button>
      <button type="button" class="selector-icon-btn danger" data-action="delete" title="Elimina casella" aria-label="Elimina casella">
        <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
      </button>
    </div>
    <textarea class="text-box-editor-input" rows="1" placeholder="Scrivi qui..."></textarea>
  `;

  const textarea = wrap.querySelector('.text-box-editor-input');
  const actions = wrap.querySelector('.text-box-editor-actions');

  wrap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });

  actions.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  actions.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.action === 'confirm') {
      commitActiveTextBox();
    } else if (btn.dataset.action === 'delete') {
      deleteSelectedTextBox();
    }
  });

  textarea.addEventListener('input', () => {
    const found = _findBoxById(state.editingTextBoxId);
    if (!found) return;
    found.textBox.text = textarea.value;
    found.textBox._layoutCache = null;
    _syncTextareaAutoHeight();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      commitActiveTextBox();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      commitActiveTextBox();
    }
  });

  _editorWrap = wrap;
  _editorTextarea = textarea;
  _editorActions = actions;
}

function _clampBoxToPage(tb, measuredHeight = tb?.height) {
  if (!tb) return;
  const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
  const h = Math.max(20, measuredHeight || tb.height || 32);
  tb.x = Math.max(8, Math.min(PAGE_WIDTH - w - 8, tb.x || 0));
  tb.y = Math.max(8, Math.min(PAGE_HEIGHT - h - 8, tb.y || 0));
}

function _syncTextareaAutoHeight() {
  if (!_editorTextarea || !_editorWrap) return;
  const found = _findBoxById(state.editingTextBoxId);
  const fontSize = found?.textBox?.fontSize || 18;
  const minH = Math.ceil(fontSize * TEXT_LINE_HEIGHT_MULT + TEXT_PAD_Y * 2);
  _editorTextarea.style.height = 'auto';
  const nextH = Math.max(minH, _editorTextarea.scrollHeight);
  _editorTextarea.style.height = `${nextH}px`;
  if (found && found.textBox) {
    found.textBox.height = nextH;
    const clampedY = Math.max(8, Math.min(PAGE_HEIGHT - nextH - 8, found.textBox.y || 0));
    if (clampedY !== found.textBox.y) {
      found.textBox.y = clampedY;
      _editorWrap.style.top = `${clampedY}px`;
    }
  }
}

function _syncEditorAppearance(tb) {
  if (!_editorWrap || !_editorTextarea || !tb) return;
  const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
  const fontSize = Math.max(10, Math.min(72, tb.fontSize || 18));
  const family = TEXT_FONTS[tb.fontFamily] || TEXT_FONTS.sans;
  const color = getEffectiveColor(tb.color || '#000000', isPaperDark(state.isDarkMode, state.paperColor));

  _editorWrap.style.left = `${tb.x}px`;
  _editorWrap.style.top = `${tb.y}px`;
  _editorWrap.style.width = `${w}px`;

  _editorTextarea.style.fontFamily = family;
  _editorTextarea.style.fontSize = `${fontSize}px`;
  _editorTextarea.style.lineHeight = String(TEXT_LINE_HEIGHT_MULT);
  _editorTextarea.style.fontWeight = tb.bold ? '700' : '400';
  _editorTextarea.style.fontStyle = tb.italic ? 'italic' : 'normal';
  _editorTextarea.style.textAlign = tb.align || 'left';
  _editorTextarea.style.color = color;
  _editorTextarea.style.padding = `${TEXT_PAD_Y}px ${TEXT_PAD_X}px`;

  _syncTextareaAutoHeight();
}

function _snapshotTextBoxStyle(tb) {
  return {
    fontFamily: tb?.fontFamily || 'sans',
    fontSize: tb?.fontSize || 18,
    bold: !!tb?.bold,
    italic: !!tb?.italic,
    align: tb?.align || 'left',
    color: tb?.color || '#000000'
  };
}

function _hasTextBoxStyleChanged(tb, initialStyle) {
  if (!tb || !initialStyle) return false;
  const cur = _snapshotTextBoxStyle(tb);
  return (
    cur.fontFamily !== initialStyle.fontFamily ||
    cur.fontSize !== initialStyle.fontSize ||
    cur.bold !== initialStyle.bold ||
    cur.italic !== initialStyle.italic ||
    cur.align !== initialStyle.align ||
    cur.color !== initialStyle.color
  );
}

function _captureInitialEditState(tb) {
  Object.defineProperty(tb, '_initialEditText', {
    value: tb.text || '',
    enumerable: false,
    configurable: true,
    writable: true
  });
  Object.defineProperty(tb, '_initialEditStyle', {
    value: _snapshotTextBoxStyle(tb),
    enumerable: false,
    configurable: true,
    writable: true
  });
}

function _openEditorForBox(pageData, tb, { selectAll = false } = {}) {
  if (!pageData || !pageData.wrapper || !tb) return;
  if (!pageData.canvas) pagePool.forceAssign(pageData.index);

  _ensureEditorDOM();
  _hideSelectionMenu();
  _captureInitialEditState(tb);

  state.selectedTextBoxId = tb.id;
  state.editingTextBoxId = tb.id;

  clearOverlay(pageData);
  if (pageData.canvas) redrawPageCanvas(pageData);

  _editorTextarea.value = tb.text || '';
  if (_editorWrap.parentElement !== pageData.wrapper) {
    pageData.wrapper.appendChild(_editorWrap);
  }
  _editorWrap.classList.remove('hidden');
  _syncEditorAppearance(tb);

  _notifyTextSelectionChanged();

  _editorTextarea.focus({ preventScroll: true });
  if (selectAll) {
    _editorTextarea.select();
  } else {
    const len = _editorTextarea.value.length;
    _editorTextarea.setSelectionRange(len, len);
  }

  requestAnimationFrame(() => {
    if (!_editorTextarea || state.editingTextBoxId !== tb.id) return;
    if (document.activeElement !== _editorTextarea) {
      _editorTextarea.focus({ preventScroll: true });
      if (selectAll) {
        _editorTextarea.select();
      } else {
        const len = _editorTextarea.value.length;
        _editorTextarea.setSelectionRange(len, len);
      }
    }
    _syncTextareaAutoHeight();
  });
}

// ============================================================
// PUBLIC LIFECYCLE & ACTIONS
// ============================================================

export function commitActiveTextBox({ deselect = false } = {}) {
  const editId = state.editingTextBoxId;
  if (!editId) {
    if (deselect) clearTextBoxSelection();
    return false;
  }

  const found = _findBoxById(editId);
  const rawVal = _editorTextarea ? _editorTextarea.value : (found?.textBox?.text || '');
  state.editingTextBoxId = null;

  if (_editorWrap && _editorWrap.parentElement) {
    _editorWrap.classList.add('hidden');
    _editorWrap.remove();
  }

  if (!found) {
    if (deselect) state.selectedTextBoxId = null;
    _notifyTextSelectionChanged();
    return false;
  }

  const { pageData, textBox } = found;
  const trimmed = rawVal.replace(/\s+$/, '');
  const isEmpty = rawVal.trim().length === 0;

  if (isEmpty) {
    pageData.textBoxes = (pageData.textBoxes || []).filter(b => b && b.id !== textBox.id);
    if (state.selectedTextBoxId === textBox.id) state.selectedTextBoxId = null;
    if (pageData.canvas) {
      clearOverlay(pageData);
      redrawPageCanvas(pageData);
    }
    _hideSelectionMenu();
    if (!textBox._isNewDraft) {
      _notifyPageContentDirty(pageData);
      pushHistory();
      scheduleSave({ markDirty: false });
    }
    _notifyTextSelectionChanged();
    return true;
  }

  const styleChanged = _hasTextBoxStyleChanged(textBox, textBox._initialEditStyle);
  const changed = trimmed !== (textBox._initialEditText ?? '') || styleChanged || !!textBox._isNewDraft;
  textBox.text = trimmed;
  delete textBox._isNewDraft;
  delete textBox._initialEditText;
  delete textBox._initialEditStyle;
  textBox._layoutCache = null;

  const ctx = _measureCanvasCtx(pageData);
  layoutTextBox(ctx, textBox);
  _clampBoxToPage(textBox);

  if (deselect) {
    state.selectedTextBoxId = null;
  } else {
    state.selectedTextBoxId = textBox.id;
  }

  if (pageData.canvas) {
    redrawPageCanvas(pageData);
    if (!deselect && state.selectedTextBoxId === textBox.id) {
      drawTextBoxSelectionOnOverlay(pageData, textBox);
      _showSelectionMenu();
    } else {
      clearOverlay(pageData);
      _hideSelectionMenu();
    }
  } else {
    _hideSelectionMenu();
  }

  if (changed) {
    _notifyPageContentDirty(pageData);
    pushHistory();
    scheduleSave({ markDirty: false });
  }

  _notifyTextSelectionChanged();
  return true;
}

export function clearTextBoxSelection() {
  if (state.editingTextBoxId) {
    commitActiveTextBox({ deselect: true });
    return;
  }
  const prevId = state.selectedTextBoxId;
  state.selectedTextBoxId = null;
  state._draggingTextBoxId = null;
  _hideSelectionMenu();

  if (prevId) {
    const found = _findBoxById(prevId);
    if (found && found.pageData && found.pageData.canvas) {
      clearOverlay(found.pageData);
      found.pageData.canvas.style.cursor = state.activeTool === 'text' ? 'text' : 'crosshair';
    }
    _notifyTextSelectionChanged();
  }
}

export function editSelectedTextBox() {
  if (state.editingTextBoxId) {
    _editorTextarea?.focus({ preventScroll: true });
    return;
  }
  const found = _findBoxById(state.selectedTextBoxId);
  if (!found) return;
  _openEditorForBox(found.pageData, found.textBox);
}

export function deleteSelectedTextBox() {
  const targetId = state.editingTextBoxId || state.selectedTextBoxId;
  if (!targetId) return false;

  const found = _findBoxById(targetId);
  state.editingTextBoxId = null;
  state.selectedTextBoxId = null;
  state._draggingTextBoxId = null;

  if (_editorWrap && _editorWrap.parentElement) {
    _editorWrap.classList.add('hidden');
    _editorWrap.remove();
  }
  _hideSelectionMenu();

  if (!found) {
    _notifyTextSelectionChanged();
    return false;
  }

  const { pageData, textBox } = found;
  pageData.textBoxes = (pageData.textBoxes || []).filter(b => b && b.id !== textBox.id);

  if (pageData.canvas) {
    clearOverlay(pageData);
    redrawPageCanvas(pageData);
  }

  if (!textBox._isNewDraft) {
    _notifyPageContentDirty(pageData);
    pushHistory();
    scheduleSave({ markDirty: false });
    showToast('Casella di testo eliminata', '🗑️');
  }
  _notifyTextSelectionChanged();
  return true;
}

export function createTextBoxAt(pageData, point) {
  if (!pageData) return null;
  if (!pageData.canvas) pagePool.forceAssign(pageData.index);
  if (!Array.isArray(pageData.textBoxes)) pageData.textBoxes = [];

  if (state.editingTextBoxId) {
    commitActiveTextBox({ deselect: true });
  }

  const style = state.textStyle || {};
  const width = Math.min(DEFAULT_BOX_WIDTH, PAGE_WIDTH - 32);
  const x = Math.max(16, Math.min(PAGE_WIDTH - width - 16, Math.round(point.x)));
  const y = Math.max(16, Math.min(PAGE_HEIGHT - 56, Math.round(point.y - (style.fontSize || 18) * 0.5)));

  const tb = {
    id: _generateTextBoxId(),
    x,
    y,
    width,
    height: Math.ceil((style.fontSize || 18) * TEXT_LINE_HEIGHT_MULT + TEXT_PAD_Y * 2),
    text: '',
    fontFamily: style.fontFamily || 'sans',
    fontSize: style.fontSize || 18,
    bold: !!style.bold,
    italic: !!style.italic,
    align: style.align || 'left',
    color: style.color || '#000000'
  };
  Object.defineProperty(tb, '_isNewDraft', { value: true, enumerable: false, configurable: true, writable: true });

  pageData.textBoxes.push(tb);
  state.activePageIndex = pageData.index;
  _openEditorForBox(pageData, tb);
  return tb;
}

export function applyTextStylePatch(patch) {
  const nextStyle = { ...(state.textStyle || {}), ...patch };
  updateToolbarSettings({ text: nextStyle });

  const found = getActiveTextBox();
  if (found && found.textBox) {
    const { pageData, textBox } = found;
    Object.assign(textBox, patch);
    textBox._layoutCache = null;

    if (state.editingTextBoxId === textBox.id) {
      _syncEditorAppearance(textBox);
      if (_editorTextarea) {
        _editorTextarea.focus({ preventScroll: true });
      }
    } else {
      const ctx = _measureCanvasCtx(pageData);
      layoutTextBox(ctx, textBox);
      _clampBoxToPage(textBox);
      if (pageData.canvas) {
        redrawPageCanvas(pageData);
        drawTextBoxSelectionOnOverlay(pageData, textBox);
        updateTextSelectionMenuPosition();
      }
      if (!textBox._isNewDraft) {
        _notifyPageContentDirty(pageData);
        pushHistory();
        scheduleSave({ markDirty: false });
      }
    }
  }
  _notifyTextSelectionChanged();
}

export function refocusActiveTextEditorIfEditing() {
  if (state.editingTextBoxId && _editorTextarea) {
    _editorTextarea.focus({ preventScroll: true });
  }
}

export function refreshActiveTextEditorTheme() {
  if (!state.editingTextBoxId) return;
  const found = _findBoxById(state.editingTextBoxId);
  if (found && found.textBox) {
    _syncEditorAppearance(found.textBox);
  }
}

// ============================================================
// POINTER INTERACTION (mouse / pen / touch-on-selected)
// ============================================================

function _selectBox(pageData, tb) {
  if (!pageData || !tb) return;
  if (state.editingTextBoxId && state.editingTextBoxId !== tb.id) {
    commitActiveTextBox({ deselect: true });
  }
  state.activePageIndex = pageData.index;
  state.selectedTextBoxId = tb.id;
  if (pageData.canvas) {
    drawTextBoxSelectionOnOverlay(pageData, tb);
  }
  _showSelectionMenu();
  _notifyTextSelectionChanged();
}

export function beginTextPointer(pageData, point) {
  const now = performance.now();

  // 1. Se c'è già una casella selezionata su questa pagina, controlla prima le maniglie
  if (state.selectedTextBoxId && !state.editingTextBoxId) {
    const sel = (pageData.textBoxes || []).find(b => b && b.id === state.selectedTextBoxId);
    if (sel) {
      const handle = hitTestTextBoxHandle(pageData, sel, point);
      if (handle) {
        _interactionMode = handle;
        _interactionPage = pageData;
        _interactionBox = sel;
        _startPoint = { x: point.x, y: point.y };
        _origBox = { x: sel.x, y: sel.y, width: sel.width, height: sel.height };
        _hasMoved = false;
        state.isDrawing = true;
        if (pageData.canvas) pageData.canvas.style.cursor = 'ew-resize';
        return;
      }
    }
  }

  // 2. Hit test su casella esistente
  const hitBox = hitTestTextBox(pageData, point);
  if (hitBox) {
    const isDoubleTap =
      _lastTapBoxId === hitBox.id &&
      (now - _lastTapTime) < DOUBLE_TAP_MS &&
      _lastTapPt &&
      Math.hypot(point.x - _lastTapPt.x, point.y - _lastTapPt.y) < DOUBLE_TAP_DIST_PX;

    _lastTapTime = now;
    _lastTapBoxId = hitBox.id;
    _lastTapPt = { x: point.x, y: point.y };

    if (isDoubleTap) {
      _interactionMode = null;
      state.isDrawing = false;
      _openEditorForBox(pageData, hitBox);
      return;
    }

    _selectBox(pageData, hitBox);
    _interactionMode = 'drag';
    _interactionPage = pageData;
    _interactionBox = hitBox;
    _startPoint = { x: point.x, y: point.y };
    _origBox = { x: hitBox.x, y: hitBox.y, width: hitBox.width, height: hitBox.height };
    _hasMoved = false;
    state.isDrawing = true;
    return;
  }

  _lastTapTime = 0;
  _lastTapBoxId = null;
  _lastTapPt = null;

  // 3. Tap su spazio vuoto
  if (state.editingTextBoxId) {
    commitActiveTextBox({ deselect: true });
    state.isDrawing = false;
    return;
  }

  if (state.selectedTextBoxId) {
    clearTextBoxSelection();
    state.isDrawing = false;
    return;
  }

  createTextBoxAt(pageData, point);
  state.isDrawing = false;
}

export function moveTextPointer(pageData, e) {
  if (!_interactionMode || !_interactionBox || !_startPoint || !_origBox) return;
  const targetPage = _interactionPage || pageData;
  if (!targetPage || !targetPage.canvas) return;

  const pt = getCanvasCoords(e, targetPage.canvas);
  const dx = pt.x - _startPoint.x;
  const dy = pt.y - _startPoint.y;

  if (!_hasMoved && Math.hypot(dx, dy) < 4) return;

  if (!_hasMoved) {
    _hasMoved = true;
    state._draggingTextBoxId = _interactionBox.id;
    _hideSelectionMenu();
    redrawPageCanvas(targetPage);
  }

  const tb = _interactionBox;
  if (_interactionMode === 'drag') {
    targetPage.canvas.style.cursor = 'grabbing';
    const w = Math.max(MIN_BOX_WIDTH, tb.width || DEFAULT_BOX_WIDTH);
    const h = tb.height || 32;
    tb.x = Math.max(8, Math.min(PAGE_WIDTH - w - 8, Math.round(_origBox.x + dx)));
    tb.y = Math.max(8, Math.min(PAGE_HEIGHT - h - 8, Math.round(_origBox.y + dy)));
  } else if (_interactionMode === 'resize-e') {
    targetPage.canvas.style.cursor = 'ew-resize';
    const maxW = PAGE_WIDTH - _origBox.x - 8;
    tb.width = Math.max(MIN_BOX_WIDTH, Math.min(maxW, Math.round(_origBox.width + dx)));
    tb._layoutCache = null;
    const layout = layoutTextBox(_measureCanvasCtx(targetPage), tb);
    tb.y = Math.max(8, Math.min(PAGE_HEIGHT - layout.height - 8, _origBox.y));
  } else if (_interactionMode === 'resize-w') {
    targetPage.canvas.style.cursor = 'ew-resize';
    const right = _origBox.x + _origBox.width;
    const nextX = Math.max(8, Math.min(right - MIN_BOX_WIDTH, Math.round(_origBox.x + dx)));
    tb.x = nextX;
    tb.width = right - nextX;
    tb._layoutCache = null;
    const layout = layoutTextBox(_measureCanvasCtx(targetPage), tb);
    tb.y = Math.max(8, Math.min(PAGE_HEIGHT - layout.height - 8, _origBox.y));
  }

  drawTextBoxSelectionOnOverlay(targetPage, tb, { drawBox: true });
}

export function endTextPointer(pageData) {
  const mode = _interactionMode;
  const targetPage = _interactionPage || pageData;
  const tb = _interactionBox;
  const didMove = _hasMoved;

  _interactionMode = null;
  _interactionPage = null;
  _interactionBox = null;
  _startPoint = null;
  _origBox = null;
  _hasMoved = false;
  state._draggingTextBoxId = null;

  if (!mode || !targetPage || !tb) return;

  if (targetPage.canvas) {
    targetPage.canvas.style.cursor = (mode === 'resize-w' || mode === 'resize-e') ? 'ew-resize' : 'move';
  }

  if (didMove) {
    if (targetPage.canvas) {
      redrawPageCanvas(targetPage);
      drawTextBoxSelectionOnOverlay(targetPage, tb);
    }
    _showSelectionMenu();
    _notifyPageContentDirty(targetPage);
    pushHistory();
    scheduleSave({ markDirty: false });
  } else {
    _showSelectionMenu();
  }
}

export function handleTextTapAtClientPoint(clientX, clientY) {
  if (state.activeTool !== 'text') return false;
  const el = document.elementFromPoint(clientX, clientY);
  if (el && el.closest && (el.closest('.text-box-editor-wrap') || el.closest('#textSelectionMenu'))) {
    return false;
  }

  const wrapper = el && el.closest ? el.closest('.page-wrapper') : null;
  let pageData = null;
  if (wrapper && wrapper.dataset.pageId) {
    pageData = state.pages.find(p => p.pageId === wrapper.dataset.pageId) || null;
  }
  if (!pageData && wrapper && wrapper.dataset.index != null) {
    pageData = state.pages[parseInt(wrapper.dataset.index, 10)] || null;
  }

  if (!pageData) {
    if (state.editingTextBoxId) commitActiveTextBox({ deselect: true });
    else if (state.selectedTextBoxId) clearTextBoxSelection();
    return false;
  }

  if (!pageData.canvas) pagePool.forceAssign(pageData.index);
  if (!pageData.canvas) return false;

  const point = getCanvasCoords({ clientX, clientY }, pageData.canvas);
  beginTextPointer(pageData, point);
  endTextPointer(pageData);
  return true;
}

export function resetTextToolState() {
  _interactionMode = null;
  _interactionPage = null;
  _interactionBox = null;
  _startPoint = null;
  _origBox = null;
  _hasMoved = false;
  state.editingTextBoxId = null;
  state.selectedTextBoxId = null;
  state._draggingTextBoxId = null;
  if (_editorWrap && _editorWrap.parentElement) {
    _editorWrap.classList.add('hidden');
    _editorWrap.remove();
  }
  _hideSelectionMenu();
  _notifyTextSelectionChanged();
}

export function normalizeTextBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const fontSize = typeof raw.fontSize === 'number'
    ? Math.max(10, Math.min(72, Math.round(raw.fontSize)))
    : 18;
  const width = typeof raw.width === 'number'
    ? Math.max(MIN_BOX_WIDTH, Math.min(PAGE_WIDTH - 16, raw.width))
    : DEFAULT_BOX_WIDTH;
  const x = typeof raw.x === 'number' ? raw.x : 40;
  const y = typeof raw.y === 'number' ? raw.y : 60;
  const height = typeof raw.height === 'number'
    ? Math.max(24, raw.height)
    : Math.ceil(fontSize * TEXT_LINE_HEIGHT_MULT + TEXT_PAD_Y * 2);

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : _generateTextBoxId(),
    x,
    y,
    width,
    height,
    text,
    fontFamily: TEXT_FONTS[raw.fontFamily] ? raw.fontFamily : 'sans',
    fontSize,
    bold: !!raw.bold,
    italic: !!raw.italic,
    align: raw.align === 'center' || raw.align === 'right' ? raw.align : 'left',
    color: typeof raw.color === 'string' && raw.color ? raw.color : '#000000'
  };
}

export function normalizeTextBoxes(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const nb = normalizeTextBox(list[i]);
    if (nb) out.push(nb);
  }
  return out;
}
