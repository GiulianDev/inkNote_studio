/**
 * @module features/persistence/autosave
 *
 * AUTOSAVE — debounce 500ms + Promise-based commit.
 *
 * Batch A:
 *   - `scheduleSave()` marca la pagina attiva come dirty PRIMA del
 *     debounce, così anche se il timer viene resettato, la pagina
 *     resta tracciata.
 *   - `_commit()` gira in `requestIdleCallback` (con timeout 3000ms):
 *     il clone delle pagine dirty e la scrittura IDB non bloccano il
 *     typing → l'utente può continuare a scrivere mentre il save
 *     procede in background.
 *   - `flushAutoSave()` resta SINCRONO: chiamato da `beforeunload` e
 *     da `returnToLibrary`, non può aspettare un idle.
 *
 * @see features/persistence/session.js
 * @see services/db.js  — saveNotebookToDB
 */

import { showStatusBadge } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  getCurrentNotebook, syncCurrentState, saveCurrentNotebook,
  markPageDirty
} from './session.js';

let _timer = null;

export function scheduleSave() {
  if (!getCurrentNotebook()) return;

  // Marca la pagina attiva come dirty. È un no-op se già marcata.
  // Le operazioni che non modificano `state.pages` (toolbar, tema,
  // titolo) marcano comunque la pagina attiva: innocuo (al più il
  // prossimo sync clona una pagina "invariata"), ma utile perché
  // non richiede di distinguere i call-site.
  markPageDirty(state.activePageIndex);

  showStatusBadge('Salvataggio...');
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_commit, 500);
}

export function flushAutoSave() {
  if (!_timer) return;
  clearTimeout(_timer);
  _timer = null;
  // Sync path: prima del beforeunload il tab potrebbe chiudersi
  // prima che un eventuale requestIdleCallback venga servito.
  _commitSync();
}

function _commit() {
  _timer = null;
  if (!getCurrentNotebook()) return;

  if ('requestIdleCallback' in window) {
    requestIdleCallback(_commitSync, { timeout: 3000 });
  } else {
    // Fallback (Safari < 17, browser senza rIC): macrotask per
    // non bloccare il frame corrente.
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