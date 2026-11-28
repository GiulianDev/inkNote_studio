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

function _isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator?.standalone === true
  );
}

function _openIOSInstallGuideModal() {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full shadow-2xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 class="text-base font-bold text-slate-900 dark:text-white">Installa InkNote Studio</h3>
      <p class="text-xs text-slate-600 dark:text-slate-300 mt-2 leading-relaxed">
        Per usare l’app a schermo intero e offline su iPhone o iPad:
      </p>
      <ol class="text-xs text-slate-700 dark:text-slate-200 mt-3 space-y-1.5 list-decimal list-inside leading-relaxed">
        <li>Tocca il pulsante <strong>Condividi</strong> nella barra di Safari.</li>
        <li>Scorri e seleziona <strong>Aggiungi alla schermata Home</strong>.</li>
        <li>Conferma toccando <strong>Aggiungi</strong> in alto a destra.</li>
      </ol>
      <div class="flex justify-end mt-5">
        <button type="button" data-pwa-guide-close
          class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-sm transition cursor-pointer">
          Ho capito
        </button>
      </div>
    </div>
  `;

  const ctrl = openModalOverlay(overlay, {
    id: 'pwaIosGuide',
    ariaLabel: 'Installa InkNote Studio'
  });

  overlay.querySelector('[data-pwa-guide-close]')?.addEventListener('click', () => {
    ctrl.close('ok');
  });
}

export function initPWA({ installBtn = null, offlineIndicator = null, onUpdateAvailable = null } = {}) {
  if (typeof window === 'undefined') return;

  let deferredPrompt = null;
  let isInstalled = _isStandaloneMode();

  const syncInstallButton = () => {
    if (!installBtn) return;
    const status = classifyInstallPlatform({
      userAgent: window.navigator?.userAgent || '',
      maxTouchPoints: window.navigator?.maxTouchPoints || 0,
      isStandalone: isInstalled,
      hasDeferredPrompt: Boolean(deferredPrompt)
    });
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

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    syncInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    isInstalled = true;
    deferredPrompt = null;
    syncInstallButton();
  });

  installBtn?.addEventListener('click', async () => {
    const status = classifyInstallPlatform({
      userAgent: window.navigator?.userAgent || '',
      maxTouchPoints: window.navigator?.maxTouchPoints || 0,
      isStandalone: isInstalled,
      hasDeferredPrompt: Boolean(deferredPrompt)
    });
    if (status.mode === 'prompt' && deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice?.outcome === 'accepted') {
          isInstalled = true;
        }
      } catch {
        // ignore prompt cancellation errors
      } finally {
        deferredPrompt = null;
        syncInstallButton();
      }
    } else if (status.mode === 'ios-guide') {
      _openIOSInstallGuideModal();
    }
  });

  window.addEventListener('online', syncOnlineIndicator);
  window.addEventListener('offline', syncOnlineIndicator);

  syncInstallButton();
  syncOnlineIndicator();

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
