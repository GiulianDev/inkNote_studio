// ============================================================
// GESTI VIEWPORT (PAN / PINCH / PULL-TO-ADD-PAGE)
// Touch (tablet) e wheel/ctrl+wheel (trackpad Mac) sono unificati:
//   - Due dita che si allargano/restringono  → zoom (pinch)
//   - Due dita che scorrono parallele        → pan
//   - Un dito (tablet)                        → pan
// ============================================================

function setupViewportGestures() {
    const viewport = document.getElementById('viewport');

    const onPointerDown = (e) => {
        const palmCheck = document.getElementById('palmRejectionCheck').checked;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pointerType: e.pointerType });

        if (activePointers.size === 1) {
            if (palmCheck && e.pointerType !== 'pen') {
                isPanning = true;
                panStart = { x: e.clientX, y: e.clientY };
                panStartTransform = { x: transformState.x, y: transformState.y };
                try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
            }
        } else if (activePointers.size === 2) {
            if (isPanning) isPanning = false;
            abortCurrentDrawing();
            isPinching = true;
            const pts = Array.from(activePointers.values());
            pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            pinchStartCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            pinchStartTransform = { x: transformState.x, y: transformState.y, scale: transformState.scale };
            try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
        }
    };

    const onPointerMove = (e) => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pointerType: e.pointerType });

        if (isPanning && activePointers.size === 1) {
            e.preventDefault();
            const dx = e.clientX - panStart.x;
            const dy = e.clientY - panStart.y;
            transformState.x = panStartTransform.x + dx;
            transformState.y = panStartTransform.y + dy;
            applyTransform();

            const container = document.getElementById('canvasContainer');
            const bottomBoundary = viewport.clientHeight - (transformState.y + container.getBoundingClientRect().height);
            if (bottomBoundary > 0 && dy < 0) {
                appState.pullOverscrollY = bottomBoundary;
                showPullIndicator(appState.pullOverscrollY >= PULL_THRESHOLD);
            } else {
                hidePullIndicator();
            }
        } else if (isPinching && activePointers.size === 2) {
            e.preventDefault();
            const pts = Array.from(activePointers.values());
            const currentDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const newCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            if (pinchStartDist > 0) {
                const factor = currentDist / pinchStartDist;
                const targetScale = Math.min(
                    Math.max(pinchStartTransform.scale * factor, transformState.minScale),
                    transformState.maxScale
                );
                applyPinchTransform(pinchStartCenter, pinchStartTransform, newCenter, targetScale);
            }
        }
    };

    const onPointerEnd = (e) => {
        activePointers.delete(e.pointerId);
        if (activePointers.size === 0) {
            if (appState.pullOverscrollY >= PULL_THRESHOLD) {
                addNewPage();
                showToast('Nuova pagina aggiunta!', '➕');
            }
            appState.pullOverscrollY = 0;
            hidePullIndicator();
            isPanning = false;
            isPinching = false;
            // Refresh risoluzione dopo il gesto (pan può aver fatto entrare
            // nuove pagine nel viewport: vanno portate ad alta risoluzione)
            scheduleResolutionRefresh();
        } else if (activePointers.size === 1) {
            isPinching = false;
        }
    };

    viewport.addEventListener('pointerdown', onPointerDown, { capture: true });
    viewport.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    viewport.addEventListener('pointerup', onPointerEnd, { capture: true });
    viewport.addEventListener('pointercancel', onPointerEnd, { capture: true });

    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();

        if (e.ctrlKey) {
            const clampedDelta = Math.max(-50, Math.min(50, e.deltaY));
            const zoomFactor = Math.exp(-clampedDelta * 0.01);
            const newScale = Math.min(
                Math.max(transformState.scale * zoomFactor, transformState.minScale),
                transformState.maxScale
            );
            if (newScale === transformState.scale) return;

            const pivot = { x: e.clientX, y: e.clientY };
            applyPinchTransform(
                pivot,
                { x: transformState.x, y: transformState.y, scale: transformState.scale },
                pivot,
                newScale
            );
        } else {
            transformState.x -= e.deltaX;
            transformState.y -= e.deltaY;
            applyTransform();
        }
    }, { passive: false });
}

function applyPinchTransform(startCenter, startTransform, newCenter, targetScale) {
    const contentX = (startCenter.x - startTransform.x) / startTransform.scale;
    const contentY = (startCenter.y - startTransform.y) / startTransform.scale;

    transformState.x = newCenter.x - contentX * targetScale;
    transformState.y = newCenter.y - contentY * targetScale;
    transformState.scale = targetScale;
    applyTransform();
}

function abortCurrentDrawing() {
    if (appState.pendingShape) finalizePendingShape();

    // Cancella i punti in attesa del flush rAF. Senza questo, al prossimo
    // frame verrebbero disegnati su uno stroke che non esiste più.
    _cancelFlush();

    if (appState.isDrawing || appState.currentStroke) {
        if (appState.currentPointerId !== null && appState.currentPageForPointer) {
            try { appState.currentPageForPointer.canvas.releasePointerCapture(appState.currentPointerId); } catch (err) {}
        }
        appState.isDrawing = false;
        appState.currentStroke = null;
        appState.currentPointerId = null;
        appState.currentPageForPointer = null;
        appState.scribbleMode = false;
        appState.scribbleTargets = [];
        const currPage = appState.pages[appState.activePageIndex];
        if (currPage) {
            redrawPageCanvas(currPage);
            clearOverlay(currPage);
        }
    }
    _drawBackupCanvas = null;
}

function showPullIndicator(isReady) {
    const ind = document.getElementById('pullPageIndicator');
    const txt = document.getElementById('pullText');
    const icon = document.getElementById('pullIcon');
    ind.classList.remove('hidden');
    ind.classList.add('flex');
    if (isReady) {
        ind.classList.remove('bg-indigo-600', 'dark:bg-indigo-500');
        ind.classList.add('bg-emerald-600', 'dark:bg-emerald-500', 'scale-105');
        txt.innerText = 'Rilascia per creare una nuova pagina!';
        icon.innerText = '✨';
    } else {
        ind.classList.remove('bg-emerald-600', 'dark:bg-emerald-500', 'scale-105');
        ind.classList.add('bg-indigo-600', 'dark:bg-indigo-500');
        txt.innerText = 'Scorri in su per aggiungere una nuova pagina...';
        icon.innerText = '⬆️';
    }
}

function hidePullIndicator() {
    const ind = document.getElementById('pullPageIndicator');
    ind.classList.add('hidden');
    ind.classList.remove('flex');
}

function togglePalmRejection(enabled) {
    showToast(enabled ? 'Palm Rejection ATTIVO: Solo Penna scrive, 1 dito muove' : 'Palm Rejection DISATTIVO: 1 dito scrive, 2 dita muovono', enabled ? '🖐️' : '✏️');
}