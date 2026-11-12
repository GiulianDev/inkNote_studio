/**
 * @module features/history
 *
 * UNDO / REDO — snapshot per-pagina, debounced 800ms.
 *
 * Batch A:
 *   - maxSteps 10 (era 20): dimezza la memoria live (≈16 MB vs 32 MB
 *     su pagina piena), riducendo la pressione sul GC.
 *   - Debounce 800ms (era 500): disaccoppia temporalmente history e
 *     autosave, evitando che i due picchi di allocazione si sommino.
 *   - Il "cap" a 3s della scrittura continua NON è più sincrono: viene
 *     rimandato a requestIdleCallback. Se scrivi per 10s di fila, il
 *     primo snapshot avviene a ~3s in idle, poi di nuovo a ~6s, ecc.
 *     Nessun blocco del typing.
 *
 * Meccanica invariata per il resto.
 *
 * Emette: `history:restore` con lo snapshot (ascoltato da pages.js).
 *
 * @see core/types.js  — Snapshot
 * @see features/persistence/autosave.js  — scheduleSave al restore
 */

import { state } from '../../core/state.js';
import { emit } from '../../core/utils.js';
import { scheduleSave } from '../persistence/autosave.js';

// Batch A: maxSteps 20 → 10.
// Stima memoria: 10 snapshot × 500 stroke × 100 punti × ~88 byte
// ≈ 44 MB (worst case). Il precedente era ~88 MB. Con device deboli
// (Surface Go 1) ogni MB risparmiato allunga l'intervallo tra major GC.
const historyState = { stack: [], index: -1, maxSteps: 10, isRestoring: false };

// Batch A: 500 → 800 ms. Disaccoppia da autosave (500 ms).
const HISTORY_DEBOUNCE_MS = 800;

// Cap scrittura continua: oltre questo tempo dall'inizio del batch,
// forza uno snapshot asincrono (in idle) invece di aspettare che il
// debounce scatti (che non scatterebbe mai in scrittura continua).
const MAX_CONTINUOUS_DRAW_MS = 3000;

let _pushHistoryTimer = null;
let _lastSnapshotTime = 0;
let _batchStartTime = 0;

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
    points: clonedPts
  };
}

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
  const strokesClone = page.strokes.map(cloneStrokeFast);
  return {
    pageIndex: state.activePageIndex,
    strokes: strokesClone,
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
    // Batch A: niente più snapshot sincrono. Rimanda a idle.
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
  const run = () => _doPushHistory();
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

function _doPushHistory() {
  if (historyState.isRestoring) return;

  const newHash = _computeStateHash();
  const lastSnap = historyState.stack[historyState.index];

  if (lastSnap && lastSnap._hash === newHash) return;

  if (historyState.index < historyState.stack.length - 1) {
    historyState.stack = historyState.stack.slice(0, historyState.index + 1);
  }

  const newSnap = captureSnapshot();
  if (!newSnap) return;
  newSnap._hash = newHash;
  historyState.stack.push(newSnap);
  if (historyState.stack.length > historyState.maxSteps) historyState.stack.shift();
  historyState.index = historyState.stack.length - 1;

  _lastSnapshotTime = performance.now();

  updateUndoRedoUI();
}

export function flushHistory() {
  if (_pushHistoryTimer) {
    clearTimeout(_pushHistoryTimer);
    _pushHistoryTimer = null;
    _batchStartTime = 0;
    _doPushHistory();
  }
}

export function resetHistory() {
  if (_pushHistoryTimer) { clearTimeout(_pushHistoryTimer); _pushHistoryTimer = null; }
  _batchStartTime = 0;
  historyState.stack = [];
  historyState.index = -1;
  const snap = captureSnapshot();
  _lastSnapshotTime = performance.now();
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
  const isCtrl = e.ctrlKey || e.metaKey;
  if (!isCtrl) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
}