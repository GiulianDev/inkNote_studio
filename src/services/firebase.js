/**
 * @module services/firebase
 *
 * Init Firebase App + Auth. Solo autenticazione, nessun
 * Firestore/Storage ancora.
 *
 * Note:
 *   - browserLocalPersistence è il default di Firebase Auth web.
 *     Non chiamiamo setPersistence (causa bug noti di wipe delle
 *     sessioni in alcuni browser).
 *   - Mobile: signInWithRedirect (i popup sono bloccati).
 *     Il risultato arriva al reload via handleRedirectResult,
 *     chiamata in main.js all'avvio.
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const hasFirebaseConfig = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

let app = null;
export let auth = null;
let googleProvider = null;

if (hasFirebaseConfig) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });
  } catch (err) {
    console.warn('[firebase] Init failed, continuing in local-only mode:', err);
    auth = null;
  }
} else {
  console.warn('[firebase] Firebase env vars not configured — running in local-only mode');
}

function _isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function signInWithGoogle() {
  if (!auth || !googleProvider) {
    throw new Error('Firebase Auth non configurato');
  }
  if (_isMobile()) {
    await signInWithRedirect(auth, googleProvider);
    return null;
  }
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function handleRedirectResult() {
  if (!auth) return null;
  try {
    const result = await getRedirectResult(auth);
    return result?.user || null;
  } catch (err) {
    console.error('[firebase] redirect result failed:', err);
    return null;
  }
}

export async function signOutGoogle() {
  if (!auth) return;
  await signOut(auth);
}

export function onAuthChange(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}