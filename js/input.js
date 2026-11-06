// ============================================================
// INPUT CANVAS (POINTER EVENTS + GOMMA + PRESSIONE)
// ============================================================

// Estrae coordinate + pressione dal pointer event.
// - Penna reale: usa e.pressure (0-1)
// - Mouse/touch: 0.5 fisso
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
        pointerType: e.pointerType
    };
}

// Smussa la pressione con una media pesata degli ultimi punti.
function smoothPressure(points, newPressure) {
    if (points.length === 0) return newPressure;
    const recent = points.slice(-3);
    let sum = newPressure * 0.6;
    for (const p of recent) sum += (p.pressure || 0.5) * 0.4 / recent.length * recent.length;
    const wNew = 0.6;
    const wOld = 0.4 / Math.max(1, recent.length);
    let acc = newPressure * wNew;
    for (const p of recent) acc += (p.pressure || 0.5) * wOld;
    return Math.max(0.05, Math.min(1, acc));
}

function attachPointerListeners(pageData) {
    const canvas = pageData.canvas;
    canvas.addEventListener('pointerdown', (e) => handlePointerDown(e, pageData));
    canvas.addEventListener('pointermove', (e) => handlePointerMove(e, pageData));
    canvas.addEventListener('pointerup', (e) => handlePointerUp(e, pageData));
    canvas.addEventListener('pointercancel', (e) => handlePointerUp(e, pageData));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function handlePointerDown(e, pageData) {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck && e.pointerType !== 'pen') return;
    if (isPanning || isPinching) return;
    if (activePointers.size > 1) return;

    if (appState.pendingShape) finalizePendingShape();

    try { pageData.canvas.setPointerCapture(e.pointerId); } catch (err) {}

    appState.activePageIndex = pageData.index;
    appState.currentPointerId = e.pointerId;
    appState.currentPageForPointer = pageData;
    updatePageCounterUI();

    const point = getCanvasCoords(e, pageData.canvas);

    if (point.pointerType === 'pen') {
        point.pressure = Math.max(point.pressure, 0.35);
    }

    if (appState.activeTool === 'lasso') {
        const bbox = getSelectionBoundingBox();
        if (bbox) {
            // 1) Click su un handle → resize/rotate
            const handle = hitTestHandle(point, bbox);
            if (handle === 'rotate') {
                startRotateSelection(point);
                return;
            } else if (handle) {
                startResizeSelection(handle, point);
                return;
            }
            // 2) Click dentro il bbox → drag (sposta)
            if (isPointInsideSelectionBoundingBox(point)) {
                appState.isDraggingSelection = true;
                appState.dragStartPoint = point;
                appState.isDrawing = true;
                appState.selectionMoved = false;
                return;
            }
        }
        // 3) Altrimenti nuovo lazo
        clearSelection();
        appState.isDrawing = true;
        appState.lassoPath = [point];
        redrawPageCanvas(pageData);
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
        points: [point]
    };
}

function handlePointerMove(e, pageData) {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck && e.pointerType !== 'pen') return;
    if (isPanning || isPinching) return;
    if (!appState.isDrawing) return;
    if (e.pointerId !== appState.currentPointerId) return;

    const point = getCanvasCoords(e, pageData.canvas);

    // Pending shape: aggiusto la linea tenendo premuto
    if (appState.pendingShape) {
        const ps = appState.pendingShape;
        if (ps.activeHandle === 'end') {
            ps.end = { x: point.x, y: point.y, pressure: 0.5 };
        } else {
            ps.start = { x: point.x, y: point.y, pressure: 0.5 };
        }
        redrawPageCanvas(pageData);
        return;
    }

    if (appState.isResizingSelection) {
        applyResizeSelection(point);
        return;
    }

    if (appState.isRotatingSelection) {
        applyRotateSelection(point);
        return;
    }

    if (appState.isDraggingSelection && appState.dragStartPoint) {
        const dx = point.x - appState.dragStartPoint.x;
        const dy = point.y - appState.dragStartPoint.y;
        if (dx !== 0 || dy !== 0) {
            appState.selectionMoved = true;
            appState.selectedStrokes.forEach(stroke => {
                stroke.points.forEach(p => { p.x += dx; p.y += dy; });
            });
            redrawPageCanvas(pageData);
            updateSelectionMenuPosition();
        }
        appState.dragStartPoint = point;
        return;
    }

    if (appState.activeTool === 'lasso') {
        appState.lassoPath.push(point);
        redrawPageCanvas(pageData);
        return;
    }

    if (appState.activeTool === 'eraser') {
        performEraserAt(pageData, point);
        return;
    }

    if (!appState.currentStroke) return;

    if (point.pointerType === 'pen' && appState.currentStroke.points.length > 0) {
        point.pressure = smoothPressure(appState.currentStroke.points, point.pressure);
    }

    appState.currentStroke.points.push(point);
    drawIncrementalSegment(pageData.ctx, appState.currentStroke, pageData.dpr);

    // Gate di performance: evita la chiamata ad ogni pointermove finché
    // non ci sono abbastanza punti per un potenziale snap.
    if (appState.autoShapeEnabled &&
        SHAPE_CAPABLE_TOOLS.includes(appState.activeTool) &&
        appState.currentStroke.points.length >= 6) {
        trySnapToLineDuringDraw(pageData, point);
    }
}

function handlePointerUp(e, pageData) {
    const palmCheck = document.getElementById('palmRejectionCheck').checked;
    if (palmCheck && e.pointerType !== 'pen') return;
    if (e.pointerId !== appState.currentPointerId) return;

    if (appState.pendingShape) {
        finalizePendingShape();
        try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        return;
    }

    try { pageData.canvas.releasePointerCapture(e.pointerId); } catch (err) {}

    if (appState.isResizingSelection) {
        const wasMoved = appState.selectionMoved;
        appState.isResizingSelection = false;
        appState.resizeHandle = null;
        appState.initialBBox = null;
        appState.initialStrokesSnapshot = null;
        appState.selectionMoved = false;
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        if (wasMoved) {
            pushHistory();
            autoSaveTrigger();
        }
        return;
    }

    if (appState.isRotatingSelection) {
        const wasMoved = appState.selectionMoved;
        appState.isRotatingSelection = false;
        appState.rotateCenter = null;
        appState.initialStrokesSnapshot = null;
        appState.selectionMoved = false;
        appState.isDrawing = false;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
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
        if (wasMoved) pushHistory();
        autoSaveTrigger();
        return;
    }

    if (!appState.isDrawing) return;
    appState.isDrawing = false;
    appState.currentPointerId = null;
    appState.currentPageForPointer = null;

    if (appState.activeTool === 'lasso') {
        if (appState.lassoPath.length > 5) {
            selectStrokesInsideLasso(pageData);
        }
        appState.lassoPath = [];
        redrawPageCanvas(pageData);
        return;
    }

    if (appState.currentStroke && appState.currentStroke.points.length > 2) {
        // Forme chiuse (cerchio/rettangolo) riconosciute a fine tratto
        if (appState.autoShapeEnabled && SHAPE_CAPABLE_TOOLS.includes(appState.activeTool)) {
            detectAndSnapShape(appState.currentStroke, pageData);
        }

        pageData.strokes.push(appState.currentStroke);
        redrawPageCanvas(pageData);
        autoSaveTrigger();
        pushHistory();
    }
    appState.currentStroke = null;
}

function performEraserAt(pageData, point) {
    const mode = document.getElementById('eraserModeSelect').value;
    const radius = appState.strokeWidth * 4.5;
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