/**
 * @module core/platform
 *
 * RILEVAMENTO CENTRALIZZATO DELLA PIATTAFORMA E STATO RUNTIME INPUT.
 *
 * Unico punto di verità per:
 *   - Rilevamento OS / famiglia device (iOS, iPadOS MacIntel+touch, Android, Windows/macOS/Linux desktop)
 *   - Capacità hardware/browser (touch, fine/coarse pointer, hover, dispositivo ibrido tipo Surface, PWA, Safari, Fullscreen API)
 *   - Metriche dinamiche (DPR, viewportClass phone/tablet/desktop, orientamento)
 *   - Stato input dinamico (lastPointerType 'pen'|'touch'|'mouse', hasSeenPen) con classi/attributi su document.body
 *
 * @see core/state.js — espone `state.platform`
 */

import { emit, on } from './utils.js';

/**
 * @typedef {'ios'|'android'|'desktop'} PlatformFamily
 * @typedef {'ipados'|'ios'|'android'|'windows'|'macos'|'linux'|'unknown'} PlatformOS
 * @typedef {'phone'|'tablet'|'desktop'} ViewportClass
 * @typedef {'pen'|'touch'|'mouse'} EffectivePointerType
 */

function _matchesMedia(win, query) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    return Boolean(win.matchMedia(query)?.matches);
  } catch {
    return false;
  }
}

/**
 * Normalizza `PointerEvent.pointerType` nelle 3 categorie UI principali.
 * Tratta `'eraser'` (gomma posteriore/tasto penna) come `'pen'`.
 *
 * @param {string|null|undefined} pointerType
 * @returns {EffectivePointerType|null}
 */
export function normalizePointerKind(pointerType) {
  if (pointerType === 'pen' || pointerType === 'eraser') return 'pen';
  if (pointerType === 'touch') return 'touch';
  if (pointerType === 'mouse') return 'mouse';
  return null;
}

/**
 * Calcola uno snapshot deterministico e puro (senza mutare il DOM)
 * della piattaforma e delle sue capacità correnti.
 *
 * @param {Object} [env]
 * @param {Navigator|null} [env.navigatorObj]
 * @param {Window|null} [env.windowObj]
 * @param {Document|null} [env.documentObj]
 */
export function detectPlatformInfo({
  navigatorObj = typeof navigator !== 'undefined' ? navigator : null,
  windowObj = typeof window !== 'undefined' ? window : null,
  documentObj = typeof document !== 'undefined' ? document : null
} = {}) {
  const nav = navigatorObj || null;
  const win = windowObj || null;
  const doc = documentObj || null;

  const userAgent = String(nav?.userAgent || '');
  const platform = String(nav?.platform || '');
  const maxTouchPoints = Number.isFinite(nav?.maxTouchPoints) ? nav.maxTouchPoints : 0;

  const isIPadUA = /iPad/.test(userAgent);
  const isIPadOS = isIPadUA || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isIPhoneOrIPod = /iPhone|iPod/.test(userAgent);
  const isIOS = isIPadOS || isIPhoneOrIPod;
  const isAndroid = !isIOS && /Android/i.test(userAgent);

  /** @type {PlatformOS} */
  let os = 'unknown';
  if (isIPadOS) os = 'ipados';
  else if (isIPhoneOrIPod) os = 'ios';
  else if (isAndroid) os = 'android';
  else if (/Win/i.test(platform) || /Windows/i.test(userAgent)) os = 'windows';
  else if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent)) os = 'macos';
  else if (/Linux|X11/i.test(platform) || /Linux/i.test(userAgent)) os = 'linux';

  /** @type {PlatformFamily} */
  const family = isIOS ? 'ios' : (isAndroid ? 'android' : 'desktop');
  const isMobile = isIOS || isAndroid;
  const isDesktop = !isMobile;

  const isSafari = Boolean(userAgent) &&
    /Safari/i.test(userAgent) &&
    !/Chrome|CriOS|Chromium|Edg|EdgiOS|EdgA|Firefox|FxiOS|OPR|SamsungBrowser/i.test(userAgent);

  const hasTouch = maxTouchPoints > 0 || Boolean(win && 'ontouchstart' in win);
  const hasFinePointer = _matchesMedia(win, '(pointer: fine)') || _matchesMedia(win, '(any-pointer: fine)');
  const hasCoarsePointer = _matchesMedia(win, '(pointer: coarse)') || _matchesMedia(win, '(any-pointer: coarse)');
  const canHover = _matchesMedia(win, '(hover: hover)') || _matchesMedia(win, '(any-hover: hover)');

  // Ibrido (es. Surface Windows / 2-in-1 touchscreen): piattaforma desktop con supporto touch
  const isHybrid = isDesktop && hasTouch;

  const isStandalone = _matchesMedia(win, '(display-mode: standalone)') || Boolean(nav?.standalone === true);
  const isPWA = isStandalone;

  const docEl = doc?.documentElement || null;
  const supportsFullscreen = Boolean(
    docEl && (
      typeof docEl.requestFullscreen === 'function' ||
      typeof docEl.webkitRequestFullscreen === 'function'
    )
  );

  const dpr = (win && Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0)
    ? win.devicePixelRatio
    : 1;

  const rawWidth = Number(win?.visualViewport?.width || win?.innerWidth || 0);
  const rawHeight = Number(win?.visualViewport?.height || win?.innerHeight || 0);
  const viewportWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.round(rawWidth) : 0;
  const viewportHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.round(rawHeight) : 0;

  /** @type {ViewportClass} */
  let viewportClass = 'desktop';
  if (viewportWidth > 0) {
    if (viewportWidth < 640) viewportClass = 'phone';
    else if (viewportWidth < 1024) viewportClass = 'tablet';
    else viewportClass = 'desktop';
  } else if (isIPadOS) {
    viewportClass = 'tablet';
  } else if (isMobile) {
    viewportClass = 'phone';
  }

  const isPortrait = viewportWidth > 0 && viewportHeight > 0
    ? viewportHeight > viewportWidth
    : false;

  return {
    os,
    family,
    isIOS,
    isIPadOS,
    isAndroid,
    isMobile,
    isDesktop,
    isHybrid,
    isSafari,
    isStandalone,
    isPWA,
    hasTouch,
    hasFinePointer,
    hasCoarsePointer,
    canHover,
    supportsFullscreen,
    dpr,
    viewportWidth,
    viewportHeight,
    viewportClass,
    isPortrait
  };
}

/**
 * Crea lo stato iniziale `state.platform` disponibile subito al caricamento dei moduli.
 */
export function createInitialPlatformState(env = {}) {
  const info = detectPlatformInfo(env);
  /** @type {EffectivePointerType|null} */
  let initialPointer = null;
  if (info.isMobile || (info.hasTouch && !info.canHover)) {
    initialPointer = 'touch';
  } else if (info.hasFinePointer || info.canHover || info.viewportWidth > 0) {
    initialPointer = 'mouse';
  }

  return {
    ...info,
    lastPointerType: initialPointer,
    hasSeenPen: false
  };
}

/**
 * Sincronizza classi CSS e attributi `data-*` su `document.body`.
 */
export function applyPlatformToDOM(platformState, doc = typeof document !== 'undefined' ? document : null) {
  const body = doc?.body;
  if (!body || !platformState) return;

  body.dataset.platformOs = platformState.os || 'unknown';
  body.dataset.platformFamily = platformState.family || 'desktop';
  body.dataset.viewportClass = platformState.viewportClass || 'desktop';

  const effectivePointer = platformState.lastPointerType ||
    ((platformState.hasTouch && !platformState.canHover) ? 'touch' : 'mouse');
  body.dataset.lastPointer = effectivePointer;

  body.classList.toggle('plat-ios', Boolean(platformState.isIOS));
  body.classList.toggle('plat-android', Boolean(platformState.isAndroid));
  body.classList.toggle('plat-desktop', Boolean(platformState.isDesktop));
  body.classList.toggle('plat-mobile', Boolean(platformState.isMobile));
  body.classList.toggle('plat-touch', Boolean(platformState.hasTouch));
  body.classList.toggle('plat-hybrid', Boolean(platformState.isHybrid));
  body.classList.toggle('plat-pwa', Boolean(platformState.isPWA));
  body.classList.toggle('plat-pen-seen', Boolean(platformState.hasSeenPen));
}

function _assignDiff(target, nextFields) {
  const changed = [];
  for (const key of Object.keys(nextFields)) {
    if (target[key] !== nextFields[key]) {
      target[key] = nextFields[key];
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Aggiorna i campi derivati da viewport/media/DPR su `targetPlatform`.
 * Non azzera `lastPointerType` / `hasSeenPen`.
 */
export function refreshPlatformMetrics(targetPlatform, env = {}) {
  if (!targetPlatform) return [];
  const next = detectPlatformInfo(env);
  const changed = _assignDiff(targetPlatform, next);
  applyPlatformToDOM(targetPlatform, env.documentObj);
  if (changed.length > 0) {
    emit('platform:changed', { changed, platform: targetPlatform });
  }
  return changed;
}

/**
 * Registra un evento pointer per aggiornare dinamicamente `lastPointerType` e `hasSeenPen`
 * (es. Surface ibrido che passa tra mouse, touch e stilo).
 */
export function recordPlatformPointer(targetPlatform, pointerType, doc = typeof document !== 'undefined' ? document : null) {
  if (!targetPlatform) return [];
  const kind = normalizePointerKind(pointerType);
  if (!kind) return [];

  const next = {
    lastPointerType: kind,
    hasSeenPen: targetPlatform.hasSeenPen || kind === 'pen'
  };
  const changed = _assignDiff(targetPlatform, next);
  if (changed.length > 0) {
    applyPlatformToDOM(targetPlatform, doc);
    emit('platform:changed', { changed, platform: targetPlatform });
  }
  return changed;
}

let _activeCleanup = null;

/**
 * Inizializza la gestione centralizzata della piattaforma allo startup dell'app.
 * Popola/riallinea `targetState.platform`, applica attributi/classi al body e ascolta
 * cambi di pointer type, resize, visualViewport e media query.
 */
export function initPlatform({
  targetState,
  windowObj = typeof window !== 'undefined' ? window : null,
  documentObj = typeof document !== 'undefined' ? document : null,
  navigatorObj = typeof navigator !== 'undefined' ? navigator : null
} = {}) {
  if (_activeCleanup) {
    _activeCleanup();
    _activeCleanup = null;
  }

  if (!targetState || typeof targetState !== 'object') {
    throw new Error('[platform] initPlatform requires targetState');
  }

  if (!targetState.platform || typeof targetState.platform !== 'object') {
    targetState.platform = createInitialPlatformState({ navigatorObj, windowObj, documentObj });
  } else {
    refreshPlatformMetrics(targetState.platform, { navigatorObj, windowObj, documentObj });
  }

  if (!targetState.platform.lastPointerType) {
    targetState.platform.lastPointerType = (targetState.platform.isMobile || (targetState.platform.hasTouch && !targetState.platform.canHover))
      ? 'touch'
      : 'mouse';
  }
  applyPlatformToDOM(targetState.platform, documentObj);

  const cleanups = [];

  if (windowObj && typeof windowObj.addEventListener === 'function') {
    const onPointer = (e) => {
      recordPlatformPointer(targetState.platform, e?.pointerType, documentObj);
    };
    const onMetricsChange = () => {
      refreshPlatformMetrics(targetState.platform, { navigatorObj, windowObj, documentObj });
    };

    windowObj.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    windowObj.addEventListener('pointermove', onPointer, { capture: true, passive: true });
    windowObj.addEventListener('resize', onMetricsChange, { passive: true });
    windowObj.addEventListener('orientationchange', onMetricsChange, { passive: true });

    cleanups.push(() => {
      windowObj.removeEventListener('pointerdown', onPointer, { capture: true });
      windowObj.removeEventListener('pointermove', onPointer, { capture: true });
      windowObj.removeEventListener('resize', onMetricsChange);
      windowObj.removeEventListener('orientationchange', onMetricsChange);
    });

    const vv = windowObj.visualViewport;
    if (vv && typeof vv.addEventListener === 'function') {
      vv.addEventListener('resize', onMetricsChange, { passive: true });
      cleanups.push(() => vv.removeEventListener('resize', onMetricsChange));
    }

    if (typeof windowObj.matchMedia === 'function') {
      for (const query of ['(display-mode: standalone)', '(pointer: fine)', '(hover: hover)']) {
        try {
          const mql = windowObj.matchMedia(query);
          if (mql && typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onMetricsChange);
            cleanups.push(() => mql.removeEventListener('change', onMetricsChange));
          }
        } catch {}
      }
    }
  }

  const destroy = () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try { fn(); } catch {}
    }
    if (_activeCleanup === destroy) _activeCleanup = null;
  };

  _activeCleanup = destroy;

  return {
    platform: targetState.platform,
    destroy
  };
}

export function onPlatformChanged(fn) {
  return on('platform:changed', fn);
}
