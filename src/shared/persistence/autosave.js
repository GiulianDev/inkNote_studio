/**
 * @module features/persistence/autosave
 *
 * AUTOSAVE — debounce 500ms + idle callback tracciabile + immediate save.
 */

import { showStatusBadge, showToast } from '../core/utils.js';
import { state } from '../core/state.js';
import { isQuotaExceededError } from '../services/db.js';
import {
  getCurrentNotebook, saveCurrentNotebook,
  markPageDirty, markPageDeleted, markOrderDirty
} from './session.js';

let _timer = null;
let _idleId = null;
let _idleIsRic = false;
let _lastQuotaToastAt = 0;

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

export function hasPendingSave() {
  return _timer !== null || _idleId !== null;
}

export function scheduleSave(opts = {}) {
  if (!getCurrentNotebook()) return Promise.resolve();

  if (opts.markDirty !== false) {
    const activePage = state.pages[state.activePageIndex];
    const pageId = opts.pageId || activePage?.pageId;
    if (pageId) markPageDirty(pageId);
    const thumbKey = pageId ?? activePage?.index;
    if (thumbKey != null) {
      window.dispatchEvent(new CustomEvent('inknote:page-content-dirty', {
        detail: { key: thumbKey }
      }));
    }
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
  _timer = setTimeout(_commit, 1200);
  return Promise.resolve();
}

export function cancelPendingSave() {
  _cancelScheduled();
}

export function flushAutoSave() {
  const hadPending = _timer !== null || _idleId !== null;
  _cancelScheduled();
  if (!hadPending) return Promise.resolve();
  return _commitSync().catch(() => {});
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

function _handleSaveError(err) {
  console.error('[autosave] save failed:', err);
  if (isQuotaExceededError(err)) {
    showStatusBadge('Spazio esaurito');
    const now = Date.now();
    if (now - _lastQuotaToastAt > 15000) {
      _lastQuotaToastAt = now;
      showToast('Spazio di archiviazione esaurito. Esporta un backup o libera spazio.', '⚠️', 6000);
    }
  } else {
    showStatusBadge('Errore salvataggio');
  }
}

function _commitSync() {
  if (!getCurrentNotebook()) return Promise.resolve();
  try {
    return saveCurrentNotebook()
      .then(() => showStatusBadge('Salvato'))
      .catch(err => {
        _handleSaveError(err);
        throw err;
      });
  } catch (err) {
    _handleSaveError(err);
    return Promise.reject(err);
  }
}