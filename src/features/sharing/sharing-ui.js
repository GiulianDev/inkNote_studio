/**
 * @module features/sharing/sharing-ui
 *
 * Gestione UI & notifiche real-time per:
 *   - Badge & notifiche (in-app toast + Browser Notification API) all'arrivo di un quaderno
 *   - Modale Condivisione (Ricevuti / Amici / Inviati) + Invio quaderno selezionato
 *   - Ricerca universale per email / @username + scansione Contatti Google
 */

import { escapeHtml, showToast, showConfirmDialog, emit } from '../../core/utils.js';
import { authState } from '../../core/state.js';
import { loadAllNotebooksFromDB } from '../../services/db.js';
import {
  isFirestoreReady,
  isGoogleLinkedUser,
  signInWithGoogle,
  consumePendingContactsAccessToken,
  getActiveFirebaseProjectId,
  getActiveFirebaseDatabaseId
} from '../../services/firebase.js';
import {
  ensureUserProfile,
  updateUserHandle,
  findUserByEmailOrHandle,
  findFriendsFromGoogleContacts,
  addFriend,
  removeFriend,
  subscribeFriends,
  sendNotebookToFriend,
  subscribeIncomingTransfers,
  listAndCleanupOutgoingTransfers,
  importIncomingTransfer,
  declineIncomingTransfer,
  deleteTransferWithChunks
} from '../../services/sharing-cloud.js';
import {
  formatRemainingTime,
  formatTransferSize,
  parseInviteHandleFromUrl,
  MAX_OUTGOING_TRANSFERS,
  checkOutgoingTransferQuota,
  formatAuthErrorMessage,
  formatFirestoreErrorMessage
} from './sharing-helpers.js';

const NOTIF_PREF_KEY = 'inknote_browser_notifications';
const PENDING_INVITE_KEY = 'inknote_pending_invite_handle';

let _profile = null;
let _friends = [];
let _incomingTransfers = [];
let _outgoingTransfers = [];
let _unsubFriends = null;
let _unsubInbox = null;
let _sessionUid = null;
let _sessionSyncError = '';
let _activeModalState = null;

// ============================================================
// HELPER NOTIFICHE BROWSER & AVATAR
// ============================================================

function _isBrowserNotifSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function _formatSharingError(err, fallback = 'Operazione non riuscita') {
  const authFormatted = formatAuthErrorMessage(err);
  if (authFormatted) return authFormatted;
  return formatFirestoreErrorMessage(err, {
    projectId: getActiveFirebaseProjectId(),
    databaseId: getActiveFirebaseDatabaseId(),
    fallback
  });
}

function _areBrowserNotifsActive() {
  if (!_isBrowserNotifSupported()) return false;
  return Notification.permission === 'granted' && localStorage.getItem(NOTIF_PREF_KEY) === '1';
}

async function _toggleBrowserNotifications() {
  if (!_isBrowserNotifSupported()) {
    showToast('Notifiche browser non supportate su questo dispositivo', 'ℹ️');
    return;
  }

  if (Notification.permission === 'denied') {
    showToast('Notifiche bloccate nelle impostazioni del browser', '⚠️');
    return;
  }

  if (_areBrowserNotifsActive()) {
    localStorage.setItem(NOTIF_PREF_KEY, '0');
    showToast('Notifiche browser disattivate', '🔕');
    _refreshActiveModal();
    return;
  }

  const perm = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();

  if (perm === 'granted') {
    localStorage.setItem(NOTIF_PREF_KEY, '1');
    showToast('Notifiche browser attive!', '🔔');
  } else {
    localStorage.setItem(NOTIF_PREF_KEY, '0');
    showToast('Permesso notifiche non concesso', 'ℹ️');
  }
  _refreshActiveModal();
}

function _fireIncomingNotifications(newTransfers) {
  if (!Array.isArray(newTransfers) || newTransfers.length === 0) return;

  const first = newTransfers[0];
  const msg = newTransfers.length === 1
    ? `${first.senderName} ti ha inviato "${first.notebookTitle}"`
    : `${newTransfers.length} nuovi quaderni ricevuti`;

  showToast(msg, '📥');

  if (_areBrowserNotifsActive()) {
    try {
      const notif = new Notification('Nuovo quaderno ricevuto — InkNote', {
        body: msg,
        tag: `inknote-transfer-${first.id}`
      });
      notif.onclick = () => {
        try { window.focus(); } catch {}
        openSharingModal({ initialTab: 'inbox' });
        notif.close();
      };
    } catch (err) {
      console.warn('[sharing] browser notification failed:', err);
    }
  }
}

function _safeHexColor(val) {
  return (typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val.trim())) ? val.trim() : '#4f46e5';
}

function _renderMiniAvatar(user, sizePx = 36) {
  const safePhoto = typeof user?.photoURL === 'string' && user.photoURL.startsWith('https://')
    ? user.photoURL
    : '';
  if (safePhoto) {
    return `<img src="${escapeHtml(safePhoto)}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`;
  }
  const name = (user?.displayName || user?.senderName || user?.handle || 'U').trim();
  const initials = name.slice(0, 2).toUpperCase();
  const palette = ['#6366f1', '#2563eb', '#059669', '#e11d48', '#d97706', '#8b5cf6', '#0d9488'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash * 31) + name.charCodeAt(i)) | 0;
  const bg = palette[Math.abs(hash) % palette.length];
  return `<span class="flex items-center justify-center w-full h-full text-white font-bold" style="background:${bg};font-size:${Math.round(sizePx * 0.38)}px;">${escapeHtml(initials)}</span>`;
}

// ============================================================
// BADGE & AUTH DROPDOWN SYNC
// ============================================================

function _syncSharingBadgesUI() {
  const count = _incomingTransfers.length;
  const targets = [
    {
      badgeId: 'authInboxBadge',
      btnId: 'authBtn',
      dropdownBadgeId: 'authDropdownInboxBadge',
      handleId: 'authDropdownHandle'
    },
    {
      badgeId: 'editorAuthInboxBadge',
      btnId: 'editorAuthBtn',
      dropdownBadgeId: 'editorAuthDropdownInboxBadge',
      handleId: 'editorAuthDropdownHandle'
    }
  ];

  for (const t of targets) {
    const badge = document.getElementById(t.badgeId);
    const btn = document.getElementById(t.btnId);
    const dropdownBadge = document.getElementById(t.dropdownBadgeId);
    const handleEl = document.getElementById(t.handleId);

    if (badge) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.toggle('hidden', count === 0);
      badge.classList.toggle('flex', count > 0);
    }
    if (btn) {
      btn.classList.toggle('is-has-unread', count > 0);
      if (count > 0) {
        btn.title = `Profilo (${count} quadern${count === 1 ? 'o' : 'i'} in attesa)`;
      } else if (btn.title.includes('in attesa')) {
        btn.title = 'Profilo';
      }
    }
    if (dropdownBadge) {
      dropdownBadge.textContent = count > 99 ? '99+' : String(count);
      dropdownBadge.classList.toggle('hidden', count === 0);
    }
    if (handleEl) {
      handleEl.textContent = _profile?.handle ? `@${_profile.handle}` : '';
      handleEl.classList.toggle('hidden', !_profile?.handle);
    }
  }
}

export function getUnreadTransfersCount() {
  return _incomingTransfers.length;
}

export function getCurrentSharingProfile() {
  return _profile;
}

export async function copyMyInviteLink() {
  if (!_profile?.handle) {
    showToast('Accedi prima per generare il tuo link invito', 'ℹ️');
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?addFriend=${encodeURIComponent(_profile.handle)}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link invito copiato negli appunti!', '🔗');
  } catch {
    showToast(`Codice amico: @${_profile.handle}`, '🔗');
  }
}

export async function handleGoogleAuthError(err) {
  const code = err?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return;
  }
  if (code === 'auth/unauthorized-domain') {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const projectId = getActiveFirebaseProjectId() || 'Firebase';
    console.warn(`[auth] Dominio non autorizzato su ${projectId}:`, host);
    const shouldCopy = await showConfirmDialog({
      title: 'Dominio non autorizzato in Firebase Auth',
      message: `Aggiungi "${host}" nella Firebase Console di "${projectId}" (Authentication → Settings → Authorized domains) per abilitare l'accesso da questo URL.`,
      confirmText: 'Copia dominio',
      cancelText: 'Chiudi'
    });
    if (shouldCopy && host) {
      try {
        await navigator.clipboard.writeText(host);
        showToast('Dominio copiato negli appunti!', '📋');
      } catch {
        showToast(host, 'ℹ️', 4500);
      }
    }
    return;
  }
  if (code === 'auth/popup-blocked') {
    console.warn('[auth] popup blocked by browser');
    showToast('Popup di accesso bloccato dal browser: consenti i popup e riprova', '⚠️', 4000);
    return;
  }
  console.warn('[auth] Google sign-in error:', code || err);
  showToast('Accesso Google non riuscito', '❌');
}

// ============================================================
// SESSIONE REALTIME ALL'ACCESSO / LOGOUT
// ============================================================

function _teardownSharingListeners() {
  if (_unsubFriends) { try { _unsubFriends(); } catch {} _unsubFriends = null; }
  if (_unsubInbox) { try { _unsubInbox(); } catch {} _unsubInbox = null; }
}

async function _consumeInviteHandleIfAny() {
  const fromUrl = parseInviteHandleFromUrl(window.location.search);
  if (fromUrl) {
    sessionStorage.setItem(PENDING_INVITE_KEY, fromUrl);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('addFriend');
      url.searchParams.delete('friend');
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {}
  }

  const pendingHandle = sessionStorage.getItem(PENDING_INVITE_KEY) || '';
  if (!pendingHandle || !authState.user || !isFirestoreReady()) return;

  sessionStorage.removeItem(PENDING_INVITE_KEY);
  if (_profile?.handle && pendingHandle === _profile.handle) return;

  try {
    const found = await findUserByEmailOrHandle(`@${pendingHandle}`);
    if (!found) {
      showToast(`Utente @${pendingHandle} non trovato`, 'ℹ️');
      return;
    }
    const already = _friends.some(f => f.uid === found.uid);
    if (already) {
      showToast(`${found.displayName} è già nei tuoi amici`, '👋');
      return;
    }
    const ok = await showConfirmDialog({
      title: `Aggiungere ${found.displayName} agli amici?`,
      message: `Codice amico: @${found.handle}. Potrete inviarvi quaderni direttamente dentro InkNote Studio.`,
      confirmText: 'Aggiungi amico',
      cancelText: 'Ignora'
    });
    if (ok) {
      await addFriend(found, 'manual');
      showToast(`${found.displayName} aggiunto agli amici!`, '🤝');
    }
  } catch (err) {
    console.warn('[sharing] invite consume failed:', err);
  }
}

export async function initSharingSession(user) {
  const nextUid = user?.uid || null;
  if (_sessionUid === nextUid && (nextUid === null || _unsubInbox)) {
    return;
  }

  _teardownSharingListeners();
  _sessionUid = nextUid;
  _sessionSyncError = '';
  _profile = null;
  _friends = [];
  _incomingTransfers = [];
  _outgoingTransfers = [];
  _syncSharingBadgesUI();

  if (!user || !isFirestoreReady()) {
    const fromUrl = parseInviteHandleFromUrl(window.location.search);
    if (fromUrl) {
      sessionStorage.setItem(PENDING_INVITE_KEY, fromUrl);
    }
    _refreshActiveModal();
    return;
  }

  try {
    _profile = await ensureUserProfile(user);
    _syncSharingBadgesUI();
  } catch (err) {
    console.error('[sharing] ensureUserProfile failed:', err);
    _sessionSyncError = _formatSharingError(err, 'Connessione a Firestore non riuscita');
  }

  _unsubFriends = subscribeFriends(user.uid, (friendsList) => {
    _friends = friendsList;
    _refreshActiveModal();
  });

  _unsubInbox = subscribeIncomingTransfers(user.uid, {
    onUpdate: (items) => {
      _incomingTransfers = items;
      _syncSharingBadgesUI();
      _refreshActiveModal();
    },
    onNewIncoming: (newItems) => {
      _fireIncomingNotifications(newItems);
    }
  });

  // Pulizia automatica eventuali inviati scaduti (> 24h)
  try {
    _outgoingTransfers = await listAndCleanupOutgoingTransfers(user.uid);
  } catch (err) {
    console.warn('[sharing] cleanup outgoing failed:', err);
  }

  // Se arrivati da un link invito ?addFriend=... o da redirect contatti mobile
  await _consumeInviteHandleIfAny();

  const redirectContactsToken = consumePendingContactsAccessToken();
  if (redirectContactsToken) {
    openSharingModal({ initialTab: 'friends', autoScanContacts: true });
  }

  _refreshActiveModal();
}

// ============================================================
// MODALE CONDIVISIONE (RICEVUTI / AMICI / INVIATI / INVIA)
// ============================================================

function _refreshActiveModal() {
  if (_activeModalState && typeof _activeModalState.render === 'function') {
    _activeModalState.render();
  }
}

export async function openSharingModal({
  initialTab = 'inbox',
  sendNotebooks = null,
  autoScanContacts = false
} = {}) {
  // Se già aperto, chiudi quello precedente
  if (_activeModalState?.close) {
    _activeModalState.close();
  }

  const isSendMode = Array.isArray(sendNotebooks) && sendNotebooks.length > 0;
  let activeTab = isSendMode ? 'send' : initialTab;
  let searchLoading = false;
  let searchResult = null;
  let searchError = '';
  let contactsLoading = false;
  let contactsMatches = null;
  let contactsScannedTotal = 0;
  let contactsError = '';
  let transferBusyId = null;
  let importStatusText = '';
  let lastImportedInfo = null;
  let sendingToUid = null;
  let sendStatusText = '';
  let editingHandle = false;
  let localNotebooksCache = null;
  let sendModeManageSent = false;

  if (authState.user && isFirestoreReady()) {
    listAndCleanupOutgoingTransfers(authState.user.uid)
      .then((list) => {
        _outgoingTransfers = list;
        _refreshActiveModal();
      })
      .catch(() => {});
  }

  const overlay = document.createElement('div');
  overlay.id = 'sharingModal';
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4 library-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', isSendMode ? 'Invia quaderno' : 'Ricevuti e Amici');

  const cleanup = () => {
    if (_activeModalState?.overlay !== overlay) return;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    _activeModalState = null;
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown, true);

  const renderSignedOutBody = () => `
    <div class="p-6 text-center space-y-4">
      <div class="w-14 h-14 mx-auto rounded-2xl bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
        <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      </div>
      <div>
        <h4 class="text-base font-bold text-slate-900 dark:text-white">Condividi quaderni con gli amici</h4>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed max-w-sm mx-auto">
          Accedi con Google per ricevere quaderni in tempo reale, aggiungere amici per email o codice e inviare i tuoi appunti.
          I file inviati restano temporaneamente su cloud e si cancellano automaticamente dopo 24 ore.
        </p>
      </div>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
        <button type="button" data-action="login-google"
          class="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-4 py-2.5 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-700 font-semibold text-xs rounded-xl shadow-sm transition cursor-pointer">
          <svg class="w-4 h-4 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          <span>Accedi con Google</span>
        </button>
        <a href="privacy.html" target="_blank" rel="noopener noreferrer"
          class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
          Privacy Policy
        </a>
      </div>
    </div>
  `;

  const renderProfileStrip = () => {
    if (!authState.user) return '';
    const notifsActive = _areBrowserNotifsActive();
    const handle = _profile?.handle || '';

    return `
      <div class="px-5 py-3 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-full overflow-hidden shrink-0 border border-slate-300 dark:border-slate-700">
            ${_renderMiniAvatar(authState.user, 36)}
          </div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(authState.user.displayName || 'Utente')}</div>
            ${editingHandle ? `
              <form data-form="edit-handle" class="flex items-center gap-1 mt-0.5">
                <span class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">@</span>
                <input type="text" id="sharingEditHandleInput" value="${escapeHtml(handle)}" maxlength="24"
                  class="w-32 bg-white dark:bg-slate-900 border border-indigo-400 rounded-lg px-2 py-0.5 text-[11px] font-semibold text-slate-900 dark:text-white outline-none">
                <button type="submit" class="px-2 py-0.5 rounded-lg bg-indigo-600 text-white text-[10px] font-semibold cursor-pointer">Salva</button>
                <button type="button" data-action="cancel-handle" class="px-1.5 py-0.5 rounded-lg text-slate-500 text-[10px] font-semibold cursor-pointer">Annulla</button>
              </form>
            ` : `
              <div class="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <span class="font-semibold text-indigo-600 dark:text-indigo-400">@${escapeHtml(handle || '...')}</span>
                <button type="button" data-action="start-edit-handle" title="Cambia @username"
                  class="text-[10px] underline hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer">modifica</button>
                <span>·</span>
                <button type="button" data-action="copy-invite"
                  class="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer">Copia link invito</button>
              </div>
            `}
          </div>
        </div>

        <button type="button" data-action="toggle-browser-notifs"
          class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-semibold border transition cursor-pointer ${
            notifsActive
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
          }">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
          </svg>
          <span>${notifsActive ? 'Notifiche attive' : 'Attiva notifiche'}</span>
        </button>
      </div>
    `;
  };

  const renderTabsBar = () => {
    if (isSendMode) return '';
    const tabs = [
      { id: 'inbox', label: 'Ricevuti', count: _incomingTransfers.length },
      { id: 'friends', label: 'Amici', count: _friends.length },
      { id: 'sent', label: 'Inviati', count: _outgoingTransfers.length }
    ];
    return `
      <div class="px-5 pt-3 flex items-center gap-1.5 border-b border-slate-200 dark:border-slate-800">
        ${tabs.map(t => {
          const isActive = activeTab === t.id;
          return `
            <button type="button" data-tab="${t.id}"
              class="px-3 py-2 text-xs font-semibold rounded-t-xl border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
                isActive
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/30'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }">
              <span>${escapeHtml(t.label)}</span>
              ${t.count > 0 ? `<span class="px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                isActive
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }">${t.count}</span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    `;
  };

  const renderInboxTab = () => {
    const importedBanner = lastImportedInfo ? `
      <div data-import-success-banner class="mb-3.5 p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-start gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-emerald-900 dark:text-emerald-200">Quaderno importato con successo!</div>
            <div class="text-[11px] text-emerald-700 dark:text-emerald-300/90 mt-0.5 truncate">
              "${escapeHtml(lastImportedInfo.title)}" salvato nella libreria${lastImportedInfo.senderName ? ` (da ${escapeHtml(lastImportedInfo.senderName)})` : ''}.
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
          ${lastImportedInfo.id ? `
            <button type="button" data-action="open-imported-nb" data-nb-id="${escapeHtml(lastImportedInfo.id)}"
              class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold shadow-sm cursor-pointer">
              Apri quaderno
            </button>
          ` : ''}
          <button type="button" data-action="dismiss-import-banner" aria-label="Chiudi avviso"
            class="p-1.5 rounded-xl text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 cursor-pointer">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>
    ` : '';

    if (_incomingTransfers.length === 0) {
      return `
        ${importedBanner}
        <div class="py-12 text-center space-y-2">
          <div class="w-12 h-12 mx-auto rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center">
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
          </div>
          <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Nessun quaderno in arrivo</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">Quando un amico ti invierà un quaderno apparirà qui in tempo reale.</p>
        </div>
      `;
    }

    const friendIds = new Set(_friends.map(f => f.uid));

    return `
      ${importedBanner}
      ${importStatusText ? `<div class="mb-3 p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-xs font-medium text-indigo-700 dark:text-indigo-300">${escapeHtml(importStatusText)}</div>` : ''}
      <div class="space-y-2.5">
        ${_incomingTransfers.map(t => {
          const isBusy = transferBusyId === t.id;
          const ttlLabel = formatRemainingTime(t.expiresAt);
          const isFriend = friendIds.has(t.senderUid);
          return `
            <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-12 rounded-md shrink-0 shadow-sm relative overflow-hidden" style="background:${_safeHexColor(t.coverColor)}">
                  <span class="absolute inset-y-0 left-0 w-1.5 bg-black/25"></span>
                </div>
                <div class="min-w-0">
                  <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(t.notebookTitle)}</div>
                  <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Da <strong class="text-slate-700 dark:text-slate-200">${escapeHtml(t.senderName)}</strong>
                    ${t.senderHandle ? `<span>(@${escapeHtml(t.senderHandle)})</span>` : ''}
                  </div>
                  <div class="flex flex-wrap items-center gap-2 mt-1 text-[10px] font-medium text-slate-500 dark:text-slate-400">
                    <span>${escapeHtml(String(t.pageCount || 1))} pag.</span>
                    <span>·</span>
                    <span>${escapeHtml(formatTransferSize(t.byteSize))}</span>
                    <span>·</span>
                    <span class="text-amber-600 dark:text-amber-400 font-semibold">Scade tra ${escapeHtml(ttlLabel)}</span>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                ${!isFriend ? `
                  <button type="button" data-action="add-sender-friend" data-transfer-id="${escapeHtml(t.id)}" ${isBusy ? 'disabled' : ''}
                    title="Salva mittente negli amici"
                    class="px-2.5 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold cursor-pointer">
                    + Amico
                  </button>
                ` : ''}
                <button type="button" data-action="decline-transfer" data-transfer-id="${escapeHtml(t.id)}" ${isBusy ? 'disabled' : ''}
                  class="px-2.5 py-1.5 rounded-xl text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-[11px] font-semibold cursor-pointer disabled:opacity-40">
                  Rifiuta
                </button>
                <button type="button" data-action="import-transfer" data-transfer-id="${escapeHtml(t.id)}" ${isBusy ? 'disabled' : ''}
                  class="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold shadow-sm cursor-pointer disabled:opacity-50">
                  ${isBusy ? 'Importo...' : 'Importa'}
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  };

  const renderQuotaPill = (count) => {
    const toneClass = count >= MAX_OUTGOING_TRANSFERS
      ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800/70'
      : (count >= MAX_OUTGOING_TRANSFERS - 2
        ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/70'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700');
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${toneClass} shrink-0">${count}/${MAX_OUTGOING_TRANSFERS} attivi</span>`;
  };

  const renderSentTab = () => {
    const activeCount = _outgoingTransfers.length;
    const sentHeader = `
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          ${isSendMode ? `
            <button type="button" data-action="back-to-send" class="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer">← Torna all'invio</button>
            <span class="text-slate-300 dark:text-slate-700">·</span>
          ` : ''}
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            Limite invii simultanei
          </span>
        </div>
        ${renderQuotaPill(activeCount)}
      </div>
    `;

    if (activeCount === 0) {
      return `
        ${sentHeader}
        <div class="py-12 text-center space-y-2">
          <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Nessun invio in sospeso</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Puoi tenere fino a ${MAX_OUTGOING_TRANSFERS} quaderni in attesa contemporaneamente. Quelli già importati o scaduti dopo 24 ore si eliminano da soli.
          </p>
        </div>
      `;
    }

    return `
      ${sentHeader}
      <div class="space-y-2.5">
        <p class="text-[11px] text-slate-500 dark:text-slate-400">
          In attesa che il destinatario li scarichi (auto-eliminazione dopo 24 ore):
        </p>
        ${_outgoingTransfers.map(t => {
          const isBusy = transferBusyId === t.id;
          return `
            <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-9 h-11 rounded-md shrink-0 relative overflow-hidden" style="background:${_safeHexColor(t.coverColor)}">
                  <span class="absolute inset-y-0 left-0 w-1 bg-black/25"></span>
                </div>
                <div class="min-w-0">
                  <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(t.notebookTitle)}</div>
                  <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    A <strong class="text-slate-700 dark:text-slate-200">${escapeHtml(t.recipientName)}</strong> · Scade tra ${escapeHtml(formatRemainingTime(t.expiresAt))}
                  </div>
                </div>
              </div>
              <button type="button" data-action="cancel-outgoing" data-transfer-id="${escapeHtml(t.id)}" ${isBusy ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-xl text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-[11px] font-semibold shrink-0 cursor-pointer disabled:opacity-40">
                ${isBusy ? 'Annullo...' : 'Annulla invio'}
              </button>
            </div>
          `;
        }).join('')}
      </div>
    `;
  };

  const renderFriendsAndSendSection = () => {
    const isGoogle = isGoogleLinkedUser(authState.user);
    const friendIds = new Set(_friends.map(f => f.uid));
    const sendQuota = checkOutgoingTransferQuota(_outgoingTransfers, isSendMode ? sendNotebooks.length : 1, MAX_OUTGOING_TRANSFERS);
    const sendBlockedByQuota = isSendMode && !sendQuota.allowed;

    const sendBanner = isSendMode ? `
      <div class="p-3.5 rounded-2xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900/70 mb-4 space-y-2.5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs font-bold text-indigo-900 dark:text-indigo-200 truncate">
              ${sendNotebooks.length === 1
                ? `Invio quaderno: "${escapeHtml(sendNotebooks[0].title || 'Quaderno')}"`
                : `Invio di ${sendNotebooks.length} quaderni selezionati`}
            </div>
            <div class="text-[11px] text-indigo-700/80 dark:text-indigo-300/80 mt-0.5">
              ${sendStatusText
                ? escapeHtml(sendStatusText)
                : `Disponibile per il destinatario per 24 ore · max ${MAX_OUTGOING_TRANSFERS} in coda contemporanea.`}
            </div>
          </div>
          ${renderQuotaPill(sendQuota.currentCount)}
        </div>
        ${sendBlockedByQuota ? `
          <div class="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <p class="text-[11px] font-medium text-rose-700 dark:text-rose-300">
              ${sendQuota.remaining === 0
                ? `Hai già ${sendQuota.currentCount}/${sendQuota.limit} invii attivi in attesa. Annullane uno per inviarne altri.`
                : `Hai solo ${sendQuota.remaining} slot liber${sendQuota.remaining === 1 ? 'o' : 'i'} (${sendQuota.currentCount}/${sendQuota.limit} occupati), ma hai selezionato ${sendQuota.requested} quaderni.`}
            </p>
            <button type="button" data-action="open-sent-tab"
              class="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold shrink-0 self-end sm:self-center cursor-pointer">
              Gestisci inviati
            </button>
          </div>
        ` : ''}
      </div>
    ` : '';

    const lookupSection = `
      <div class="space-y-2.5 mb-4">
        <form data-form="lookup-friend" class="flex items-center gap-2">
          <input id="sharingFriendSearchInput" type="text" placeholder="Email amico o @username..."
            class="flex-1 min-w-0 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-indigo-500">
          <button type="submit" ${searchLoading ? 'disabled' : ''}
            class="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shrink-0 cursor-pointer disabled:opacity-50">
            ${searchLoading ? 'Cerco...' : 'Cerca'}
          </button>
        </form>
        ${searchError ? `<p class="text-[11px] text-rose-600 dark:text-rose-400 font-medium">${escapeHtml(searchError)}</p>` : ''}
        ${searchResult ? `
          <div class="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/70 flex items-center justify-between gap-2.5">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-full overflow-hidden shrink-0">${_renderMiniAvatar(searchResult, 32)}</div>
              <div class="min-w-0">
                <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(searchResult.displayName)}</div>
                <div class="text-[11px] text-slate-500 dark:text-slate-400">@${escapeHtml(searchResult.handle)}</div>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              ${isSendMode ? `
                <button type="button" data-action="send-to-searched" ${(sendingToUid || sendBlockedByQuota) ? 'disabled' : ''}
                  class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold cursor-pointer disabled:opacity-50">
                  Invia ora
                </button>
              ` : ''}
              ${friendIds.has(searchResult.uid)
                ? `<span class="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 px-2">Già amico</span>`
                : `<button type="button" data-action="add-searched-friend"
                    class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold cursor-pointer">
                    + Aggiungi
                  </button>`}
            </div>
          </div>
        ` : ''}
      </div>
    `;

    const contactsSection = isGoogle ? `
      <div class="mb-4 p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="text-xs font-bold text-slate-800 dark:text-slate-100">Contatti Google</div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400">Trova automaticamente chi usa già InkNote Studio</div>
          </div>
          <button type="button" data-action="scan-google-contacts" ${contactsLoading ? 'disabled' : ''}
            class="px-3 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-[11px] font-semibold shrink-0 cursor-pointer disabled:opacity-50">
            ${contactsLoading ? 'Scansione...' : 'Trova da Contatti'}
          </button>
        </div>
        ${contactsError ? `<p class="text-[11px] text-rose-600 dark:text-rose-400 font-medium">${escapeHtml(contactsError)}</p>` : ''}
        ${Array.isArray(contactsMatches) ? (
          contactsMatches.length === 0
            ? `<p class="text-[11px] text-slate-500 dark:text-slate-400">Nessun nuovo contatto trovato su InkNote (su ${contactsScannedTotal} contatti con email).</p>`
            : `<div class="space-y-1.5 pt-1">
                <div class="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300">
                  <span>Trovati ${contactsMatches.length} amic${contactsMatches.length === 1 ? 'o' : 'i'} su InkNote:</span>
                  <button type="button" data-action="add-all-contacts" class="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer">Aggiungi tutti</button>
                </div>
                ${contactsMatches.map(m => {
                  const already = friendIds.has(m.uid);
                  return `
                    <div class="flex items-center justify-between gap-2 p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                      <div class="flex items-center gap-2 min-w-0">
                        <div class="w-7 h-7 rounded-full overflow-hidden shrink-0">${_renderMiniAvatar(m, 28)}</div>
                        <div class="min-w-0">
                          <div class="text-xs font-semibold text-slate-900 dark:text-white truncate">${escapeHtml(m.displayName)}</div>
                          <div class="text-[10px] text-slate-500 dark:text-slate-400">@${escapeHtml(m.handle)}</div>
                        </div>
                      </div>
                      ${already
                        ? `<span class="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 px-2">Già amico</span>`
                        : `<button type="button" data-action="add-contact-friend" data-uid="${escapeHtml(m.uid)}"
                            class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold cursor-pointer">+ Aggiungi</button>`}
                    </div>
                  `;
                }).join('')}
              </div>`
        ) : ''}
      </div>
    ` : '';

    const friendsListSection = `
      <div class="space-y-2">
        <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          I tuoi amici (${_friends.length})
        </div>
        ${_friends.length === 0 ? `
          <div class="py-8 text-center rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
            Nessun amico salvato. Cercane uno qui sopra per email o @username${isGoogle ? ' oppure dai Contatti Google' : ''}.
          </div>
        ` : _friends.map(f => {
          const isSendingThis = sendingToUid === f.uid;
          return `
            <div class="p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 flex items-center justify-between gap-2.5">
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-9 h-9 rounded-full overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700">${_renderMiniAvatar(f, 36)}</div>
                <div class="min-w-0">
                  <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(f.displayName)}</div>
                  <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">${f.handle ? `@${escapeHtml(f.handle)}` : 'Utente InkNote'}</div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                ${isSendMode ? `
                  <button type="button" data-action="send-to-friend" data-uid="${escapeHtml(f.uid)}" ${(sendingToUid || sendBlockedByQuota) ? 'disabled' : ''}
                    class="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold shadow-sm cursor-pointer disabled:opacity-50">
                    ${isSendingThis ? 'Invio...' : 'Invia'}
                  </button>
                ` : `
                  <button type="button" data-action="pick-nb-for-friend" data-uid="${escapeHtml(f.uid)}"
                    class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold shadow-sm cursor-pointer">
                    Invia quaderno
                  </button>
                  <button type="button" data-action="remove-friend" data-uid="${escapeHtml(f.uid)}" title="Rimuovi amico"
                    class="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                  </button>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    return `${sendBanner}${lookupSection}${contactsSection}${friendsListSection}`;
  };

  const renderNotebookPickerForFriend = (friend) => {
    const nbs = localNotebooksCache || [];
    const pickQuota = checkOutgoingTransferQuota(_outgoingTransfers, 1, MAX_OUTGOING_TRANSFERS);
    return `
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-bold text-slate-900 dark:text-white truncate">
            Scegli quale quaderno inviare a ${escapeHtml(friend.displayName)}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${renderQuotaPill(pickQuota.currentCount)}
            <button type="button" data-action="back-to-friends" class="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer">← Indietro</button>
          </div>
        </div>
        ${!pickQuota.allowed ? `
          <div class="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/70 text-[11px] font-medium text-rose-700 dark:text-rose-300">
            Hai già ${pickQuota.currentCount}/${pickQuota.limit} quaderni in attesa. Annulla un invio dalla scheda "Inviati" per liberare spazio.
          </div>
        ` : ''}
        ${sendStatusText ? `<div class="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-xs font-medium text-indigo-700 dark:text-indigo-300">${escapeHtml(sendStatusText)}</div>` : ''}
        ${nbs.length === 0 ? `
          <p class="py-8 text-center text-xs text-slate-500">Nessun quaderno disponibile in libreria.</p>
        ` : `
          <div class="space-y-1.5">
            ${nbs.map(nb => `
              <button type="button" data-action="send-picked-nb" data-nb-id="${escapeHtml(nb.id)}" data-uid="${escapeHtml(friend.uid)}" ${(sendingToUid || !pickQuota.allowed) ? 'disabled' : ''}
                class="w-full p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 text-left transition cursor-pointer disabled:opacity-50">
                <div class="flex items-center gap-2.5 min-w-0">
                  <span class="w-4 h-5 rounded-sm shrink-0" style="background:${_safeHexColor(nb.coverColor)}"></span>
                  <span class="text-xs font-semibold text-slate-900 dark:text-white truncate">${escapeHtml(nb.title || 'Quaderno')}</span>
                </div>
                <span class="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 shrink-0">${nb.pageCount || 1} pag. →</span>
              </button>
            `).join('')}
          </div>
        `}
      </div>
    `;
  };

  let pickedFriendForSend = null;

  const sendNotebooksToRecipient = async (notebooksList, recipient) => {
    if (!recipient || !Array.isArray(notebooksList) || notebooksList.length === 0) return;
    sendingToUid = recipient.uid;
    sendStatusText = 'Verifica slot di invio...';
    render();
    try {
      _outgoingTransfers = await listAndCleanupOutgoingTransfers(authState.user.uid);
      const quota = checkOutgoingTransferQuota(_outgoingTransfers, notebooksList.length, MAX_OUTGOING_TRANSFERS);
      if (!quota.allowed) {
        throw new Error(
          quota.remaining === 0
            ? `Limite raggiunto: hai già ${quota.currentCount}/${quota.limit} quaderni in attesa. Annulla un invio in "Inviati" o attendi che vengano scaricati.`
            : `Puoi inviare ancora solo ${quota.remaining} quadern${quota.remaining === 1 ? 'o' : 'i'} (${quota.currentCount}/${quota.limit} slot attivi).`
        );
      }

      for (let i = 0; i < notebooksList.length; i++) {
        const nb = notebooksList[i];
        await sendNotebookToFriend({
          notebookId: nb.id,
          friend: recipient,
          senderProfile: _profile,
          onProgress: ({ label }) => {
            sendStatusText = label || `Invio ${i + 1}/${notebooksList.length}...`;
            render();
          }
        });
      }
      _outgoingTransfers = await listAndCleanupOutgoingTransfers(authState.user.uid);
      showToast(
        notebooksList.length === 1
          ? `Quaderno inviato a ${recipient.displayName}!`
          : `${notebooksList.length} quaderni inviati a ${recipient.displayName}!`,
        '📤'
      );
      cleanup();
    } catch (err) {
      console.error('[sharing] send failed:', err);
      showToast(_formatSharingError(err, 'Invio fallito'), '❌', 3800);
      sendingToUid = null;
      sendStatusText = '';
      render();
    }
  };

  const render = () => {
    const signedIn = Boolean(authState.user && isFirestoreReady());
    let bodyHtml = '';
    if (!signedIn) {
      bodyHtml = renderSignedOutBody();
    } else if (pickedFriendForSend) {
      bodyHtml = renderNotebookPickerForFriend(pickedFriendForSend);
    } else if (sendModeManageSent || (!isSendMode && activeTab === 'sent')) {
      bodyHtml = renderSentTab();
    } else if (isSendMode || activeTab === 'friends') {
      bodyHtml = renderFriendsAndSendSection();
    } else {
      bodyHtml = renderInboxTab();
    }

    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-lg w-full shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden" style="max-height: 88vh;">
        <div class="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3 class="text-base font-bold text-slate-900 dark:text-white">
              ${isSendMode ? 'Invia a un amico' : 'Condivisione & Amici'}
            </h3>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">
              Scadenza automatica 24h · Privacy garantita ·
              <a href="privacy.html" target="_blank" rel="noopener noreferrer" class="underline hover:text-indigo-600 dark:hover:text-indigo-400">Privacy</a>
            </p>
          </div>
          <button type="button" data-modal-cancel aria-label="Chiudi"
            class="w-8 h-8 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        ${signedIn ? renderProfileStrip() : ''}
        ${signedIn && _sessionSyncError ? `
          <div class="mx-5 mt-3 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/70 text-[11px] font-medium text-rose-700 dark:text-rose-300">
            ${escapeHtml(_sessionSyncError)}
          </div>
        ` : ''}
        ${signedIn ? renderTabsBar() : ''}

        <div class="p-5 overflow-y-auto flex-1 custom-scrollbar" style="touch-action: pan-y;">
          ${bodyHtml}
        </div>
      </div>
    `;

    bindEvents();
  };

  const bindEvents = () => {
    overlay.querySelector('[data-modal-cancel]')?.addEventListener('click', cleanup);

    overlay.querySelector('[data-action="login-google"]')?.addEventListener('click', async () => {
      try {
        await signInWithGoogle();
      } catch (err) {
        await handleGoogleAuthError(err);
      }
    });

    overlay.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        pickedFriendForSend = null;
        render();
      });
    });

    overlay.querySelector('[data-action="copy-invite"]')?.addEventListener('click', () => {
      void copyMyInviteLink();
    });

    overlay.querySelector('[data-action="toggle-browser-notifs"]')?.addEventListener('click', () => {
      void _toggleBrowserNotifications();
    });

    overlay.querySelector('[data-action="start-edit-handle"]')?.addEventListener('click', () => {
      editingHandle = true;
      render();
      overlay.querySelector('#sharingEditHandleInput')?.focus();
    });

    overlay.querySelector('[data-action="cancel-handle"]')?.addEventListener('click', () => {
      editingHandle = false;
      render();
    });

    overlay.querySelector('[data-form="edit-handle"]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = overlay.querySelector('#sharingEditHandleInput');
      try {
        _profile = await updateUserHandle(input?.value || '');
        editingHandle = false;
        _syncSharingBadgesUI();
        showToast(`Username aggiornato a @${_profile.handle}`, '✅');
        render();
      } catch (err) {
        showToast(_formatSharingError(err, 'Impossibile aggiornare username'), '⚠️');
      }
    });

    overlay.querySelector('[data-form="lookup-friend"]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = overlay.querySelector('#sharingFriendSearchInput')?.value || '';
      searchLoading = true;
      searchError = '';
      searchResult = null;
      render();
      try {
        const res = await findUserByEmailOrHandle(q);
        if (!res) searchError = 'Nessun utente InkNote trovato con questa email o @username.';
        else searchResult = res;
      } catch (err) {
        searchError = _formatSharingError(err, 'Ricerca fallita');
      } finally {
        searchLoading = false;
        render();
      }
    });

    overlay.querySelector('[data-action="add-searched-friend"]')?.addEventListener('click', async () => {
      if (!searchResult) return;
      try {
        await addFriend(searchResult, 'manual');
        showToast(`${searchResult.displayName} aggiunto agli amici!`, '🤝');
      } catch (err) {
        showToast(_formatSharingError(err, 'Errore aggiunta amico'), '❌');
      }
    });

    overlay.querySelector('[data-action="send-to-searched"]')?.addEventListener('click', async () => {
      if (!searchResult || !isSendMode) return;
      await sendNotebooksToRecipient(sendNotebooks, searchResult);
    });

    overlay.querySelector('[data-action="scan-google-contacts"]')?.addEventListener('click', async () => {
      contactsLoading = true;
      contactsError = '';
      contactsMatches = null;
      render();
      try {
        const res = await findFriendsFromGoogleContacts();
        if (res.redirected) return;
        contactsMatches = res.matches;
        contactsScannedTotal = res.totalContactsWithEmail;
      } catch (err) {
        contactsError = _formatSharingError(err, 'Impossibile leggere i contatti Google');
      } finally {
        contactsLoading = false;
        render();
      }
    });

    overlay.querySelector('[data-action="add-all-contacts"]')?.addEventListener('click', async () => {
      if (!Array.isArray(contactsMatches)) return;
      const existing = new Set(_friends.map(f => f.uid));
      const toAdd = contactsMatches.filter(m => !existing.has(m.uid));
      for (const m of toAdd) {
        await addFriend(m, 'contacts');
      }
      if (toAdd.length > 0) {
        showToast(`Aggiunti ${toAdd.length} amici dai Contatti`, '🤝');
      }
    });

    overlay.querySelectorAll('[data-action="add-contact-friend"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const match = contactsMatches?.find(m => m.uid === btn.dataset.uid);
        if (!match) return;
        await addFriend(match, 'contacts');
        showToast(`${match.displayName} aggiunto!`, '🤝');
      });
    });

    overlay.querySelectorAll('[data-action="remove-friend"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await removeFriend(btn.dataset.uid);
        showToast('Amico rimosso', 'ℹ️');
      });
    });

    overlay.querySelectorAll('[data-action="send-to-friend"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const friend = _friends.find(f => f.uid === btn.dataset.uid);
        if (friend && isSendMode) {
          await sendNotebooksToRecipient(sendNotebooks, friend);
        }
      });
    });

    overlay.querySelectorAll('[data-action="pick-nb-for-friend"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const friend = _friends.find(f => f.uid === btn.dataset.uid);
        if (!friend) return;
        localNotebooksCache = await loadAllNotebooksFromDB();
        pickedFriendForSend = friend;
        render();
      });
    });

    overlay.querySelector('[data-action="back-to-friends"]')?.addEventListener('click', () => {
      pickedFriendForSend = null;
      sendStatusText = '';
      render();
    });

    overlay.querySelector('[data-action="open-sent-tab"]')?.addEventListener('click', () => {
      sendModeManageSent = true;
      render();
    });

    overlay.querySelector('[data-action="back-to-send"]')?.addEventListener('click', () => {
      sendModeManageSent = false;
      render();
    });

    overlay.querySelectorAll('[data-action="send-picked-nb"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const nb = localNotebooksCache?.find(n => n.id === btn.dataset.nbId);
        const friend = _friends.find(f => f.uid === btn.dataset.uid);
        if (nb && friend) {
          await sendNotebooksToRecipient([nb], friend);
        }
      });
    });

    overlay.querySelector('[data-action="dismiss-import-banner"]')?.addEventListener('click', () => {
      lastImportedInfo = null;
      render();
    });

    overlay.querySelector('[data-action="open-imported-nb"]')?.addEventListener('click', (e) => {
      const nbId = e.currentTarget.dataset.nbId;
      cleanup();
      if (nbId) emit('library:open-notebook', nbId);
    });

    overlay.querySelectorAll('[data-action="import-transfer"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const t = _incomingTransfers.find(item => item.id === btn.dataset.transferId);
        if (!t) return;
        transferBusyId = t.id;
        importStatusText = `Importazione di "${t.notebookTitle}" in corso...`;
        lastImportedInfo = null;
        render();
        try {
          const importedList = await importIncomingTransfer(t, ({ label }) => {
            if (label) {
              importStatusText = label;
              render();
            }
          });
          const importedNb = importedList?.[0] || null;
          const importedTitle = importedNb?.title || t.notebookTitle || 'Quaderno';
          lastImportedInfo = {
            id: importedNb?.id || null,
            title: importedTitle,
            senderName: t.senderName || ''
          };
          emit('library:refresh');
          showToast(`"${importedTitle}" importato con successo!`, '✅', 3800);
        } catch (err) {
          console.error('[sharing] import failed:', err);
          showToast(_formatSharingError(err, 'Importazione fallita'), '❌', 3500);
        } finally {
          transferBusyId = null;
          importStatusText = '';
          render();
        }
      });
    });

    overlay.querySelectorAll('[data-action="decline-transfer"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.transferId;
        if (!id) return;
        transferBusyId = id;
        render();
        try {
          await declineIncomingTransfer(id);
          showToast('Quaderno rifiutato ed eliminato', '🗑️');
        } catch (err) {
          showToast('Errore eliminazione', '❌');
        } finally {
          transferBusyId = null;
          render();
        }
      });
    });

    overlay.querySelectorAll('[data-action="add-sender-friend"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const t = _incomingTransfers.find(item => item.id === btn.dataset.transferId);
        if (!t) return;
        await addFriend({
          uid: t.senderUid,
          displayName: t.senderName,
          handle: t.senderHandle || '',
          photoURL: t.senderPhoto || ''
        }, 'received');
        showToast(`${t.senderName} aggiunto agli amici!`, '🤝');
      });
    });

    overlay.querySelectorAll('[data-action="cancel-outgoing"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.transferId;
        if (!id) return;
        transferBusyId = id;
        render();
        try {
          await deleteTransferWithChunks(id);
          _outgoingTransfers = _outgoingTransfers.filter(t => t.id !== id);
          showToast('Invio annullato', '🗑️');
        } catch {
          showToast('Errore annullamento', '❌');
        } finally {
          transferBusyId = null;
          render();
        }
      });
    });
  };

  _activeModalState = { overlay, render, close: cleanup };
  render();
  document.body.appendChild(overlay);
  if (autoScanContacts && authState.user && isFirestoreReady() && isGoogleLinkedUser(authState.user)) {
    overlay.querySelector('[data-action="scan-google-contacts"]')?.click();
  }
}
