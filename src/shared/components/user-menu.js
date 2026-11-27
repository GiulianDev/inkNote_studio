/**
 * @module components/user-menu
 *
 * Componente riutilizzabile del menu account utente (`<ink-menu id="userAuthMenu">`).
 * Montato una sola volta su `document.body` e condiviso tra Libreria ed Editor,
 * ancorato dinamicamente al bottone avatar che lo apre.
 */

import userMenuHtml from './user-menu.html?raw';
import {
  createFloatingMenu,
  closeAllFloatingMenus,
  closeFloatingMenuById,
  isFloatingMenuOpen
} from './floating-menu.js';

export const USER_MENU_ID = 'userAuthMenu';

let _menuCtrl = null;
let _activeTrigger = null;
let _bound = false;

function _ensureMounted() {
  let panel = document.getElementById(USER_MENU_ID);
  if (!panel && typeof document !== 'undefined' && document.body) {
    document.body.insertAdjacentHTML('beforeend', userMenuHtml);
    panel = document.getElementById(USER_MENU_ID);
  }
  return panel;
}

/**
 * Inizializza il menu account condiviso e collega le azioni utente.
 * @param {object} [handlers]
 * @param {() => void} [handlers.onOpenSharing]
 * @param {() => void} [handlers.onCopyInvite]
 * @param {() => void} [handlers.onLogout]
 */
export function initUserMenu({ onOpenSync, onOpenSharing, onCopyInvite, onLogout } = {}) {
  const panel = _ensureMounted();
  if (!panel) return null;

  if (!_menuCtrl) {
    _menuCtrl = createFloatingMenu({
      id: USER_MENU_ID,
      panel,
      trigger: () => _activeTrigger,
      align: 'end',
      gap: 8,
      onClose: () => {
        _activeTrigger = null;
      }
    });
  }

  if (!_bound) {
    _bound = true;
    document.getElementById('userAuthMenuSyncBtn')?.addEventListener('click', () => {
      closeAllFloatingMenus();
      onOpenSync?.();
    });
    document.getElementById('userAuthMenuSharingBtn')?.addEventListener('click', () => {
      closeAllFloatingMenus();
      onOpenSharing?.();
    });
    document.getElementById('userAuthMenuCopyInviteBtn')?.addEventListener('click', () => {
      closeAllFloatingMenus();
      onCopyInvite?.();
    });
    document.getElementById('userAuthMenuLogoutBtn')?.addEventListener('click', () => {
      onLogout?.();
    });
  }

  return _menuCtrl;
}

/**
 * Apre o chiude il menu utente ancorandolo al trigger specificato.
 * @param {HTMLElement|null} triggerEl
 */
export function toggleUserMenuForTrigger(triggerEl) {
  if (!triggerEl) return;
  if (!_menuCtrl) initUserMenu();
  if (!_menuCtrl) return;

  if (_menuCtrl.isOpen() && _activeTrigger === triggerEl) {
    _menuCtrl.close();
    return;
  }

  if (_menuCtrl.isOpen()) {
    _menuCtrl.close();
  }

  if (!triggerEl.hasAttribute('aria-haspopup')) {
    triggerEl.setAttribute('aria-haspopup', 'menu');
  }
  _activeTrigger = triggerEl;
  _menuCtrl.open();
}

export function closeUserMenu() {
  closeFloatingMenuById(USER_MENU_ID);
}

export function isUserMenuOpen() {
  return isFloatingMenuOpen(USER_MENU_ID);
}

/**
 * Aggiorna i dati profilo mostrati nell'header del menu utente condiviso.
 * @param {object|null} user
 * @param {string} [avatarHtml]
 */
export function syncUserMenuUser(user, avatarHtml = '') {
  const panel = _ensureMounted();
  if (!panel) return;

  const avatarEl = document.getElementById('userAuthMenuAvatar');
  const nameEl   = document.getElementById('userAuthMenuName');
  const emailEl  = document.getElementById('userAuthMenuEmail');

  if (!user) {
    closeUserMenu();
    if (avatarEl) avatarEl.innerHTML = '';
    if (nameEl) nameEl.textContent = '';
    if (emailEl) emailEl.textContent = '';
    return;
  }

  if (avatarEl) {
    avatarEl.className = 'w-10 h-10 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0';
    avatarEl.innerHTML = avatarHtml;
  }
  if (nameEl) nameEl.textContent = user.displayName || 'Utente';
  if (emailEl) emailEl.textContent = user.email || '';
}

/**
 * Aggiorna il contatore messaggi in arrivo e l'@handle nel menu utente condiviso.
 * @param {object} opts
 * @param {number} [opts.unreadCount=0]
 * @param {string} [opts.handle='']
 */
export function syncUserMenuSharing({ unreadCount = 0, handle = '' } = {}) {
  const badgeEl  = document.getElementById('userAuthMenuInboxBadge');
  const handleEl = document.getElementById('userAuthMenuHandle');

  if (badgeEl) {
    badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    badgeEl.classList.toggle('hidden', unreadCount === 0);
  }
  if (handleEl) {
    handleEl.textContent = handle ? `@${handle}` : '';
    handleEl.classList.toggle('hidden', !handle);
  }
}

export function syncUserMenuCloudStatus({ subtitle = 'Manuale' } = {}) {
  const metaEl = document.getElementById('userAuthMenuSyncMeta');
  if (metaEl) {
    metaEl.textContent = subtitle || 'Manuale';
  }
}
