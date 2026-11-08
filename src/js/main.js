// ============================================================
// BOOT E FUNZIONI FINALI
// ============================================================

window.addEventListener('load', async () => {
    initSettings();
        // Bind iniziale della canvas di test e degli slider di pressione
    _bindPressureSliders();

    try {
        await initDB();
        renderLibraryView();
    } catch (err) { console.error(err); }

    centerViewport();
    setupViewportGestures();
    setupKeyboardShortcuts();
    updateAutoShapeButtonUI();
    renderRecentColors();

    window.addEventListener('resize', () => {
        refreshCanvasResolution(true);
    });

    if (window.matchMedia) {
        try {
            const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            if (mq.addEventListener) {
                mq.addEventListener('change', () => refreshCanvasResolution(true));
            }
        } catch (e) { /* fallback silenzioso */ }
    }
});

// FIX: flush dei debounce prima della chiusura.
// Senza questo, gli ultimi 200-500ms di attività andrebbero persi
// se l'utente chiude il tab subito dopo aver disegnato.
window.addEventListener('beforeunload', (e) => {
    // Se c'è un autosave pendente, flusha e avvisa.
    const hasPendingSave = _autoSaveTimer !== null;
    flushHistory();
    flushAutoSave();
    if (hasPendingSave && currentNotebook) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
});

function toggleFullscreen() {
    if (!document.fullscreenElement) { document.documentElement.requestFullscreen().catch(() => {}); }
    else { document.exitFullscreen(); }
}

function exportToPDF() {
    if (appState.pendingShape) finalizePendingShape();

    const settings = loadSettings();
    const printDark = settings.printTheme === 'dark';
    const PRINT_DPR = Math.min((window.devicePixelRatio || 1) * 2, 4);

    appState.pages.forEach(p => {
        // FIX difensivo: invalida la cache stile su ogni stroke. Elimina
        // qualsiasi possibilità di usare stili stale (dark) durante il
        // render di stampa (light).
        p.strokes.forEach(s => { s._styleCache = null; });
        // FIX difensivo: pulisci overlay PRIMA del resize. Se il resize
        // non cambia le dimensioni (caso raro), l'overlay manterrebbe il
        // contenuto precedente e coprirebbe il page canvas durante il print.
        clearOverlay(p);
        resizeCanvasForHDPI(p, PRINT_DPR);
        redrawPageCanvas(p, printDark);
    });
    document.body.classList.toggle('print-dark', printDark);
    document.body.classList.toggle('print-light', !printDark);

    const restore = () => {
        refreshCanvasResolution(true);
        document.body.classList.remove('print-dark', 'print-light');
        window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);

    setTimeout(() => window.print(), 150);
}