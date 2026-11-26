/**
 * @module features/toolbar/dock-autohide
 *
 * State-based buffer controller per il nascondimento automatico del dock
 * durante la scrittura a mano libera (`autoHideDock`).
 *
 * Macchina a stati:
 *   - 'idle'      : nessuna scrittura recente → dock visibile (hidden = false)
 *   - 'writing'   : tratto attivo in corso      → dock nascosto (hidden = true)
 *   - 'buffering' : penna sollevata, in attesa  → dock ancora nascosto finché
 *                   l'attività non resta inattiva ininterrottamente per
 *                   `inactivityDelayMs`.
 */

export const DEFAULT_WRITING_INACTIVITY_MS = 1200;

export const DOCK_BUFFER_STATES = Object.freeze({
  IDLE: 'idle',
  WRITING: 'writing',
  BUFFERING: 'buffering'
});

/**
 * Crea un controller con buffer basato sullo stato della scrittura.
 * Le dipendenze temporali (`now`, `scheduleTimer`, `cancelTimer`) sono
 * iniettabili per consentire test deterministici senza attese reali.
 */
export function createDockAutoHideController({
  inactivityDelayMs = DEFAULT_WRITING_INACTIVITY_MS,
  enabled = false,
  onVisibilityChange = () => {},
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  scheduleTimer = (fn, ms) => setTimeout(fn, ms),
  cancelTimer = (id) => clearTimeout(id)
} = {}) {
  const delayMs = Math.max(0, Number(inactivityDelayMs) || 0);

  let _enabled = !!enabled;
  let _state = DOCK_BUFFER_STATES.IDLE;
  let _hidden = false;
  let _timerId = null;
  let _lastActivityAt = 0;

  function _clearTimer() {
    if (_timerId !== null) {
      cancelTimer(_timerId);
      _timerId = null;
    }
  }

  function _setHidden(nextHidden) {
    const next = !!nextHidden;
    if (next === _hidden) return;
    _hidden = next;
    onVisibilityChange(next);
  }

  function _scheduleInactivityCheck(waitMs) {
    _clearTimer();
    _timerId = scheduleTimer(() => {
      _timerId = null;
      if (_state !== DOCK_BUFFER_STATES.BUFFERING) return;

      const elapsed = now() - _lastActivityAt;
      if (elapsed < delayMs) {
        _scheduleInactivityCheck(delayMs - elapsed);
        return;
      }

      _state = DOCK_BUFFER_STATES.IDLE;
      _setHidden(false);
    }, Math.max(0, Math.ceil(waitMs)));
  }

  function beginWriting() {
    if (!_enabled) return false;
    _clearTimer();
    _lastActivityAt = now();
    _state = DOCK_BUFFER_STATES.WRITING;
    _setHidden(true);
    return true;
  }

  function keepWritingAlive() {
    if (!_enabled || _state === DOCK_BUFFER_STATES.IDLE) return false;
    _lastActivityAt = now();
    if (_state === DOCK_BUFFER_STATES.BUFFERING) {
      _scheduleInactivityCheck(delayMs);
    }
    return true;
  }

  function endWriting() {
    if (!_enabled) {
      revealNow();
      return;
    }
    if (_state === DOCK_BUFFER_STATES.IDLE) return;

    _lastActivityAt = now();
    _state = DOCK_BUFFER_STATES.BUFFERING;
    _scheduleInactivityCheck(delayMs);
  }

  function revealNow() {
    _clearTimer();
    _state = DOCK_BUFFER_STATES.IDLE;
    _setHidden(false);
  }

  function setEnabled(nextEnabled) {
    const next = !!nextEnabled;
    if (next === _enabled) return;
    _enabled = next;
    if (!next) {
      revealNow();
    }
  }

  return {
    beginWriting,
    keepWritingAlive,
    endWriting,
    revealNow,
    setEnabled,
    isEnabled: () => _enabled,
    isHidden: () => _hidden,
    getState: () => _state,
    getLastActivityAt: () => _lastActivityAt,
    getInactivityDelayMs: () => delayMs
  };
}
