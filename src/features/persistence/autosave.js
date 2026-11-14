/**
 * @module features/persistence/autosave
 *
 * AUTOSAVE — debounce 500ms + requestIdleCallback.
 *
 * API:
 *   - scheduleSave(opts)  → debounce; opts.markDirty, opts.silent
 *   - flushAutoSave()     → forza sync se c'è un timer pendente
 *   - forceSave()         → cancella timer + salva SEMPRE, ritorna Promise
 */

import { showStatusBadge } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  getCurrentNotebook, syncCurrentState, saveCurrentNotebook,
  markPageDirty
} from './session.js';

let _timer = null;

export function scheduleSave(opts = {}) {
  if (!getCurrentNotebook()) return;

  if (opts.markDirty !== false) {
    markPageDirty(state.activePageIndex);
  }
  if (opts.silent !== true) {
    showStatusBadge('Salvataggio...');
  }

  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_commit, 500);
}

/**
 * Forza il commit sincrono SE c'è un timer pendente (debounce scaduto).
 * Usato da beforeunload: il tab potrebbe chiudersi prima che l'idle
 * callback venga servita.
 */
export function flushAutoSave() {
  if (!_timer) return;
  clearTimeout(_timer);
  _timer = null;
  _commitSync().catch(() => {});
}

/**
 * Forza un commit sincrono anche senza timer pendente.
 * Cancella il timer se presente per evitare doppio save.
 * Ritorna la Promise del commit IDB, così il chiamante può await-arla
 * (es. returnToLibrary).
 */
export function forceSave() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  return _commitSync();
}

function _commit() {
  _timer = null;
  if (!getCurrentNotebook()) return;
  const run = () => { _commitSync().catch(() => {}); };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 0);
  }
}

function _commitSync() {
  if (!getCurrentNotebook()) return Promise.resolve();
  try {
    syncCurrentState();
  } catch (err) {
    console.error('[autosave] sync failed:', err);
    showStatusBadge('Errore salvataggio');
    return Promise.reject(err);
  }
  return saveCurrentNotebook()
    .then(() => showStatusBadge('Salvato'))
    .catch(err => {
      console.error('[autosave] save failed:', err);
      showStatusBadge('Errore salvataggio');
      throw err;
    });
}