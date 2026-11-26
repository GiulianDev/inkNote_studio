/**
 * @module core/back-navigation
 *
 * Gestione unificata del tasto Indietro (browser, Android/iPadOS swipe-back, PWA)
 * basata su History API (`pushState` / `replaceState` / `popstate`).
 *
 * Gerarchia di navigazione:
 *   base (depth -1) → guard / Libreria root (depth 0)
 *                   → folder (depth 1..N)
 *                   → editor / quaderno aperto (depth current + 1)
 *
 * Priorità su `popstate`:
 *   1. Chiude overlay/modali/popover/selezione/filtri attivi restando nella vista corrente.
 *   2. Se nell'editor del quaderno, torna alla libreria (ripristinando la cartella di provenienza).
 *   3. Se in una sottocartella, risale alla cartella precedente / radice.
 *   4. Alla radice della libreria, mostra "Premi ancora Indietro per uscire" al primo tocco
 *      e consente l'uscita solo al secondo tocco entro `exitConfirmWindowMs`.
 */

export const BACK_STATE_KEY = '__inknoteBack';
export const BACK_KIND_BASE = 'base';
export const BACK_KIND_GUARD = 'guard';
export const BACK_KIND_FOLDER = 'folder';
export const BACK_KIND_EDITOR = 'editor';
export const DEFAULT_EXIT_CONFIRM_WINDOW_MS = 2000;

function _cloneBackState(state) {
  if (!state || typeof state !== 'object' || !state[BACK_STATE_KEY]) return null;
  return { ...state };
}

export function createBackNavigationController({
  historyObj = typeof window !== 'undefined' ? window.history : null,
  windowObj = typeof window !== 'undefined' ? window : null,
  now = () => Date.now(),
  exitConfirmWindowMs = DEFAULT_EXIT_CONFIRM_WINDOW_MS,
  scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
  clearScheduledTimeout = (id) => clearTimeout(id),
  isEditorOpen = () => false,
  onReturnToLibrary = () => {},
  onNavigateFolder = () => {},
  onDismissTransientUI = () => null,
  onExitPrompt = () => {},
  getCurrentFolderId = () => null,
  getParentFolderId = () => null
} = {}) {
  let _initialized = false;
  let _activeState = { [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null };
  let _ignoreNextPopstate = false;
  let _ignoreTimer = null;
  let _allowingExit = false;
  let _allowingExitTimer = null;
  let _returningToLibrary = false;
  let _lastRootBackAt = 0;

  function _clearIgnoreTimer() {
    if (_ignoreTimer !== null) {
      clearScheduledTimeout(_ignoreTimer);
      _ignoreTimer = null;
    }
  }

  function _setIgnoreNextPopstate() {
    _ignoreNextPopstate = true;
    _clearIgnoreTimer();
    _ignoreTimer = scheduleTimeout(() => {
      _ignoreTimer = null;
      _ignoreNextPopstate = false;
    }, 250);
  }

  function _clearAllowExitTimer() {
    if (_allowingExitTimer !== null) {
      clearScheduledTimeout(_allowingExitTimer);
      _allowingExitTimer = null;
    }
  }

  function _pushHistoryState(nextState) {
    if (!historyObj) return;
    _activeState = { ...nextState };
    historyObj.pushState(_activeState, '');
  }

  function _replaceHistoryState(nextState) {
    if (!historyObj) return;
    _activeState = { ...nextState };
    historyObj.replaceState(_activeState, '');
  }

  function _currentHistoryState() {
    const raw = historyObj?.state;
    return _cloneBackState(raw) || _activeState;
  }

  function _currentDepth() {
    const st = _currentHistoryState();
    return typeof st?.depth === 'number' ? st.depth : 0;
  }

  function _syncActiveFromEvent(rawState) {
    const cloned = _cloneBackState(rawState);
    if (cloned) {
      _activeState = cloned;
      return cloned;
    }
    return { [BACK_STATE_KEY]: BACK_KIND_BASE, depth: -1, folderId: null };
  }

  function armGuard() {
    if (!historyObj) return;
    const raw = historyObj.state;
    const kind = raw?.[BACK_STATE_KEY];
    if (!kind || kind === BACK_KIND_BASE) {
      _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
    } else {
      _activeState = { ...raw };
    }
  }

  function pushFolder(folderId) {
    if (!historyObj) return;
    _lastRootBackAt = 0;
    const normalizedId = folderId || null;
    const cur = _currentHistoryState();

    if (normalizedId === null) {
      if (cur[BACK_STATE_KEY] === BACK_KIND_FOLDER && cur.depth > 0) {
        historyObj.go(-cur.depth);
      } else if (cur[BACK_STATE_KEY] !== BACK_KIND_GUARD) {
        _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
      }
      return;
    }

    if (cur[BACK_STATE_KEY] === BACK_KIND_FOLDER && cur.folderId === normalizedId) {
      return;
    }

    const baseDepth = cur[BACK_STATE_KEY] === BACK_KIND_BASE ? 0 : Math.max(0, _currentDepth());
    if (cur[BACK_STATE_KEY] === BACK_KIND_BASE) {
      _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
    }
    _pushHistoryState({
      [BACK_STATE_KEY]: BACK_KIND_FOLDER,
      folderId: normalizedId,
      depth: baseDepth + 1
    });
  }

  /**
   * Naviga verso un breadcrumb (targetDepth = 0 per radice, >=1 per cartella antenata).
   * Ritorna true se la navigazione è stata delegata a `history.go(delta)` (asincrona),
   * false se il chiamante deve aggiornare subito la vista.
   */
  function navigateToBreadcrumb(targetFolderId, targetDepth) {
    _lastRootBackAt = 0;
    if (!historyObj) return false;
    const cur = _currentHistoryState();
    const curDepth = typeof cur?.depth === 'number' ? cur.depth : 0;
    const wantedDepth = Math.max(0, Number(targetDepth) || 0);

    if (cur[BACK_STATE_KEY] === BACK_KIND_FOLDER && wantedDepth < curDepth) {
      const delta = wantedDepth - curDepth;
      historyObj.go(delta);
      return true;
    }
    return false;
  }

  function pushEditor(notebookId, folderId) {
    if (!historyObj) return;
    _lastRootBackAt = 0;
    const cur = _currentHistoryState();
    const resolvedFolderId = folderId !== undefined ? folderId : getCurrentFolderId();
    const normalizedFolderId = resolvedFolderId || null;

    if (cur[BACK_STATE_KEY] === BACK_KIND_EDITOR) {
      _replaceHistoryState({
        ...cur,
        notebookId: notebookId || null,
        folderId: normalizedFolderId
      });
      return;
    }

    if (cur[BACK_STATE_KEY] === BACK_KIND_BASE) {
      _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
    }

    const curDepth = Math.max(0, _currentDepth());
    _pushHistoryState({
      [BACK_STATE_KEY]: BACK_KIND_EDITOR,
      notebookId: notebookId || null,
      folderId: normalizedFolderId,
      depth: curDepth + 1
    });
  }

  function popEditorIfActive() {
    if (!historyObj) return false;
    const raw = historyObj.state;
    if (raw?.[BACK_STATE_KEY] !== BACK_KIND_EDITOR) return false;
    _setIgnoreNextPopstate();
    historyObj.back();
    return true;
  }

  function _triggerReturnToLibrary(targetFolderId) {
    _returningToLibrary = true;
    try {
      const maybePromise = onReturnToLibrary({ fromPopstate: true, targetFolderId });
      if (maybePromise && typeof maybePromise.then === 'function') {
        Promise.resolve(maybePromise).finally(() => {
          _returningToLibrary = false;
        });
      } else {
        _returningToLibrary = false;
      }
    } catch (err) {
      _returningToLibrary = false;
      throw err;
    }
  }

  function handlePopstate(event) {
    const prevActive = { ..._activeState };
    const landed = _syncActiveFromEvent(event?.state);

    if (_ignoreNextPopstate) {
      _ignoreNextPopstate = false;
      _clearIgnoreTimer();
      return { action: 'ignored-ui-sync' };
    }

    if (_allowingExit) {
      return { action: 'allowing-exit' };
    }

    if (_returningToLibrary) {
      _pushHistoryState(prevActive);
      return { action: 'return-in-progress' };
    }

    // 1. Prima chiudi eventuali modali, conferme, popover, menu o selezione attiva
    const dismissed = onDismissTransientUI();
    if (dismissed) {
      _lastRootBackAt = 0;
      const restoreState = prevActive[BACK_STATE_KEY] === BACK_KIND_BASE
        ? { [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null }
        : prevActive;
      _pushHistoryState(restoreState);
      return { action: `dismiss:${dismissed}` };
    }

    // 2. Se l'utente è dentro un quaderno e la history è scesa sotto l'editor → torna alla libreria
    if (isEditorOpen()) {
      _lastRootBackAt = 0;
      const targetFolderId = landed[BACK_STATE_KEY] === BACK_KIND_FOLDER
        ? (landed.folderId || null)
        : (prevActive.folderId ?? getCurrentFolderId() ?? null);

      if (landed[BACK_STATE_KEY] === BACK_KIND_BASE) {
        _pushHistoryState({
          [BACK_STATE_KEY]: targetFolderId ? BACK_KIND_FOLDER : BACK_KIND_GUARD,
          folderId: targetFolderId,
          depth: targetFolderId ? 1 : 0
        });
      }
      _triggerReturnToLibrary(targetFolderId);
      return { action: 'return-to-library', targetFolderId };
    }

    // 3. Navigazione cartelle nella libreria
    if (landed[BACK_STATE_KEY] === BACK_KIND_FOLDER) {
      _lastRootBackAt = 0;
      onNavigateFolder(landed.folderId || null);
      return { action: 'navigate-folder', folderId: landed.folderId || null };
    }

    if (landed[BACK_STATE_KEY] === BACK_KIND_GUARD) {
      _lastRootBackAt = 0;
      if (getCurrentFolderId() !== null) {
        onNavigateFolder(null);
        return { action: 'navigate-root' };
      }
      return { action: 'at-guard' };
    }

    // 4. Siamo atterrati su `base` (pressione Indietro da `guard`)
    const curFolderId = getCurrentFolderId();
    if (curFolderId !== null) {
      _lastRootBackAt = 0;
      const parentId = getParentFolderId(curFolderId) || null;
      onNavigateFolder(parentId);
      _pushHistoryState(
        parentId
          ? { [BACK_STATE_KEY]: BACK_KIND_FOLDER, folderId: parentId, depth: 1 }
          : { [BACK_STATE_KEY]: BACK_KIND_GUARD, folderId: null, depth: 0 }
      );
      return { action: 'fallback-parent-folder', folderId: parentId };
    }

    // 5. Radice della libreria: doppia pressione per uscire dall'app
    const t = now();
    if (_lastRootBackAt > 0 && (t - _lastRootBackAt) <= exitConfirmWindowMs) {
      _lastRootBackAt = 0;
      _allowingExit = true;
      _clearAllowExitTimer();
      _allowingExitTimer = scheduleTimeout(() => {
        _allowingExitTimer = null;
        _allowingExit = false;
      }, 250);
      historyObj?.back();
      return { action: 'exit-app' };
    }

    _lastRootBackAt = t;
    _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
    onExitPrompt();
    return { action: 'exit-prompt' };
  }

  function _onUserInteraction() {
    armGuard();
  }

  function init() {
    if (_initialized) return;
    _initialized = true;

    if (historyObj) {
      const existing = historyObj.state;
      const kind = existing?.[BACK_STATE_KEY];
      if (!kind) {
        _replaceHistoryState({ ...(existing || {}), [BACK_STATE_KEY]: BACK_KIND_BASE, depth: -1 });
        _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
      } else if (kind === BACK_KIND_BASE) {
        _pushHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
      } else if (kind === BACK_KIND_EDITOR || kind === BACK_KIND_FOLDER) {
        // Dopo un reload completo l'app parte sempre dalla radice della libreria
        _replaceHistoryState({ [BACK_STATE_KEY]: BACK_KIND_GUARD, depth: 0, folderId: null });
      } else {
        _activeState = { ...existing };
      }
    }

    if (windowObj) {
      windowObj.addEventListener('popstate', handlePopstate);
      windowObj.addEventListener('pointerdown', _onUserInteraction, { capture: true, passive: true });
      windowObj.addEventListener('keydown', _onUserInteraction, { capture: true, passive: true });
    }
  }

  function destroy() {
    _clearIgnoreTimer();
    _clearAllowExitTimer();
    if (windowObj && _initialized) {
      windowObj.removeEventListener('popstate', handlePopstate);
      windowObj.removeEventListener('pointerdown', _onUserInteraction, { capture: true });
      windowObj.removeEventListener('keydown', _onUserInteraction, { capture: true });
    }
    _initialized = false;
  }

  return {
    init,
    destroy,
    armGuard,
    pushFolder,
    navigateToBreadcrumb,
    pushEditor,
    popEditorIfActive,
    handlePopstate,
    getActiveState: () => ({ ..._activeState })
  };
}

let _singleton = null;

export function initBackNavigation(options = {}) {
  if (_singleton) _singleton.destroy();
  _singleton = createBackNavigationController(options);
  _singleton.init();
  return _singleton;
}

export function getBackNavigation() {
  return _singleton;
}

export function pushEditorBackState(notebookId, folderId) {
  _singleton?.pushEditor(notebookId, folderId);
}

export function popEditorBackStateIfActive() {
  return _singleton ? _singleton.popEditorIfActive() : false;
}

export function pushFolderBackState(folderId) {
  _singleton?.pushFolder(folderId);
}

export function navigateBreadcrumbBackState(targetFolderId, targetDepth) {
  return _singleton ? _singleton.navigateToBreadcrumb(targetFolderId, targetDepth) : false;
}
