// ============================================================
// UNDO/REDO: snapshot per-pagina, debounced 500ms
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

function areSnapshotsEqual(a, b) {
  if (!a || !b) return false;
  if (a.pageIndex !== b.pageIndex) return false;
  if (a.bgPattern !== b.bgPattern) return false;
  if (a.strokes.length !== b.strokes.length) return false;
  return JSON.stringify(a.strokes) === JSON.stringify(b.strokes);
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
  if (historyState.index < historyState.stack.length - 1) {
    historyState.stack = historyState.stack.slice(0, historyState.index + 1);
  }
  const newSnap = captureSnapshot();
  if (!newSnap) return;
  const lastSnap = historyState.stack[historyState.index];
  if (lastSnap && areSnapshotsEqual(lastSnap, newSnap)) return;
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

  // Ricostruzione pagina: emetto evento, pages.js ascolta e ricostruisce
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