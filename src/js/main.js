// ============================================================
// BOOT E FUNZIONI FINALI
// ============================================================

window.addEventListener('load', async () => {
    initSettings();   // applica tema + handedness prima di tutto

    try {
        await initDB();
        renderLibraryView();
    } catch (err) { console.error(err); }

    centerViewport();
    setupViewportGestures();
    updateAutoShapeButtonUI();

    window.addEventListener('resize', () => {
        // Cambio dimensioni finestra (o DPR del monitor): ridisegna tutto
        refreshCanvasResolution(true);
    });

    // Alcuni browser non emettono `resize` al cambio di monitor/DPR:
    // ascolta il matchMedia della risoluzione corrente.
    if (window.matchMedia) {
        try {
            const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            if (mq.addEventListener) {
                mq.addEventListener('change', () => refreshCanvasResolution(true));
            }
        } catch (e) { /* fallback silenzioso */ }
    }
});

function toggleFullscreen() {
    if (!document.fullscreenElement) { document.documentElement.requestFullscreen().catch(() => {}); }
    else { document.exitFullscreen(); }
}

function exportToPDF() {
    const settings = loadSettings();
    const printDark = settings.printTheme === 'dark';

    // Per la stampa: forza un DPR alto su tutte le pagine,
    // indipendentemente dallo zoom corrente e dalla visibilità.
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