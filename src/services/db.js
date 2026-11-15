// ============================================================
// IndexedDB — v2 con store separati per notebook e pagine.
//
// Campi metadata aggiornati:
//   - updatedAt: ogni save (qualsiasi modifica)
//   - lastEditAt: solo se dirtyPages.length > 0 (scrittura reale)
// ============================================================

let db = null;

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('InkNoteStudioDB', 2);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;

      if (e.oldVersion > 0 && e.oldVersion < 2) {
        if (database.objectStoreNames.contains('notebooks')) {
          database.deleteObjectStore('notebooks');
        }
      }

      if (!database.objectStoreNames.contains('notebooks')) {
        database.createObjectStore('notebooks', { keyPath: 'id' });
      }

      if (!database.objectStoreNames.contains('pages')) {
        const pageStore = database.createObjectStore('pages', {
          keyPath: ['notebookId', 'pageIndex']
        });
        pageStore.createIndex('notebookId', 'notebookId');
      }
    };

    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onerror = reject;
  });
}

/**
 * Salva metadata + pagine dirty.
 *
 * @param {object} notebook        — oggetto in memoria
 * @param {number[]} dirtyPages    — indici delle pagine modificate
 * @param {object} [opts]
 *   - preserveLastEditAt: true → non aggiornare lastEditAt
 *     (usato dall'import per preservare il valore del file)
 *
 * lastEditAt si aggiorna SOLO se dirtyPages.length > 0. Cambi
 * toolbar/titolo/pattern non marcano la pagina dirty → lastEditAt
 * resta invariato. Cambio pattern fogli passa per scheduleSave()
 * senza markDirty:false, quindi marca dirty e aggiorna lastEditAt.
 */
export function saveNotebookToDB(notebook, dirtyPages = [], opts = {}) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();

    const now = new Date().toISOString();
    notebook.updatedAt = now;

    if (dirtyPages.length > 0 && !opts.preserveLastEditAt) {
      notebook.lastEditAt = now;
    }
    if (!notebook.lastEditAt) {
      notebook.lastEditAt = notebook.updatedAt;
    }

    const meta = {
      id: notebook.id,
      title: notebook.title,
      coverColor: notebook.coverColor,
      pattern: notebook.pattern,
      createdAt: notebook.createdAt,
      updatedAt: notebook.updatedAt,
      lastEditAt: notebook.lastEditAt,
      toolbarSettings: notebook.toolbarSettings,
      pageCount: Array.isArray(notebook.pages) ? notebook.pages.length : 0,
      lastPageIndex: typeof notebook.lastPageIndex === 'number' ? notebook.lastPageIndex : 0
    };

    const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
    try {
      tx.objectStore('notebooks').put(meta);
      for (const idx of dirtyPages) {
        const page = notebook.pages && notebook.pages[idx];
        if (!page) continue;
        tx.objectStore('pages').put({
          notebookId: notebook.id,
          pageIndex: page.pageIndex != null ? page.pageIndex : idx,
          strokes: page.strokes || []
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
    const tx = db.transaction(['notebooks', 'pages'], 'readonly');
    const nbReq = tx.objectStore('notebooks').get(id);
    const pagesReq = tx.objectStore('pages')
      .index('notebookId')
      .getAll(IDBKeyRange.only(id));

    tx.oncomplete = () => {
      const nb = nbReq.result;
      if (!nb) return resolve(null);

      const pageMap = new Map();
      (pagesReq.result || []).forEach(p => {
        pageMap.set(p.pageIndex, p.strokes || []);
      });

      const totalPages = Math.max(1, nb.pageCount || 1);
      const fullPages = new Array(totalPages);
      for (let i = 0; i < totalPages; i++) {
        fullPages[i] = {
          pageIndex: i,
          strokes: pageMap.get(i) || []
        };
      }
      nb.pages = fullPages;
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
    const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
    tx.objectStore('notebooks').delete(id);
    const range = IDBKeyRange.bound([id, 0], [id, 1e9]);
    tx.objectStore('pages').delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}