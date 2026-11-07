// ============================================================
// LIBRERIA QUADERNI E LOGIN
// ============================================================

let _autoSaveTimer = null;

function handleGoogleLogin() {
    if (!currentUser) {
        setTimeout(() => {
            currentUser = { displayName: "Utente Demo", email: "demo@inknote.app" };
            updateLoginUI();
            showToast("Accesso effettuato con successo!", "👤");
        }, 400);
    } else {
        currentUser = null;
        updateLoginUI();
        showToast("Disconnesso", "👋");
    }
}

function updateLoginUI() {
    const btnText = document.getElementById('googleLoginText');
    if (currentUser) {
        btnText.innerText = currentUser.displayName;
        showStatusBadge('Online (Cloud Sync)');
    } else {
        btnText.innerText = 'Accedi con Google';
        showStatusBadge('Locale');
    }
}

async function renderLibraryView() {
    const notebooks = await loadAllNotebooksFromDB();
    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    grid.innerHTML = '';

    if (notebooks.length === 0) {
        emptyMsg.classList.remove('hidden');
        emptyMsg.classList.add('flex');
    } else {
        emptyMsg.classList.add('hidden');
        emptyMsg.classList.remove('flex');
        notebooks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        notebooks.forEach(nb => {
            const dateStr = new Date(nb.updatedAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
            const card = document.createElement('div');
            card.className = 'notebook-card cursor-pointer flex flex-col group';
            card.innerHTML = `
                <div onclick="openNotebook('${nb.id}')" class="w-full h-52 rounded-r-xl rounded-l-sm shadow-md relative overflow-hidden flex flex-col justify-between p-4" style="background-color: ${nb.coverColor || '#4f46e5'}; border-left: 12px solid rgba(0,0,0,0.25);">
                    <div class="notebook-spine absolute left-0 top-0 bottom-0 w-3"></div>
                    <div class="bg-black/20 backdrop-blur-md rounded-lg p-2.5 text-white border border-white/10">
                        <h4 class="font-bold text-sm truncate">${escapeHtml(nb.title)}</h4>
                        <span class="text-[10px] opacity-80">${nb.pages ? nb.pages.length : 1} pag.</span>
                    </div>
                    <div class="flex items-center justify-between text-white/90 text-[10px] font-medium">
                        <span>${dateStr}</span>
                        <span>📖 InkNote</span>
                    </div>
                </div>
                <div class="flex items-center justify-between mt-2 px-1 text-xs">
                    <span class="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[120px]">${escapeHtml(nb.title)}</span>
                    <button onclick="deleteNotebook(event, '${nb.id}')" class="text-slate-400 hover:text-rose-600 p-1 transition" title="Elimina Quaderno">🗑️</button>
                </div>
            `;
            grid.appendChild(card);
        });
    }
    document.getElementById('libraryView').classList.remove('hidden');
}

function openNewNotebookModal() {
    const modal = document.getElementById('newNotebookModal');
    if (!modal) return;
    // FIX: stesso pattern della modale impostazioni.
    modal.classList.remove('hidden');
    modal.scrollTop = 0;
}

function closeNewNotebookModal() {
    const modal = document.getElementById('newNotebookModal');
    if (!modal) return;
    modal.classList.add('hidden');
}

function selectCoverColor(btn) {
    document.querySelectorAll('#coverColorOptions button').forEach(b => b.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110'));
    btn.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110');
    selectedCoverColor = btn.dataset.color;
}

async function confirmCreateNotebook() {
    const title = document.getElementById('modalNbTitle').value.trim() || 'Nuovo Quaderno';
    const pattern = document.getElementById('modalNbPattern').value;

    const newNb = {
        id: 'nb_' + Date.now(),
        title: title,
        coverColor: selectedCoverColor,
        pattern: pattern,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pages: [{ pageIndex: 0, strokes: [] }]
    };

    await saveNotebookToDB(newNb);
    closeNewNotebookModal();
    openNotebook(newNb.id);
}

async function openNotebook(id) {
    const notebooks = await loadAllNotebooksFromDB();
    currentNotebook = notebooks.find(n => n.id === id);
    if (!currentNotebook) return;

    document.getElementById('docTitle').value = currentNotebook.title;
    appState.bgPattern = currentNotebook.pattern || 'ruled';
    document.getElementById('bgPatternSelect').value = appState.bgPattern;

    document.getElementById('canvasContainer').innerHTML = '';
    appState.pages = [];
    appState.pendingShape = null;
    appState.selectedStrokes = [];

    if (currentNotebook.pages && currentNotebook.pages.length > 0) {
        currentNotebook.pages.forEach((pageData, idx) => {
            createNewPageDOM(idx, pageData.strokes || []);
        });
    } else {
        createNewPageDOM(0, []);
    }

    appState.activePageIndex = 0;
    updatePageCounterUI();
    document.getElementById('libraryView').classList.add('hidden');

    resetHistory();
    showToast(`Quaderno "${currentNotebook.title}" aperto`, '📖');
}

async function deleteNotebook(e, id) {
    e.stopPropagation();
    if (confirm("Sei sicuro di voler eliminare questo quaderno e tutte le sue pagine?")) {
        await deleteNotebookFromDB(id);
        renderLibraryView();
        showToast("Quaderno eliminato", "🗑️");
    }
}

function returnToLibrary() {
    if (appState.pendingShape) finalizePendingShape();
    flushAutoSave();
    if (currentNotebook) {
        syncCurrentStateToNotebook();
        saveNotebookToDB(currentNotebook);
    }
    resetHistory();
    renderLibraryView();
}

function updateCurrentNotebookTitle(newTitle) {
    if (currentNotebook) {
        currentNotebook.title = newTitle;
        autoSaveTrigger();
        pushHistory();
    }
}

function syncCurrentStateToNotebook() {
    if (!currentNotebook) return;
    currentNotebook.pattern = appState.bgPattern;
    currentNotebook.pages = appState.pages.map(p => ({ pageIndex: p.index, strokes: p.strokes }));
}

// Debounce: accoda un salvataggio che avviene dopo 500ms di quiete.
// Disegno veloce = 1 scrittura IndexedDB invece di N.
function autoSaveTrigger() {
    if (!currentNotebook) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
        _autoSaveTimer = null;
        if (!currentNotebook) return;
        syncCurrentStateToNotebook();
        saveNotebookToDB(currentNotebook);
    }, 500);
}

function flushAutoSave() {
    if (_autoSaveTimer) {
        clearTimeout(_autoSaveTimer);
        _autoSaveTimer = null;
        if (!currentNotebook) return;
        syncCurrentStateToNotebook();
        saveNotebookToDB(currentNotebook);
    }
}