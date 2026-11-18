// ============================================================
// IndexedDB — v4:
//   - notebooks:  metadati leggeri (keyPath 'id')
//   - pageOrders: mapping ordine { notebookId, order: string[] }
//   - pages:      contenuto pagine (keyPath ['notebookId', 'pageId'])
//
// Verifica lo schema reale (keyPath) e migra da v1, v2 e v3 senza perdere dati.
// ============================================================

import { generatePageId } from '../core/utils.js';

let db = null;

function _dedupOrder(list) {
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('InkNoteStudioDB', 4);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      const tx = e.target.transaction;

      if (e.oldVersion === 0) {
        database.createObjectStore('notebooks', { keyPath: 'id' });
        database.createObjectStore('pageOrders', { keyPath: 'notebookId' });
        const pageStore = database.createObjectStore('pages', {
          keyPath: ['notebookId', 'pageId']
        });
        pageStore.createIndex('notebookId', 'notebookId');
        return;
      }

      const hasNotebooks = database.objectStoreNames.contains('notebooks');
      const hasPages = database.objectStoreNames.contains('pages');
      const hasPageOrders = database.objectStoreNames.contains('pageOrders');

      const existingKeyPath = hasPages ? tx.objectStore('pages').keyPath : null;
      const needsPagesRebuild = !hasPages ||
        !Array.isArray(existingKeyPath) ||
        existingKeyPath[0] !== 'notebookId' ||
        existingKeyPath[1] !== 'pageId';

      const nbReq = hasNotebooks ? tx.objectStore('notebooks').getAll() : null;
      const pagesReq = hasPages ? tx.objectStore('pages').getAll() : null;
      const ordersReq = hasPageOrders ? tx.objectStore('pageOrders').getAll() : null;

      let oldNotebooks = [];
      let oldPages = [];
      let oldOrders = [];
      let pending = (nbReq ? 1 : 0) + (pagesReq ? 1 : 0) + (ordersReq ? 1 : 0);

      const finalizeUpgrade = () => {
        if (!hasNotebooks) {
          database.createObjectStore('notebooks', { keyPath: 'id' });
        }
        const pageOrdersStore = hasPageOrders
          ? tx.objectStore('pageOrders')
          : database.createObjectStore('pageOrders', { keyPath: 'notebookId' });

        let targetPagesStore;
        if (needsPagesRebuild) {
          if (hasPages) database.deleteObjectStore('pages');
          targetPagesStore = database.createObjectStore('pages', {
            keyPath: ['notebookId', 'pageId']
          });
          targetPagesStore.createIndex('notebookId', 'notebookId');
        } else {
          targetPagesStore = tx.objectStore('pages');
        }

        const nbStore = tx.objectStore('notebooks');

        const ordersByNb = new Map();
        for (const rec of oldOrders) {
          if (rec && rec.notebookId && Array.isArray(rec.order)) {
            ordersByNb.set(rec.notebookId, rec.order);
          }
        }

        const pagesByNb = new Map();
        for (const p of oldPages) {
          if (!p || !p.notebookId) continue;
          if (!pagesByNb.has(p.notebookId)) pagesByNb.set(p.notebookId, []);
          pagesByNb.get(p.notebookId).push(p);
        }

        for (const nb of oldNotebooks) {
          if (!nb || !nb.id) continue;

          let order = [];
          const existingList = pagesByNb.get(nb.id) || [];

          if (!needsPagesRebuild) {
            const existingOrder = ordersByNb.get(nb.id) ||
              (Array.isArray(nb.pageOrder) ? nb.pageOrder : null);
            order = _dedupOrder(
              existingOrder && existingOrder.length > 0
                ? existingOrder
                : existingList.map(p => p.pageId)
            );
          } else if (Array.isArray(nb.pages) && nb.pages.length > 0 && existingList.length === 0) {
            for (const p of nb.pages) {
              const pageId = (p && typeof p.pageId === 'string' && p.pageId) ? p.pageId : generatePageId();
              order.push(pageId);
              targetPagesStore.put({
                notebookId: nb.id,
                pageId,
                strokes: (p && p.strokes) || []
              });
            }
            delete nb.pages;
          } else {
            const hasPageIdRecords = existingList.some(p => typeof p.pageId === 'string' && p.pageId);
            if (hasPageIdRecords) {
              const byId = new Map();
              for (const p of existingList) {
                const pid = (typeof p.pageId === 'string' && p.pageId) ? p.pageId : generatePageId();
                byId.set(pid, p.strokes || []);
              }
              const preferred = Array.isArray(nb.pageOrder) && nb.pageOrder.length > 0
                ? _dedupOrder(nb.pageOrder)
                : Array.from(byId.keys());
              for (const pid of preferred) {
                order.push(pid);
                targetPagesStore.put({
                  notebookId: nb.id,
                  pageId: pid,
                  strokes: byId.get(pid) || []
                });
              }
              for (const [pid, strokes] of byId.entries()) {
                if (!order.includes(pid)) {
                  order.push(pid);
                  targetPagesStore.put({ notebookId: nb.id, pageId: pid, strokes });
                }
              }
            } else {
              const byIndex = new Map();
              let maxIdx = -1;
              for (const p of existingList) {
                const idx = typeof p.pageIndex === 'number' ? p.pageIndex : 0;
                byIndex.set(idx, p);
                if (idx > maxIdx) maxIdx = idx;
              }
              const total = Math.max(
                1,
                typeof nb.pageCount === 'number' && nb.pageCount > 0 ? nb.pageCount : (maxIdx + 1)
              );
              for (let i = 0; i < total; i++) {
                const oldP = byIndex.get(i);
                const pageId = generatePageId();
                order.push(pageId);
                targetPagesStore.put({
                  notebookId: nb.id,
                  pageId,
                  strokes: (oldP && oldP.strokes) || []
                });
              }
            }
          }

          order = _dedupOrder(order);
          if (order.length === 0) {
            const firstId = generatePageId();
            order.push(firstId);
            targetPagesStore.put({ notebookId: nb.id, pageId: firstId, strokes: [] });
          }

          pageOrdersStore.put({ notebookId: nb.id, order });
          delete nb.pageOrder;
          nb.pageCount = order.length;
          nbStore.put(nb);
        }
      };

      if (pending === 0) {
        finalizeUpgrade();
      } else {
        const onPartDone = () => {
          pending--;
          if (pending === 0) finalizeUpgrade();
        };
        if (nbReq) nbReq.onsuccess = () => { oldNotebooks = nbReq.result || []; onPartDone(); };
        if (pagesReq) pagesReq.onsuccess = () => { oldPages = pagesReq.result || []; onPartDone(); };
        if (ordersReq) ordersReq.onsuccess = () => { oldOrders = ordersReq.result || []; onPartDone(); };
      }
    };

    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onerror = (e) => reject(e.target.error || e);
  });
}

export function saveNotebookToDB(notebook, dirtyPageIds = [], opts = {}) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();

    const now = new Date().toISOString();
    notebook.updatedAt = now;

    const deletedIds = Array.isArray(opts.deletedPageIds) ? opts.deletedPageIds : [];
    const shouldWriteOrder = Boolean(
      opts.orderChanged || opts.replaceAllPages || opts.saveOrder || deletedIds.length > 0
    );
    const hasContentEdit =
      dirtyPageIds.length > 0 || deletedIds.length > 0 || opts.orderChanged === true;

    if (hasContentEdit && !opts.preserveLastEditAt) {
      notebook.lastEditAt = now;
    }
    if (!notebook.lastEditAt) {
      notebook.lastEditAt = notebook.updatedAt;
    }

    const rawOrder = Array.isArray(notebook.pageOrder)
      ? notebook.pageOrder
      : (Array.isArray(notebook.pages) ? notebook.pages.map(p => p.pageId) : []);
    const pageOrder = _dedupOrder(rawOrder);

    const meta = {
      id: notebook.id,
      title: notebook.title,
      coverColor: notebook.coverColor,
      pattern: notebook.pattern,
      createdAt: notebook.createdAt,
      updatedAt: notebook.updatedAt,
      lastEditAt: notebook.lastEditAt,
      toolbarSettings: notebook.toolbarSettings,
      pageCount: pageOrder.length,
      lastPageIndex: typeof notebook.lastPageIndex === 'number' ? notebook.lastPageIndex : 0
    };

    const pageById = new Map();
    if (Array.isArray(notebook.pages)) {
      for (const p of notebook.pages) {
        if (p && p.pageId) pageById.set(p.pageId, p);
      }
    }

    const tx = db.transaction(['notebooks', 'pageOrders', 'pages'], 'readwrite');
    try {
      tx.objectStore('notebooks').put(meta);

      if (shouldWriteOrder) {
        tx.objectStore('pageOrders').put({
          notebookId: notebook.id,
          order: pageOrder
        });
      }

      const pagesStore = tx.objectStore('pages');
      if (opts.replaceAllPages) {
        pagesStore.delete(IDBKeyRange.bound([notebook.id, ''], [notebook.id, []]));
      } else {
        for (const pageId of deletedIds) {
          if (pageId) pagesStore.delete([notebook.id, pageId]);
        }
      }

      for (const pageId of dirtyPageIds) {
        const page = pageById.get(pageId);
        if (!page) continue;
        pagesStore.put({
          notebookId: notebook.id,
          pageId,
          strokes: page.strokes || []
        });
      }
    } catch (err) {
      console.error('[db] put failed:', err);
      reject(err);
      return;
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
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

      const pageMap = new Map();
      (pagesReq.result || []).forEach(p => {
        if (p && p.pageId) pageMap.set(p.pageId, p.strokes || []);
      });

      const orderRec = orderReq.result;
      let order = _dedupOrder(
        (orderRec && Array.isArray(orderRec.order) ? orderRec.order : null) ||
        (Array.isArray(nb.pageOrder) ? nb.pageOrder : [])
      );

      if (order.length === 0) {
        if (pageMap.size > 0) {
          order = Array.from(pageMap.keys());
        } else {
          const total = Math.max(1, nb.pageCount || 1);
          order = Array.from({ length: total }, () => generatePageId());
        }
      }

      nb.pageOrder = order;
      nb.pageCount = order.length;
      nb.pages = order.map(pageId => ({
        pageId,
        strokes: pageMap.get(pageId) || []
      }));
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
    const range = IDBKeyRange.bound([id, ''], [id, []]);
    tx.objectStore('pages').delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}