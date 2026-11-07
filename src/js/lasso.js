// ============================================================
// LAZO, SELEZIONE, RESIZE (similarità con pivot), COLOR, WIDTH
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

// ------------------------------------------------------------
// BOUNDING BOX (reale + visivo)
// ------------------------------------------------------------

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

function getVisualBoundingBox() {
    const real = getSelectionBoundingBox(false);
    if (!real) return null;
    const minSize = 40 / transformState.scale;
    const cx = (real.minX + real.maxX) / 2;
    const cy = (real.minY + real.maxY) / 2;
    let { minX, maxX, minY, maxY } = real;

    if (real.width < minSize) {
        minX = cx - minSize / 2;
        maxX = cx + minSize / 2;
    }
    if (real.height < minSize) {
        minY = cy - minSize / 2;
        maxY = cy + minSize / 2;
    }
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function getVisibleHandles() {
    return ['nw', 'se'];
}

function isPointInsideSelectionBoundingBox(pt) {
    const bbox = getSelectionBoundingBox();
    if (!bbox) return false;
    return pt.x >= bbox.minX && pt.x <= bbox.maxX && pt.y >= bbox.minY && pt.y <= bbox.maxY;
}

function isPointInBBox(pt, bbox) {
    if (!bbox) return false;
    return pt.x >= bbox.minX && pt.x <= bbox.maxX && pt.y >= bbox.minY && pt.y <= bbox.maxY;
}

function getHandlePositions(bbox) {
    return {
        nw: { x: bbox.minX, y: bbox.minY },
        se: { x: bbox.maxX, y: bbox.maxY }
    };
}

function hitTestHandle(point, visualBBox) {
    if (!visualBBox) return null;
    const handles = getHandlePositions(visualBBox);
    const hitRadius = 16 / transformState.scale;
    for (const name of ['nw', 'se']) {
        const h = handles[name];
        if (Math.hypot(point.x - h.x, point.y - h.y) < hitRadius) {
            return name;
        }
    }
    return null;
}

function findClosestPointInSelection(target) {
    let closest = null;
    let minDist = Infinity;
    appState.selectedStrokes.forEach(stroke => {
        stroke.points.forEach(p => {
            const d = Math.hypot(p.x - target.x, p.y - target.y);
            if (d < minDist) {
                minDist = d;
                closest = { x: p.x, y: p.y };
            }
        });
    });
    return closest;
}

// FIX CRITICO: non chiama redrawPageCanvas se non c'era nulla da pulire.
// Prima veniva chiamato a ogni pointerdown in handlePointerDown → ogni nuovo
// stroke ridisegnava l'intera pagina (O(N) per stroke, O(N²) totale).
// Questo era il collo di bottiglia residuo principale.
function clearSelection() {
    const hadSelection = appState.selectedStrokes.length > 0;
    const hadLasso = appState.lassoPath.length > 0;

    appState.selectedStrokes = [];
    appState.isDraggingSelection = false;
    appState.isResizingSelection = false;
    appState.resizePivot = null;
    appState.resizeAnchor = null;
    appState.resizeOffset = null;
    appState.initialStrokesSnapshot = null;
    hideSelectionMenu();

    if (hadSelection || hadLasso) {
        const currentPage = appState.pages[appState.activePageIndex];
        if (currentPage) {
            currentPage.canvas.style.cursor = 'crosshair';
            redrawPageCanvas(currentPage);
        }
    }
}

// ------------------------------------------------------------
// RESIZE (similarità: pivot fisso, anchor→target)
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
    const visualBBox = getVisualBoundingBox();
    if (!visualBBox) return;

    const handles = getHandlePositions(visualBBox);
    const oppositeHandle = handle === 'nw' ? 'se' : 'nw';
    const oppositeCorner = handles[oppositeHandle];
    const draggedCorner = handles[handle];

    const pivot = findClosestPointInSelection(oppositeCorner);
    const anchor = findClosestPointInSelection(draggedCorner);
    if (!pivot || !anchor) return;

    const baseDist = Math.hypot(anchor.x - pivot.x, anchor.y - pivot.y);
    if (baseDist < 1 / transformState.scale) {
        showToast('Selezione troppo piccola per ridimensionare', '⚠️');
        return;
    }

    const offset = {
        x: startPoint.x - anchor.x,
        y: startPoint.y - anchor.y
    };

    appState.isResizingSelection = true;
    appState.isDrawing = true;
    appState.resizeHandle = handle;
    appState.resizePivot = { x: pivot.x, y: pivot.y };
    appState.resizeAnchor = { x: anchor.x, y: anchor.y };
    appState.resizeOffset = offset;
    appState.resizeBaseDist = baseDist;
    appState.resizeBaseAngle = Math.atan2(anchor.y - pivot.y, anchor.x - pivot.x);
    appState.resizeCurrentAngle = 0;
    appState.initialStrokesSnapshot = snapshotSelectedStrokes();
    appState.selectionMoved = false;

    const currentPage = appState.pages[appState.activePageIndex];
    if (currentPage) currentPage.canvas.style.cursor = 'nwse-resize';
}

function applyResizeSelection(point) {
    if (!appState.isResizingSelection || !appState.resizePivot) return;

    const pivot = appState.resizePivot;
    const offset = appState.resizeOffset || { x: 0, y: 0 };
    const target = { x: point.x - offset.x, y: point.y - offset.y };

    const dx = target.x - pivot.x;
    const dy = target.y - pivot.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 2 / transformState.scale) return;

    const angle = Math.atan2(dy, dx);
    const scale = dist / appState.resizeBaseDist;
    const deltaAngle = angle - appState.resizeBaseAngle;

    const snapThreshold = Math.PI / 90;
    const quarterTurn = Math.PI / 2;
    const nearest = Math.round(deltaAngle / quarterTurn) * quarterTurn;
    let effectiveAngle = deltaAngle;
    if (Math.abs(deltaAngle - nearest) < snapThreshold) {
        effectiveAngle = nearest;
    }
    appState.resizeCurrentAngle = effectiveAngle;

    const cos = Math.cos(effectiveAngle);
    const sin = Math.sin(effectiveAngle);

    appState.selectedStrokes.forEach((stroke, i) => {
        const snap = appState.initialStrokesSnapshot[i];
        stroke.points = snap.points.map(p => {
            const px = p.x - pivot.x;
            const py = p.y - pivot.y;
            return {
                x: pivot.x + (px * cos - py * sin) * scale,
                y: pivot.y + (px * sin + py * cos) * scale,
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
// COLOR / WIDTH
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
    const bbox = getVisualBoundingBox();
    const currentPage = appState.pages[appState.activePageIndex];
    if (!bbox || !currentPage) return;
    const rect = currentPage.canvas.getBoundingClientRect();
    const scaleRatio = rect.width / PAGE_WIDTH;
    const screenX = rect.left + (bbox.minX + bbox.width / 2) * scaleRatio;
    const screenY = rect.top + bbox.minY * scaleRatio - 60;
    const menuWidth = menu.offsetWidth || 320;
    menu.style.left = `${Math.max(20, Math.min(window.innerWidth - menuWidth - 20, screenX - menuWidth / 2))}px`;
    menu.style.top = `${Math.max(60, screenY)}px`;
}