// ============================================================
// LAZO, SELEZIONE, RESIZE, ROTATE, COLOR, WIDTH
// ============================================================

function selectStrokesInsideLasso(pageData) {
    const polygon = appState.lassoPath;
    appState.selectedStrokes = pageData.strokes.filter(stroke =>
        stroke.points.some(pt => isPointInPolygon(pt, polygon))
    );

    if (appState.selectedStrokes.length > 0) {
        showSelectionMenu();
        showToast(`${appState.selectedStrokes.length} elementi selezionati`, '✂️');
    } else {
        clearSelection();
    }
}

function isPointInPolygon(point, vs) {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y;
        let xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Bounding box degli stroke selezionati. Il pad (default) è in pixel
// schermo (12 / scale) così da essere visivamente costante allo zoom.
// Per i calcoli geometrici di resize passiamo includePad = false.
function getSelectionBoundingBox(includePad = true) {
    if (appState.selectedStrokes.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    appState.selectedStrokes.forEach(stroke => {
        stroke.points.forEach(p => {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        });
    });
    const pad = includePad ? 12 / transformState.scale : 0;
    return {
        minX: minX - pad, maxX: maxX + pad,
        minY: minY - pad, maxY: maxY + pad,
        width: (maxX - minX) + pad * 2,
        height: (maxY - minY) + pad * 2
    };
}

function isPointInsideSelectionBoundingBox(pt) {
    const bbox = getSelectionBoundingBox();
    if (!bbox) return false;
    return pt.x >= bbox.minX && pt.x <= bbox.maxX && pt.y >= bbox.minY && pt.y <= bbox.maxY;
}

// Posizioni degli handle in coordinate canvas.
// Le distanze (es. offset rotate) sono in pixel schermo / scale,
// così restano visivamente costanti indipendentemente dallo zoom.
function getHandlePositions(bbox) {
    const cx = bbox.minX + bbox.width / 2;
    const cy = bbox.minY + bbox.height / 2;
    const rotOffset = 30 / transformState.scale;
    return {
        nw: { x: bbox.minX, y: bbox.minY },
        n:  { x: cx, y: bbox.minY },
        ne: { x: bbox.maxX, y: bbox.minY },
        e:  { x: bbox.maxX, y: cy },
        se: { x: bbox.maxX, y: bbox.maxY },
        s:  { x: cx, y: bbox.maxY },
        sw: { x: bbox.minX, y: bbox.maxY },
        w:  { x: bbox.minX, y: cy },
        rotate: { x: cx, y: bbox.minY - rotOffset }
    };
}

// Hit test: restituisce il nome dell'handle sotto il punto, o null.
// L'area di click è più generosa dell'handle visivo (14px vs 10px).
function hitTestHandle(point, bbox) {
    if (!bbox) return null;
    const hitRadius = 14 / transformState.scale;
    const handles = getHandlePositions(bbox);
    for (const name in handles) {
        const h = handles[name];
        if (Math.hypot(point.x - h.x, point.y - h.y) < hitRadius) {
            return name;
        }
    }
    return null;
}

function clearSelection() {
    appState.selectedStrokes = [];
    appState.isDraggingSelection = false;
    appState.isResizingSelection = false;
    appState.isRotatingSelection = false;
    appState.initialBBox = null;
    appState.initialStrokesSnapshot = null;
    hideSelectionMenu();
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage) redrawPageCanvas(currentPage);
}

// ------------------------------------------------------------
// RESIZE
// ------------------------------------------------------------

function snapshotSelectedStrokes() {
    return appState.selectedStrokes.map(s => ({
        color: s.color,
        size: s.size,
        tool: s.tool,
        points: s.points.map(p => ({ x: p.x, y: p.y, pressure: p.pressure }))
    }));
}

function startResizeSelection(handle, startPoint) {
    // BBox senza pad: il calcolo geometrico lavora sui limiti reali degli stroke
    const bbox = getSelectionBoundingBox(false);
    if (!bbox) return;

    appState.isResizingSelection = true;
    appState.isDrawing = true;
    appState.resizeHandle = handle;
    appState.dragStartPoint = startPoint;
    appState.initialBBox = { ...bbox };
    appState.initialStrokesSnapshot = snapshotSelectedStrokes();
    appState.selectionMoved = false;
}

function applyResizeSelection(point) {
    if (!appState.isResizingSelection || !appState.initialBBox) return;

    const bbox0 = appState.initialBBox;
    const start = appState.dragStartPoint;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const handle = appState.resizeHandle;

    let newMinX = bbox0.minX;
    let newMaxX = bbox0.maxX;
    let newMinY = bbox0.minY;
    let newMaxY = bbox0.maxY;

    if (handle.includes('w')) newMinX = bbox0.minX + dx;
    if (handle.includes('e')) newMaxX = bbox0.maxX + dx;
    if (handle.includes('n')) newMinY = bbox0.minY + dy;
    if (handle.includes('s')) newMaxY = bbox0.maxY + dy;

    // Evita bbox collassato o invertito (minimo 20px schermo)
    const minSize = 20 / transformState.scale;
    if (newMaxX - newMinX < minSize) {
        if (handle.includes('w')) newMinX = newMaxX - minSize;
        else newMaxX = newMinX + minSize;
    }
    if (newMaxY - newMinY < minSize) {
        if (handle.includes('n')) newMinY = newMaxY - minSize;
        else newMaxY = newMinY + minSize;
    }

    const scaleX = (newMaxX - newMinX) / bbox0.width;
    const scaleY = (newMaxY - newMinY) / bbox0.height;

    appState.selectedStrokes.forEach((stroke, i) => {
        const snap = appState.initialStrokesSnapshot[i];
        stroke.points = snap.points.map(p => ({
            x: newMinX + (p.x - bbox0.minX) * scaleX,
            y: newMinY + (p.y - bbox0.minY) * scaleY,
            pressure: p.pressure
        }));
    });

    appState.selectionMoved = true;
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage) redrawPageCanvas(currentPage);
    updateSelectionMenuPosition();
}

// ------------------------------------------------------------
// ROTATE
// ------------------------------------------------------------

function startRotateSelection(startPoint) {
    const bbox = getSelectionBoundingBox(false);
    if (!bbox) return;

    const cx = bbox.minX + bbox.width / 2;
    const cy = bbox.minY + bbox.height / 2;

    appState.isRotatingSelection = true;
    appState.isDrawing = true;
    appState.rotateCenter = { x: cx, y: cy };
    appState.rotateStartAngle = Math.atan2(startPoint.y - cy, startPoint.x - cx);
    appState.initialStrokesSnapshot = snapshotSelectedStrokes();
    appState.selectionMoved = false;
}

function applyRotateSelection(point) {
    if (!appState.isRotatingSelection || !appState.rotateCenter) return;

    const { x: cx, y: cy } = appState.rotateCenter;
    const currentAngle = Math.atan2(point.y - cy, point.x - cx);
    const deltaAngle = currentAngle - appState.rotateStartAngle;

    // Snap morbido a 0°, 45°, 90°, ... entro 3°
    const snapThreshold = Math.PI / 60;
    let effectiveAngle = deltaAngle;
    const quarterTurn = Math.PI / 4;
    const nearest = Math.round(deltaAngle / quarterTurn) * quarterTurn;
    if (Math.abs(deltaAngle - nearest) < snapThreshold) {
        effectiveAngle = nearest;
    }

    const cos = Math.cos(effectiveAngle);
    const sin = Math.sin(effectiveAngle);

    appState.selectedStrokes.forEach((stroke, i) => {
        const snap = appState.initialStrokesSnapshot[i];
        stroke.points = snap.points.map(p => {
            const px = p.x - cx;
            const py = p.y - cy;
            return {
                x: cx + px * cos - py * sin,
                y: cy + px * sin + py * cos,
                pressure: p.pressure
            };
        });
    });

    appState.selectionMoved = true;
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage) redrawPageCanvas(currentPage);
    updateSelectionMenuPosition();
}

// ------------------------------------------------------------
// COLOR / WIDTH (modifica bulk)
// ------------------------------------------------------------

function changeSelectionColor(newColor) {
    if (appState.selectedStrokes.length === 0) return;
    appState.selectedStrokes.forEach(s => { s.color = newColor; });
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage) redrawPageCanvas(currentPage);
    autoSaveTrigger();
    pushHistory();
    showToast('Colore aggiornato', '🎨');
}

function changeSelectionWidth(newWidth) {
    if (appState.selectedStrokes.length === 0) return;
    const w = parseInt(newWidth);
    appState.selectedStrokes.forEach(s => { s.size = w; });
    const widthValue = document.getElementById('selectionWidthValue');
    if (widthValue) widthValue.innerText = w;
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage) redrawPageCanvas(currentPage);
    autoSaveTrigger();
    pushHistory();
    showToast('Spessore aggiornato', '📏');
}

// ------------------------------------------------------------
// DELETE
// ------------------------------------------------------------

function deleteSelectedStrokes() {
    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage && appState.selectedStrokes.length > 0) {
        currentPage.strokes = currentPage.strokes.filter(s => !appState.selectedStrokes.includes(s));
        clearSelection();
        redrawPageCanvas(currentPage);
        autoSaveTrigger();
        pushHistory();
        showToast('Elementi eliminati', '🗑️');
    }
}

// ------------------------------------------------------------
// MENU
// ------------------------------------------------------------

function showSelectionMenu() {
    const menu = document.getElementById('selectionMenu');
    menu.classList.remove('hidden');

    if (appState.selectedStrokes.length > 0) {
        const first = appState.selectedStrokes[0];
        const colorPicker = document.getElementById('selectionColorPicker');
        const widthSlider = document.getElementById('selectionWidthSlider');
        const widthValue = document.getElementById('selectionWidthValue');
        if (colorPicker && first.color) colorPicker.value = first.color;
        if (widthSlider) widthSlider.value = first.size || 3;
        if (widthValue) widthValue.innerText = first.size || 3;
    }

    updateSelectionMenuPosition();
}

function hideSelectionMenu() {
    document.getElementById('selectionMenu').classList.add('hidden');
}

function updateSelectionMenuPosition() {
    const menu = document.getElementById('selectionMenu');
    if (menu.classList.contains('hidden')) return;
    const bbox = getSelectionBoundingBox();
    const currentPage = appState.pages[appState.activePageIndex];
    if (!bbox || !currentPage) return;
    const rect = currentPage.canvas.getBoundingClientRect();
    const scaleRatio = rect.width / PAGE_WIDTH;
    const screenX = rect.left + (bbox.minX + bbox.width / 2) * scaleRatio;
    const screenY = rect.top + bbox.minY * scaleRatio - 60;
    // Menu più largo: clampa per non uscire dal viewport
    const menuWidth = menu.offsetWidth || 320;
    menu.style.left = `${Math.max(20, Math.min(window.innerWidth - menuWidth - 20, screenX - menuWidth / 2))}px`;
    menu.style.top = `${Math.max(60, screenY)}px`;
}