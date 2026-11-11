/**
 * @module features/persistence/autosave
 *
 * AUTOSAVE — debounce 500ms + Promise-based commit.
 *
 * Flusso:
 *   - scheduleSave()      → debounce, mostra "Salvataggio..." subito
 *   - flushAutoSave()     → forza commit immediato (es. beforeunload)
 *   - _commit()           → sync → save → "Salvato" | "Errore salvataggio"
 *
 * saveCurrentNotebook() ritorna una Promise: il badge "Salvato" viene
 * mostrato solo quando la transazione IDB è committata (no race con
 * navigazione o chiusura tab).
 *
 * No-op se non c'è notebook aperto (`getCurrentNotebook()` null):
 * chiamarla è sempre safe.
 *
 * @see features/persistence/session.js
 * @see services/db.js  — saveNotebookToDB
 */

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
  } catch (err) {
    console.error('[autosave] sync failed:', err);
    showStatusBadge('Errore salvataggio');
    return;
  }
  saveCurrentNotebook()
    .then(() => showStatusBadge('Salvato'))
    .catch(err => {
      console.error('[autosave] save failed:', err);
      showStatusBadge('Errore salvataggio');
    });
}