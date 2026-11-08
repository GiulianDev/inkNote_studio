// ============================================================
// STORICO UNDO / REDO
// Snapshot per-pagina, debounced: 1 push ogni ~200ms di attività.
// ============================================================

const historyState = {
    stack: [],
    index: -1,
    maxSteps: 50,
    isRestoring: false
};

let _pushHistoryTimer = null;

function deepClone(obj) {
    if (typeof structuredClone === 'function') {
        try { return structuredClone(obj); } catch (e) { /* fallback */ }
    }
    return JSON.parse(JSON.stringify(obj));
}

// Snapshot SOLO della pagina attiva. Le pagine inattive non cambiano
// durante il disegno: clonarle era O(tutte le pagine) per ogni pointerup.
function captureSnapshot() {
    const page = appState.pages[appState.activePageIndex];
    if (!page) return null;
    const strokesClone = deepClone(page.strokes);
    // Rimuovi campi derivati dal rendering che non devono influenzare
    // il confronto fra snapshot (evita push inutili dopo toggle tema).
    strokesClone.forEach(s => {
        delete s._styleCache;
        delete s._pathLen;
    });
    return {
        pageIndex: appState.activePageIndex,
        strokes: strokesClone,
        bgPattern: appState.bgPattern,
        notebookTitle: currentNotebook ? currentNotebook.title : ''
    };
}

function areSnapshotsEqual(a, b) {
    if (!a || !b) return false;
    if (a.pageIndex !== b.pageIndex) return false;
    if (a.bgPattern !== b.bgPattern) return false;
    if (a.notebookTitle !== b.notebookTitle) return false;
    if (a.strokes.length !== b.strokes.length) return false;
    return JSON.stringify(a.strokes) === JSON.stringify(b.strokes);
}

// Debounce: ogni chiamata resetta il timer. Lo snapshot viene
// effettivamente push-ato dopo 200ms di quiete.
function pushHistory() {
    if (historyState.isRestoring) return;
    if (_pushHistoryTimer) clearTimeout(_pushHistoryTimer);
    _pushHistoryTimer = setTimeout(() => {
        _pushHistoryTimer = null;
        _doPushHistory();
    }, 500);   // ← era 200, ora 500
}

function _doPushHistory() {
    if (historyState.isRestoring) return;

    if (historyState.index < historyState.stack.length - 1) {
        historyState.stack = historyState.stack.slice(0, historyState.index + 1);
    }

    const newSnap = captureSnapshot();
    if (!newSnap) return;

    const lastSnap = historyState.stack[historyState.index];
    if (lastSnap && areSnapshotsEqual(lastSnap, newSnap)) {
        return;
    }

    historyState.stack.push(newSnap);
    if (historyState.stack.length > historyState.maxSteps) {
        historyState.stack.shift();
    }
    historyState.index = historyState.stack.length - 1;
    updateUndoRedoUI();
}

// Forza l'esecuzione del push pendente. Usato da undo/redo e beforeunload.
function flushHistory() {
    if (_pushHistoryTimer) {
        clearTimeout(_pushHistoryTimer);
        _pushHistoryTimer = null;
        _doPushHistory();
    }
}

function resetHistory() {
    if (_pushHistoryTimer) {
        clearTimeout(_pushHistoryTimer);
        _pushHistoryTimer = null;
    }
    historyState.stack = [];
    historyState.index = -1;
    if (!currentNotebook) {
        updateUndoRedoUI();
        return;
    }
    const snap = captureSnapshot();
    if (!snap) {
        updateUndoRedoUI();
        return;
    }
    historyState.stack.push(snap);
    historyState.index = 0;
    updateUndoRedoUI();
}

function undo() {
    flushHistory();
    if (historyState.index <= 0) return;
    historyState.index--;
    applySnapshot(historyState.stack[historyState.index]);
}

function redo() {
    flushHistory();
    if (historyState.index >= historyState.stack.length - 1) return;
    historyState.index++;
    applySnapshot(historyState.stack[historyState.index]);
}

// Applica snapshot solo alla pagina attiva. Undo cross-page non è
// supportato: se l'utente ha cambiato pagina, resetta lo stack.
function applySnapshot(snap) {
    if (!snap) return;
    if (snap.pageIndex !== appState.activePageIndex) {
        resetHistory();
        return;
    }
    historyState.isRestoring = true;

    appState.pendingShape = null;
    appState.selectedStrokes = [];
    appState.lassoPath = [];
    appState.isDrawing = false;
    appState.currentStroke = null;
    appState.currentPointerId = null;
    appState.currentPageForPointer = null;
    appState.isDraggingSelection = false;
    appState.dragStartPoint = null;
    appState.selectionMoved = false;
    hideSelectionMenu();

    if (snap.bgPattern) {
        appState.bgPattern = snap.bgPattern;
        const sel = document.getElementById('bgPatternSelect');
        if (sel) sel.value = snap.bgPattern;
    }

    if (currentNotebook && snap.notebookTitle !== undefined) {
        currentNotebook.title = snap.notebookTitle;
        document.getElementById('docTitle').value = snap.notebookTitle;
    }

    // Ricostruisce SOLO la pagina attiva
    const pageIndex = appState.activePageIndex;
    const container = document.getElementById('canvasContainer');
    const oldWrapper = container.querySelector(`.page-wrapper[data-index="${pageIndex}"]`);
    if (oldWrapper) oldWrapper.remove();
    appState.pages.splice(pageIndex, 1);

    // snap.strokes è già una copia isolata (deepClone in captureSnapshot),
    // non serve un secondo clone qui.
    createNewPageDOM(snap.pageIndex, snap.strokes);
    
    // createNewPageDOM fa push in fondo: riordino array e DOM per index
    appState.pages.sort((a, b) => a.index - b.index);
    const wrappers = Array.from(container.querySelectorAll('.page-wrapper'));
    wrappers.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
    wrappers.forEach(w => container.appendChild(w));

    updatePageCounterUI();

    // FASE C: la pagina è stata ricostruita, l'overlay della nuova pagina
    // è vuoto (appena creato da createNewPageDOM). Ma se c'era una
    // selezione attiva prima dell'undo, va ripulita anche visivamente.
    const newPage = appState.pages[appState.activePageIndex];
    if (newPage) {
        redrawSelectionOverlay(newPage);
    }

    historyState.isRestoring = false;
    updateUndoRedoUI();
    autoSaveTrigger();
}

function updateUndoRedoUI() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) undoBtn.disabled = historyState.index <= 0;
    if (redoBtn) redoBtn.disabled = historyState.index >= historyState.stack.length - 1;
}

function handleHistoryKeyboard(e) {
    const target = e.target;
    if (target && target.matches &&
        target.matches('input, textarea, select, [contenteditable="true"]')) return;

    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return;

    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
    }
}

window.addEventListener('load', () => {
    document.addEventListener('keydown', handleHistoryKeyboard);
    updateUndoRedoUI();
});