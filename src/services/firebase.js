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

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

function _isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function signInWithGoogle() {
  if (_isMobile()) {
    await signInWithRedirect(auth, googleProvider);
    return null;
  }
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function handleRedirectResult() {
  try {
    const result = await getRedirectResult(auth);
    return result?.user || null;
  } catch (err) {
    console.error('[firebase] redirect result failed:', err);
    return null;
  }
}

export async function signOutGoogle() {
  await signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}