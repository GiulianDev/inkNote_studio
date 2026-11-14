// ============================================================
// SESSION: notebook attualmente aperto + sync + save
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
 * Sincronizza `state` → `_currentNotebook`.
 *
 * GARANTISCE che `_currentNotebook.pages` sia sempre lungo
 * `state.pages.length` e senza buchi (undefined). Le pagine
 * non-dirty mantengono il loro contenuto precedente; le pagine
 * mai scritte diventano entry vuote `{ pageIndex: i, strokes: [] }`.
 *
 * Questo evita che `pageCount` (calcolato da `_currentNotebook.pages.length`)
 * sia disallineato da `state.pages.length`, e che al load successivo
 * il DB contenga entry sparse (buco in 0) → shift/traslazione.
 */
export function syncCurrentState() {
  if (!_currentNotebook) return;
  _currentNotebook.pattern = state.bgPattern;
  _currentNotebook.toolbarSettings = getToolbarSettingsForSave();
  _currentNotebook.lastPageIndex = state.activePageIndex;

  if (!_currentNotebook.pages) _currentNotebook.pages = [];

  // Allinea la lunghezza di _currentNotebook.pages a state.pages.length.
  // Le nuove posizioni restano `null` finché non vengono riempite
  // (dirty) o stabilizzate (placeholder vuoto).
  const targetLen = state.pages.length;
  while (_currentNotebook.pages.length < targetLen) {
    _currentNotebook.pages.push(null);
  }
  if (_currentNotebook.pages.length > targetLen) {
    _currentNotebook.pages.length = targetLen;
  }

  // Aggiorna le pagine dirty con il contenuto corrente packato.
  for (const idx of _dirtyPages) {
    const page = state.pages[idx];
    if (!page) continue;
    _currentNotebook.pages[idx] = {
      pageIndex: page.index,
      strokes: packStrokes(page.strokes)
    };
  }

  // Riempi i buchi (pagine mai scritte) con placeholder vuoto.
  // Necessario perché `pageCount` conta `_currentNotebook.pages.length`
  // e non deve contenere `null` / `undefined`.
  for (let i = 0; i < _currentNotebook.pages.length; i++) {
    if (!_currentNotebook.pages[i]) {
      _currentNotebook.pages[i] = { pageIndex: i, strokes: [] };
    }
  }
}

export function saveCurrentNotebook() {
  if (!_currentNotebook) return Promise.resolve();
  const dirty = Array.from(_dirtyPages);
  _dirtyPages.clear();
  return saveNotebookToDB(_currentNotebook, dirty);
}