// ============================================================
// INPUT CANVAS (POINTER EVENTS + GOMMA + PRESSIONE + SMOOTHING)
// ============================================================

const _DEBUG_INK = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('debug');
let _debugEl = null;

const MAX_BATCH_POINTS = 8;

// pointerrawupdate: emesso da Chrome/Edge/WebView2 prima dell'allineamento
// al vsync. Guadagna 5-10ms di latenza percepita.
const _useRawPointerUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

const _flushState = {
    points: [],
    rafId: null,
    pageData: null
};

function _updateDebugOverlay(pt) {
    if (!_DEBUG_INK) return;
    if (!_debugEl) {
        _debugEl = document.createElement('div');
        _debugEl.style.cssText = `
            position:fixed; bottom:80px; right:16px; z-index:9999;
            background:rgba(0,0,0,0.85); color:#0f0; padding:8px 12px;
            font-family:monospace; font-size:12px; border-radius:8px;
            pointer-events:none; line-height:1.4;
        `;
        document.body.appendChild(_debugEl);
    }
    const tiltMag = Math.hypot(pt.tiltX || 0, pt.tiltY || 0);
    _debugEl.innerHTML =
        `${_useRawPointerUpdate ? 'raw' : 'move'} · type: ${pt.pointerType || '-'}<br>` +
        `tiltMag: ${tiltMag.toFixed(1)}°  speed: ${(pt.speed || 0).toFixed(1)}px<br>` +
        `pressure: ${(pt.pressure || 0).toFixed(3)}<br>` +
        `batch: ${_flushState.points.length} pending`;
}

function getCanvasCoords(e, canvas) {
    const rect = canvas.getBoundingClientRect();

    let pressure = 0.5;
    if (e.pointerType === 'pen') {
        pressure = (e.pressure && e.pressure > 0) ? e.pressure : 0.5;
    }

    return {
        x: (e.clientX - rect.left) * (PAGE_WIDTH / rect.width),
        y: (e.clientY - rect.top) * (PAGE_HEIGHT / rect.height),
        pressure: pressure,
        tiltX: e.tiltX || 0,
        tiltY: e.tiltY || 0,
        pointerType: e.pointerType
    };
}

function smoothPressure(points, newPressure) {
    if (points.length === 0) return newPressure;
    const recent = points.slice(-3);
    const wNew = 0.6;
    const wOld = 0.4 / Math.max(1, recent.length);
    let acc = newPressure * wNew;
    for (const p of recent) acc += (p.pressure || 0.5) * wOld;
    return Math.max(0.05, Math.min(1, acc));
}

function smoothRawPoint(rawPoint, prevSmoothed) {
    const smoothness = Math.max(0, Math.min(1, appState.smoothing));

    if (!prevSmoothed || smoothness <= 0.01) {
        return rawPoint;
    }

    const dx = rawPoint.x - prevSmoothed.x;
    const dy = rawPoint.y - prevSmoothed.y;
    const speed = Math.hypot(dx, dy);

    const minAlpha = 0.85 - smoothness * 0.55;
    const alpha = Math.min(1.0, minAlpha + speed * 0.05);

    rawPoint.x = prevSmoothed.x + dx * alpha;
    rawPoint.y = prevSmoothed.y + dy * alpha;
    return rawPoint;
}

function attachPointerListeners(pageData) {
    const canvas = pageData.canvas;
    canvas.addEventListener('pointerdown', (e) => handlePointerDown(e, pageData));

    // Usa pointerrawupdate dove disponibile (Chrome/Edge/WebView2).
    // Fallback a pointermove per altri browser.
    if (_useRawPointerUpdate) {
        canvas.addEventListener('pointerrawupdate', (e) => handlePointerMove(e, pageData), { passive: false });
    } else {
        canvas.addEventListener('pointermove', (e) => handlePointerMove(e, pageData), { passive: false });
    }

    canvas.addEventListener('pointerup', (e) => handlePointerUp(e, pageData));
    canvas.addEventListener('pointercancel', (e) => handlePointerUp(e, pageData));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ============================================================
// BATCHING rAF
// ============================================================

function _processPointerPoint(rawPoint, pageData) {
    if (appState.pendingShape) return;
    if (!appState.currentStroke || !appState.isDrawing) return;

    const prevSmoothed = appState.currentStroke.points[appState.currentStroke.points.length - 1];
    const smoothedPos = smoothRawPoint(rawPoint, prevSmoothed);

    let smoothedPressure = rawPoint.pressure;
    if (rawPoint.pointerType === 'pen' && appState.currentStroke.points.length > 0) {
        smoothedPressure = smoothPressure(appState.currentStroke.points, rawPoint.pressure);
    }

    // Con smoothness = 0, non filtrare: ogni punto della penna deve essere
    // disegnato. Con smoothness > 0, filtra i micro-movimenti.
    const minDist = appState.smoothing <= 0.01 ? 0.01 : 0.4;
    if (prevSmoothed && Math.hypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y) < minDist) {
        return;
    }

    const speedPx = prevSmoothed
        ? Math.hypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y)
        : 0;

    const smoothedPoint = {
        x: smoothedPos.x,
        y: smoothedPos.y,
        pressure: smoothedPressure,
        tiltX: rawPoint.tiltX,
        tiltY: rawPoint.tiltY,
        speed: speedPx,
        pointerType: rawPoint.pointerType
    };

    appState.currentStroke.points.push(smoothedPoint);

    if (appState.currentStroke._pathLen === undefined) {
        appState.currentStroke._pathLen = 0;
    }
    if (appState.currentStroke.points.length >= 2) {
        const prev = appState.currentStroke.points[appState.currentStroke.points.length - 2];
        appState.currentStroke._pathLen += Math.hypot(smoothedPoint.x - prev.x, smoothedPoint.y - prev.y);
    }

    if (appState.scribbleMode) {
        // Scribble path va sull'overlay, non sul page canvas
        drawScribbleSegment(pageData.overlayCtx, appState.currentStroke, pageData.dpr);
    } else if (appState.activeTool === 'highlighter') {
        // Highlighter: multiply/screen non funziona su overlay trasparente.
        // Continua su page canvas diretto.
        drawIncrementalSegment(pageData.ctx, appState.currentStroke, pageData.dpr);
    } else {
        // Pen, pencil, marker: scrittura su overlay
        drawIncrementalSegment(pageData.overlayCtx, appState.currentStroke, pageData.dpr);
    }

    _updateDebugOverlay(smoothedPoint);
}

function _runPostBatchChecks(pageData) {
    if (!appState.currentStroke || !appState.isDrawing) return;
    if (appState.pendingShape) return;

    const pts = appState.currentStroke.points;
    if (pts.length === 0) return;

    checkForScribble(pageData);

    if (!appState.currentStroke || !appState.isDrawing) return;
    if (appState.pendingShape) return;

    if (!appState.scribbleMode &&
        appState.autoShapeEnabled &&
        SHAPE_CAPABLE_TOOLS.includes(appState.activeTool) &&
        pts.length >= 6) {
        const lastPt = pts[pts.length - 1];
        trySnapToLineDuringDraw(pageData, lastPt);
    }
}

function _scheduleFlush(pageData) {
    _flushState.pageData = pageData;

    if (_flushState.points.length >= MAX_BATCH_POINTS) {
        if (_flushState.rafId !== null) {
            cancelAnimationFrame(_flushState.rafId);
            _flushState.rafId = null;
        }
        _doFlush();
        return;
    }

    if (_flushState.rafId !== null) return;
    _flushState.rafId = requestAnimationFrame(_doFlush);
}

function _doFlush() {
    _flushState.rafId = null;
    const pageData = _flushState.pageData;
    const batch = _flushState.points;
    _flushState.points = [];
    _flushState.pageData = null;

    if (!pageData || batch.length === 0) return;
    if (!appState.currentStroke || !appState.isDrawing) return;
    if (appState.pendingShape) return;

    for (const rawPoint of batch) {
        if (appState.pendingShape) break;
        if (!appState.currentStroke || !appState.isDrawing) break;
        _processPointerPoint(rawPoint, pageData);
    }

    _runPostBatchChecks(pageData);
}

function _cancelFlush() {
    if (_flushState.rafId !== null) {
        cancelAnimationFrame(_flushState.rafId);
        _flushState.rafId = null;
    }
    _flushState.points = [];
    _flushState.pageData = null;
}

function _forceFlushNow(pageData) {
    if (_flushState.rafId !== null) {
        cancelAnimationFrame(_flushState.rafId);
        _flushState.rafId = null;
    }
    const batch = _flushState.points;
    _flushState.points = [];
    _flushState.pageData = null;

    if (!pageData || batch.length === 0) return;
    if (!appState.currentStroke || !appState.isDrawing) return;
    if (appState.pendingShape) return;

    for (const rawPoint of batch) {
        if (appState.pendingShape) break;
        if (!appState.currentStroke || !appState.isDrawing) break;
        _processPointerPoint(rawPoint, pageData);
    }

    if (!appState.currentStroke || !appState.isDrawing) return;
    checkForScribble(pageData);
}

// ============================================================
// POINTER HANDLERS
// ============================================================

function handlePointerDown(e, pageData) {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck && e.pointerType !== 'pen') return;
    if (isPanning || isPinching) return;
    if (activePointers.size > 1) return;

    if (appState.pendingShape) finalizePendingShape();

    appState.scribbleMode = false;
    appState.scribbleTargets = [];
    _cancelFlush();

    // Rete di sicurezza: se un'operazione precedente ha lasciato residui
    // sull'overlay (abort anomalo, cambio tab durante pendingShape, ecc.),
    // li puliamo prima di iniziare il nuovo stroke.
    clearOverlay(pageData);

    try { pageData.canvas.setPointerCapture(e.pointerId); } catch (err) {}

    appState.activePageIndex = pageData.index;
    appState.currentPointerId = e.pointerId;
    appState.currentPageForPointer = pageData;
    updatePageCounterUI();

    const point = getCanvasCoords(e, pageData.canvas);

    if (point.pointerType === 'pen') {
        point.pressure = Math.max(point.pressure, 0.2);
    }

    if (appState.activeTool === 'lasso') {
        const visualBBox = getVisualBoundingBox();
        if (visualBBox) {
            const handle = hitTestHandle(point, visualBBox);
            if (handle) {
                startResizeSelection(handle, point);
                return;
            }
            if (isPointInBBox(point, visualBBox)) {
                appState.isDraggingSelection = true;
                appState.dragStartPoint = point;
                appState.isDrawing = true;
                appState.selectionMoved = false;
                pageData.canvas.style.cursor = 'grabbing';
                return;
            }
        }
        clearSelection();
        appState.isDrawing = true;
        appState.lassoPath = [point];
        // FASE C: il lasso va sull'overlay, il page canvas non cambia
        clearOverlay(pageData);
        return;
    }

    clearSelection();
    appState.isDrawing = true;

    if (appState.activeTool === 'eraser') {
        performEraserAt(pageData, point);
        return;
    }

    appState.currentStroke = {
        tool: appState.activeTool,
        color: appState.currentColor,
        size: appState.strokeWidth,
        startTime: performance.now(),
        points: [{
            x: point.x,
            y: point.y,
            pressure: point.pressure,
            tiltX: point.tiltX,
            tiltY: point.tiltY,
            speed: 0,
            pointerType: point.pointerType
        }]
    };
}

function handlePointerMove(e, pageData) {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck && e.pointerType !== 'pen') return;
    if (isPanning || isPinching) return;

    if (!appState.isDrawing && appState.activeTool === 'lasso' && e.pointerType !== 'touch') {
        updateCursorForSelection(e, pageData);
    }

    if (!appState.isDrawing) return;
    if (e.pointerId !== appState.currentPointerId) return;

    if (appState.pendingShape) {
        const rawPoint = getCanvasCoords(e, pageData.canvas);
        const ps = appState.pendingShape;
        if (ps.activeHandle === 'end') {
            ps.end = { x: rawPoint.x, y: rawPoint.y, pressure: 0.5 };
        } else {
            ps.start = { x: rawPoint.x, y: rawPoint.y, pressure: 0.5 };
        }
        clearOverlay(pageData);
        renderPendingShapeOnOverlay(pageData);
        return;
    }

    if (appState.isResizingSelection) {
        applyResizeSelection(getCanvasCoords(e, pageData.canvas));
        return;
    }

    if (appState.isDraggingSelection && appState.dragStartPoint) {
        const rawPoint = getCanvasCoords(e, pageData.canvas);
        const dx = rawPoint.x - appState.dragStartPoint.x;
        const dy = rawPoint.y - appState.dragStartPoint.y;
        if (dx !== 0 || dy !== 0) {
            appState.selectionMoved = true;
            appState.selectedStrokes.forEach(stroke => {
                stroke.points.forEach(p => { p.x += dx; p.y += dy; });
            });
            redrawPageCanvas(pageData);
            updateSelectionMenuPosition();
        }
        appState.dragStartPoint = rawPoint;
        return;
    }

    if (appState.activeTool === 'lasso') {
        appState.lassoPath.push(getCanvasCoords(e, pageData.canvas));
        // FASE C: disegna solo il nuovo segmento sull'overlay.
        // O(1) per frame invece di O(n stroke sulla pagina).
        drawLassoIncrementalOnOverlay(pageData);
        return;
    }

    if (appState.activeTool === 'eraser') {
        performEraserAt(pageData, getCanvasCoords(e, pageData.canvas));
        return;
    }

    if (!appState.currentStroke) return;

    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const events = (coalesced && coalesced.length > 0) ? coalesced : [e];

    for (const ev of events) {
        _flushState.points.push(getCanvasCoords(ev, pageData.canvas));
    }

    _scheduleFlush(pageData);
}

function handlePointerUp(e, pageData) {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck && e.pointerType !== 'pen') return;
    if (e.pointerId !== appState.currentPointerId) return;

    _forceFlushNow(pageData);

    if (appState.pendingShape) {
        finalizePendingShape();
        try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        return;
    }

    try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}

    if (appState.scribbleMode) {
        finalizeScribble(pageData);
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        appState.currentStroke = null;
        return;
    }

    if (appState.isResizingSelection) {
        const wasMoved = appState.selectionMoved;
        appState.isResizingSelection = false;
        appState.resizeHandle = null;
        appState.resizePivot = null;
        appState.resizeAnchor = null;
        appState.resizeOffset = null;
        appState.resizeCurrentAngle = 0;
        appState.initialStrokesSnapshot = null;
        appState.selectionMoved = false;
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        pageData.canvas.style.cursor = 'crosshair';
        if (wasMoved) {
            pushHistory();
            autoSaveTrigger();
        }
        return;
    }

    if (appState.isDraggingSelection) {
        const wasMoved = appState.selectionMoved;
        appState.isDraggingSelection = false;
        appState.dragStartPoint = null;
        appState.selectionMoved = false;
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        pageData.canvas.style.cursor = 'crosshair';
        if (wasMoved) pushHistory();
        autoSaveTrigger();
        return;
    }

    if (!appState.isDrawing) {
        return;
    }
    appState.isDrawing = false;
    appState.currentPointerId = null;
    appState.currentPageForPointer = null;

    if (appState.activeTool === 'lasso') {
        if (appState.lassoPath.length > 5) {
            selectStrokesInsideLasso(pageData);
        } else {
            // Lasso troppo corto: nessuna selezione, pulisci overlay
            appState.lassoPath = [];
            clearOverlay(pageData);
        }
        return;
    }

    if (appState.currentStroke && appState.currentStroke.points.length >= 1) {
        let snapped = false;

        if (appState.currentStroke.points.length > 2 && appState.autoShapeEnabled) {
            if (appState.activeTool === 'highlighter') {
                if (trySnapHighlighter(appState.currentStroke)) {
                    showToast('Evidenziatore raddrizzato', '🖍️');
                    snapped = true;
                }
            } else if (SHAPE_CAPABLE_TOOLS.includes(appState.activeTool)) {
                if (trySnapToLine(appState.currentStroke)) {
                    showToast('Linea agganciata', '📏');
                    snapped = true;
                } else if (detectAndSnapShape(appState.currentStroke, pageData)) {
                    snapped = true;
                }
            }
        }

        pageData.strokes.push(appState.currentStroke);

        if (snapped) {
            // Snappato: i punti sono cambiati, ridisegna tutto sul page canvas
            // (l'overlay contiene la curva live pre-snap, inutile copiarla)
            const pctx = pageData.ctx;
            const dpr = pageData.dpr || 1;
            pctx.save();
            pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            renderFullStroke(pctx, appState.currentStroke, appState.isDarkMode);
            pctx.restore();
        } else if (appState.currentStroke.points.length === 1) {
            // Dot: disegna direttamente sul page canvas
            drawDotOnly(pageData, appState.currentStroke);
        } else if (appState.activeTool === 'highlighter') {
            // Highlighter: il grosso è già sul page canvas, chiudi l'ultimo pezzo
            drawFinalSegmentOnly(pageData, appState.currentStroke);
        } else {
            // Pen, pencil, marker: lo stroke è sull'overlay, copialo 1:1 sul page canvas
            // e chiudi l'ultimo segmento (che con smoothness > 0 non era disegnato)
            const pctx = pageData.ctx;
            pctx.save();
            pctx.setTransform(1, 0, 0, 1, 0, 0);
            pctx.drawImage(pageData.overlayCanvas, 0, 0);
            pctx.restore();
            drawFinalSegmentOnly(pageData, appState.currentStroke);
        }

        clearOverlay(pageData);

        autoSaveTrigger();
        pushHistory();
    }
    appState.currentStroke = null;
}

function performEraserAt(pageData, point) {
    const mode = document.getElementById('eraserModeSelect').value;
    const radius = sliderToBaseSize(appState.strokeWidth) * 12;
    const initCount = pageData.strokes.length;

    if (mode === 'stroke') {
        pageData.strokes = pageData.strokes.filter(stroke =>
            !stroke.points.some(p => Math.hypot(p.x - point.x, p.y - point.y) < radius)
        );
    } else {
        pageData.strokes.forEach(stroke => {
            stroke.points = stroke.points.filter(p => Math.hypot(p.x - point.x, p.y - point.y) >= radius);
        });
        pageData.strokes = pageData.strokes.filter(s => s.points.length > 1);
    }

    if (pageData.strokes.length !== initCount) {
        redrawPageCanvas(pageData);
        autoSaveTrigger();
        pushHistory();
    }
}

function updateCursorForSelection(e, pageData) {
    if (appState.activeTool !== 'lasso' || appState.selectedStrokes.length === 0) {
        pageData.canvas.style.cursor = 'crosshair';
        return;
    }
    const point = getCanvasCoords(e, pageData.canvas);
    const visualBBox = getVisualBoundingBox();
    const handle = hitTestHandle(point, visualBBox);

    if (handle) {
        pageData.canvas.style.cursor = 'nwse-resize';
    } else if (isPointInBBox(point, visualBBox)) {
        pageData.canvas.style.cursor = 'move';
    } else {
        pageData.canvas.style.cursor = 'crosshair';
    }
}