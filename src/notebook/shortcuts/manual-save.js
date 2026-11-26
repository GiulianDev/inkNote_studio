/**
 * @module features/shortcuts/manual-save
 *
 * Esegue il salvataggio manuale (Ctrl+S / Cmd+S) attendendo l'esito reale
 * di `forceSave()` prima di mostrare il toast di conferma o errore.
 */

export function createManualSaveRunner({
  flushHistory,
  forceSave,
  showToast,
  showStatusBadge = null
}) {
  let _inFlight = null;

  return async function runManualSave() {
    if (_inFlight) return _inFlight;

    _inFlight = (async () => {
      flushHistory?.();
      showStatusBadge?.('Salvataggio...');
      try {
        await forceSave();
        showToast?.('Salvato', '💾');
        return true;
      } catch {
        showToast?.('Errore durante il salvataggio', '⚠️');
        return false;
      } finally {
        _inFlight = null;
      }
    })();

    return _inFlight;
  };
}
