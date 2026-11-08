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
    updateAutoShapeButtonUI();

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
window.addEventListener('beforeunload', () => {
    flushHistory();
    flushAutoSave();
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