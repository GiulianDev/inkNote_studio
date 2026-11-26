// ============================================================
// LIBRERIA — AUTENTICAZIONE GOOGLE & UI PROFILO
// ============================================================

import { escapeHtml, showToast } from '../core/utils.js';
import { authState } from '../core/state.js';
import { signInWithGoogle, signOutGoogle, onAuthChange } from '../services/firebase.js';
import {
  initSharingSession,
  openSharingModal,
  copyMyInviteLink,
  handleGoogleAuthError
} from '../sharing/sharing-ui.js';
import {
  initUserMenu,
  toggleUserMenuForTrigger,
  closeUserMenu,
  syncUserMenuUser
} from '../components/user-menu.js';
import { syncSendMenuAuthState } from '../../notebook/toolbar/toolbar.js';

const AVATAR_PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
  '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#a855f7'
];

const GUEST_ICON_SVG = `
  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>
  </svg>
`;

function _colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 31) + str.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function _getInitials(user) {
  const name = user.displayName || user.email || '';
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function _renderAvatarHtml(user, size) {
  if (user.photoURL) {
    return `<img src="${escapeHtml(user.photoURL)}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`;
  }
  const initials = _getInitials(user);
  const bg = _colorFromString(user.email || user.displayName || user.uid || '');
  return `<span class="flex items-center justify-center w-full h-full text-white font-bold" style="background-color: ${bg}; font-size: ${Math.round(size * 0.4)}px;">${escapeHtml(initials)}</span>`;
}

function _syncTriggerButtonDOM(btnId, contentId) {
  const btn = document.getElementById(btnId);
  const content = document.getElementById(contentId);
  if (!btn || !content) return;

  if (authState.user) {
    btn.title = 'Profilo';
    btn.setAttribute('aria-haspopup', 'menu');
    content.className = 'flex items-center justify-center w-full h-full';
    content.innerHTML = _renderAvatarHtml(authState.user, 40);
  } else {
    btn.title = 'Accedi con Google';
    btn.removeAttribute('aria-haspopup');
    btn.setAttribute('aria-expanded', 'false');
    content.className = 'flex items-center justify-center w-full h-full text-base';
    content.innerHTML = GUEST_ICON_SVG;
  }
}

function _updateAuthUI() {
  _syncTriggerButtonDOM('authBtn', 'authBtnContent');
  _syncTriggerButtonDOM('editorAuthBtn', 'editorAuthBtnContent');
  const avatarHtml = authState.user ? _renderAvatarHtml(authState.user, 40) : '';
  syncUserMenuUser(authState.user, avatarHtml);
  syncSendMenuAuthState();
}

export function closeAllAuthDropdowns() {
  closeUserMenu();
}

async function _handleAuthClick(triggerId) {
  if (authState.loading) return;

  if (authState.user) {
    toggleUserMenuForTrigger(document.getElementById(triggerId));
    return;
  }

  try {
    const user = await signInWithGoogle();
    if (user) {
      showToast(`Benvenuto, ${user.displayName || user.email}!`, '👋');
    }
  } catch (err) {
    await handleGoogleAuthError(err);
  }
}

async function _handleLogout() {
  try {
    await signOutGoogle();
    closeAllAuthDropdowns();
    showToast('Disconnesso', '👋');
  } catch (err) {
    console.error('[auth] signOut failed:', err);
    showToast('Logout fallito', '❌');
  }
}

/**
 * Inizializza lo stato Firebase Auth e collega i controlli dell'header libreria ed editor.
 */
export function bindLibraryAuth() {
  onAuthChange((user) => {
    const accountUser = user && !user.isAnonymous ? user : null;
    authState.user = accountUser;
    authState.loading = false;
    _updateAuthUI();
    void initSharingSession(accountUser);
  });

  initUserMenu({
    onOpenSharing: () => openSharingModal({ initialTab: 'inbox' }),
    onCopyInvite: () => { void copyMyInviteLink(); },
    onLogout: _handleLogout
  });

  document.getElementById('authBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void _handleAuthClick('authBtn');
  });

  document.getElementById('editorAuthBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void _handleAuthClick('editorAuthBtn');
  });

  _updateAuthUI();
}
