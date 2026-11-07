// ============================================================
// INPUT CANVAS (POINTER EVENTS + GOMMA + PRESSIONE + SMOOTHING)
// ============================================================

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

function smoothPressure(points, newPressure) {
    if (points.length === 0) return newPressure;
    const recent = points.slice(-3);
    const wNew = 0.6;
    const wOld = 0.4 / Math.max(1, recent.length);
    let acc = newPressure * wNew;
    for (const p of recent) acc += (p.pressure || 0.5) * wOld;
    return Math.max(0.05, Math.min(1, acc));
}

// E: muta rawPoint in-place invece di allocare un nuovo oggetto.
// Evita un'allocazione per pointermove (a 240Hz su Surface sono migliaia
// di oggetti al secondo).
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

    appState.scribbleMode = false;
    appState.scribbleTargets = [];

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

    if (!appState.isDrawing && appState.activeTool === 'lasso' && e.pointerType !== 'touch') {
        updateCursorForSelection(e, pageData);
    }

    if (!appState.isDrawing) return;
    if (e.pointerId !== appState.currentPointerId) return;

    const rawPoint = getCanvasCoords(e, pageData.canvas);

    if (appState.pendingShape) {
        const ps = appState.pendingShape;
        if (ps.activeHandle === 'end') {
            ps.end = { x: rawPoint.x, y: rawPoint.y, pressure: 0.5 };
        } else {
            ps.start = { x: rawPoint.x, y: rawPoint.y, pressure: 0.5 };
        }
        redrawPageCanvas(pageData);
        return;
    }

    if (appState.isResizingSelection) {
        applyResizeSelection(rawPoint);
        return;
    }

    if (appState.isDraggingSelection && appState.dragStartPoint) {
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
        appState.lassoPath.push(rawPoint);
        redrawPageCanvas(pageData);
        return;
    }

    if (appState.activeTool === 'eraser') {
        performEraserAt(pageData, rawPoint);
        return;
    }

    if (!appState.currentStroke) return;

    const prevSmoothed = appState.currentStroke.points[appState.currentStroke.points.length - 1];
    const smoothedPos = smoothRawPoint(rawPoint, prevSmoothed);

    let smoothedPressure = rawPoint.pressure;
    if (rawPoint.pointerType === 'pen' && appState.currentStroke.points.length > 0) {
        smoothedPressure = smoothPressure(appState.currentStroke.points, rawPoint.pressure);
    }

    const minDist = 0.4;
    if (prevSmoothed && Math.hypot(smoothedPos.x - prevSmoothed.x, smoothedPos.y - prevSmoothed.y) < minDist) {
        return;
    }

    const smoothedPoint = {
        x: smoothedPos.x,
        y: smoothedPos.y,
        pressure: smoothedPressure,
        pointerType: rawPoint.pointerType
    };

    appState.currentStroke.points.push(smoothedPoint);
    drawIncrementalSegment(pageData.ctx, appState.currentStroke, pageData.dpr);

    checkForScribble(pageData);
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
        if (appState.autoShapeEnabled && SHAPE_CAPABLE_TOOLS.includes(appState.activeTool)) {
            if (trySnapToLine(appState.currentStroke)) {
                showToast('Linea agganciata', '📏');
            } else {
                detectAndSnapShape(appState.currentStroke, pageData);
            }
        }

        pageData.strokes.push(appState.currentStroke);

        // C: append invece di redraw completo se non ci sono overlay attivi.
        const hasOverlay = appState.pendingShape ||
                          appState.lassoPath.length > 0 ||
                          appState.selectedStrokes.length > 0;
        if (hasOverlay) {
            redrawPageCanvas(pageData);
        } else {
            appendStrokeToCanvas(pageData, appState.currentStroke);
        }

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