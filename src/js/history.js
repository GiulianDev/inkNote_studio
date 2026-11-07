// ============================================================
// STORICO UNDO / REDO
// Snapshot completi dello stato del quaderno (pagine + pattern + titolo)
// ============================================================

const historyState = {
    stack: [],
    index: -1,
    maxSteps: 50,
    isRestoring: false
};

function deepClone(obj) {
    if (typeof structuredClone === 'function') {
        try { return structuredClone(obj); } catch (e) { /* fallback */ }
    }
    return JSON.parse(JSON.stringify(obj));
}

function captureSnapshot() {
    return {
        pages: appState.pages.map(p => ({
            index: p.index,
            strokes: deepClone(p.strokes)
        })),
        activePageIndex: appState.activePageIndex,
        bgPattern: appState.bgPattern,
        notebookTitle: currentNotebook ? currentNotebook.title : ''
    };
}

function areSnapshotsEqual(a, b) {
    if (!a || !b) return false;
    if (a.bgPattern !== b.bgPattern) return false;
    if (a.notebookTitle !== b.notebookTitle) return false;
    if (a.pages.length !== b.pages.length) return false;
    for (let i = 0; i < a.pages.length; i++) {
        if (a.pages[i].strokes.length !== b.pages[i].strokes.length) return false;
        if (JSON.stringify(a.pages[i].strokes) !== JSON.stringify(b.pages[i].strokes)) return false;
    }
    return true;
}

function pushHistory() {
    if (historyState.isRestoring) return;

    // Rimuove i redo oltre l'indice corrente
    if (historyState.index < historyState.stack.length - 1) {
        historyState.stack = historyState.stack.slice(0, historyState.index + 1);
    }

    const newSnap = captureSnapshot();
    const lastSnap = historyState.stack[historyState.index];
    if (lastSnap && areSnapshotsEqual(lastSnap, newSnap)) {
        return; // nessuna modifica reale: skip
    }

    historyState.stack.push(newSnap);
    if (historyState.stack.length > historyState.maxSteps) {
        historyState.stack.shift();
    }
    historyState.index = historyState.stack.length - 1;
    updateUndoRedoUI();
}

function resetHistory() {
    historyState.stack = [];
    historyState.index = -1;
    if (!currentNotebook) {
        updateUndoRedoUI();
        return;
    }
    const snap = captureSnapshot();
    historyState.stack.push(snap);
    historyState.index = 0;
    updateUndoRedoUI();
}

function undo() {
    if (historyState.index <= 0) return;
    historyState.index--;
    applySnapshot(historyState.stack[historyState.index]);
}

function redo() {
    if (historyState.index >= historyState.stack.length - 1) return;
    historyState.index++;
    applySnapshot(historyState.stack[historyState.index]);
}

function applySnapshot(snap) {
    if (!snap) return;
    historyState.isRestoring = true;

    // Reset stato temporaneo
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

    // Pattern
    if (snap.bgPattern) {
        appState.bgPattern = snap.bgPattern;
        const sel = document.getElementById('bgPatternSelect');
        if (sel) sel.value = snap.bgPattern;
    }

    // Titolo
    if (currentNotebook && snap.notebookTitle !== undefined) {
        currentNotebook.title = snap.notebookTitle;
        document.getElementById('docTitle').value = snap.notebookTitle;
    }

    // Ricostruisce il canvas container
    document.getElementById('canvasContainer').innerHTML = '';
    appState.pages = [];
    snap.pages.forEach(p => {
        createNewPageDOM(p.index, deepClone(p.strokes));
    });

    appState.activePageIndex = Math.min(
        Math.max(0, snap.activePageIndex),
        Math.max(0, appState.pages.length - 1)
    );
    updatePageCounterUI();

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