// ============================================================
// SESSION: notebook attualmente aperto + sync + save
// Rompe il ciclo autosave ↔ editor: chiunque può leggere/salvare
// il current notebook senza conoscere editor.js
// ============================================================

import { state } from '../../core/state.js';
import { saveNotebookToDB } from '../../services/db.js';

let _currentNotebook = null;

export function getCurrentNotebook() { return _currentNotebook; }

export function setCurrentNotebook(nb) { _currentNotebook = nb; }

export function syncCurrentState() {
  if (!_currentNotebook) return;
  _currentNotebook.pattern = state.bgPattern;
  _currentNotebook.pages = state.pages.map(p => ({
    pageIndex: p.index,
    strokes: p.strokes
  }));
}

export function saveCurrentNotebook() {
  if (!_currentNotebook) return;
  saveNotebookToDB(_currentNotebook);
}