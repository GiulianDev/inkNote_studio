// ============================================================
// GESTIONE PAGINE
// ============================================================

// DPR massimo per canvas (limita la memoria: ~57MB per pagina a dpr=4).
const MAX_RENDER_DPR = 4;

// Moltiplicatore extra di DPR applicato alle pagine visibili durante lo zoom.
// Con deviceDpr=2 (Retina) e zoom=2x → dpr=4 → 1:1 pixel fisici.
const MAX_ZOOM_DPR_BOOST = 2;

let _resolutionRefreshTimer = null;

function createNewPageDOM(pageIndex, initialStrokes = []) {
    const container = document.getElementById('canvasContainer');
    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'page-wrapper';
    pageWrapper.dataset.index = pageIndex;

    // Canvas 1: inchiostro consolidato (cambia solo su commit/undo/tema)
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';

    // Canvas 2: overlay per stato transitorio (FASE A: non ancora usato)
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'overlay-canvas';

    pageWrapper.appendChild(canvas);
    pageWrapper.appendChild(overlayCanvas);
    container.appendChild(pageWrapper);

    const ctx = canvas.getContext('2d');
    const overlayCtx = overlayCanvas.getContext('2d');
    const pageData = {
        index: pageIndex,
        wrapper: pageWrapper,
        canvas: canvas,
        ctx: ctx,
        overlayCanvas: overlayCanvas,
        overlayCtx: overlayCtx,
        strokes: initialStrokes
    };

    resizeCanvasForHDPI(pageData);
    appState.pages.push(pageData);
    attachPointerListeners(pageData);
    redrawPageCanvas(pageData);
    return pageData;
}

function addNewPage() {
    const newIndex = appState.pages.length;
    const newPage = createNewPageDOM(newIndex, []);
    appState.activePageIndex = newIndex;
    updatePageCounterUI();
    autoSaveTrigger();
    pushHistory();
    newPage.wrapper.scrollIntoView({ behavior: 'smooth' });
    scheduleResolutionRefresh();
}

function centerViewport() {
    const viewport = document.getElementById('viewport');
    transformState.x = (viewport.clientWidth - 794) / 2;
    transformState.y = 20;
    applyTransform();
}

function applyTransform() {
    const container = document.getElementById('canvasContainer');
    container.style.transform = `translate(${transformState.x}px, ${transformState.y}px) scale(${transformState.scale})`;
    document.getElementById('zoomText').innerText = `${Math.round(transformState.scale * 100)}%`;
    updateSelectionMenuPosition();
    scheduleResolutionRefresh();
}

function resetZoom() {
    transformState.scale = 1.0;
    centerViewport();
    showToast('Zoom resettato', '🔍');
}

// Calcola il DPR di rendering per una pagina in base a zoom + visibilità.
function getCurrentRenderDpr(pageData) {
    const deviceDpr = window.devicePixelRatio || 1;
    const zoom = Math.max(1, transformState.scale);
    const extra = Math.min(zoom, MAX_ZOOM_DPR_BOOST);
    const highDpr = Math.min(deviceDpr * extra, MAX_RENDER_DPR);
    const lowDpr = deviceDpr;

    // Pagine fuori viewport: risoluzione base (risparmio memoria)
    if (pageData && !isPageVisible(pageData)) return lowDpr;
    return highDpr;
}

function isPageVisible(pageData) {
    const viewport = document.getElementById('viewport');
    if (!viewport) return true;
    const vpRect = viewport.getBoundingClientRect();
    const pRect = pageData.wrapper.getBoundingClientRect();
    return !(pRect.right < vpRect.left || pRect.left > vpRect.right ||
             pRect.bottom < vpRect.top || pRect.top > vpRect.bottom);
}

// Ridimensiona ENTRAMBI i canvas (page + overlay) allo stesso DPR.
// Ritorna true se almeno uno è stato effettivamente ridimensionato.
function resizeCanvasForHDPI(pageData, dprOverride) {
    const dpr = dprOverride || getCurrentRenderDpr(pageData);
    const newW = Math.floor(PAGE_WIDTH * dpr);
    const newH = Math.floor(PAGE_HEIGHT * dpr);

    let changed = false;

    if (pageData.canvas.width !== newW || pageData.canvas.height !== newH) {
        pageData.canvas.width = newW;
        pageData.canvas.height = newH;
        changed = true;
    }

    if (pageData.overlayCanvas &&
        (pageData.overlayCanvas.width !== newW || pageData.overlayCanvas.height !== newH)) {
        pageData.overlayCanvas.width = newW;
        pageData.overlayCanvas.height = newH;
        changed = true;
    }

    pageData.dpr = dpr;
    return changed;
}

// Ridisegna le pagine solo se dpr o visibilità sono cambiati.
// `force=true` per ridisegnare tutto (es. cambio monitor / resize finestra).
function refreshCanvasResolution(force = false) {
    appState.pages.forEach(p => {
        const visible = isPageVisible(p);
        const targetDpr = getCurrentRenderDpr(p);
        const dprChanged = Math.abs((p.dpr || 1) - targetDpr) > 0.01;
        const visibilityChanged = p._wasVisible !== visible;

        if (force || dprChanged || visibilityChanged) {
            resizeCanvasForHDPI(p, targetDpr);
            redrawPageCanvas(p);
            p._wasVisible = visible;
        }
    });
}

// Debounce: durante zoom/pan continui resetta il timer; solo dopo 200ms
// di quiete applica il cambio di risoluzione. Stessa strategia di iPad Notes:
// zoom fluido a bassa risoluzione, poi un breve "pop" di nitidezza.
function scheduleResolutionRefresh() {
    if (_resolutionRefreshTimer) clearTimeout(_resolutionRefreshTimer);
    _resolutionRefreshTimer = setTimeout(() => {
        _resolutionRefreshTimer = null;
        refreshCanvasResolution(false);
    }, 200);
}

function updatePageCounterUI() {
    document.getElementById('pageCounterText').innerText = `Pagina ${appState.activePageIndex + 1} di ${appState.pages.length}`;
}

function changeBackgroundPattern(pattern) {
    appState.bgPattern = pattern;
    autoSaveTrigger();
    appState.pages.forEach(p => redrawPageCanvas(p));
    pushHistory();
}

function clearCurrentPage() {
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage && currentPage.strokes.length > 0) {
        currentPage.strokes = [];
        clearSelection();
        redrawPageCanvas(currentPage);
        autoSaveTrigger();
        pushHistory();
        showToast('Pagina pulita', '🧹');
    }
}