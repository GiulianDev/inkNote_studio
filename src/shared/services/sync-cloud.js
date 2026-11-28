/**
 * @module services/sync-cloud
 *
 * Motore di sincronizzazione Cloud MANUALE su Firestore.
 *   - Zero listener `onSnapshot` e zero scritture automatiche in background:
 *     ogni lettura/scrittura avviene esclusivamente su azione esplicita dell'utente.
 *   - Riconciliazione bidirezionale con tombstone per cartelle e quaderni.
 *   - Deduplicazione per pagina via SHA-256 (`pageId` immutabile) e chunking
 *     automatico oltre la soglia di sicurezza di 1 MiB per documento Firestore.
 */

import {
  Bytes,
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp
} from 'firebase/firestore';
import {
  auth,
  db,
  OperationType,
  handleFirestoreError,
  isFirestoreReady
} from './firebase.js';
import { ensureUserProfile } from './sharing-cloud.js';
import {
  loadAllFoldersFromDB,
  loadAllNotebooksFromDB,
  loadNotebookWithPages,
  saveFolderToDB,
  saveNotebookToDB,
  deleteNotebookFromDB,
  deleteLibraryItemsFromDB
} from './db.js';
import { getCurrentNotebook } from '../persistence/session.js';
import { forceSave } from '../persistence/autosave.js';
import {
  compressPageForCloud,
  decompressPageBundle,
  reassembleCompressedPageFromChunks
} from '../backup/serialization-cloud.js';
import { generatePageId } from '../core/utils.js';
import {
  sanitizeCloudFolderPayload,
  sanitizeCloudNotebookPayload,
  sanitizeToolbarSettingsForCloud,
  sanitizePageOrder,
  assertCloudSyncPageLimit,
  computeFolderMetaSignature,
  computeNotebookMetaSignature,
  cloudFolderToLocalRecord,
  sortFoldersParentFirst,
  reconcileSyncSets,
  sha256Uint8Array,
  parseSyncTimestampMs,
  loadLocalTombstones,
  clearLocalDeletion,
  loadUserSyncState,
  saveUserSyncState,
  loadDailySyncUsage,
  recordDailySyncUsage
} from '../sync/sync-helpers.js';

let _syncInFlight = null;

function _requireVerifiedCloudUser() {
  if (!isFirestoreReady()) {
    throw new Error('Firebase Firestore non configurato su questa installazione.');
  }
  const user = auth?.currentUser;
  if (!user || user.isAnonymous) {
    throw new Error('Accedi con un account Google per sincronizzare nel cloud.');
  }
  if (!user.emailVerified) {
    throw new Error('Il tuo account deve avere un’email verificata per sincronizzare.');
  }
  return user;
}

function _bytesFieldToUint8Array(val) {
  if (!val) return new Uint8Array(0);
  if (val instanceof Uint8Array) return val;
  if (typeof val.toUint8Array === 'function') return val.toUint8Array();
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (ArrayBuffer.isView(val)) return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  return new Uint8Array(0);
}

function _generateCopiedNotebookId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'nb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function _listOwnerCollectionDocs(pathSegments, ownerUid, pathLabel, stats) {
  const colRef = collection(db, ...pathSegments);
  const q = query(colRef, where('ownerUid', '==', ownerUid));
  try {
    const snap = await getDocs(q);
    stats.readsApprox += Math.max(1, snap.size);
    const out = [];
    snap.forEach((docSnap) => {
      out.push({ id: docSnap.id, ...docSnap.data() });
    });
    return out;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, pathLabel);
  }
}

async function _deleteChunkRange(uid, nbId, pageId, fromIndex, toIndexExclusive, stats) {
  for (let idx = fromIndex; idx < toIndexExclusive; idx++) {
    const path = `users/${uid}/sync_notebooks/${nbId}/pages/${pageId}/chunks/${idx}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'sync_notebooks', nbId, 'pages', pageId, 'chunks', String(idx)));
      stats.writesApprox += 1;
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }
}

async function _deleteAllChunksOfPage(uid, nbId, pageId, stats) {
  const pathLabel = `users/${uid}/sync_notebooks/${nbId}/pages/${pageId}/chunks`;
  const chunks = await _listOwnerCollectionDocs(
    ['users', uid, 'sync_notebooks', nbId, 'pages', pageId, 'chunks'],
    uid,
    pathLabel,
    stats
  );
  for (const ch of chunks) {
    const chPath = `${pathLabel}/${ch.id}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'sync_notebooks', nbId, 'pages', pageId, 'chunks', ch.id));
      stats.writesApprox += 1;
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, chPath);
    }
  }
}

async function _uploadNotebookToCloud({
  uid,
  notebookId,
  existingCloudNb = null,
  stats,
  onProgress,
  progressPrefix = ''
}) {
  const fullNb = await loadNotebookWithPages(notebookId);
  if (!fullNb) {
    return null;
  }

  assertCloudSyncPageLimit(fullNb);

  const sanitizedMeta = sanitizeCloudNotebookPayload({
    notebook: fullNb,
    ownerUid: uid,
    deleted: false,
    existingCloud: existingCloudNb
  });

  const pagesPathLabel = `users/${uid}/sync_notebooks/${notebookId}/pages`;
  const existingCloudPages = await _listOwnerCollectionDocs(
    ['users', uid, 'sync_notebooks', notebookId, 'pages'],
    uid,
    pagesPathLabel,
    stats
  );
  const cloudPageById = new Map(existingCloudPages.map(p => [p.pageId || p.id, p]));

  // Se il quaderno è nuovo in cloud, creiamo prima un documento padre in stato di staging
  // (pageOrder: [], pageCount: 0) affinché le regole Firestore su pages/chunks possano
  // verificarne il proprietario via get(), senza esporre pageOrder finché tutte le pagine
  // non sono state caricate con successo.
  const nbDocRef = doc(db, 'users', uid, 'sync_notebooks', notebookId);
  const nbDocPath = `users/${uid}/sync_notebooks/${notebookId}`;
  let createdStagingParent = false;
  if (!existingCloudNb) {
    try {
      await setDoc(nbDocRef, {
        ...sanitizedMeta,
        pageOrder: [],
        pageCount: 0,
        lastPageIndex: 0,
        clientUpdatedAt: '1970-01-01T00:00:00.000Z',
        lastEditAt: '1970-01-01T00:00:00.000Z',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      createdStagingParent = true;
      stats.writesApprox += 1;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, nbDocPath);
    }
  }

  const pageOrderSet = new Set(sanitizedMeta.pageOrder);
  const pages = Array.isArray(fullNb.pages) ? fullNb.pages : [];
  const nextPageHashes = {};
  const uploadedNewPageIds = [];

  try {
    for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (!p || !p.pageId || !pageOrderSet.has(p.pageId)) continue;
    const pageId = p.pageId;
    const pagePath = `${pagesPathLabel}/${pageId}`;
    const pageRef = doc(db, 'users', uid, 'sync_notebooks', notebookId, 'pages', pageId);

    onProgress?.({
      stage: 'upload_page',
      label: `${progressPrefix}Compressione pagina ${i + 1}/${pages.length} di "${sanitizedMeta.title}"...`
    });

    const packedRes = await compressPageForCloud(p.strokes || [], p.textBoxes || []);
    const hash = await sha256Uint8Array(packedRes.compressed);
    nextPageHashes[pageId] = hash;

    const existingPage = cloudPageById.get(pageId) || null;
    if (existingPage && !existingPage.deleted && existingPage.hash === hash) {
      stats.skippedPages += 1;
      continue;
    }

    if (packedRes.nearLimit) {
      stats.nearLimitPages.push({
        notebookTitle: sanitizedMeta.title,
        pageNumber: i + 1,
        byteLength: packedRes.totalBytes,
        chunked: packedRes.chunked,
        chunkCount: packedRes.chunkCount
      });
    }

    const clientUpdatedAt = sanitizedMeta.clientUpdatedAt;
    const emptyBytes = Bytes.fromUint8Array(new Uint8Array(0));

    if (packedRes.chunked) {
      // Prima aggiorniamo/creiamo il documento padre della pagina (richiesto da get() delle regole sui chunk)
      if (!existingPage) {
        try {
          await setDoc(pageRef, {
            pageId,
            notebookId,
            ownerUid: uid,
            hash,
            chunked: true,
            chunkCount: packedRes.chunkCount,
            totalBytes: packedRes.totalBytes,
            payload: emptyBytes,
            deleted: false,
            clientUpdatedAt,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          stats.writesApprox += 1;
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, pagePath);
        }
      } else {
        try {
          await updateDoc(pageRef, {
            hash,
            chunked: true,
            chunkCount: packedRes.chunkCount,
            totalBytes: packedRes.totalBytes,
            payload: emptyBytes,
            deleted: false,
            clientUpdatedAt,
            updatedAt: serverTimestamp()
          });
          stats.writesApprox += 1;
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, pagePath);
        }
      }

      const prevChunkCount = existingPage?.chunkCount || 0;
      for (let cIdx = 0; cIdx < packedRes.chunks.length; cIdx++) {
        onProgress?.({
          stage: 'upload_chunk',
          label: `${progressPrefix}Invio frammento ${cIdx + 1}/${packedRes.chunks.length} (pag. ${i + 1} di "${sanitizedMeta.title}")...`
        });
        const chunkRef = doc(db, 'users', uid, 'sync_notebooks', notebookId, 'pages', pageId, 'chunks', String(cIdx));
        const chunkPath = `${pagePath}/chunks/${cIdx}`;
        const chunkData = Bytes.fromUint8Array(packedRes.chunks[cIdx]);
        try {
          if (cIdx < prevChunkCount) {
            await updateDoc(chunkRef, {
              index: cIdx,
              data: chunkData,
              updatedAt: serverTimestamp()
            });
          } else {
            await setDoc(chunkRef, {
              index: cIdx,
              ownerUid: uid,
              data: chunkData,
              updatedAt: serverTimestamp()
            });
          }
          stats.writesApprox += 1;
        } catch (err) {
          handleFirestoreError(err, cIdx < prevChunkCount ? OperationType.UPDATE : OperationType.CREATE, chunkPath);
        }
      }

      if (prevChunkCount > packedRes.chunkCount) {
        await _deleteChunkRange(uid, notebookId, pageId, packedRes.chunkCount, prevChunkCount, stats);
      }
    } else {
      const payloadBytes = Bytes.fromUint8Array(packedRes.compressed);
      if (!existingPage) {
        try {
          await setDoc(pageRef, {
            pageId,
            notebookId,
            ownerUid: uid,
            hash,
            chunked: false,
            chunkCount: 1,
            totalBytes: packedRes.totalBytes,
            payload: payloadBytes,
            deleted: false,
            clientUpdatedAt,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          stats.writesApprox += 1;
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, pagePath);
        }
      } else {
        try {
          await updateDoc(pageRef, {
            hash,
            chunked: false,
            chunkCount: 1,
            totalBytes: packedRes.totalBytes,
            payload: payloadBytes,
            deleted: false,
            clientUpdatedAt,
            updatedAt: serverTimestamp()
          });
          stats.writesApprox += 1;
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, pagePath);
        }
      }

      if (existingPage?.chunked || (existingPage?.chunkCount || 0) > 1) {
        await _deleteAllChunksOfPage(uid, notebookId, pageId, stats);
      }
    }

    if (!existingPage) {
      uploadedNewPageIds.push(pageId);
    }
    stats.uploadedPages += 1;
    stats.bytesUploaded += packedRes.totalBytes;
  }

  // Finalizza i metadati del quaderno (pageOrder/pageCount reali) solo dopo che
  // tutte le pagine attive e relativi chunk sono stati caricati con successo.
  try {
    await updateDoc(nbDocRef, {
      title: sanitizedMeta.title,
      coverColor: sanitizedMeta.coverColor,
      pattern: sanitizedMeta.pattern,
      folderId: sanitizedMeta.folderId,
      isFavorite: sanitizedMeta.isFavorite,
      pageOrder: sanitizedMeta.pageOrder,
      pageCount: sanitizedMeta.pageCount,
      lastPageIndex: sanitizedMeta.lastPageIndex,
      toolbarSettings: sanitizedMeta.toolbarSettings,
      deleted: false,
      clientCreatedAt: sanitizedMeta.clientCreatedAt,
      clientUpdatedAt: sanitizedMeta.clientUpdatedAt,
      lastEditAt: sanitizedMeta.lastEditAt,
      updatedAt: serverTimestamp()
    });
    stats.writesApprox += 1;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, nbDocPath);
  }
  } catch (uploadErr) {
    if (createdStagingParent) {
      for (const pid of uploadedNewPageIds) {
        try {
          await _deleteAllChunksOfPage(uid, notebookId, pid, stats);
        } catch {}
        try {
          await deleteDoc(doc(db, 'users', uid, 'sync_notebooks', notebookId, 'pages', pid));
        } catch {}
      }
      try {
        await deleteDoc(nbDocRef);
      } catch {}
    }
    throw uploadErr;
  }

  // Solo dopo aver aggiornato pageOrder sul documento padre eliminiamo le pagine obsolete (best-effort)
  for (const [oldPid, oldPage] of cloudPageById.entries()) {
    if (pageOrderSet.has(oldPid)) continue;
    try {
      if (oldPage.chunked || (oldPage.chunkCount || 0) > 1) {
        await _deleteAllChunksOfPage(uid, notebookId, oldPid, stats);
      }
      await deleteDoc(doc(db, 'users', uid, 'sync_notebooks', notebookId, 'pages', oldPid));
      stats.writesApprox += 1;
    } catch (cleanupErr) {
      console.warn('[sync-cloud] cleanup removed page skipped:', oldPid, cleanupErr);
    }
  }

  stats.uploadedNotebooks += 1;
  clearLocalDeletion('notebooks', notebookId);

  return {
    localUpdatedMs: parseSyncTimestampMs(fullNb.updatedAt || fullNb.lastEditAt || fullNb.createdAt),
    cloudServerUpdatedMs: existingCloudNb ? 0 : 0,
    uploadedClientUpdatedAt: sanitizedMeta.clientUpdatedAt,
    localMetaSignature: computeNotebookMetaSignature(fullNb),
    cloudMetaSignature: computeNotebookMetaSignature(sanitizedMeta),
    pageHashes: nextPageHashes
  };
}

async function _downloadNotebookFromCloud({
  uid,
  cloudNb,
  prevSyncEntry = null,
  stats,
  onProgress,
  progressPrefix = ''
}) {
  const nbId = cloudNb.id;
  const pagesPathLabel = `users/${uid}/sync_notebooks/${nbId}/pages`;
  const cloudPages = await _listOwnerCollectionDocs(
    ['users', uid, 'sync_notebooks', nbId, 'pages'],
    uid,
    pagesPathLabel,
    stats
  );
  const cloudPageMap = new Map(cloudPages.map(p => [p.pageId || p.id, p]));

  const existingLocal = await loadNotebookWithPages(nbId);
  const localPageMap = new Map();
  if (existingLocal && Array.isArray(existingLocal.pages)) {
    for (const lp of existingLocal.pages) {
      if (lp && lp.pageId) localPageMap.set(lp.pageId, lp);
    }
  }

  const prevHashes = prevSyncEntry?.pageHashes || {};
  const orderedIds = sanitizePageOrder(cloudNb.pageOrder);
  const downloadedPages = [];
  const nextPageHashes = {};

  for (let i = 0; i < orderedIds.length; i++) {
    const pid = orderedIds[i];
    const cp = cloudPageMap.get(pid);
    if (!cp || cp.deleted) {
      throw new Error(
        `Sincronizzazione cloud incompleta per "${cloudNb.title || nbId}": pagina ${i + 1} (${pid}) mancante nel cloud. Riprova a sincronizzare dal dispositivo di origine.`
      );
    }

    if (cp.hash && prevHashes[pid] === cp.hash && localPageMap.has(pid)) {
      const reused = localPageMap.get(pid);
      downloadedPages.push({
        pageId: pid,
        strokes: reused.strokes || [],
        textBoxes: Array.isArray(reused.textBoxes) ? reused.textBoxes : []
      });
      nextPageHashes[pid] = cp.hash;
      stats.skippedPages += 1;
      continue;
    }

    onProgress?.({
      stage: 'download_page',
      label: `${progressPrefix}Scaricamento pagina ${i + 1}/${orderedIds.length} di "${cloudNb.title}"...`
    });

    let compressedBytes;
    if (cp.chunked) {
      const chunksPathLabel = `${pagesPathLabel}/${pid}/chunks`;
      const rawChunks = await _listOwnerCollectionDocs(
        ['users', uid, 'sync_notebooks', nbId, 'pages', pid, 'chunks'],
        uid,
        chunksPathLabel,
        stats
      );
      compressedBytes = reassembleCompressedPageFromChunks(rawChunks);
    } else {
      compressedBytes = _bytesFieldToUint8Array(cp.payload);
    }

    stats.bytesDownloaded += compressedBytes.byteLength;
    stats.downloadedPages += 1;

    const bundle = compressedBytes.byteLength > 0
      ? await decompressPageBundle(compressedBytes)
      : { strokes: [], textBoxes: [] };

    downloadedPages.push({
      pageId: pid,
      strokes: Array.isArray(bundle.strokes) ? bundle.strokes : [],
      textBoxes: Array.isArray(bundle.textBoxes) ? bundle.textBoxes : []
    });
    if (cp.hash) nextPageHashes[pid] = cp.hash;
  }

  if (downloadedPages.length === 0) {
    const fallbackPid = generatePageId();
    downloadedPages.push({ pageId: fallbackPid, strokes: [], textBoxes: [] });
  }

  const finalPageOrder = downloadedPages.map(p => p.pageId);
  const nowIso = new Date().toISOString();
  const updatedIso = cloudNb.clientUpdatedAt || nowIso;
  const createdIso = cloudNb.clientCreatedAt || updatedIso;
  const lastEditIso = cloudNb.lastEditAt || updatedIso;

  const localRecord = {
    id: nbId,
    title: cloudNb.title || 'Quaderno senza titolo',
    coverColor: cloudNb.coverColor || '#4f46e5',
    pattern: cloudNb.pattern || 'ruled',
    folderId: cloudNb.folderId || null,
    isFavorite: !!cloudNb.isFavorite,
    createdAt: createdIso,
    updatedAt: updatedIso,
    lastEditAt: lastEditIso,
    toolbarSettings: sanitizeToolbarSettingsForCloud(cloudNb.toolbarSettings),
    pageOrder: finalPageOrder,
    pageCount: downloadedPages.length,
    lastPageIndex: Math.max(0, Math.min(downloadedPages.length - 1, Number(cloudNb.lastPageIndex) || 0)),
    pages: downloadedPages
  };

  await saveNotebookToDB(localRecord, finalPageOrder, {
    preserveUpdatedAt: true,
    preserveLastEditAt: true,
    replaceAllPages: true,
    saveOrder: true
  });

  stats.downloadedNotebooks += 1;

  return {
    localUpdatedMs: parseSyncTimestampMs(localRecord.updatedAt || localRecord.lastEditAt),
    cloudServerUpdatedMs: parseSyncTimestampMs(cloudNb.updatedAt || cloudNb.clientUpdatedAt),
    localMetaSignature: computeNotebookMetaSignature(localRecord),
    cloudMetaSignature: computeNotebookMetaSignature(cloudNb),
    pageHashes: nextPageHashes
  };
}

async function _duplicateLocalNotebookForConflict(nbId, existingTitlesSet) {
  const fullNb = await loadNotebookWithPages(nbId);
  if (!fullNb) return null;

  const baseTitle = (fullNb.title || 'Quaderno').trim() || 'Quaderno';
  let candidate = `${baseTitle} (Copia locale)`;
  let counter = 2;
  while (existingTitlesSet.has(candidate.toLowerCase())) {
    candidate = `${baseTitle} (Copia locale ${counter++})`;
  }
  existingTitlesSet.add(candidate.toLowerCase());

  const newPages = (fullNb.pages || []).map(p => ({
    pageId: generatePageId(),
    strokes: p.strokes || [],
    textBoxes: Array.isArray(p.textBoxes) ? p.textBoxes : []
  }));
  if (newPages.length === 0) {
    newPages.push({ pageId: generatePageId(), strokes: [], textBoxes: [] });
  }
  const newOrder = newPages.map(p => p.pageId);
  const nowIso = new Date().toISOString();

  const copyNb = {
    ...fullNb,
    id: _generateCopiedNotebookId(),
    title: candidate,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastEditAt: fullNb.lastEditAt || nowIso,
    pageOrder: newOrder,
    pageCount: newPages.length,
    pages: newPages
  };

  await saveNotebookToDB(copyNb, newOrder, {
    preserveLastEditAt: true,
    replaceAllPages: false,
    saveOrder: true
  });

  return copyNb;
}

async function _markNotebookDeletedInCloud({
  uid,
  notebookId,
  existingCloudNb,
  tombstoneMs,
  stats
}) {
  const pagesPathLabel = `users/${uid}/sync_notebooks/${notebookId}/pages`;
  const cloudPages = await _listOwnerCollectionDocs(
    ['users', uid, 'sync_notebooks', notebookId, 'pages'],
    uid,
    pagesPathLabel,
    stats
  );
  for (const cp of cloudPages) {
    const pid = cp.pageId || cp.id;
    if (cp.chunked || (cp.chunkCount || 0) > 1) {
      await _deleteAllChunksOfPage(uid, notebookId, pid, stats);
    }
    const pagePath = `${pagesPathLabel}/${pid}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'sync_notebooks', notebookId, 'pages', pid));
      stats.writesApprox += 1;
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, pagePath);
    }
  }

  const tombstonePayload = sanitizeCloudNotebookPayload({
    notebookId,
    ownerUid: uid,
    deleted: true,
    existingCloud: existingCloudNb,
    deletedAtMs: tombstoneMs
  });

  const nbRef = doc(db, 'users', uid, 'sync_notebooks', notebookId);
  const nbPath = `users/${uid}/sync_notebooks/${notebookId}`;
  try {
    await updateDoc(nbRef, {
      pageOrder: [],
      pageCount: 0,
      lastPageIndex: 0,
      deleted: true,
      clientUpdatedAt: tombstonePayload.clientUpdatedAt,
      lastEditAt: tombstonePayload.lastEditAt,
      updatedAt: serverTimestamp()
    });
    stats.writesApprox += 1;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, nbPath);
  }

  clearLocalDeletion('notebooks', notebookId);
  stats.deletedCloud += 1;
}

/**
 * Restituisce un riepilogo 100% locale dello stato sync e dei consumi odierni
 * (ZERO chiamate a Firestore).
 */
export async function getManualSyncOverview(uid = auth?.currentUser?.uid) {
  const [folders, notebooks] = await Promise.all([
    loadAllFoldersFromDB(),
    loadAllNotebooksFromDB()
  ]);
  const tombstones = loadLocalTombstones();
  const syncState = uid ? loadUserSyncState(uid) : { lastSyncAt: null, folders: {}, notebooks: {} };
  const dailyUsage = uid ? loadDailySyncUsage(uid) : loadDailySyncUsage('');

  return {
    localFoldersCount: folders.length,
    localNotebooksCount: notebooks.length,
    pendingTombstonesCount:
      Object.keys(tombstones.folders).length + Object.keys(tombstones.notebooks).length,
    lastSyncAt: syncState.lastSyncAt,
    dailyUsage
  };
}

/**
 * Esegue la sincronizzazione manuale completa con Firestore.
 * Non avvia alcun listener né sincronizzazione automatica.
 *
 * @param {object} [opts]
 * @param {(progress: {stage: string, label: string, done?: number, total?: number}) => void} [opts.onProgress]
 * @param {(conflicts: Array<object>) => Promise<Record<string, 'keep_local'|'use_cloud'|'keep_both'|'skip'>>} [opts.onConflicts]
 */
export async function runManualCloudSync({ onProgress, onConflicts } = {}) {
  if (_syncInFlight) {
    throw new Error('Sincronizzazione già in corso');
  }

  const run = (async () => {
    const user = _requireVerifiedCloudUser();
    const uid = user.uid;

    const stats = {
      uploadedFolders: 0,
      downloadedFolders: 0,
      uploadedNotebooks: 0,
      downloadedNotebooks: 0,
      uploadedPages: 0,
      downloadedPages: 0,
      skippedPages: 0,
      deletedCloud: 0,
      deletedLocal: 0,
      bytesUploaded: 0,
      bytesDownloaded: 0,
      readsApprox: 0,
      writesApprox: 0,
      nearLimitPages: [],
      updatedOpenNotebook: false,
      deletedOpenNotebook: false,
      openNotebookId: getCurrentNotebook()?.id || null,
      abortedByUser: false
    };

    try {
      onProgress?.({ stage: 'prepare', label: 'Salvataggio modifiche locali e verifica account...' });
      if (getCurrentNotebook()) {
        await forceSave();
      }

      await ensureUserProfile(user);

      onProgress?.({ stage: 'fetch', label: 'Controllo stato cloud su Firestore...' });
      const [localFolders, localNotebooks, cloudFolders, cloudNotebooks] = await Promise.all([
        loadAllFoldersFromDB(),
        loadAllNotebooksFromDB(),
        _listOwnerCollectionDocs(['users', uid, 'sync_folders'], uid, `users/${uid}/sync_folders`, stats),
        _listOwnerCollectionDocs(['users', uid, 'sync_notebooks'], uid, `users/${uid}/sync_notebooks`, stats)
      ]);

      const tombstones = loadLocalTombstones();
      const prevSyncState = loadUserSyncState(uid);
      const nextSyncState = {
        lastSyncAt: prevSyncState.lastSyncAt,
        folders: { ...(prevSyncState.folders || {}) },
        notebooks: { ...(prevSyncState.notebooks || {}) }
      };

      const folderActions = reconcileSyncSets({
        localItems: localFolders,
        cloudItems: cloudFolders,
        localTombstones: tombstones.folders,
        lastSyncMap: prevSyncState.folders || {},
        getLocalSignature: computeFolderMetaSignature,
        getCloudSignature: computeFolderMetaSignature
      });

      const notebookActions = reconcileSyncSets({
        localItems: localNotebooks,
        cloudItems: cloudNotebooks,
        localTombstones: tombstones.notebooks,
        lastSyncMap: prevSyncState.notebooks || {},
        getLocalSignature: computeNotebookMetaSignature,
        getCloudSignature: computeNotebookMetaSignature
      });

      // Raccoglie eventuali conflitti (cartelle + quaderni) e chiede una sola volta all'utente
      const conflictItems = [];
      for (const act of folderActions) {
        if (act.action === 'conflict') {
          conflictItems.push({ kind: 'folder', ...act });
        }
      }
      for (const act of notebookActions) {
        if (act.action === 'conflict') {
          conflictItems.push({ kind: 'notebook', ...act });
        }
      }

      let conflictChoices = {};
      if (conflictItems.length > 0) {
        if (typeof onConflicts === 'function') {
          const resolved = await onConflicts(conflictItems);
          if (!resolved) {
            stats.abortedByUser = true;
            return stats;
          }
          conflictChoices = resolved;
        } else {
          for (const c of conflictItems) {
            conflictChoices[`${c.kind}:${c.id}`] = 'keep_local';
          }
        }
      }

      // Applica scelte sui conflitti alle liste azioni
      const applyConflictChoice = (act, kind) => {
        if (act.action !== 'conflict') return act;
        const choice = conflictChoices[`${kind}:${act.id}`] || 'skip';
        if (choice === 'keep_local') {
          if (!act.local && act.tombstoneMs) {
            return { ...act, action: 'delete_cloud' };
          }
          return { ...act, action: 'upload' };
        }
        if (choice === 'use_cloud') {
          if (act.cloud?.deleted) {
            return { ...act, action: 'delete_local' };
          }
          return { ...act, action: 'download' };
        }
        if (choice === 'keep_both' && kind === 'notebook' && act.local && act.cloud && !act.cloud.deleted) {
          return { ...act, action: 'keep_both_download' };
        }
        return { ...act, action: 'skip' };
      };

      const resolvedFolderActions = folderActions.map(a => applyConflictChoice(a, 'folder'));
      const resolvedNotebookActions = notebookActions.map(a => applyConflictChoice(a, 'notebook'));

      // 1. Cartelle (prima download/upload in ordine genitori -> figli)
      const folderDownloads = sortFoldersParentFirst(
        resolvedFolderActions.filter(a => a.action === 'download').map(a => a.cloud)
      );
      const folderUploads = sortFoldersParentFirst(
        resolvedFolderActions.filter(a => a.action === 'upload').map(a => a.local)
      );
      const cloudFolderById = new Map(cloudFolders.map(f => [f.id, f]));

      if (folderDownloads.length > 0 || folderUploads.length > 0) {
        onProgress?.({ stage: 'folders', label: 'Allineamento raccolte e cartelle...' });
      }

      for (const cf of folderDownloads) {
        const localRec = cloudFolderToLocalRecord(cf);
        await saveFolderToDB(localRec, { preserveUpdatedAt: true });
        nextSyncState.folders[cf.id] = {
          localUpdatedMs: parseSyncTimestampMs(localRec.updatedAt),
          cloudServerUpdatedMs: parseSyncTimestampMs(cf.updatedAt || cf.clientUpdatedAt),
          localMetaSignature: computeFolderMetaSignature(localRec),
          cloudMetaSignature: computeFolderMetaSignature(cf)
        };
        stats.downloadedFolders += 1;
      }

      for (const lf of folderUploads) {
        const existingCloud = cloudFolderById.get(lf.id) || null;
        const payload = sanitizeCloudFolderPayload({
          folder: lf,
          ownerUid: uid,
          deleted: false,
          existingCloud
        });
        const fRef = doc(db, 'users', uid, 'sync_folders', lf.id);
        const fPath = `users/${uid}/sync_folders/${lf.id}`;
        try {
          if (!existingCloud) {
            await setDoc(fRef, {
              ...payload,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          } else {
            await updateDoc(fRef, {
              name: payload.name,
              parentId: payload.parentId,
              color: payload.color,
              deleted: false,
              clientCreatedAt: payload.clientCreatedAt,
              clientUpdatedAt: payload.clientUpdatedAt,
              updatedAt: serverTimestamp()
            });
          }
          stats.writesApprox += 1;
        } catch (err) {
          handleFirestoreError(err, existingCloud ? OperationType.UPDATE : OperationType.CREATE, fPath);
        }
        clearLocalDeletion('folders', lf.id);
        nextSyncState.folders[lf.id] = {
          localUpdatedMs: parseSyncTimestampMs(lf.updatedAt || lf.createdAt),
          cloudServerUpdatedMs: 0,
          uploadedClientUpdatedAt: payload.clientUpdatedAt,
          localMetaSignature: computeFolderMetaSignature(lf),
          cloudMetaSignature: computeFolderMetaSignature(payload)
        };
        stats.uploadedFolders += 1;
      }

      const folderIdsToDeleteLocal = [];
      for (const act of resolvedFolderActions) {
        if (act.action === 'delete_cloud' && act.cloud) {
          const payload = sanitizeCloudFolderPayload({
            folderId: act.id,
            ownerUid: uid,
            deleted: true,
            existingCloud: act.cloud,
            deletedAtMs: act.tombstoneMs
          });
          const fRef = doc(db, 'users', uid, 'sync_folders', act.id);
          const fPath = `users/${uid}/sync_folders/${act.id}`;
          try {
            await updateDoc(fRef, {
              deleted: true,
              clientUpdatedAt: payload.clientUpdatedAt,
              updatedAt: serverTimestamp()
            });
            stats.writesApprox += 1;
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, fPath);
          }
          clearLocalDeletion('folders', act.id);
          delete nextSyncState.folders[act.id];
          stats.deletedCloud += 1;
        } else if (act.action === 'delete_local') {
          folderIdsToDeleteLocal.push(act.id);
          delete nextSyncState.folders[act.id];
        } else if (act.action === 'noop') {
          if (act.clearTombstone) clearLocalDeletion('folders', act.id);
          if (act.local && act.cloud && !act.cloud.deleted) {
            nextSyncState.folders[act.id] = {
              localUpdatedMs: parseSyncTimestampMs(act.local.updatedAt || act.local.createdAt),
              cloudServerUpdatedMs: parseSyncTimestampMs(act.cloud.updatedAt || act.cloud.clientUpdatedAt),
              localMetaSignature: computeFolderMetaSignature(act.local),
              cloudMetaSignature: computeFolderMetaSignature(act.cloud)
            };
          } else if (act.cloud?.deleted) {
            delete nextSyncState.folders[act.id];
          }
        }
      }

      if (folderIdsToDeleteLocal.length > 0) {
        await deleteLibraryItemsFromDB({
          folderIds: folderIdsToDeleteLocal,
          deleteFolderContents: false,
          fromCloudSync: true
        });
        stats.deletedLocal += folderIdsToDeleteLocal.length;
      }

      // 2. Quaderni
      const existingTitlesSet = new Set(
        localNotebooks.map(n => String(n?.title || '').trim().toLowerCase()).filter(Boolean)
      );
      const nbWorkQueue = resolvedNotebookActions.filter(
        a => a.action !== 'noop' && a.action !== 'skip'
      );
      let completedNbSteps = 0;

      for (const act of resolvedNotebookActions) {
        if (act.action === 'noop') {
          if (act.clearTombstone) clearLocalDeletion('notebooks', act.id);
          if (act.local && act.cloud && !act.cloud.deleted) {
            nextSyncState.notebooks[act.id] = {
              localUpdatedMs: parseSyncTimestampMs(act.local.updatedAt || act.local.lastEditAt || act.local.createdAt),
              cloudServerUpdatedMs: parseSyncTimestampMs(act.cloud.updatedAt || act.cloud.clientUpdatedAt),
              localMetaSignature: computeNotebookMetaSignature(act.local),
              cloudMetaSignature: computeNotebookMetaSignature(act.cloud),
              pageHashes: prevSyncState.notebooks?.[act.id]?.pageHashes || {}
            };
          } else if (act.cloud?.deleted) {
            delete nextSyncState.notebooks[act.id];
          }
          continue;
        }

        if (act.action === 'skip') continue;

        completedNbSteps++;
        const prefix = nbWorkQueue.length > 1 ? `[${completedNbSteps}/${nbWorkQueue.length}] ` : '';

        if (act.action === 'upload') {
          onProgress?.({
            stage: 'upload_nb',
            done: completedNbSteps - 1,
            total: nbWorkQueue.length,
            label: `${prefix}Caricamento "${act.local?.title || 'Quaderno'}"...`
          });
          const entry = await _uploadNotebookToCloud({
            uid,
            notebookId: act.id,
            existingCloudNb: act.cloud || null,
            stats,
            onProgress,
            progressPrefix: prefix
          });
          if (entry) nextSyncState.notebooks[act.id] = entry;
        } else if (act.action === 'download' || act.action === 'keep_both_download') {
          if (act.action === 'keep_both_download') {
            onProgress?.({
              stage: 'duplicate',
              label: `${prefix}Salvataggio copia locale di "${act.local?.title || 'Quaderno'}"...`
            });
            const duplicated = await _duplicateLocalNotebookForConflict(act.id, existingTitlesSet);
            if (duplicated) {
              const dupEntry = await _uploadNotebookToCloud({
                uid,
                notebookId: duplicated.id,
                existingCloudNb: null,
                stats,
                onProgress,
                progressPrefix: prefix
              });
              if (dupEntry) nextSyncState.notebooks[duplicated.id] = dupEntry;
            }
          }

          onProgress?.({
            stage: 'download_nb',
            done: completedNbSteps - 1,
            total: nbWorkQueue.length,
            label: `${prefix}Scaricamento "${act.cloud?.title || 'Quaderno'}"...`
          });
          const entry = await _downloadNotebookFromCloud({
            uid,
            cloudNb: act.cloud,
            prevSyncEntry: prevSyncState.notebooks?.[act.id] || null,
            stats,
            onProgress,
            progressPrefix: prefix
          });
          nextSyncState.notebooks[act.id] = entry;
          if (stats.openNotebookId && stats.openNotebookId === act.id) {
            stats.updatedOpenNotebook = true;
          }
        } else if (act.action === 'delete_cloud' && act.cloud) {
          onProgress?.({
            stage: 'delete_cloud',
            done: completedNbSteps - 1,
            total: nbWorkQueue.length,
            label: `${prefix}Rimozione dal cloud "${act.cloud?.title || 'Quaderno'}"...`
          });
          await _markNotebookDeletedInCloud({
            uid,
            notebookId: act.id,
            existingCloudNb: act.cloud,
            tombstoneMs: act.tombstoneMs,
            stats
          });
          delete nextSyncState.notebooks[act.id];
        } else if (act.action === 'delete_local') {
          onProgress?.({
            stage: 'delete_local',
            done: completedNbSteps - 1,
            total: nbWorkQueue.length,
            label: `${prefix}Rimozione locale "${act.local?.title || 'Quaderno'}"...`
          });
          await deleteNotebookFromDB(act.id, { fromCloudSync: true });
          delete nextSyncState.notebooks[act.id];
          stats.deletedLocal += 1;
          if (stats.openNotebookId && stats.openNotebookId === act.id) {
            stats.deletedOpenNotebook = true;
          }
        }
      }

      nextSyncState.lastSyncAt = new Date().toISOString();
      saveUserSyncState(uid, nextSyncState);
      recordDailySyncUsage(uid, {
        syncCount: 1,
        bytesUploaded: stats.bytesUploaded,
        bytesDownloaded: stats.bytesDownloaded,
        readsApprox: stats.readsApprox,
        writesApprox: stats.writesApprox
      });

      onProgress?.({ stage: 'done', label: 'Sincronizzazione completata!' });
      return stats;
    } finally {
      // Anche se fallisce parzialmente o viene annullato, non lasciamo stato bloccato
    }
  })();

  _syncInFlight = run;
  try {
    return await run;
  } finally {
    if (_syncInFlight === run) {
      _syncInFlight = null;
    }
  }
}

export function isCloudSyncRunning() {
  return Boolean(_syncInFlight);
}
