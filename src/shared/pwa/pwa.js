/**
 * @module shared/pwa/pwa
 *
 * Gestione PWA: registrazione Service Worker, prompt di installazione in-app
 * (Chromium/Android/Desktop e guida iOS Safari) e indicatore stato offline.
 */

import { openModalOverlay } from '../components/modal.js';

export function classifyInstallPlatform({
  userAgent = '',
  maxTouchPoints = 0,
  isStandalone = false,
  hasDeferredPrompt = false
} = {}) {
  if (isStandalone) {
    return { isInstalled: true, isIOS: false, mode: 'installed' };
  }
  const ua = String(userAgent || '').toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && Number(maxTouchPoints) > 1);
  if (hasDeferredPrompt) {
    return { isInstalled: false, isIOS, mode: 'prompt' };
  }
  if (isIOS) {
    return { isInstalled: false, isIOS: true, mode: 'ios-guide' };
  }
  return { isInstalled: false, isIOS: false, mode: 'none' };
}

export function resolveSettingsInstallPresentation({ mode = 'none', isIOS = false } = {}) {
  if (mode === 'installed') {
    return {
      label: 'App installata',
      description: 'InkNote Studio è già installata su questo dispositivo.',
      disabled: true,
      tone: 'installed'
    };
  }
  if (mode === 'prompt') {
    return {
      label: 'Installa app',
      description: 'Aggiungi InkNote Studio alla schermata Home o al desktop per usarla offline a schermo intero.',
      disabled: false,
      tone: 'primary'
    };
  }
  if (mode === 'ios-guide' || isIOS) {
    return {
      label: 'Installa su iPhone / iPad',
      description: 'Aggiungi InkNote Studio alla schermata Home da Safari per usarla offline a schermo intero.',
      disabled: false,
      tone: 'secondary'
    };
  }
  return {
    label: 'Come installare',
    description: 'Puoi installare InkNote Studio dal menu del browser per aprirla come app e usarla offline.',
    disabled: false,
    tone: 'secondary'
  };
}

function _isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator?.standalone === true
  );
}

function _openGuideModal({ id, title, intro, steps }) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[120] flex items-center justify-center p-4';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full shadow-2xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="text-base font-bold text-slate-900 dark:text-white">${title}</h3>
      <p class="text-xs text-slate-600 dark:text-slate-300 mt-2 leading-relaxed">${intro}</p>
      <ol class="text-xs text-slate-700 dark:text-slate-200 mt-3 space-y-1.5 list-decimal list-inside leading-relaxed">
        ${steps.map((s) => `<li>${s}</li>`).join('')}
      </ol>
      <div class="flex justify-end mt-5">
        <button type="button" data-pwa-guide-close
          class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-sm transition cursor-pointer">
          Ho capito
        </button>
      </div>
    </div>
  `;

  const ctrl = openModalOverlay(overlay, { id, ariaLabel: title });
  overlay.querySelector('[data-pwa-guide-close]')?.addEventListener('click', () => {
    ctrl.close('ok');
  });
}

function _openIOSInstallGuideModal() {
  _openGuideModal({
    id: 'pwaIosGuide',
    title: 'Installa InkNote Studio',
    intro: 'Per usare l’app a schermo intero e offline su iPhone o iPad:',
    steps: [
      'Tocca il pulsante <strong>Condividi</strong> nella barra di Safari.',
      'Scorri e seleziona <strong>Aggiungi alla schermata Home</strong>.',
      'Conferma toccando <strong>Aggiungi</strong> in alto a destra.'
    ]
  });
}

function _openBrowserInstallGuideModal() {
  _openGuideModal({
    id: 'pwaBrowserGuide',
    title: 'Installa come App',
    intro: 'Se il browser non mostra il popup automatico, puoi installare InkNote Studio manualmente:',
    steps: [
      'Apri il menu del browser (icona <strong>⋮</strong> o barra degli indirizzi).',
      'Seleziona <strong>Installa app</strong> oppure <strong>Aggiungi a schermata Home</strong>.',
      'Conferma per avviare InkNote Studio in finestra dedicata e offline.'
    ]
  });
}

let _deferredPrompt = null;
let _isInstalled = false;
let _initialized = false;
const _statusListeners = new Set();

export function getPWAInstallState() {
  if (typeof window === 'undefined') {
    return { isInstalled: false, isIOS: false, mode: 'none' };
  }
  const standalone = _isInstalled || _isStandaloneMode();
  return classifyInstallPlatform({
    userAgent: window.navigator?.userAgent || '',
    maxTouchPoints: window.navigator?.maxTouchPoints || 0,
    isStandalone: standalone,
    hasDeferredPrompt: Boolean(_deferredPrompt)
  });
}

export function onPWAStatusChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  _statusListeners.add(listener);
  return () => _statusListeners.delete(listener);
}

function _notifyPWAStatusListeners() {
  const status = getPWAInstallState();
  for (const listener of _statusListeners) {
    try {
      listener(status);
    } catch {
      // ignore listener errors
    }
  }
}

export async function triggerPWAInstall({ allowBrowserGuide = false } = {}) {
  const status = getPWAInstallState();
  if (status.mode === 'installed') {
    return { outcome: 'installed' };
  }
  if (status.mode === 'prompt' && _deferredPrompt) {
    try {
      await _deferredPrompt.prompt();
      const choice = await _deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        _isInstalled = true;
      }
      return { outcome: choice?.outcome || 'dismissed' };
    } catch {
      return { outcome: 'dismissed' };
    } finally {
      _deferredPrompt = null;
      _notifyPWAStatusListeners();
    }
  }
  if (status.mode === 'ios-guide') {
    _openIOSInstallGuideModal();
    return { outcome: 'guide' };
  }
  if (allowBrowserGuide) {
    _openBrowserInstallGuideModal();
    return { outcome: 'guide' };
  }
  return { outcome: 'unavailable' };
}

export function initPWA({ installBtn = null, offlineIndicator = null, onUpdateAvailable = null } = {}) {
  if (typeof window === 'undefined') return;

  _isInstalled = _isStandaloneMode();

  const syncInstallButton = () => {
    if (!installBtn) return;
    const status = getPWAInstallState();
    const visible = status.mode === 'prompt' || status.mode === 'ios-guide';
    installBtn.classList.toggle('hidden', !visible);
    installBtn.setAttribute('aria-hidden', String(!visible));
    if (status.mode === 'ios-guide') {
      installBtn.title = 'Installa su iPhone o iPad';
    } else {
      installBtn.title = 'Installa applicazione';
    }
  };

  const syncOnlineIndicator = () => {
    if (!offlineIndicator) return;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    offlineIndicator.classList.toggle('hidden', !offline);
    offlineIndicator.classList.toggle('flex', offline);
  };

  if (!_initialized) {
    _initialized = true;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      _deferredPrompt = e;
      _notifyPWAStatusListeners();
    });

    window.addEventListener('appinstalled', () => {
      _isInstalled = true;
      _deferredPrompt = null;
      _notifyPWAStatusListeners();
    });

    window.addEventListener('online', syncOnlineIndicator);
    window.addEventListener('offline', syncOnlineIndicator);

    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        if (typeof registerSW !== 'function') return;
        registerSW({
          immediate: true,
          onNeedRefresh() {
            onUpdateAvailable?.();
          }
        });
      })
      .catch(() => {
        // Safe fallback in singlefile builds or unsupported environments
      });
  }

  onPWAStatusChanged(syncInstallButton);

  installBtn?.addEventListener('click', () => {
    triggerPWAInstall({ allowBrowserGuide: false });
  });

  syncInstallButton();
  syncOnlineIndicator();
}
