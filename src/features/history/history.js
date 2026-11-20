/**
 * @module features/history
 *
 * UNDO / REDO — snapshot per-pagina (identificati da pageId), debounced 800ms.
 */

import { state } from '../../core/state.js';
import { emit } from '../../core/utils.js';
import { scheduleSave } from '../persistence/autosave.js';
import { normalizeTextBoxes, resetTextToolState } from '../tools/text.js';

const MAX_HISTORY_STEPS = 20;
const MAX_CACHED_PAGES = 6;
const _pageHistories = new Map(); // pageId -> { stack: Snapshot[], index: number }
let _activeHistoryPageId = null;

const historyState = { stack: [], index: -1, maxSteps: MAX_HISTORY_STEPS, isRestoring: false };

const HISTORY_DEBOUNCE_MS = 800;
const MAX_CONTINUOUS_DRAW_MS = 3000;

let _pushHistoryTimer = null;
let _idlePushId = null;
let _idlePushIsRic = false;
let _lastSnapshotTime = 0;
let _batchStartTime = 0;

function _cancelIdlePush() {
  if (_idlePushId === null) return;
  if (_idlePushIsRic && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(_idlePushId);
  } else {
    clearTimeout(_idlePushId);
  }
  _idlePushId = null;
  _idlePushIsRic = false;
}

function cloneStrokeFast(s) {
  const pts = s.points;
  const n = pts.length;
  const clonedPts = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    clonedPts[i] = {
      x: p.x, y: p.y,
      pressure: p.pressure,
      tiltX: p.tiltX, tiltY: p.tiltY,
      speed: p.speed,
      pointerType: p.pointerType
    };
  }
  return {
    tool: s.tool,
    color: s.color,
    size: s.size,
    opacity: s.opacity != null ? s.opacity : 1.0,
    style: s.style || 'solid',
    points: clonedPts
  };
}

function _hashString(h, str) {
  for (let j = 0; j < str.length; j++) {
    h = ((h * 31) + str.charCodeAt(j)) | 0;
  }
  return h;
}

function _resolveHistoryPage(targetPageId = _activeHistoryPageId) {
  if (targetPageId) {
    const found = state.pages.find(p => p && p.pageId === targetPageId);
    if (found) return found;
  }
  return state.pages[state.activePageIndex] || null;
}

function _touchPageEntry(pageId, entry) {
  if (!pageId) return;
  if (_pageHistories.has(pageId)) _pageHistories.delete(pageId);
  _pageHistories.set(pageId, entry);
  while (_pageHistories.size > MAX_CACHED_PAGES) {
    const oldestKey = _pageHistories.keys().next().value;
    if (oldestKey === pageId) break;
    _pageHistories.delete(oldestKey);
  }
}

function _computeStateHash(page = _resolveHistoryPage()) {
  const pattern = state.bgPattern || '';
  if (!page) {
    return _hashString(-1, pattern) | 0;
  }
  const strokes = page.strokes;
  let h = strokes.length | 0;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    h = ((h * 31) + (s.points.length | 0)) | 0;
    h = ((h * 31) + (s.size | 0)) | 0;
    h = ((h * 31) + (((s.opacity != null ? s.opacity : 1.0) * 1000) | 0)) | 0;
    h = _hashString(h, s.style || 'solid');
    h = _hashString(h, s.color || '#000000');
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    if (first) {
      h = ((h * 31) + ((first.x * 100) | 0)) | 0;
      h = ((h * 31) + ((first.y * 100) | 0)) | 0;
    }
    if (last && last !== first) {
      h = ((h * 31) + ((last.x * 100) | 0)) | 0;
      h = ((h * 31) + ((last.y * 100) | 0)) | 0;
    }
  }
  const textBoxes = Array.isArray(page.textBoxes) ? page.textBoxes : [];
  h = ((h * 31) + (textBoxes.length | 0)) | 0;
  for (let i = 0; i < textBoxes.length; i++) {
    const tb = textBoxes[i];
    if (!tb) continue;
    h = _hashString(h, tb.id || '');
    h = _hashString(h, tb.text || '');
    h = ((h * 31) + Math.round(tb.x || 0)) | 0;
    h = ((h * 31) + Math.round(tb.y || 0)) | 0;
    h = ((h * 31) + Math.round(tb.width || 0)) | 0;
    h = ((h * 31) + Math.round(tb.fontSize || 18)) | 0;
    h = ((h * 31) + (tb.bold ? 1 : 0) + (tb.italic ? 2 : 0)) | 0;
    h = _hashString(h, tb.fontFamily || 'sans');
    h = _hashString(h, tb.align || 'left');
    h = _hashString(h, tb.color || '#000000');
  }
  h = _hashString(h, pattern);
  return h | 0;
}

function captureSnapshot(page = _resolveHistoryPage()) {
  if (!page) return null;
  const strokesClone = page.strokes.map(cloneStrokeFast);
  const textBoxesClone = normalizeTextBoxes(page.textBoxes || []);
  return {
    pageId: page.pageId,
    pageIndex: page.index,
    strokes: strokesClone,
    textBoxes: textBoxesClone,
    bgPattern: state.bgPattern
  };
}

export function pushHistory() {
  if (historyState.isRestoring) return;
  if (_pushHistoryTimer) clearTimeout(_pushHistoryTimer);

  const now = performance.now();
  if (_batchStartTime === 0) _batchStartTime = now;

  const elapsed = now - _batchStartTime;
  const forceNow = elapsed > MAX_CONTINUOUS_DRAW_MS;

  if (forceNow) {
    _pushHistoryTimer = null;
    _batchStartTime = 0;
    _scheduleIdlePush();
    return;
  }

  _pushHistoryTimer = setTimeout(() => {
    _pushHistoryTimer = null;
    _batchStartTime = 0;
    _doPushHistory();
  }, HISTORY_DEBOUNCE_MS);
}

function _scheduleIdlePush() {
  _cancelIdlePush();
  const run = () => {
    _idlePushId = null;
    _idlePushIsRic = false;
    _doPushHistory();
  };
  if ('requestIdleCallback' in window) {
    _idlePushIsRic = true;
    _idlePushId = requestIdleCallback(run, { timeout: 2000 });
  } else {
    _idlePushIsRic = false;
    _idlePushId = setTimeout(run, 0);
  }
}

function _doPushHistory() {
  if (historyState.isRestoring) return;

  const page = _resolveHistoryPage();
  if (!page) return;
  if (!_activeHistoryPageId) _activeHistoryPageId = page.pageId;

  const newHash = _computeStateHash(page);
  const lastSnap = historyState.stack[historyState.index];

  if (lastSnap && lastSnap._hash === newHash) return;

  if (historyState.index < historyState.stack.length - 1) {
    historyState.stack = historyState.stack.slice(0, historyState.index + 1);
  }

  const newSnap = captureSnapshot(page);
  if (!newSnap) return;
  newSnap._hash = newHash;
  historyState.stack.push(newSnap);
  if (historyState.stack.length > historyState.maxSteps) historyState.stack.shift();
  historyState.index = historyState.stack.length - 1;

  _touchPageEntry(page.pageId, { stack: historyState.stack, index: historyState.index });
  _lastSnapshotTime = performance.now();

  updateUndoRedoUI();
}

export function flushHistory() {
  const hadPending = _pushHistoryTimer !== null || _idlePushId !== null;
  if (_pushHistoryTimer) {
    clearTimeout(_pushHistoryTimer);
    _pushHistoryTimer = null;
  }
  _cancelIdlePush();
  _batchStartTime = 0;
  if (hadPending) {
    _doPushHistory();
  }
}

export function dropPageHistory(pageId) {
  if (!pageId) return;
  _pageHistories.delete(pageId);
  if (_activeHistoryPageId === pageId) {
    if (_pushHistoryTimer) { clearTimeout(_pushHistoryTimer); _pushHistoryTimer = null; }
    _cancelIdlePush();
    _batchStartTime = 0;
    _activeHistoryPageId = null;
    historyState.stack = [];
    historyState.index = -1;
  }
}

export function syncHistoryToPage() {
  flushHistory();

  const activePage = state.pages[state.activePageIndex];
  if (!activePage) {
    _activeHistoryPageId = null;
    historyState.stack = [];
    historyState.index = -1;
    updateUndoRedoUI();
    return;
  }

  const pageId = activePage.pageId;
  _activeHistoryPageId = pageId;

  let entry = pageId ? _pageHistories.get(pageId) : null;
  if (entry && entry.stack.length > 0) {
    _touchPageEntry(pageId, entry);
    historyState.stack = entry.stack;
    historyState.index = Math.min(entry.index, entry.stack.length - 1);
  } else {
    const snap = captureSnapshot(activePage);
    if (!snap) {
      historyState.stack = [];
      historyState.index = -1;
      updateUndoRedoUI();
      return;
    }
    snap._hash = _computeStateHash(activePage);
    entry = { stack: [snap], index: 0 };
    _touchPageEntry(pageId, entry);
    historyState.stack = entry.stack;
    historyState.index = 0;
  }

  _lastSnapshotTime = performance.now();
  updateUndoRedoUI();
}

export function resetHistory() {
  if (_pushHistoryTimer) { clearTimeout(_pushHistoryTimer); _pushHistoryTimer = null; }
  _cancelIdlePush();
  _batchStartTime = 0;
  _pageHistories.clear();
  _activeHistoryPageId = null;
  historyState.stack = [];
  historyState.index = -1;
  const activePage = state.pages[state.activePageIndex];
  const snap = captureSnapshot(activePage);
  _lastSnapshotTime = performance.now();
  if (!snap || !activePage) { updateUndoRedoUI(); return; }
  snap._hash = _computeStateHash(activePage);
  historyState.stack.push(snap);
  historyState.index = 0;
  _activeHistoryPageId = activePage.pageId;
  _touchPageEntry(activePage.pageId, { stack: historyState.stack, index: historyState.index });
  updateUndoRedoUI();
}

export function undo() {
  flushHistory();
  if (historyState.index <= 0) return;
  historyState.index--;
  const pageId = _activeHistoryPageId || state.pages[state.activePageIndex]?.pageId;
  if (pageId) _touchPageEntry(pageId, { stack: historyState.stack, index: historyState.index });
  _applySnapshot(historyState.stack[historyState.index]);
}

export function redo() {
  flushHistory();
  if (historyState.index >= historyState.stack.length - 1) return;
  historyState.index++;
  const pageId = _activeHistoryPageId || state.pages[state.activePageIndex]?.pageId;
  if (pageId) _touchPageEntry(pageId, { stack: historyState.stack, index: historyState.index });
  _applySnapshot(historyState.stack[historyState.index]);
}

function _applySnapshot(snap) {
  if (!snap) return;
  const activePage = state.pages[state.activePageIndex];
  const matchesPage = activePage && (
    snap.pageId ? snap.pageId === activePage.pageId : snap.pageIndex === state.activePageIndex
  );
  if (!matchesPage) {
    syncHistoryToPage();
    return;
  }

  historyState.isRestoring = true;

  state.pendingShape = null;
  state.selectedStrokes = [];
  state.lassoPath = [];
  state.isDrawing = false;
  state.currentStroke = null;
  state.currentPointerId = null;
  state.currentPageForPointer = null;
  state.isDraggingSelection = false;
  state.dragStartPoint = null;
  state.selectionMoved = false;
  document.getElementById('selectionMenu')?.classList.add('hidden');
  resetTextToolState();

  if (snap.bgPattern) {
    state.bgPattern = snap.bgPattern;
  }

  emit('history:restore', snap);

  historyState.isRestoring = false;
  _lastSnapshotTime = performance.now();
  updateUndoRedoUI();
  scheduleSave();
}

export function updateUndoRedoUI() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) undoBtn.disabled = historyState.index <= 0;
  if (redoBtn) redoBtn.disabled = historyState.index >= historyState.stack.length - 1;
}

export function handleHistoryKeyboard(e) {
  const target = e.target;
  if (target && target.matches && target.matches('input, textarea, select, [contenteditable="true"]')) return;
  if (!e.key) return;
  const lib = document.getElementById('libraryView');
  if (lib && !lib.classList.contains('hidden')) return;
  const settings = document.getElementById('settingsModal');
  if (settings && !settings.classList.contains('hidden')) return;
  const newNb = document.getElementById('newNotebookModal');
  if (newNb && !newNb.classList.contains('hidden')) return;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

  const isCtrl = e.ctrlKey || e.metaKey;
  if (!isCtrl) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
}