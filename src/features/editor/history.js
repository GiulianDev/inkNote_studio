// ============================================================
// UNDO/REDO: snapshot per-pagina, debounced 500ms
// Priorità 7: hash leggero per evitare deepClone + stringify
// inutili quando lo stato non è cambiato.
// ============================================================

import { state } from '../../core/state.js';
import { emit } from '../../core/utils.js';
import { scheduleSave } from './autosave.js';

const historyState = { stack: [], index: -1, maxSteps: 50, isRestoring: false };
let _pushHistoryTimer = null;

function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch (e) {}
  }
  return JSON.parse(JSON.stringify(obj));
}

// ------------------------------------------------------------
// Hash leggero dello stato corrente.
// Cattura: n° stroke, n° punti, size, colore, primo e ultimo punto,
// bgPattern. Non è crittografico: collisioni rare possono causare
// uno skip occasionale di uno step, non un bug visibile.
// ------------------------------------------------------------
function _computeStateHash() {
  const page = state.pages[state.activePageIndex];
  const pattern = state.bgPattern || '';
  if (!page) {
    let h = -1;
    for (let j = 0; j < pattern.length; j++) h = ((h * 31) + pattern.charCodeAt(j)) | 0;
    return h | 0;
  }
  const strokes = page.strokes;
  let h = strokes.length | 0;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    h = ((h * 31) + (s.points.length | 0)) | 0;
    h = ((h * 31) + (s.size | 0)) | 0;
    const c = s.color || '#000000';
    for (let j = 0; j < c.length; j++) h = ((h * 31) + c.charCodeAt(j)) | 0;
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
  for (let j = 0; j < pattern.length; j++) h = ((h * 31) + pattern.charCodeAt(j)) | 0;
  return h | 0;
}

function captureSnapshot() {
  const page = state.pages[state.activePageIndex];
  if (!page) return null;
  const strokesClone = deepClone(page.strokes);
  strokesClone.forEach(s => { delete s._styleCache; delete s._pathLen; });
  return {
    pageIndex: state.activePageIndex,
    strokes: strokesClone,
    bgPattern: state.bgPattern
  };
}

export function pushHistory() {
  if (historyState.isRestoring) return;
  if (_pushHistoryTimer) clearTimeout(_pushHistoryTimer);
  _pushHistoryTimer = setTimeout(() => {
    _pushHistoryTimer = null;
    _doPushHistory();
  }, 500);
}

function _doPushHistory() {
  if (historyState.isRestoring) return;

  const newHash = _computeStateHash();
  const lastSnap = historyState.stack[historyState.index];

  // Skip se lo stato è identico all'ultimo snapshot (nessun clone!)
  if (lastSnap && lastSnap._hash === newHash) return;

  // Taglia il future prima di pushare
  if (historyState.index < historyState.stack.length - 1) {
    historyState.stack = historyState.stack.slice(0, historyState.index + 1);
  }

  const newSnap = captureSnapshot();
  if (!newSnap) return;
  newSnap._hash = newHash;
  historyState.stack.push(newSnap);
  if (historyState.stack.length > historyState.maxSteps) historyState.stack.shift();
  historyState.index = historyState.stack.length - 1;
  updateUndoRedoUI();
}

export function flushHistory() {
  if (_pushHistoryTimer) {
    clearTimeout(_pushHistoryTimer);
    _pushHistoryTimer = null;
    _doPushHistory();
  }
}

export function resetHistory() {
  if (_pushHistoryTimer) { clearTimeout(_pushHistoryTimer); _pushHistoryTimer = null; }
  historyState.stack = [];
  historyState.index = -1;
  const snap = captureSnapshot();
  if (!snap) { updateUndoRedoUI(); return; }
  snap._hash = _computeStateHash();
  historyState.stack.push(snap);
  historyState.index = 0;
  updateUndoRedoUI();
}

export function undo() {
  flushHistory();
  if (historyState.index <= 0) return;
  historyState.index--;
  _applySnapshot(historyState.stack[historyState.index]);
}

export function redo() {
  flushHistory();
  if (historyState.index >= historyState.stack.length - 1) return;
  historyState.index++;
  _applySnapshot(historyState.stack[historyState.index]);
}

function _applySnapshot(snap) {
  if (!snap) return;
  if (snap.pageIndex !== state.activePageIndex) { resetHistory(); return; }
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
  document.getElementById('selectionMenu').classList.add('hidden');

  if (snap.bgPattern) {
    state.bgPattern = snap.bgPattern;
    const sel = document.getElementById('bgPatternSelect');
    if (sel) sel.value = snap.bgPattern;
  }

  emit('history:restore', snap);

  historyState.isRestoring = false;
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
  const isCtrl = e.ctrlKey || e.metaKey;
  if (!isCtrl) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
}