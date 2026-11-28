/**
 * @module services/firebase
 *
 * Init Firebase App + Auth + Firestore.
 * Supporta sia le variabili VITE_FIREBASE_* (build/deploy personali)
 * sia firebase-applet-config.json (ambiente AI Studio).
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  reauthenticateWithPopup,
  reauthenticateWithRedirect,
  signInAnonymously,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer
} from 'firebase/firestore';
import appletConfig from '../../../firebase-applet-config.json';
import { state } from '../core/state.js';
import {
  hasOAuthScope,
  resolveEffectiveFirestoreDatabaseId,
  selectActiveFirebaseConfig
} from '../sharing/sharing-helpers.js';

const rawEnvFirebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  firestoreDatabaseId: import.meta.env.VITE_FIREBASE_DATABASE_ID || ''
};

const currentHostname = typeof window !== 'undefined' ? window.location.hostname : '';
const { config: activeConfig, source: activeConfigSource } = selectActiveFirebaseConfig({
  envConfig: rawEnvFirebaseConfig,
  appletConfig,
  hostname: currentHostname
});

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
});

let app = null;
export let auth = null;
export let db = null;
let googleProvider = null;
let effectiveDatabaseId = '';

const SCOPES = ['https://www.googleapis.com/auth/contacts.readonly'];
const CONTACTS_REDIRECT_KEY = 'inknote_pending_contacts_redirect';
const CONTACTS_TOKEN_TTL_MS = 50 * 60 * 1000;
let _pendingContactsAccessToken = null;
let _cachedContactsToken = null; // { uid, token, expiresAt } — solo in memoria (mai localStorage/sessionStorage)

async function _testFirestoreConnection() {
  if (!db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error(
        `Please check your Firebase configuration (Firestore client is offline for project="${activeConfig?.projectId || ''}", database="${effectiveDatabaseId || '(default)'}").`
      );
    }
  }
}

if (activeConfig) {
  try {
    const dbResolution = resolveEffectiveFirestoreDatabaseId({
      projectId: activeConfig.projectId,
      firestoreDatabaseId: activeConfig.firestoreDatabaseId,
      fromEnv: activeConfigSource === 'env'
    });
    effectiveDatabaseId = dbResolution.databaseId;
    if (dbResolution.fallbackReason === 'ai_studio_db_on_external_project') {
      console.warn(
        `[firebase] VITE_FIREBASE_DATABASE_ID ("${dbResolution.ignoredDatabaseId}") appartiene a un database AI Studio e non esiste su "${activeConfig.projectId}". Uso il database "(default)". Rimuovi o svuota VITE_FIREBASE_DATABASE_ID.`
      );
    }

    app = initializeApp({
      apiKey: activeConfig.apiKey,
      authDomain: activeConfig.authDomain,
      projectId: activeConfig.projectId,
      storageBucket: activeConfig.storageBucket,
      messagingSenderId: activeConfig.messagingSenderId,
      appId: activeConfig.appId
    });
    auth = getAuth(app);
    db = effectiveDatabaseId
      ? getFirestore(app, effectiveDatabaseId)
      : getFirestore(app);
    googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });
    onAuthStateChanged(auth, (user) => {
      if (!user || (_cachedContactsToken && _cachedContactsToken.uid !== user.uid)) {
        _cachedContactsToken = null;
        _pendingContactsAccessToken = null;
      }
    });
    void _testFirestoreConnection();
  } catch (err) {
    console.warn('[firebase] Init failed, continuing in local-only mode:', err);
    auth = null;
    db = null;
  }
} else {
  console.warn('[firebase] Firebase config not found — running in local-only mode');
}

export function isFirebaseReady() {
  return Boolean(auth);
}

export function isFirestoreReady() {
  return Boolean(auth && db);
}

export function getActiveFirebaseProjectId() {
  return activeConfig?.projectId || '';
}

export function getActiveFirebaseDatabaseId() {
  return effectiveDatabaseId || '(default)';
}

export function handleFirestoreError(error, operationType, path) {
  const user = auth?.currentUser || null;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: user?.uid || null,
      email: user?.email || null,
      emailVerified: user?.emailVerified ?? null,
      isAnonymous: user?.isAnonymous ?? null,
      tenantId: user?.tenantId ?? null,
      providerInfo: user?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function isGoogleLinkedUser(user = auth?.currentUser) {
  if (!user || !Array.isArray(user.providerData)) return false;
  return user.providerData.some(p => p?.providerId === 'google.com');
}

export async function ensureBugReportAuth() {
  if (!auth) {
    throw new Error('Firebase Auth non configurato');
  }
  if (auth.currentUser) {
    return auth.currentUser;
  }
  const result = await signInAnonymously(auth);
  return result.user;
}

export async function signInWithGoogle() {
  if (!auth || !googleProvider) {
    throw new Error('Firebase Auth non configurato');
  }
  if (state.platform.isMobile) {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      return result.user;
    } catch (err) {
      if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, googleProvider);
        return null;
      }
      throw err;
    }
  }
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function handleRedirectResult() {
  if (!auth) return null;
  try {
    const result = await getRedirectResult(auth);
    if (result) {
      const hadContactsRedirect = sessionStorage.getItem(CONTACTS_REDIRECT_KEY) === '1';
      sessionStorage.removeItem(CONTACTS_REDIRECT_KEY);
      const cred = GoogleAuthProvider.credentialFromResult(result);
      if (hadContactsRedirect && cred?.accessToken) {
        _pendingContactsAccessToken = cred.accessToken;
        _cachedContactsToken = {
          uid: result.user?.uid || '',
          token: cred.accessToken,
          expiresAt: Date.now() + CONTACTS_TOKEN_TTL_MS
        };
      }
      return result.user || null;
    }
    sessionStorage.removeItem(CONTACTS_REDIRECT_KEY);
    return null;
  } catch (err) {
    sessionStorage.removeItem(CONTACTS_REDIRECT_KEY);
    console.error('[firebase] redirect result failed:', err);
    return null;
  }
}

export function consumePendingContactsAccessToken() {
  const tok = _pendingContactsAccessToken;
  _pendingContactsAccessToken = null;
  return tok;
}

export function clearCachedContactsAccessToken() {
  _cachedContactsToken = null;
  _pendingContactsAccessToken = null;
}

async function _assertContactsTokenHasScope(accessToken) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!res.ok) return;
    const info = await res.json().catch(() => null);
    if (info && typeof info.scope === 'string' && !hasOAuthScope(info.scope, SCOPES[0])) {
      console.warn('[auth] Token Google privo dello scope contacts.readonly. Scopes ricevuti:', info.scope, 'aud:', info.aud);
      throw new Error(
        'Permesso Contatti Google non selezionato: nella finestra di Google assicurati di spuntare la casella "Visualizza e scarica i tuoi contatti" prima di continuare.'
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Permesso Contatti Google non selezionato')) {
      throw err;
    }
  }
}

export async function requestGoogleContactsAccessToken({ forceRefresh = false } = {}) {
  if (!auth?.currentUser) {
    throw new Error('Devi accedere prima con Google');
  }
  if (!isGoogleLinkedUser(auth.currentUser)) {
    throw new Error('Questa funzione richiede un account collegato a Google');
  }

  const uid = auth.currentUser.uid;
  if (!forceRefresh && _cachedContactsToken && _cachedContactsToken.uid === uid && Date.now() < _cachedContactsToken.expiresAt) {
    return _cachedContactsToken.token;
  }

  if (!forceRefresh && _pendingContactsAccessToken) {
    const token = _pendingContactsAccessToken;
    _pendingContactsAccessToken = null;
    await _assertContactsTokenHasScope(token);
    _cachedContactsToken = { uid, token, expiresAt: Date.now() + CONTACTS_TOKEN_TTL_MS };
    return token;
  }

  const contactsProvider = new GoogleAuthProvider();
  SCOPES.forEach((scope) => contactsProvider.addScope(scope));
  const customParams = {
    prompt: 'consent',
    include_granted_scopes: 'true'
  };
  if (auth.currentUser.email) {
    customParams.login_hint = auth.currentUser.email;
  }
  contactsProvider.setCustomParameters(customParams);

  try {
    const result = await reauthenticateWithPopup(auth.currentUser, contactsProvider);
    const cred = GoogleAuthProvider.credentialFromResult(result);
    if (!cred?.accessToken) {
      throw new Error('Permesso contatti non ricevuto');
    }
    await _assertContactsTokenHasScope(cred.accessToken);
    _cachedContactsToken = {
      uid,
      token: cred.accessToken,
      expiresAt: Date.now() + CONTACTS_TOKEN_TTL_MS
    };
    return cred.accessToken;
  } catch (err) {
    if (state.platform.isMobile && (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment')) {
      sessionStorage.setItem(CONTACTS_REDIRECT_KEY, '1');
      await reauthenticateWithRedirect(auth.currentUser, contactsProvider);
      return null;
    }
    if (err?.code === 'auth/user-mismatch') {
      const mismatchErr = new Error(
        auth.currentUser.email
          ? `Seleziona lo stesso account Google (${auth.currentUser.email}) nella finestra di autorizzazione.`
          : 'Seleziona lo stesso account Google con cui hai effettuato l’accesso.'
      );
      mismatchErr.code = 'auth/user-mismatch';
      throw mismatchErr;
    }
    throw err;
  }
}

export async function signOutGoogle() {
  if (!auth) return;
  clearCachedContactsAccessToken();
  await signOut(auth);
}

export function onAuthChange(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}