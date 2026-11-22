/**
 * @module services/sharing-cloud
 *
 * Livello Cloud Firestore per:
 *   - Profilo scopribile e @username / indice email SHA-256
 *   - Rubrica Amici (ricerca universale per email/@username + Contatti Google)
 *   - Trasferimento quaderni P2P con chunking .inknote, notifiche realtime
 *     e auto-eliminazione garantita dopo 24 ore (o subito all'import/rifiuto).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  writeBatch
} from 'firebase/firestore';
import {
  auth,
  db,
  OperationType,
  handleFirestoreError,
  isFirestoreReady,
  requestGoogleContactsAccessToken,
  isGoogleLinkedUser
} from './firebase.js';
import {
  loadNotebookWithPages,
  loadAllNotebooksFromDB,
  saveNotebookToDB
} from './db.js';
import { serializeBackup, deserializeBackup } from '../features/backup/backup-format.js';
import { generatePageId } from '../core/utils.js';
import {
  TRANSFER_TTL_MS,
  normalizeEmail,
  isValidEmailFormat,
  normalizeHandle,
  isValidHandle,
  suggestHandleFromUser,
  sanitizePhotoUrl,
  hashNormalizedEmail,
  splitBytesToBase64Chunks,
  reassembleBase64Chunks,
  computeTransferExpirationMs,
  classifyInboxTransfers,
  classifyOutgoingTransfers,
  extractGoogleContactCandidates,
  buildUniqueReceivedTitle
} from '../features/sharing/sharing-helpers.js';

function _requireReady() {
  if (!isFirestoreReady() || !auth?.currentUser) {
    throw new Error('Accedi con un account verificato per usare la condivisione');
  }
  return auth.currentUser;
}

function _buildSafeDisplayName(user) {
  const raw = String(user?.displayName || user?.email?.split('@')[0] || 'Utente InkNote').trim();
  return (raw || 'Utente InkNote').slice(0, 80);
}

function _generateTransferId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'tr_' + crypto.randomUUID().replace(/-/g, '');
  }
  return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// ============================================================
// PROFILO & DIRECTORY PRIVACY-SAFE
// ============================================================

export async function getMyProfile(uid = auth?.currentUser?.uid) {
  if (!isFirestoreReady() || !uid) return null;
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

async function _claimUniqueHandle(uid, baseCandidate) {
  let candidate = normalizeHandle(baseCandidate);
  if (!isValidHandle(candidate)) candidate = suggestHandleFromUser({ uid });

  for (let attempt = 0; attempt < 6; attempt++) {
    const checkHandle = attempt === 0
      ? candidate
      : `${candidate.slice(0, 19)}_${Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, '0')}`;
    const path = `directory_handles/${checkHandle}`;
    try {
      const snap = await getDoc(doc(db, 'directory_handles', checkHandle));
      if (!snap.exists() || snap.data()?.uid === uid) {
        return checkHandle;
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, path);
    }
  }
  return `u_${uid.slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}_${Date.now().toString(36).slice(-4)}`;
}

async function _syncDirectoryEntries({ uid, handle, displayName, photoURL, email }) {
  const handlePath = `directory_handles/${handle}`;
  try {
    await setDoc(doc(db, 'directory_handles', handle), {
      uid,
      handle,
      displayName,
      photoURL,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, handlePath);
  }

  const emailHash = email ? await hashNormalizedEmail(email) : '';
  if (emailHash) {
    const emailPath = `directory_emails/${emailHash}`;
    try {
      await setDoc(doc(db, 'directory_emails', emailHash), {
        uid,
        handle,
        displayName,
        photoURL,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, emailPath);
    }
  }
}

export async function ensureUserProfile(user = auth?.currentUser) {
  if (!isFirestoreReady() || !user?.uid) return null;
  if (!user.emailVerified) return null;

  const userPath = `users/${user.uid}`;
  const displayName = _buildSafeDisplayName(user);
  const photoURL = sanitizePhotoUrl(user.photoURL || '');

  let existing = null;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    existing = snap.exists() ? snap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userPath);
  }

  let handle = existing?.handle && isValidHandle(existing.handle)
    ? existing.handle
    : await _claimUniqueHandle(user.uid, suggestHandleFromUser(user));

  if (!existing) {
    try {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        displayName,
        photoURL,
        handle,
        discoverable: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, userPath);
    }
  } else if (existing.displayName !== displayName || existing.photoURL !== photoURL) {
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        displayName,
        photoURL,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, userPath);
    }
  }

  await _syncDirectoryEntries({
    uid: user.uid,
    handle,
    displayName,
    photoURL,
    email: user.email || ''
  });

  return {
    uid: user.uid,
    displayName,
    photoURL,
    handle,
    discoverable: existing ? !!existing.discoverable : true
  };
}

export async function updateUserHandle(rawHandle) {
  const user = _requireReady();
  const nextHandle = normalizeHandle(rawHandle);
  if (!isValidHandle(nextHandle)) {
    throw new Error('Lo username deve avere 3-24 caratteri (lettere minuscole, numeri o _)');
  }

  const profile = await ensureUserProfile(user);
  const prevHandle = profile?.handle || '';
  if (prevHandle === nextHandle) return profile;

  const newHandlePath = `directory_handles/${nextHandle}`;
  let existingHandleDoc = null;
  try {
    const snap = await getDoc(doc(db, 'directory_handles', nextHandle));
    existingHandleDoc = snap.exists() ? snap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, newHandlePath);
  }

  if (existingHandleDoc && existingHandleDoc.uid !== user.uid) {
    throw new Error(`@${nextHandle} è già occupato da un altro utente`);
  }

  const displayName = _buildSafeDisplayName(user);
  const photoURL = sanitizePhotoUrl(user.photoURL || '');

  try {
    await setDoc(doc(db, 'directory_handles', nextHandle), {
      uid: user.uid,
      handle: nextHandle,
      displayName,
      photoURL,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, newHandlePath);
  }

  const userPath = `users/${user.uid}`;
  try {
    await updateDoc(doc(db, 'users', user.uid), {
      handle: nextHandle,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, userPath);
  }

  const emailHash = user.email ? await hashNormalizedEmail(user.email) : '';
  if (emailHash) {
    const emailPath = `directory_emails/${emailHash}`;
    try {
      await setDoc(doc(db, 'directory_emails', emailHash), {
        uid: user.uid,
        handle: nextHandle,
        displayName,
        photoURL,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, emailPath);
    }
  }

  if (prevHandle && prevHandle !== nextHandle) {
    const oldPath = `directory_handles/${prevHandle}`;
    try {
      await deleteDoc(doc(db, 'directory_handles', prevHandle));
    } catch (err) {
      console.warn('[sharing] cleanup old handle failed:', err);
    }
  }

  return {
    ...profile,
    handle: nextHandle,
    displayName,
    photoURL
  };
}

// ============================================================
// RICERCA UTENTI & RUBRICA AMICI
// ============================================================

export async function findUserByEmailOrHandle(rawQuery) {
  const user = _requireReady();
  const trimmed = String(rawQuery || '').trim();
  if (!trimmed) {
    throw new Error('Inserisci un’email o uno @username');
  }

  let match = null;
  if (trimmed.includes('@') && !trimmed.startsWith('@')) {
    if (!isValidEmailFormat(trimmed)) {
      throw new Error('Formato email non valido');
    }
    const emailHash = await hashNormalizedEmail(trimmed);
    const path = `directory_emails/${emailHash}`;
    try {
      const snap = await getDoc(doc(db, 'directory_emails', emailHash));
      match = snap.exists() ? snap.data() : null;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, path);
    }
  } else {
    const handle = normalizeHandle(trimmed);
    if (!isValidHandle(handle)) {
      throw new Error('Inserisci uno @username valido (3-24 caratteri a-z, 0-9, _) oppure un’email');
    }
    const path = `directory_handles/${handle}`;
    try {
      const snap = await getDoc(doc(db, 'directory_handles', handle));
      match = snap.exists() ? snap.data() : null;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, path);
    }
  }

  if (!match) return null;
  if (match.uid === user.uid) {
    throw new Error('Questo sei tu!');
  }
  return {
    uid: match.uid,
    displayName: match.displayName || 'Utente InkNote',
    handle: match.handle || '',
    photoURL: sanitizePhotoUrl(match.photoURL || '')
  };
}

export async function findFriendsFromGoogleContacts(onProgress) {
  const user = _requireReady();
  if (!isGoogleLinkedUser(user)) {
    throw new Error('Collegati con Google per cercare amici tra i tuoi Contatti');
  }

  const accessToken = await requestGoogleContactsAccessToken();
  if (!accessToken) {
    return { redirected: true, totalContactsWithEmail: 0, matches: [] };
  }

  const allConnections = [];
  let pageToken = '';
  for (let page = 0; page < 4; page++) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,emailAddresses,photos');
    url.searchParams.set('pageSize', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) {
        throw new Error('Accesso ai Contatti Google non autorizzato o People API non abilitata sul progetto');
      }
      throw new Error(`Errore lettura Contatti Google (${res.status})`);
    }
    const payload = await res.json();
    if (Array.isArray(payload.connections)) {
      allConnections.push(...payload.connections);
    }
    pageToken = payload.nextPageToken || '';
    if (!pageToken) break;
  }

  const candidates = extractGoogleContactCandidates(allConnections)
    .filter(c => normalizeEmail(c.email) !== normalizeEmail(user.email || ''));

  const matchesByUid = new Map();
  const CONCURRENCY = 20;
  let checked = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (candidate) => {
      const hash = await hashNormalizedEmail(candidate.email);
      if (!hash) return;
      const path = `directory_emails/${hash}`;
      try {
        const snap = await getDoc(doc(db, 'directory_emails', hash));
        if (snap.exists()) {
          const data = snap.data();
          if (data?.uid && data.uid !== user.uid && !matchesByUid.has(data.uid)) {
            matchesByUid.set(data.uid, {
              uid: data.uid,
              displayName: data.displayName || candidate.name || 'Utente InkNote',
              handle: data.handle || '',
              photoURL: sanitizePhotoUrl(data.photoURL || candidate.photoURL || ''),
              contactName: candidate.name || ''
            });
          }
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, path);
      } finally {
        checked++;
      }
    }));
    onProgress?.({ checked, total: candidates.length });
  }

  return {
    redirected: false,
    totalContactsWithEmail: candidates.length,
    matches: Array.from(matchesByUid.values())
  };
}

export async function addFriend(friendUser, source = 'manual') {
  const user = _requireReady();
  if (!friendUser?.uid || friendUser.uid === user.uid) {
    throw new Error('Utente non valido');
  }

  await ensureUserProfile(user);
  const path = `users/${user.uid}/friends/${friendUser.uid}`;
  const validSource = ['manual', 'contacts', 'received'].includes(source) ? source : 'manual';

  let existingAddedAt = null;
  try {
    const existingSnap = await getDoc(doc(db, 'users', user.uid, 'friends', friendUser.uid));
    if (existingSnap.exists()) {
      existingAddedAt = existingSnap.data()?.addedAt || null;
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  const payload = {
    uid: friendUser.uid,
    displayName: String(friendUser.displayName || 'Utente InkNote').trim().slice(0, 80) || 'Utente InkNote',
    handle: isValidHandle(friendUser.handle || '') ? friendUser.handle : '',
    photoURL: sanitizePhotoUrl(friendUser.photoURL || ''),
    source: validSource,
    addedAt: existingAddedAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, 'users', user.uid, 'friends', friendUser.uid), payload);
  } catch (err) {
    handleFirestoreError(err, existingAddedAt ? OperationType.UPDATE : OperationType.CREATE, path);
  }
}

export async function removeFriend(friendUid) {
  const user = _requireReady();
  if (!friendUid) return;
  const path = `users/${user.uid}/friends/${friendUid}`;
  try {
    await deleteDoc(doc(db, 'users', user.uid, 'friends', friendUid));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function subscribeFriends(uid, onUpdate) {
  if (!isFirestoreReady() || !uid) {
    onUpdate([]);
    return () => {};
  }
  const path = `users/${uid}/friends`;
  return onSnapshot(
    collection(db, 'users', uid, 'friends'),
    (snap) => {
      const list = [];
      snap.forEach((docSnap) => {
        list.push({ uid: docSnap.id, ...docSnap.data() });
      });
      list.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'it', { sensitivity: 'base' }));
      onUpdate(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

// ============================================================
// TRASFERIMENTI P2P (24H TTL + CHUNKING + AUTO-CLEANUP)
// ============================================================

export async function deleteTransferWithChunks(transferId) {
  if (!isFirestoreReady() || !transferId) return;
  const chunksPath = `transfers/${transferId}/chunks`;
  const transferPath = `transfers/${transferId}`;

  try {
    const chunksSnap = await getDocs(collection(db, 'transfers', transferId, 'chunks'));
    if (!chunksSnap.empty) {
      const batch = writeBatch(db);
      chunksSnap.forEach((chunkDoc) => batch.delete(chunkDoc.ref));
      await batch.commit();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, chunksPath);
  }

  try {
    await deleteDoc(doc(db, 'transfers', transferId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, transferPath);
  }
}

export async function sendNotebookToFriend({ notebookId, friend, senderProfile, onProgress }) {
  const user = _requireReady();
  if (!friend?.uid || friend.uid === user.uid) {
    throw new Error('Destinatario non valido');
  }

  const profile = senderProfile || await ensureUserProfile(user);
  const fullNb = await loadNotebookWithPages(notebookId);
  if (!fullNb) {
    throw new Error('Quaderno non trovato');
  }

  onProgress?.({ stage: 'pack', label: `Compressione "${fullNb.title || 'Quaderno'}"...` });

  const cleanNb = {
    ...fullNb,
    folderId: null,
    folderPath: null,
    isFavorite: false
  };

  const blob = await serializeBackup([cleanNb]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = splitBytesToBase64Chunks(bytes);

  const transferId = _generateTransferId();
  const transferPath = `transfers/${transferId}`;
  const expiresAt = Timestamp.fromMillis(computeTransferExpirationMs(Date.now(), TRANSFER_TTL_MS));
  const coverColor = /^#[0-9a-fA-F]{6}$/.test(fullNb.coverColor || '') ? fullNb.coverColor : '#4f46e5';

  try {
    await setDoc(doc(db, 'transfers', transferId), {
      id: transferId,
      senderUid: user.uid,
      senderName: profile?.displayName || _buildSafeDisplayName(user),
      senderHandle: profile?.handle || '',
      senderPhoto: sanitizePhotoUrl(profile?.photoURL || user.photoURL || ''),
      recipientUid: friend.uid,
      recipientName: String(friend.displayName || 'Amico').trim().slice(0, 80) || 'Amico',
      notebookTitle: String(fullNb.title || 'Quaderno').trim().slice(0, 140) || 'Quaderno',
      coverColor,
      pageCount: Math.max(1, Math.min(500, fullNb.pages?.length || 1)),
      byteSize: bytes.byteLength,
      chunkCount: chunks.length,
      status: 'uploading',
      createdAt: serverTimestamp(),
      expiresAt
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, transferPath);
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.({
        stage: 'upload',
        done: i,
        total: chunks.length,
        label: `Invio "${fullNb.title || 'Quaderno'}" (${i + 1}/${chunks.length})...`
      });
      const chunkPath = `transfers/${transferId}/chunks/${i}`;
      try {
        await setDoc(doc(db, 'transfers', transferId, 'chunks', String(i)), {
          index: chunks[i].index,
          data: chunks[i].data
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, chunkPath);
      }
    }

    try {
      await updateDoc(doc(db, 'transfers', transferId), {
        status: 'pending'
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, transferPath);
    }
  } catch (err) {
    // Cleanup trasferimento incompleto per non lasciare dati orfani su Firestore
    try {
      await deleteTransferWithChunks(transferId);
    } catch {}
    throw err;
  }

  return transferId;
}

export function subscribeIncomingTransfers(uid, { onUpdate, onNewIncoming }) {
  if (!isFirestoreReady() || !uid) {
    onUpdate([]);
    return () => {};
  }

  let initialized = false;
  const knownIds = new Set();
  const q = query(collection(db, 'transfers'), where('recipientUid', '==', uid));

  return onSnapshot(
    q,
    (snap) => {
      const raw = [];
      snap.forEach((docSnap) => {
        raw.push({ id: docSnap.id, ...docSnap.data() });
      });

      const { activePending, expiredIds } = classifyInboxTransfers(raw, Date.now());

      // Auto-eliminazione immediata dei trasferimenti scaduti (>24h) o già processati
      for (const expId of expiredIds) {
        void deleteTransferWithChunks(expId).catch(() => {});
      }

      const newlyArrived = [];
      const currentIds = new Set();
      for (const item of activePending) {
        currentIds.add(item.id);
        if (initialized && !knownIds.has(item.id)) {
          newlyArrived.push(item);
        }
      }

      knownIds.clear();
      currentIds.forEach(id => knownIds.add(id));
      if (!initialized) {
        initialized = true;
      } else if (newlyArrived.length > 0) {
        onNewIncoming?.(newlyArrived);
      }

      onUpdate(activePending);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'transfers');
    }
  );
}

export async function listAndCleanupOutgoingTransfers(uid = auth?.currentUser?.uid) {
  if (!isFirestoreReady() || !uid) return [];
  const q = query(collection(db, 'transfers'), where('senderUid', '==', uid));
  let snap;
  try {
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'transfers');
  }

  const raw = [];
  snap.forEach((docSnap) => raw.push({ id: docSnap.id, ...docSnap.data() }));
  const { activeSent, cleanupIds } = classifyOutgoingTransfers(raw, Date.now());

  for (const id of cleanupIds) {
    void deleteTransferWithChunks(id).catch(() => {});
  }

  return activeSent;
}

export async function importIncomingTransfer(transfer, onProgress) {
  const user = _requireReady();
  if (!transfer?.id || transfer.recipientUid !== user.uid) {
    throw new Error('Trasferimento non valido');
  }

  onProgress?.({ stage: 'download', label: `Scaricamento "${transfer.notebookTitle || 'Quaderno'}"...` });

  const chunksPath = `transfers/${transfer.id}/chunks`;
  let chunksSnap;
  try {
    chunksSnap = await getDocs(collection(db, 'transfers', transfer.id, 'chunks'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, chunksPath);
  }

  const chunkList = [];
  chunksSnap.forEach((d) => {
    const data = d.data();
    if (data && typeof data.data === 'string' && typeof data.index === 'number') {
      chunkList.push(data);
    }
  });

  const binary = reassembleBase64Chunks(chunkList);
  const { notebooks } = await deserializeBackup(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength), onProgress);

  if (!Array.isArray(notebooks) || notebooks.length === 0) {
    throw new Error('Contenuto del quaderno vuoto o corrotto');
  }

  const existingNbs = await loadAllNotebooksFromDB();
  const existingTitles = new Set(existingNbs.map(n => (n.title || '').trim().toLowerCase()));
  const baseTs = Date.now();
  const importedNotebooks = [];

  for (let i = 0; i < notebooks.length; i++) {
    const src = notebooks[i];
    const uniqueTitle = buildUniqueReceivedTitle(src.title || transfer.notebookTitle, existingTitles);
    existingTitles.add(uniqueTitle.toLowerCase());

    const pages = (src.pages || []).map(p => ({
      ...p,
      pageId: generatePageId(),
      strokes: Array.isArray(p?.strokes) ? p.strokes : [],
      textBoxes: Array.isArray(p?.textBoxes) ? p.textBoxes : []
    }));
    if (pages.length === 0) {
      pages.push({ pageId: generatePageId(), strokes: [], textBoxes: [] });
    }
    const pageOrder = pages.map(p => p.pageId);
    const now = new Date().toISOString();

    const importedNb = {
      ...src,
      id: `nb_${baseTs}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      title: uniqueTitle,
      folderId: null,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
      lastEditAt: now,
      pageOrder,
      pageCount: pages.length,
      pages
    };
    delete importedNb.folderPath;

    await saveNotebookToDB(importedNb, pageOrder, {
      preserveLastEditAt: true,
      replaceAllPages: false,
      saveOrder: true
    });
    importedNotebooks.push(importedNb);
  }

  // Libera subito lo spazio su Firestore eliminando chunk e documento trasferimento
  await deleteTransferWithChunks(transfer.id);

  return importedNotebooks;
}

export async function declineIncomingTransfer(transferId) {
  _requireReady();
  await deleteTransferWithChunks(transferId);
}
