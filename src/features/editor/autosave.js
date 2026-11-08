// ============================================================
// AUTOSAVE: debounce 500ms → sync + save del notebook corrente
// ============================================================

import { showStatusBadge } from '../../core/utils.js';
import { getCurrentNotebook, syncCurrentState, saveCurrentNotebook } from './session.js';

let _timer = null;

export function scheduleSave() {
  if (!getCurrentNotebook()) return;
  showStatusBadge('Salvataggio...');
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_commit, 500);
}

export function flushAutoSave() {
  if (!_timer) return;
  clearTimeout(_timer);
  _commit();
}

export function isPending() { return _timer !== null; }

function _commit() {
  _timer = null;
  if (!getCurrentNotebook()) return;
  syncCurrentState();
  saveCurrentNotebook();
  showStatusBadge('Salvato');
}