// ============================================================
// SESSION: notebook attualmente aperto + sync + save
// Rompe il ciclo autosave ↔ editor: chiunque può leggere/salvare
// il current notebook senza conoscere editor.js
// ============================================================

import { state } from '../../core/state.js';
import { saveNotebookToDB } from '../../services/db.js';
import { getToolbarSettingsForSave } from '../toolbar/toolbar-state.js';

let _currentNotebook = null;

export function getCurrentNotebook() { return _currentNotebook; }

export function setCurrentNotebook(nb) { _currentNotebook = nb; }

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

export function syncCurrentState() {
  if (!_currentNotebook) return;
  _currentNotebook.pattern = state.bgPattern;
  _currentNotebook.toolbarSettings = getToolbarSettingsForSave();
  _currentNotebook.pages = state.pages.map(p => ({
    pageIndex: p.index,
    strokes: p.strokes.map(_cloneStrokeForSave)
  }));
}

export function saveCurrentNotebook() {
  if (!_currentNotebook) return;
  saveNotebookToDB(_currentNotebook);
}