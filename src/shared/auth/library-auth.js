// ============================================================
// LIBRERIA — AUTENTICAZIONE GOOGLE & UI PROFILO + ISOLAMENTO ACCOUNT
// ============================================================

import { escapeHtml, showToast, showConfirmDialog, emit } from '../core/utils.js';
import { authState } from '../core/state.js';
import { signInWithGoogle, signOutGoogle, onAuthChange } from '../services/firebase.js';
import {
  setActiveLibraryOwnerUid,
  getGuestLibrarySummary,
  assignGuestLibraryItemsToOwner
} from '../services/db.js';
import { normalizeOwnerUid, shouldPromptGuestClaim } from '../services/db-scope-helpers.js';
import {
  getDismissedGuestClaimSignature,
  setDismissedGuestClaimSignature
} from '../sync/sync-helpers.js';
import { showProgressDialog } from '../backup/backup-progress.js';
import { broadcastTabEvent } from '../core/tab-sync.js';
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
import { openCloudSyncModal, refreshUserMenuSyncBadge } from '../sync/sync-ui.js';

const AVATAR_PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
  '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#a855f7'
];

const GUEST_ICON_SVG = `
  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>
  </svg>
`;

const AUTH_SPINNER_SVG = `
  <span class="w-4 h-4 rounded-full border-2 border-indigo-600 dark:border-indigo-400 border-t-transparent animate-spin" aria-hidden="true"></span>
`;

let _currentAccountUid;
let _authQueue = Promise.resolve();
let _authBusy = false;
let _initialTransitionDone = false;
let _resolveInitialTransition = null;
const _initialTransitionPromise = new Promise((resolve) => {
  _resolveInitialTransition = resolve;
});

let _lifecycleHandlers = {
  onBeforeAccountSwitch: null,
  onAccountChanged: null,
  onSetLoading: null,
  onResetLibrary: null
};

export function registerAuthLifecycleHandlers({
  onBeforeAccountSwitch,
  onAccountChanged,
  onSetLoading,
  onResetLibrary
} = {}) {
  _lifecycleHandlers = {
    onBeforeAccountSwitch: typeof onBeforeAccountSwitch === 'function' ? onBeforeAccountSwitch : null,
    onAccountChanged: typeof onAccountChanged === 'function' ? onAccountChanged : null,
    onSetLoading: typeof onSetLoading === 'function' ? onSetLoading : null,
    onResetLibrary: typeof onResetLibrary === 'function' ? onResetLibrary : null
  };
}

export function waitForInitialAuthTransition() {
  if (_initialTransitionDone) return Promise.resolve();
  return _initialTransitionPromise;
}

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

  btn.disabled = _authBusy;

  if (_authBusy) {
    btn.title = 'Operazione account in corso...';
    content.className = 'flex items-center justify-center w-full h-full';
    content.innerHTML = AUTH_SPINNER_SVG;
    return;
  }

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
  refreshUserMenuSyncBadge(authState.user);
  emit('auth:changed', { user: authState.user });
}

export function closeAllAuthDropdowns() {
  closeUserMenu();
}

function _formatGuestCountSummary(notebooksCount, foldersCount) {
  const parts = [];
  if (notebooksCount > 0) {
    parts.push(`${notebooksCount} quadern${notebooksCount === 1 ? 'o' : 'i'}`);
  }
  if (foldersCount > 0) {
    parts.push(`${foldersCount} raccolt${foldersCount === 1 ? 'a' : 'e'}`);
  }
  return parts.join(' e ');
}

async function _maybePromptClaimGuestItems(accountUser, { isInitial = false } = {}) {
  const uid = normalizeOwnerUid(accountUser?.uid);
  if (!uid) return;

  let summary;
  try {
    summary = await getGuestLibrarySummary();
  } catch (err) {
    console.warn('[auth] guest library summary check failed:', err);
    return;
  }

  // Su ricarica pagina con utente già connesso, rispetta la scelta precedente per la stessa firma;
  // al momento di un nuovo login esplicito, chiedi sempre se sono presenti elementi senza account.
  const dismissedSignature = isInitial ? getDismissedGuestClaimSignature(uid) : '';
  const shouldAsk = shouldPromptGuestClaim({
    uid,
    guestSummary: summary,
    signature: summary.signature,
    dismissedSignature
  });
  if (!shouldAsk) return;

  const itemsText = _formatGuestCountSummary(summary.notebooksCount, summary.foldersCount) || 'alcuni elementi';
  const accountLabel = accountUser.email || accountUser.displayName || 'questo profilo Google';

  const confirmed = await showConfirmDialog({
    title: 'Quaderni senza account trovati',
    message: `Sul dispositivo sono presenti ${itemsText} creati senza accesso. Vuoi associarli ora all’account "${accountLabel}"? Se scegli di lasciarli senza account, resteranno visibili solo dopo il logout.`,
    confirmText: 'Associa al mio account',
    cancelText: 'Lascia senza account'
  });

  if (confirmed) {
    const progress = showProgressDialog('Associazione al profilo...');
    progress.update({ done: 0, total: 0, label: 'Collegamento quaderni e raccolte...' });
    _lifecycleHandlers.onSetLoading?.(true, {
      title: 'Associazione quaderni...',
      subtitle: 'Collegamento al tuo account Google in corso'
    });
    try {
      const res = await assignGuestLibraryItemsToOwner(uid);
      setDismissedGuestClaimSignature(uid, '');
      broadcastTabEvent('library:mutated', { source: 'claim-guest', ownerUid: uid });
      await _lifecycleHandlers.onAccountChanged?.({
        uid,
        user: accountUser,
        isInitial: false,
        switchedAccount: false
      });
      emit('library:guest-claimed', { uid, ...res });
      showToast('Quaderni associati al tuo account', '✅');
    } catch (err) {
      console.error('[auth] assign guest library items failed:', err);
      showToast('Impossibile associare i quaderni senza account', '❌');
    } finally {
      _lifecycleHandlers.onSetLoading?.(false);
      progress.close();
    }
  } else {
    setDismissedGuestClaimSignature(uid, summary.signature);
  }
}

async function _processAuthTransition(accountUser) {
  const nextUid = normalizeOwnerUid(accountUser?.uid);
  const isInitial = _currentAccountUid === undefined;
  const prevUid = isInitial ? null : _currentAccountUid;
  const switchedAccount = !isInitial && prevUid !== nextUid;

  if (switchedAccount) {
    _lifecycleHandlers.onSetLoading?.(true, {
      title: nextUid ? 'Cambio account...' : 'Chiusura sessione...',
      subtitle: nextUid ? 'Caricamento della libreria dell’account' : 'Caricamento dei quaderni senza account'
    });
    await _lifecycleHandlers.onBeforeAccountSwitch?.({ prevUid, nextUid });
    _lifecycleHandlers.onResetLibrary?.();
  }

  _currentAccountUid = nextUid;
  setActiveLibraryOwnerUid(nextUid);
  authState.user = accountUser;
  authState.loading = false;
  _updateAuthUI();

  void initSharingSession(accountUser);

  try {
    await _lifecycleHandlers.onAccountChanged?.({
      uid: nextUid,
      user: accountUser,
      isInitial,
      switchedAccount
    });
  } finally {
    _lifecycleHandlers.onSetLoading?.(false);
    if (!_initialTransitionDone) {
      _initialTransitionDone = true;
      _resolveInitialTransition?.();
    }
  }

  if (accountUser && nextUid) {
    await _maybePromptClaimGuestItems(accountUser, { isInitial });
  }
}

function _enqueueAuthTransition(user) {
  const accountUser = user && !user.isAnonymous ? user : null;
  _authQueue = _authQueue
    .then(() => _processAuthTransition(accountUser))
    .catch((err) => {
      console.error('[auth] transition failed:', err);
      _lifecycleHandlers.onSetLoading?.(false);
      if (!_initialTransitionDone) {
        _initialTransitionDone = true;
        _resolveInitialTransition?.();
      }
    });
}

async function _handleAuthClick(triggerId) {
  if (authState.loading || _authBusy) return;

  if (authState.user) {
    toggleUserMenuForTrigger(document.getElementById(triggerId));
    return;
  }

  _authBusy = true;
  _updateAuthUI();
  try {
    const user = await signInWithGoogle();
    if (user) {
      showToast(`Benvenuto, ${user.displayName || user.email}!`, '👋');
    }
  } catch (err) {
    await handleGoogleAuthError(err);
  } finally {
    _authBusy = false;
    _updateAuthUI();
  }
}

async function _handleLogout() {
  if (_authBusy) return;
  closeAllAuthDropdowns();
  _authBusy = true;
  _updateAuthUI();

  const progress = showProgressDialog('Disconnessione in corso...');
  progress.update({ done: 0, total: 0, label: 'Salvataggio modifiche e chiusura sessione...' });
  _lifecycleHandlers.onSetLoading?.(true, {
    title: 'Disconnessione in corso...',
    subtitle: 'Ripristino libreria senza account'
  });

  try {
    const prevUid = normalizeOwnerUid(authState.user?.uid);
    await _lifecycleHandlers.onBeforeAccountSwitch?.({ prevUid, nextUid: null });
    await signOutGoogle();
    closeAllAuthDropdowns();
    showToast('Disconnesso', '👋');
  } catch (err) {
    console.error('[auth] signOut failed:', err);
    _lifecycleHandlers.onSetLoading?.(false);
    showToast('Logout fallito', '❌');
  } finally {
    _authBusy = false;
    _updateAuthUI();
    progress.close();
  }
}

/**
 * Inizializza lo stato Firebase Auth e collega i controlli dell'header libreria ed editor.
 */
export function bindLibraryAuth() {
  onAuthChange((user) => {
    _enqueueAuthTransition(user);
  });

  initUserMenu({
    onOpenSync: () => { void openCloudSyncModal(); },
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
