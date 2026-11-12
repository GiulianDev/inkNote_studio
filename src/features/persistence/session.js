// ============================================================
// SESSION: notebook attualmente aperto + sync + save
//
// syncCurrentState() packa gli strokes delle pagine dirty in
// Float32Array prima di assegnarli a _currentNotebook.pages[idx].
// saveCurrentNotebook() li passa a IDB (memcpy nativo).
//
// Il pack elimina:
//   - structured-clone JS di 50.000 oggetti → memcpy di 500 Float32Array
//   - clone runtime duplicato (pack alloca 1 buffer contiguo, non
//     50.000 oggetti temporanei)
// ============================================================

import { state } from '../../core/state.js';
import { saveNotebookToDB } from '../../services/db.js';
import { getToolbarSettingsForSave } from '../toolbar/toolbar-settings.js';
import { packStrokes } from './serialization.js';

let _currentNotebook = null;
const _dirtyPages = new Set();

export function getCurrentNotebook() { return _currentNotebook; }

export function setCurrentNotebook(nb) {
  _currentNotebook = nb;
  _dirtyPages.clear();
}

export function markPageDirty(pageIndex) {
  if (typeof pageIndex === 'number' && pageIndex >= 0) {
    _dirtyPages.add(pageIndex);
  }
}

/**
 * Sincronizza `state` → `_currentNotebook`, packando solo le
 * pagine dirty. Le pagine pulite restano invariate (packed dal
 * loro ultimo sync).
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
      strokes: packStrokes(page.strokes)
    };
  }
}

/**
 * Salva il notebook: metadata + pagine dirty (già packed).
 * Ritorna Promise che risolve al commit IDB.
 */
export function saveCurrentNotebook() {
  if (!_currentNotebook) return Promise.resolve();
  const dirty = Array.from(_dirtyPages);
  _dirtyPages.clear();
  return saveNotebookToDB(_currentNotebook, dirty);
}