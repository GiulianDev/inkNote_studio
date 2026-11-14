// ============================================================
// IndexedDB — v2 con store separati per notebook e pagine.
//
// Struttura:
//   - store "notebooks" (keyPath: 'id')
//       { id, title, coverColor, pattern, createdAt, updatedAt,
//         toolbarSettings, pageCount, lastPageIndex }
//   - store "pages" (keyPath: ['notebookId', 'pageIndex'])
//       { notebookId, pageIndex, strokes: PackedStroke[] }
//       + index 'notebookId' per getAll(id)
//
// Perché split per-page:
//   - saveNotebookToDB(nb, dirtyPages) scrive SOLO le pagine dirty
//   - structured-clone = ~4.4 MB (una pagina) invece di ~130 MB (30 pagine)
//   - su Surface Go 1: da ~500-1500 ms a ~5-35 ms per save
//
// Fresh start: se oldVersion < 2, cancella lo store v1. L'app è in
// sviluppo, non ci sono dati legacy da migrare.
// ============================================================

let db = null;

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('InkNoteStudioDB', 2);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;

      // v1 → v2: butta via lo store monolitico v1 (fresh start).
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
 * @param {number[]} dirtyPages    — indici in notebook.pages delle pagine
 *                                    modificate dall'ultimo save. Se omesso
 *                                    o vuoto, salva solo metadata (veloce).
 *
 * Costo: metadata = pochi KB; ogni pagina dirty = ~4.4 MB
 * (Float32Array → memcpy nativo di IDB).
 */
export function saveNotebookToDB(notebook, dirtyPages = []) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    notebook.updatedAt = new Date().toISOString();

    // Metadata senza pages (le pagine vivono nello store separato).
    const meta = {
      id: notebook.id,
      title: notebook.title,
      coverColor: notebook.coverColor,
      pattern: notebook.pattern,
      createdAt: notebook.createdAt,
      updatedAt: notebook.updatedAt,
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

/**
 * Carica un notebook completo (metadata + tutte le pagine).
 *
 * Il DB contiene solo le pagine effettivamente scritte. Le pagine
 * mai usate non hanno entry nello store `pages`. Qui ricostruiamo
 * TUTTE le pagine 0..pageCount-1, riempiendo le mancanti con
 * strokes vuoti. Così ogni pagina mantiene il suo indice originale
 * e non c'è shift/compaction al load.
 */
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

/**
 * Carica solo i metadata di tutti i notebook (per la libreria).
 * Nessuna pagina: leggero anche con notebook grandi.
 */
export function loadAllNotebooksFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction('notebooks', 'readonly');
    const req = tx.objectStore('notebooks').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = reject;
  });
}

/**
 * Cancella notebook + tutte le sue pagine (range query sull'indice).
 */
export function deleteNotebookFromDB(id) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
    tx.objectStore('notebooks').delete(id);
    // Range: tutte le entry con chiave composta [id, *]
    const range = IDBKeyRange.bound([id, 0], [id, 1e9]);
    tx.objectStore('pages').delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}