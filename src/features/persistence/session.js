// ============================================================
// SESSION: notebook attualmente aperto + sync + save
// Rompe il ciclo autosave ↔ editor: chiunque può leggere/salvare
// il current notebook senza conoscere editor.js
//
// Batch A — autosave incrementale:
//   - `_dirtyPages` traccia le pagine modificate dall'ultimo sync.
//   - `syncCurrentState()` clona SOLO le pagine dirty, non più tutte.
//   - Le pagine "pulite" restano gli stessi oggetti JS in memoria,
//     niente riallocazione (fix principale del lag su pagina piena).
// ============================================================

import { state } from '../../core/state.js';
import { saveNotebookToDB } from '../../services/db.js';
import { getToolbarSettingsForSave } from '../toolbar/toolbar-settings.js';

let _currentNotebook = null;

/** @type {Set<number>} indici di pagina modificati dall'ultimo sync */
const _dirtyPages = new Set();

export function getCurrentNotebook() { return _currentNotebook; }

export function setCurrentNotebook(nb) {
  _currentNotebook = nb;
  _dirtyPages.clear();
}

/**
 * Marca una pagina come modificata. Sarà clonata al prossimo
 * `syncCurrentState()`. Idempotente.
 *
 * Chiamata da `autosave.scheduleSave()` di default sulla pagina attiva.
 * Se in futuro servirà marcare pagine non attive (es. operazioni bulk),
 * basterà chiamarla esplicitamente.
 */
export function markPageDirty(pageIndex) {
  if (typeof pageIndex === 'number' && pageIndex >= 0) {
    _dirtyPages.add(pageIndex);
  }
}

/**
 * Copia un solo i campi "puri" dello stroke.
 * Esclude: _cacheCanvas (HTMLCanvasElement, NON clonabile da IDB),
 * _styleCache, _pathLen, _drawnIdx, startTime.
 * Questi campi sono runtime/cache e vengono ricreati al caricamento.
 */
function _cloneStrokeForSave(s) {
  const pts = s.points;
  const n = pts.length;
  const clonedPoints = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    clonedPoints[i] = {
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
    points: clonedPoints
  };
}

/**
 * Sincronizza `state` → `_currentNotebook`.
 *
 * - pattern e toolbarSettings sono globali: sempre aggiornati (costo ~0).
 * - pages: clona SOLO quelle dirty. Se nessuna pagina è dirty, non
 *   alloca nulla (caso tipico: cambio toolbar/titolo senza editing).
 *
 * Dopo il sync, il Set `_dirtyPages` viene svuotato. Se il successivo
 * `saveNotebookToDB` fallisce, `_currentNotebook.pages` conserva
 * comunque i dati aggiornati → il prossimo save riproverà lo stesso
 * `put` (retry corretto).
 */
export function syncCurrentState() {
  if (!_currentNotebook) return;
  _currentNotebook.pattern = state.bgPattern;
  _currentNotebook.toolbarSettings = getToolbarSettingsForSave();

  if (!_currentNotebook.pages) _currentNotebook.pages = [];

  if (_dirtyPages.size === 0) return;

  for (const idx of _dirtyPages) {
    const page = state.pages[idx];
    if (!page) continue;
    _currentNotebook.pages[idx] = {
      pageIndex: page.index,
      strokes: page.strokes.map(_cloneStrokeForSave)
    };
  }
  _dirtyPages.clear();
}

/**
 * Ritorna una Promise che risolve quando il commit IDB è completato.
 * Chi chiama deve gestire la Promise (then/catch o await) per evitare
 * unhandled rejections.
 */
export function saveCurrentNotebook() {
  if (!_currentNotebook) return Promise.resolve();
  return saveNotebookToDB(_currentNotebook);
}