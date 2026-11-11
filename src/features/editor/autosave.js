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

function _commit() {
  _timer = null;
  if (!getCurrentNotebook()) return;
  try {
    syncCurrentState();
    saveCurrentNotebook();
    showStatusBadge('Salvato');
  } catch (err) {
    console.error('[autosave] commit failed:', err);
    showStatusBadge('Errore salvataggio');
  }
}