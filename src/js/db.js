// ============================================================
// PERSISTENZA (IndexedDB)
// ============================================================

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('InkNoteStudioDB', 1);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('notebooks')) {
                database.createObjectStore('notebooks', { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e);
    });
}

function saveNotebookToDB(notebook) {
    if (!db) return;
    notebook.updatedAt = new Date().toISOString();
    const tx = db.transaction('notebooks', 'readwrite');
    tx.objectStore('notebooks').put(notebook);
    // Badge "Salvato" gestito da library.js (autoSaveTrigger).
}

function loadAllNotebooksFromDB() {
    return new Promise((resolve, reject) => {
        if (!db) return resolve([]);
        const tx = db.transaction('notebooks', 'readonly');
        const request = tx.objectStore('notebooks').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = (e) => reject(e);
    });
}

function deleteNotebookFromDB(id) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve();
        const tx = db.transaction('notebooks', 'readwrite');
        const request = tx.objectStore('notebooks').delete(id);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e);
    });
}