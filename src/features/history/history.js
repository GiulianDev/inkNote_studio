// ============================================================
// UNDO/REDO: snapshot per-pagina, debounced 500ms
// - Fix 2: forzatura snapshot ogni 3s di scrittura continua
// - Fix 3: clone manuale degli stroke (2-3x più veloce di structuredClone)
// - Fix 4: maxSteps 20 (bilanciamento memoria/undo disponibili)
// ============================================================

import { state } from '../../core/state.js';
import { emit } from '../../core/utils.js';
import { scheduleSave } from '../persistence/autosave.js';

// Fix 4: maxSteps 20.
// Memoria stimata: 20 snapshot × ~500 stroke × 100 punti × ~32 byte
// ≈ 32 MB. Riduce la pressione sul GC rispetto ai 50 originali
// (~80 MB) mantenendo 20 undo disponibili, più che sufficienti
// per l'uso tipico. Se servono più undo, alzare questo valore
// comporta un costo lineare in memoria.
const historyState = { stack: [], index: -1, maxSteps: 20, isRestoring: false };
let _pushHistoryTimer = null;
let _lastSnapshotTime = 0;

// Fix 2: se durante una scrittura continua (stacco/riattacco rapido
// < 500ms) il timer debounced viene continuamente resettato, senza
// questo limite il primo undo cancellerebbe TUTTI gli stroke fatti
// in una sessione, potenzialmente centinaia. Con 3s, il "blocco di
// undo" massimo copre al più 3 secondi di scrittura.
const MAX_CONTINUOUS_DRAW_MS = 3000;

// Fix 3: clone manuale degli stroke.
// structuredClone fa reflection, gestisce cicli, tipi esotici — costoso
// e con overhead per ogni campo. Il nostro Stroke ha struttura fissa:
// copiamo solo i campi che servono (x, y, pressure, tilt, speed,
// pointerType). I campi di cache (_styleCache, _pathLen, _drawnIdx,
// _cacheCanvas, _cacheKey) non vengono clonati: verranno ricreati al
// prossimo redraw/draw.
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

  // Fix 2: se sono passati più di MAX_CONTINUOUS_DRAW_MS dall'ultimo
  // snapshot effettivo, forza subito lo snapshot. Così una sessione
  // di scrittura continua non accumula più di 3s in un unico step.
  if (performance.now() - _lastSnapshotTime > MAX_CONTINUOUS_DRAW_MS) {
    _pushHistoryTimer = null;
    _doPushHistory();
    return;
  }

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

  // Fix 2: aggiorna il timestamp SOLO quando lo snapshot è
  // effettivamente avvenuto (non quando è stato skippato per hash).
  _lastSnapshotTime = performance.now();

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