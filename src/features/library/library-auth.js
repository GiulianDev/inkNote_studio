// ============================================================
// LIBRERIA — AUTENTICAZIONE GOOGLE & UI PROFILO
// ============================================================

import { escapeHtml, showToast } from '../../core/utils.js';
import { authState } from '../../core/state.js';
import { signInWithGoogle, signOutGoogle, onAuthChange } from '../../services/firebase.js';
import {
  initSharingSession,
  openSharingModal,
  copyMyInviteLink,
  handleGoogleAuthError
} from '../sharing/sharing-ui.js';

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

function _syncTargetAuthDOM({ btnId, contentId, dropdownId, avatarId, nameId, emailId }) {
  const btn = document.getElementById(btnId);
  const content = document.getElementById(contentId);
  const dropdown = document.getElementById(dropdownId);
  if (!btn || !content) return;

  if (authState.user) {
    btn.title = 'Profilo';
    content.className = 'flex items-center justify-center w-full h-full';
    content.innerHTML = _renderAvatarHtml(authState.user, 40);

    const dAvatar = document.getElementById(avatarId);
    const dName = document.getElementById(nameId);
    const dEmail = document.getElementById(emailId);
    if (dAvatar) {
      dAvatar.className = 'w-10 h-10 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0';
      dAvatar.innerHTML = _renderAvatarHtml(authState.user, 40);
    }
    if (dName) dName.textContent = authState.user.displayName || 'Utente';
    if (dEmail) dEmail.textContent = authState.user.email || '';
  } else {
    btn.title = 'Accedi con Google';
    content.className = 'flex items-center justify-center w-full h-full text-base';
    content.innerHTML = GUEST_ICON_SVG;
    if (dropdown) dropdown.classList.add('hidden');
  }
}

function _updateAuthUI() {
  _syncTargetAuthDOM({
    btnId: 'authBtn',
    contentId: 'authBtnContent',
    dropdownId: 'authDropdown',
    avatarId: 'authDropdownAvatar',
    nameId: 'authDropdownName',
    emailId: 'authDropdownEmail'
  });
  _syncTargetAuthDOM({
    btnId: 'editorAuthBtn',
    contentId: 'editorAuthBtnContent',
    dropdownId: 'editorAuthDropdown',
    avatarId: 'editorAuthDropdownAvatar',
    nameId: 'editorAuthDropdownName',
    emailId: 'editorAuthDropdownEmail'
  });
}

export function closeAllAuthDropdowns() {
  document.getElementById('authDropdown')?.classList.add('hidden');
  document.getElementById('editorAuthDropdown')?.classList.add('hidden');
}

async function _handleAuthClick(dropdownId = 'authDropdown') {
  if (authState.loading) return;

  if (authState.user) {
    const otherId = dropdownId === 'authDropdown' ? 'editorAuthDropdown' : 'authDropdown';
    document.getElementById(otherId)?.classList.add('hidden');
    document.getElementById(dropdownId)?.classList.toggle('hidden');
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
    authState.user = user;
    authState.loading = false;
    _updateAuthUI();
    void initSharingSession(user);
  });

  document.addEventListener('click', (e) => {
    for (const [containerId, dropdownId] of [
      ['authContainer', 'authDropdown'],
      ['editorAuthContainer', 'editorAuthDropdown']
    ]) {
      const container = document.getElementById(containerId);
      const dropdown = document.getElementById(dropdownId);
      if (container && dropdown && !dropdown.classList.contains('hidden')) {
        if (!container.contains(e.target)) dropdown.classList.add('hidden');
      }
    }
  });

  document.getElementById('authBtn')?.addEventListener('click', () => _handleAuthClick('authDropdown'));
  document.getElementById('authDropdownSharingBtn')?.addEventListener('click', () => {
    closeAllAuthDropdowns();
    openSharingModal({ initialTab: 'inbox' });
  });
  document.getElementById('authDropdownCopyInviteBtn')?.addEventListener('click', () => {
    closeAllAuthDropdowns();
    void copyMyInviteLink();
  });
  document.getElementById('authLogoutBtn')?.addEventListener('click', _handleLogout);

  document.getElementById('editorAuthBtn')?.addEventListener('click', () => _handleAuthClick('editorAuthDropdown'));
  document.getElementById('editorAuthDropdownSharingBtn')?.addEventListener('click', () => {
    closeAllAuthDropdowns();
    openSharingModal({ initialTab: 'inbox' });
  });
  document.getElementById('editorAuthDropdownCopyInviteBtn')?.addEventListener('click', () => {
    closeAllAuthDropdowns();
    void copyMyInviteLink();
  });
  document.getElementById('editorAuthLogoutBtn')?.addEventListener('click', _handleLogout);

  _updateAuthUI();
}
