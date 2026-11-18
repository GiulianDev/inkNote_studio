/**
 * @module features/persistence/autosave
 *
 * AUTOSAVE — debounce 500ms + idle callback tracciabile + immediate save.
 */

import { showStatusBadge } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  getCurrentNotebook, saveCurrentNotebook,
  markPageDirty, markPageDeleted, markOrderDirty
} from './session.js';

let _timer = null;
let _idleId = null;
let _idleIsRic = false;

function _cancelScheduled() {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  if (_idleId !== null) {
    if (_idleIsRic && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(_idleId);
    } else {
      clearTimeout(_idleId);
    }
    _idleId = null;
    _idleIsRic = false;
  }
}

export function scheduleSave(opts = {}) {
  if (!getCurrentNotebook()) return Promise.resolve();

  if (opts.markDirty !== false) {
    const pageId = opts.pageId || state.pages[state.activePageIndex]?.pageId;
    if (pageId) markPageDirty(pageId);
  }
  if (opts.deletedPageId) {
    markPageDeleted(opts.deletedPageId);
  }
  if (opts.orderDirty) {
    markOrderDirty();
  }

  if (opts.silent !== true) {
    showStatusBadge('Salvataggio...');
  }

  if (opts.immediate) {
    _cancelScheduled();
    return _commitSync().catch(() => {});
  }

  _cancelScheduled();
  _timer = setTimeout(_commit, 500);
  return Promise.resolve();
}

export function cancelPendingSave() {
  _cancelScheduled();
}

export function flushAutoSave() {
  const hadPending = _timer !== null || _idleId !== null;
  _cancelScheduled();
  if (!hadPending) return;
  _commitSync().catch(() => {});
}

export function forceSave() {
  _cancelScheduled();
  return _commitSync();
}

function _commit() {
  _timer = null;
  if (!getCurrentNotebook()) return;
  const run = () => {
    _idleId = null;
    _idleIsRic = false;
    _commitSync().catch(() => {});
  };
  if ('requestIdleCallback' in window) {
    _idleIsRic = true;
    _idleId = requestIdleCallback(run, { timeout: 3000 });
  } else {
    _idleIsRic = false;
    _idleId = setTimeout(run, 0);
  }
}

function _commitSync() {
  if (!getCurrentNotebook()) return Promise.resolve();
  try {
    return saveCurrentNotebook()
      .then(() => showStatusBadge('Salvato'))
      .catch(err => {
        console.error('[autosave] save failed:', err);
        showStatusBadge('Errore salvataggio');
        throw err;
      });
  } catch (err) {
    console.error('[autosave] sync failed:', err);
    showStatusBadge('Errore salvataggio');
    return Promise.reject(err);
  }
}