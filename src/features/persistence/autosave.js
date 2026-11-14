/**
 * @module features/persistence/autosave
 *
 * AUTOSAVE — debounce 500ms + requestIdleCallback.
 *
 * scheduleSave(opts):
 *   - markDirty: false → non marcare la pagina attiva dirty
 *     (per save di solo metadata, es. cambio pagina)
 *   - silent: true → non mostrare il badge "Salvataggio..."
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

export function flushAutoSave() {
  if (!_timer) return;
  clearTimeout(_timer);
  _timer = null;
  _commitSync();
}

function _commit() {
  _timer = null;
  if (!getCurrentNotebook()) return;
  if ('requestIdleCallback' in window) {
    requestIdleCallback(_commitSync, { timeout: 3000 });
  } else {
    setTimeout(_commitSync, 0);
  }
}

function _commitSync() {
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