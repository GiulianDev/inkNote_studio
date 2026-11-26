/**
 * @module core/fullscreen
 *
 * Gestione unificata dello stato Schermo Intero (Libreria + Editor),
 * con supporto nativo Fullscreen API e fallback CSS `body.is-fullscreen`
 * per ambienti che bloccano `requestFullscreen()` (es. iPadOS Safari / iFrame).
 */

/**
 * Ritorna lo stato booleano effettivo dello schermo intero dato
 * lo stato nativo del documento e il fallback interno.
 */
export function resolveFullscreenState({ nativeFullscreen, fallbackActive }) {
  return !!(nativeFullscreen || fallbackActive);
}

/**
 * Calcola la transizione su `fullscreenchange`.
 * Se la Fullscreen API nativa era attiva ed è appena uscita (es. tasto ESC),
 * azzera anche il fallback in modo che entrambi i pulsanti si riallineino.
 */
export function reduceNativeFullscreenChange({ wasNativeActive, isNativeNow, fallbackActive }) {
  if (isNativeNow) {
    return { nativeActive: true, fallbackActive: false, isFullscreen: true };
  }
  if (wasNativeActive) {
    return { nativeActive: false, fallbackActive: false, isFullscreen: false };
  }
  return {
    nativeActive: false,
    fallbackActive: !!fallbackActive,
    isFullscreen: !!fallbackActive
  };
}

let _nativeActive = false;
let _fallbackActive = false;
let _initialized = false;
const _listeners = new Set();

function _hasNativeElement() {
  if (typeof document === 'undefined') return false;
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

export function isAppFullscreen() {
  return resolveFullscreenState({
    nativeFullscreen: _hasNativeElement() || _nativeActive,
    fallbackActive: _fallbackActive
  });
}

function _applyFullscreenToDOM(active) {
  if (typeof document === 'undefined') return;
  document.body?.classList.toggle('is-fullscreen', active);

  const libBtn = document.getElementById('libraryFullscreenBtn');
  if (libBtn) {
    libBtn.title = active ? 'Esci da schermo intero' : 'Schermo intero';
    libBtn.setAttribute('aria-label', active ? 'Esci da schermo intero' : 'Schermo intero');
    libBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    const exp = document.getElementById('libFullscreenIconExpand');
    const red = document.getElementById('libFullscreenIconReduce');
    if (exp) exp.style.display = active ? 'none' : '';
    if (red) red.style.display = active ? '' : 'none';
  }
}

function _notify() {
  const active = isAppFullscreen();
  _applyFullscreenToDOM(active);
  for (const fn of _listeners) {
    try { fn(active); } catch (err) { console.error('[fullscreen] listener error:', err); }
  }
}

export function onAppFullscreenChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function initAppFullscreenSync() {
  if (_initialized || typeof document === 'undefined') return;
  _initialized = true;

  const handleNativeChange = () => {
    const isNativeNow = _hasNativeElement();
    const next = reduceNativeFullscreenChange({
      wasNativeActive: _nativeActive,
      isNativeNow,
      fallbackActive: _fallbackActive
    });
    _nativeActive = next.nativeActive;
    _fallbackActive = next.fallbackActive;
    _notify();
  };

  document.addEventListener('fullscreenchange', handleNativeChange);
  document.addEventListener('webkitfullscreenchange', handleNativeChange);
  _applyFullscreenToDOM(isAppFullscreen());
}

export function setAppFullscreen(targetActive) {
  const want = !!targetActive;
  const el = typeof document !== 'undefined' ? document.documentElement : null;

  if (want) {
    _fallbackActive = true;
    _notify();

    if (el) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (typeof req === 'function' && !_hasNativeElement()) {
        try {
          const res = req.call(el);
          if (res && typeof res.then === 'function') {
            res.then(() => {
              _nativeActive = _hasNativeElement();
              if (_nativeActive) _fallbackActive = false;
              _notify();
            }).catch(() => {
              // Fallback CSS resta attivo
            });
          }
        } catch {
          // Fallback CSS resta attivo
        }
      }
    }
    return true;
  }

  _fallbackActive = false;
  const wasNative = _hasNativeElement() || _nativeActive;
  _nativeActive = false;
  _notify();

  if (wasNative && typeof document !== 'undefined') {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (typeof exit === 'function') {
      try {
        const res = exit.call(document);
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch {}
    }
  }
  return false;
}

export function toggleAppFullscreen() {
  return setAppFullscreen(!isAppFullscreen());
}
