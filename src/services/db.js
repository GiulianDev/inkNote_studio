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

export function saveNotebookToDB(notebook) {
  if (!db) return;
  notebook.updatedAt = new Date().toISOString();
  const tx = db.transaction('notebooks', 'readwrite');
  tx.objectStore('notebooks').put(notebook);
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