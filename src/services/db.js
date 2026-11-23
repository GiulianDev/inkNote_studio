// ============================================================
// IndexedDB — v4 con `pageOrders` + `pages` indicizzate per pageId
// e tracciamento formato (`CURRENT_NOTEBOOK_FORMAT`).
// ============================================================

import { generatePageId } from '../core/utils.js';

const DB_NAME = 'InkNoteStudioDB';
const DB_VERSION = 5;
export const CURRENT_NOTEBOOK_FORMAT = 4;

let db = null;

function _isV4PagesKeyPath(keyPath) {
  return Array.isArray(keyPath) &&
    keyPath.length === 2 &&
    keyPath[0] === 'notebookId' &&
    keyPath[1] === 'pageId';
}

function _strokeNeedsUpgrade(s) {
  if (!s) return false;
  if (!s.packed && Array.isArray(s.points)) return true;
  if (s.opacity == null) return true;
  if (s.tool === 'highlighter' && (!s.color || s.color === '#000000' || s.color === '#000' || s.color === 'black')) {
    return true;
  }
  return false;
}

function _dedupOrder(rawOrder) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rawOrder)) return out;
  for (const pid of rawOrder) {
    if (typeof pid !== 'string' || !pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

function _requestPersistentStorage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    if (typeof navigator.storage.persisted === 'function') {
      navigator.storage.persisted().then((already) => {
        if (!already) return navigator.storage.persist();
      }).catch(() => {});
    } else {
      navigator.storage.persist().catch(() => {});
    }
  } catch {
    // ignore environments without StorageManager
  }
}

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      const tx = e.target.transaction;
      const oldVersion = e.oldVersion;

      if (oldVersion > 0 && oldVersion < 2) {
        if (database.objectStoreNames.contains('notebooks')) {
          database.deleteObjectStore('notebooks');
        }
      }

      if (!database.objectStoreNames.contains('notebooks')) {
        database.createObjectStore('notebooks', { keyPath: 'id' });
      }

      const hadPageOrders = database.objectStoreNames.contains('pageOrders');
      if (!hadPageOrders) {
        database.createObjectStore('pageOrders', { keyPath: 'notebookId' });
      }

      if (!database.objectStoreNames.contains('folders')) {
        const folderStore = database.createObjectStore('folders', { keyPath: 'id' });
        folderStore.createIndex('parentId', 'parentId');
      }

      const hasPages = database.objectStoreNames.contains('pages');
      let needsPagesRebuild = false;
      if (hasPages) {
        try {
          const existingStore = tx.objectStore('pages');
          needsPagesRebuild = !_isV4PagesKeyPath(existingStore.keyPath);
        } catch {
          needsPagesRebuild = true;
        }
      }

      if (!hasPages) {
        const pageStore = database.createObjectStore('pages', {
          keyPath: ['notebookId', 'pageId']
        });
        pageStore.createIndex('notebookId', 'notebookId');
        return;
      }

      if (needsPagesRebuild) {
        const oldPagesStore = tx.objectStore('pages');
        const oldPagesReq = oldPagesStore.getAll();
        const nbsReq = tx.objectStore('notebooks').getAll();
        const existingOrdersReq = hadPageOrders ? tx.objectStore('pageOrders').getAll() : null;

        let oldPages = null;
        let allNbs = null;
        let existingOrders = existingOrdersReq ? null : [];
        let pending = existingOrdersReq ? 3 : 2;

        const finishToV4 = () => {
          pending--;
          if (pending > 0) return;

          database.deleteObjectStore('pages');
          const newPagesStore = database.createObjectStore('pages', {
            keyPath: ['notebookId', 'pageId']
          });
          newPagesStore.createIndex('notebookId', 'notebookId');

          const existingOrderMap = new Map();
          for (const rec of (existingOrders || [])) {
            if (rec && rec.notebookId) {
              existingOrderMap.set(rec.notebookId, _dedupOrder(rec.order));
            }
          }

          const byNb = new Map();
          for (const rec of (oldPages || [])) {
            if (!rec || !rec.notebookId) continue;
            if (!byNb.has(rec.notebookId)) byNb.set(rec.notebookId, []);
            byNb.get(rec.notebookId).push(rec);
          }

          const pagesOrderStore = tx.objectStore('pageOrders');
          const handledNb = new Set();

          for (const nb of (allNbs || [])) {
            if (!nb || !nb.id) continue;
            handledNb.add(nb.id);

            const rawList = byNb.get(nb.id) || [];
            rawList.sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));

            const idMap = new Map();
            const generatedIds = [];
            for (const rec of rawList) {
              const pid = (typeof rec.pageId === 'string' && rec.pageId)
                ? rec.pageId
                : generatePageId();
              idMap.set(pid, rec.strokes || []);
              generatedIds.push(pid);
              newPagesStore.put({
                notebookId: nb.id,
                pageId: pid,
                strokes: rec.strokes || [],
                textBoxes: Array.isArray(rec.textBoxes) ? rec.textBoxes : []
              });
            }

            const existingOrder = existingOrderMap.get(nb.id);
            let finalOrder = [];
            if (existingOrder && existingOrder.length > 0) {
              const seen = new Set();
              for (const pid of existingOrder) {
                if (!seen.has(pid) && idMap.has(pid)) {
                  seen.add(pid);
                  finalOrder.push(pid);
                }
              }
              for (const pid of generatedIds) {
                if (!seen.has(pid)) {
                  seen.add(pid);
                  finalOrder.push(pid);
                }
              }
            } else {
              finalOrder = generatedIds;
            }

            const targetCount = Math.max(1, nb.pageCount || finalOrder.length || 1);
            while (finalOrder.length < targetCount) {
              const pid = generatePageId();
              finalOrder.push(pid);
              newPagesStore.put({ notebookId: nb.id, pageId: pid, strokes: [], textBoxes: [] });
            }

            pagesOrderStore.put({ notebookId: nb.id, order: finalOrder });
          }

          for (const [nbId, rawList] of byNb.entries()) {
            if (handledNb.has(nbId)) continue;
            rawList.sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));
            const order = [];
            for (const rec of rawList) {
              const pid = (typeof rec.pageId === 'string' && rec.pageId)
                ? rec.pageId
                : generatePageId();
              order.push(pid);
              newPagesStore.put({
                notebookId: nbId,
                pageId: pid,
                strokes: rec.strokes || [],
                textBoxes: Array.isArray(rec.textBoxes) ? rec.textBoxes : []
              });
            }
            if (order.length > 0) {
              pagesOrderStore.put({ notebookId: nbId, order });
            }
          }
        };

        oldPagesReq.onsuccess = () => { oldPages = oldPagesReq.result || []; finishToV4(); };
        nbsReq.onsuccess = () => { allNbs = nbsReq.result || []; finishToV4(); };
        if (existingOrdersReq) {
          existingOrdersReq.onsuccess = () => { existingOrders = existingOrdersReq.result || []; finishToV4(); };
        }
      } else if (oldVersion < 4 && hadPageOrders) {
        const ordersReq = tx.objectStore('pageOrders').getAll();
        ordersReq.onsuccess = () => {
          const store = tx.objectStore('pageOrders');
          for (const rec of (ordersReq.result || [])) {
            if (!rec || !rec.notebookId) continue;
            const deduped = _dedupOrder(rec.order);
            if (!Array.isArray(rec.order) || deduped.length !== rec.order.length) {
              store.put({ notebookId: rec.notebookId, order: deduped });
            }
          }
        };
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      _requestPersistentStorage();
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Salva metadata + (opzionalmente) ordine pagine + pagine dirty/eliminate.
 *
 * @param {object} notebook
 * @param {Array<string|number>} dirtyPageIds
 * @param {object} [opts]
 *   - preserveLastEditAt: true → mantiene notebook.lastEditAt
 *   - preserveUpdatedAt: true  → mantiene notebook.updatedAt (usato dalla migrazione automatica)
 *   - deletedPageIds: string[] → elimina questi pageId da `pages`
 *   - orderChanged: boolean    → salva `pageOrders`
 *   - saveOrder: boolean       → salva `pageOrders`
 *   - replaceAllPages: boolean → rimuove da `pages` eventuali pageId non più nell'ordine
 */
export function saveNotebookToDB(notebook, dirtyPageIds = [], opts = {}) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();

    const now = new Date().toISOString();
    if (!opts.preserveUpdatedAt || !notebook.updatedAt) {
      notebook.updatedAt = now;
    }
    if (dirtyPageIds.length > 0 && !opts.preserveLastEditAt) {
      notebook.lastEditAt = now;
    }
    if (!notebook.lastEditAt) {
      notebook.lastEditAt = notebook.updatedAt;
    }
    notebook.formatVersion = CURRENT_NOTEBOOK_FORMAT;

    const pages = Array.isArray(notebook.pages) ? notebook.pages : [];
    const dirtyList = Array.isArray(dirtyPageIds) ? dirtyPageIds : [];
    const needsOrderRebuild = !!(
      opts.saveOrder ||
      opts.orderChanged ||
      opts.replaceAllPages ||
      !Array.isArray(notebook.pageOrder) ||
      notebook.pageOrder.length !== pages.length
    );

    let order;
    let seenIds = null;
    const dirtyPagesToPut = [];

    if (!needsOrderRebuild && dirtyList.every(k => typeof k === 'string' && k)) {
      order = notebook.pageOrder;
      if (dirtyList.length === 1) {
        const targetId = dirtyList[0];
        const hintIdx = typeof notebook.lastPageIndex === 'number' ? notebook.lastPageIndex : -1;
        const hinted = (hintIdx >= 0 && hintIdx < pages.length) ? pages[hintIdx] : null;
        if (hinted && hinted.pageId === targetId) {
          dirtyPagesToPut.push(hinted);
        } else {
          for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            if (p && p.pageId === targetId) {
              dirtyPagesToPut.push(p);
              break;
            }
          }
        }
      } else if (dirtyList.length > 1) {
        const wanted = new Set(dirtyList);
        for (let i = 0; i < pages.length && wanted.size > 0; i++) {
          const p = pages[i];
          if (p && p.pageId && wanted.has(p.pageId)) {
            dirtyPagesToPut.push(p);
            wanted.delete(p.pageId);
          }
        }
      }
    } else {
      order = [];
      seenIds = new Set();
      const pageById = new Map();

      for (const p of pages) {
        if (!p) continue;
        if (!p.pageId) p.pageId = generatePageId();
        if (!seenIds.has(p.pageId)) {
          seenIds.add(p.pageId);
          order.push(p.pageId);
          pageById.set(p.pageId, p);
        }
      }
      notebook.pageOrder = order.slice();

      for (const key of dirtyList) {
        const page = typeof key === 'number' ? pages[key] : pageById.get(key);
        if (page && page.pageId) dirtyPagesToPut.push(page);
      }
    }

    const meta = {
      id: notebook.id,
      title: notebook.title,
      coverColor: notebook.coverColor,
      pattern: notebook.pattern || 'ruled',
      folderId: (typeof notebook.folderId === 'string' && notebook.folderId) ? notebook.folderId : null,
      isFavorite: !!notebook.isFavorite,
      createdAt: notebook.createdAt || now,
      updatedAt: notebook.updatedAt,
      lastEditAt: notebook.lastEditAt,
      toolbarSettings: notebook.toolbarSettings || null,
      pageCount: order.length,
      lastPageIndex: typeof notebook.lastPageIndex === 'number' ? notebook.lastPageIndex : 0,
      formatVersion: CURRENT_NOTEBOOK_FORMAT
    };

    const tx = db.transaction(['notebooks', 'pageOrders', 'pages'], 'readwrite');
    try {
      tx.objectStore('notebooks').put(meta);

      const pageOrdersStore = tx.objectStore('pageOrders');
      if (opts.saveOrder || opts.orderChanged || opts.replaceAllPages) {
        pageOrdersStore.put({ notebookId: notebook.id, order });
      }

      const pagesStore = tx.objectStore('pages');

      if (opts.replaceAllPages) {
        const range = IDBKeyRange.only(notebook.id);
        pagesStore.index('notebookId').openCursor(range).onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          if (!seenIds.has(cursor.value.pageId)) {
            cursor.delete();
          }
          cursor.continue();
        };
      }

      if (Array.isArray(opts.deletedPageIds)) {
        for (const delId of opts.deletedPageIds) {
          if (typeof delId === 'string' && delId) {
            pagesStore.delete([notebook.id, delId]);
          }
        }
      }

      for (const page of dirtyPagesToPut) {
        pagesStore.put({
          notebookId: notebook.id,
          pageId: page.pageId,
          strokes: page.strokes || [],
          textBoxes: Array.isArray(page.textBoxes) ? page.textBoxes : []
        });
      }
    } catch (err) {
      console.error('[db] put failed:', err);
      reject(err);
      return;
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function loadNotebookWithPages(id) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(null);
    const tx = db.transaction(['notebooks', 'pageOrders', 'pages'], 'readonly');
    const nbReq = tx.objectStore('notebooks').get(id);
    const orderReq = tx.objectStore('pageOrders').get(id);
    const pagesReq = tx.objectStore('pages')
      .index('notebookId')
      .getAll(IDBKeyRange.only(id));

    tx.oncomplete = () => {
      const nb = nbReq.result;
      if (!nb) return resolve(null);

      const orderRec = orderReq.result;
      const rawPages = pagesReq.result || [];

      let orderAdjusted = !orderRec || !Array.isArray(orderRec.order);
      let pagesAdjusted = false;

      const rawMap = new Map();
      const rawWithoutId = [];
      for (const rec of rawPages) {
        if (!rec) continue;
        const entry = {
          strokes: rec.strokes || [],
          textBoxes: Array.isArray(rec.textBoxes) ? rec.textBoxes : []
        };
        if (typeof rec.pageId === 'string' && rec.pageId) {
          rawMap.set(rec.pageId, entry);
        } else {
          pagesAdjusted = true;
          rawWithoutId.push(rec);
        }
      }
      if (rawWithoutId.length > 0) {
        rawWithoutId.sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));
        for (const rec of rawWithoutId) {
          const pid = generatePageId();
          rawMap.set(pid, {
            strokes: rec.strokes || [],
            textBoxes: Array.isArray(rec.textBoxes) ? rec.textBoxes : []
          });
        }
      }

      const order = [];
      const seen = new Set();
      if (orderRec && Array.isArray(orderRec.order)) {
        for (const pid of orderRec.order) {
          if (typeof pid !== 'string' || !pid || seen.has(pid)) {
            orderAdjusted = true;
            continue;
          }
          seen.add(pid);
          order.push(pid);
        }
      }

      // Eventuali record in `pages` non presenti in `pageOrders`
      for (const pid of rawMap.keys()) {
        if (!seen.has(pid)) {
          seen.add(pid);
          order.push(pid);
          orderAdjusted = true;
        }
      }

      if (order.length === 0) {
        const pid = generatePageId();
        order.push(pid);
        rawMap.set(pid, { strokes: [], textBoxes: [] });
        orderAdjusted = true;
        pagesAdjusted = true;
      }

      const expectedCount = typeof nb.pageCount === 'number' ? nb.pageCount : order.length;
      while (order.length < expectedCount) {
        const pid = generatePageId();
        order.push(pid);
        rawMap.set(pid, { strokes: [], textBoxes: [] });
        orderAdjusted = true;
        pagesAdjusted = true;
      }

      const legacyPageIds = [];
      const fullPages = order.map((pageId, i) => {
        const hasRec = rawMap.has(pageId);
        const rec = hasRec ? rawMap.get(pageId) : { strokes: [], textBoxes: [] };
        const strokes = rec.strokes;
        const textBoxes = rec.textBoxes;
        if (!hasRec) {
          pagesAdjusted = true;
        }
        if (!hasRec || strokes.some(_strokeNeedsUpgrade)) {
          legacyPageIds.push(pageId);
        }
        return {
          pageIndex: i,
          pageId,
          strokes,
          textBoxes
        };
      });

      const hasLegacyMeta =
        (nb.formatVersion || 0) < CURRENT_NOTEBOOK_FORMAT ||
        !nb.lastEditAt ||
        !nb.pattern ||
        !nb.toolbarSettings ||
        typeof nb.toolbarSettings.autoShapeEnabled === 'boolean';

      nb.pages = fullPages;
      nb.pageOrder = order.slice();

      const needsUpgrade =
        hasLegacyMeta ||
        orderAdjusted ||
        pagesAdjusted ||
        legacyPageIds.length > 0;

      // Proprietà non enumerabili: usate solo da openNotebook(), mai serializzate
      Object.defineProperties(nb, {
        _needsFormatUpgrade: { value: needsUpgrade, enumerable: false, configurable: true, writable: true },
        _orderReconstructed: { value: orderAdjusted || pagesAdjusted, enumerable: false, configurable: true, writable: true },
        _legacyPageIds: { value: legacyPageIds, enumerable: false, configurable: true, writable: true }
      });

      resolve(nb);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export function loadAllNotebooksFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction('notebooks', 'readonly');
    const req = tx.objectStore('notebooks').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = reject;
  });
}

export function deleteNotebookFromDB(id) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction(['notebooks', 'pageOrders', 'pages'], 'readwrite');
    tx.objectStore('notebooks').delete(id);
    tx.objectStore('pageOrders').delete(id);

    const pagesStore = tx.objectStore('pages');
    pagesStore.index('notebookId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) return;
      pagesStore.delete(cursor.primaryKey);
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function updateNotebookMetadataInDB(id, patch = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!db || !id) return resolve(null);
    const tx = db.transaction('notebooks', 'readwrite');
    const store = tx.objectStore('notebooks');
    const req = store.get(id);
    let updated = null;

    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) return;
      updated = { ...existing };
      if ('title' in patch) updated.title = String(patch.title || '').trim() || existing.title;
      if ('coverColor' in patch && patch.coverColor) updated.coverColor = patch.coverColor;
      if ('folderId' in patch) {
        updated.folderId = (typeof patch.folderId === 'string' && patch.folderId) ? patch.folderId : null;
      }
      if ('isFavorite' in patch) updated.isFavorite = !!patch.isFavorite;
      if (opts.touchUpdatedAt) {
        updated.updatedAt = new Date().toISOString();
      }
      store.put(updated);
    };

    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
  });
}

export function loadAllFoldersFromDB() {
  return new Promise((resolve, reject) => {
    if (!db || !db.objectStoreNames.contains('folders')) return resolve([]);
    const tx = db.transaction('folders', 'readonly');
    const req = tx.objectStore('folders').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export function saveFolderToDB(folder) {
  return new Promise((resolve, reject) => {
    if (!db || !folder || !folder.id) return resolve(null);
    const now = new Date().toISOString();
    const record = {
      id: folder.id,
      name: String(folder.name || 'Nuova Cartella').trim() || 'Nuova Cartella',
      parentId: (typeof folder.parentId === 'string' && folder.parentId && folder.parentId !== folder.id)
        ? folder.parentId
        : null,
      color: folder.color || '#6366f1',
      createdAt: folder.createdAt || now,
      updatedAt: now
    };
    const tx = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export function deleteLibraryItemsFromDB({
  folderIds = [],
  notebookIds = [],
  deleteFolderContents = true
} = {}) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve({ deletedFolderIds: [], deletedNotebookIds: [] });

    const stores = ['notebooks', 'pageOrders', 'pages'];
    const hasFoldersStore = db.objectStoreNames.contains('folders');
    if (hasFoldersStore) stores.push('folders');

    const tx = db.transaction(stores, 'readwrite');
    const folderStore = hasFoldersStore ? tx.objectStore('folders') : null;
    const nbStore = tx.objectStore('notebooks');
    const pageOrdersStore = tx.objectStore('pageOrders');
    const pagesStore = tx.objectStore('pages');

    const explicitFolderIds = new Set((folderIds || []).filter(Boolean));
    const explicitNbIds = new Set((notebookIds || []).filter(Boolean));

    const allFoldersReq = folderStore ? folderStore.getAll() : null;
    const allNbsReq = nbStore.getAll();

    let allFolders = allFoldersReq ? null : [];
    let allNbs = null;
    let deletedFolderIds = [];
    let deletedNotebookIds = [];

    const tryApply = () => {
      if (allFolders === null || allNbs === null) return;

      const folderMap = new Map(allFolders.filter(f => f && f.id).map(f => [f.id, f]));
      const foldersToDelete = new Set();

      if (deleteFolderContents) {
        const queue = [];
        for (const fid of explicitFolderIds) {
          if (folderMap.has(fid) && !foldersToDelete.has(fid)) {
            foldersToDelete.add(fid);
            queue.push(fid);
          }
        }
        while (queue.length > 0) {
          const cur = queue.shift();
          for (const f of allFolders) {
            if (f && (f.parentId || null) === cur && !foldersToDelete.has(f.id)) {
              foldersToDelete.add(f.id);
              queue.push(f.id);
            }
          }
        }
      } else {
        for (const fid of explicitFolderIds) {
          if (folderMap.has(fid)) foldersToDelete.add(fid);
        }
      }

      const resolveSurvivingParent = (startParentId) => {
        const visited = new Set();
        let cur = startParentId || null;
        while (cur && !visited.has(cur)) {
          visited.add(cur);
          if (!foldersToDelete.has(cur)) return folderMap.has(cur) ? cur : null;
          const f = folderMap.get(cur);
          cur = f ? (f.parentId || null) : null;
        }
        return null;
      };

      const nbsToDelete = new Set(explicitNbIds);
      if (deleteFolderContents) {
        for (const nb of allNbs) {
          if (nb && nb.folderId && foldersToDelete.has(nb.folderId)) {
            nbsToDelete.add(nb.id);
          }
        }
      }

      if (!deleteFolderContents) {
        const now = new Date().toISOString();
        for (const f of allFolders) {
          if (!f || foldersToDelete.has(f.id)) continue;
          if (f.parentId && foldersToDelete.has(f.parentId)) {
            folderStore.put({
              ...f,
              parentId: resolveSurvivingParent(f.parentId),
              updatedAt: now
            });
          }
        }
        for (const nb of allNbs) {
          if (!nb || nbsToDelete.has(nb.id)) continue;
          if (nb.folderId && foldersToDelete.has(nb.folderId)) {
            nbStore.put({
              ...nb,
              folderId: resolveSurvivingParent(nb.folderId)
            });
          }
        }
      }

      for (const fid of foldersToDelete) {
        folderStore?.delete(fid);
      }

      for (const nbId of nbsToDelete) {
        nbStore.delete(nbId);
        pageOrdersStore.delete(nbId);
        pagesStore.index('notebookId').openKeyCursor(IDBKeyRange.only(nbId)).onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          pagesStore.delete(cursor.primaryKey);
          cursor.continue();
        };
      }

      deletedFolderIds = Array.from(foldersToDelete);
      deletedNotebookIds = Array.from(nbsToDelete);
    };

    if (allFoldersReq) {
      allFoldersReq.onsuccess = () => { allFolders = allFoldersReq.result || []; tryApply(); };
    }
    allNbsReq.onsuccess = () => { allNbs = allNbsReq.result || []; tryApply(); };

    tx.oncomplete = () => resolve({ deletedFolderIds, deletedNotebookIds });
    tx.onerror = () => reject(tx.error);
  });
}

export function deleteFolderFromDB(folderId, { deleteContents = false } = {}) {
  return deleteLibraryItemsFromDB({
    folderIds: folderId ? [folderId] : [],
    deleteFolderContents: deleteContents
  });
}