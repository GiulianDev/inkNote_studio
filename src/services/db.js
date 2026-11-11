// ============================================================
// IndexedDB puro
// ============================================================

let db = null;

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('InkNoteStudioDB', 1);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('notebooks')) {
        database.createObjectStore('notebooks', { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onerror = reject;
  });
}

/**
 * Salva (o aggiorna) un notebook. Ritorna una Promise che risolve
 * quando la transazione è committata.
 * Necessario per garantire che `openNotebook(id)` successivo trovi
 * il notebook in IDB (readwrite → readonly sono serializzate ma
 * serve il commit, non solo l'enqueue).
 */
export function saveNotebookToDB(notebook) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    notebook.updatedAt = new Date().toISOString();
    const tx = db.transaction('notebooks', 'readwrite');
    try {
      tx.objectStore('notebooks').put(notebook);
    } catch (err) {
      // DataCloneError (o altro errore sincrono del put)
      console.error('[db] put failed:', err);
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error('[db] tx error:', tx.error);
      reject(tx.error);
    };
    tx.onabort = () => {
      console.error('[db] tx abort:', tx.error);
      reject(tx.error);
    };
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
    const tx = db.transaction('notebooks', 'readwrite');
    const req = tx.objectStore('notebooks').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = reject;
  });
}