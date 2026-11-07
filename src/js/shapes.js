// ============================================================
// RICONOSCIMENTO FORME (linea, cerchio, rettangolo)
// Le forme geometriche usano pressione fissa 0.5 (sono "pulite")
// ============================================================

// Rilevamento linea LIVE durante il disegno.
// Invece di redrawPageCanvas (che causava lag), ripristina il canvas
// dallo snapshot salvato al pointerdown e disegna solo il pendingShape.
// Entra in modalità "aggiusta la linea muovendo il puntatore" fino al rilascio.
function trySnapToLineDuringDraw(pageData, currentPoint) {
    const stroke = appState.currentStroke;
    if (!stroke) return false;

    const pts = stroke.points;
    if (pts.length < 6) return false;

    const startPt = pts[0];
    const endPt = currentPoint;

    const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
    if (chordLen < 50) return false;

    let pathLen = 0;
    for (let i = 1; i < pts.length; i++) {
        pathLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }
    const pathEfficiency = chordLen / Math.max(pathLen, 1);
    if (pathEfficiency < 0.94) return false;

    const rmsDev = perpendicularRmsDeviation(pts, startPt, endPt);
    if (rmsDev === null) return false;
    const tolerance = Math.max(1.5, chordLen * 0.035);
    if (rmsDev > tolerance) return false;

    if (pts.length >= 3) {
        const a = pts[pts.length - 3];
        const b = pts[pts.length - 2];
        const c = pts[pts.length - 1];
        const v1x = b.x - a.x, v1y = b.y - a.y;
        const v2x = c.x - b.x, v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 > 0.5 && l2 > 0.5) {
            const chordDx = endPt.x - startPt.x, chordDy = endPt.y - startPt.y;
            const chordL = Math.hypot(chordDx, chordDy);
            if (chordL > 0) {
                const cosChord1 = (v1x * chordDx + v1y * chordDy) / (l1 * chordL);
                const cosChord2 = (v2x * chordDx + v2y * chordDy) / (l2 * chordL);
                if (cosChord1 < 0.80 || cosChord2 < 0.80) return false;
            }
        }
    }

    // Entra in pendingShape. NON fa redrawPageCanvas completo:
    // ripristina lo snapshot + disegna solo la linea. O(1) per move.
    appState.pendingShape = {
        start: { x: startPt.x, y: startPt.y, pressure: 0.5 },
        end: { x: endPt.x, y: endPt.y, pressure: 0.5 },
        tool: stroke.tool,
        color: stroke.color,
        size: stroke.size,
        activeHandle: 'end'
    };
    appState.currentStroke = null;

    restoreCanvasFromBackup(pageData);
    renderPendingShapeOnly(pageData);

    showToast('Linea agganciata — muovi per aggiustare, rilascia per confermare', '📏');
    return true;
}

// Rilevamento linea "statico" al pointerup (fallback quando il check live
// non è scattato, es. l'utente ha rilasciato prima del check periodico).
// Ritorna true se lo stroke è stato trasformato in linea retta.
function trySnapToLine(stroke) {
    const pts = stroke.points;
    if (pts.length < 6) return false;

    const startPt = pts[0];
    const endPt = pts[pts.length - 1];

    const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
    if (chordLen < 50) return false;

    let pathLen = 0;
    for (let i = 1; i < pts.length; i++) {
        pathLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }

    const pathEfficiency = chordLen / Math.max(pathLen, 1);
    if (pathEfficiency < 0.94) return false;

    const rmsDev = perpendicularRmsDeviation(pts, startPt, endPt);
    if (rmsDev === null) return false;

    const tolerance = Math.max(1.5, chordLen * 0.035);
    if (rmsDev > tolerance) return false;

    if (pts.length >= 3) {
        const a = pts[pts.length - 3];
        const b = pts[pts.length - 2];
        const c = pts[pts.length - 1];
        const v1x = b.x - a.x, v1y = b.y - a.y;
        const v2x = c.x - b.x, v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 > 0.5 && l2 > 0.5) {
            const chordDx = endPt.x - startPt.x, chordDy = endPt.y - startPt.y;
            const chordL = Math.hypot(chordDx, chordDy);
            if (chordL > 0) {
                const cosChord1 = (v1x * chordDx + v1y * chordDy) / (l1 * chordL);
                const cosChord2 = (v2x * chordDx + v2y * chordDy) / (l2 * chordL);
                if (cosChord1 < 0.80 || cosChord2 < 0.80) return false;
            }
        }
    }

    const steps = Math.max(8, Math.floor(chordLen / 4));
    const straightPts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        straightPts.push({
            x: startPt.x + (endPt.x - startPt.x) * t,
            y: startPt.y + (endPt.y - startPt.y) * t,
            pressure: 0.5
        });
    }
    stroke.points = straightPts;
    return true;
}

function perpendicularRmsDeviation(points, A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ux = dx / len, uy = dy / len;
    let sumSq = 0;
    for (const p of points) {
        const px = p.x - A.x, py = p.y - A.y;
        const along = px * ux + py * uy;
        const perpX = px - along * ux;
        const perpY = py - along * uy;
        const d = Math.hypot(perpX, perpY);
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / points.length);
}

function finalizePendingShape() {
    if (!appState.pendingShape) return;
    const ps = appState.pendingShape;
    const currPage = appState.pages[appState.activePageIndex];
    if (currPage) {
        const startPt = { x: ps.start.x, y: ps.start.y, pressure: 0.5 };
        const endPt = { x: ps.end.x, y: ps.end.y, pressure: 0.5 };
        const steps = Math.max(8, Math.floor(Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) / 4));
        const straightPts = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            straightPts.push({
                x: startPt.x + (endPt.x - startPt.x) * t,
                y: startPt.y + (endPt.y - startPt.y) * t,
                pressure: 0.5
            });
        }
        const newStroke = {
            tool: ps.tool,
            color: ps.color,
            size: ps.size,
            points: straightPts
        };
        currPage.strokes.push(newStroke);
        redrawPageCanvas(currPage);
        autoSaveTrigger();
        pushHistory();
        triggerSnapAnimation(currPage);
    }
    appState.pendingShape = null;
}

function detectAndSnapShape(stroke, pageData) {
    const pts = stroke.points;
    if (pts.length < 8) return false;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let pathLen = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (i > 0) pathLen += Math.hypot(p.x - pts[i-1].x, p.y - pts[i-1].y);
    }
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const bboxDiag = Math.hypot(bboxW, bboxH);

    if (bboxDiag < 90) return false;

    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    const closureDist = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
    const closureRatio = closureDist / Math.max(pathLen, 1);
    if (closureRatio > 0.12) return false;

    const w = bboxW, h = bboxH;
    if (w < 40 || h < 40) return false;

    const aspect = w / h;
    if (aspect < 0.75 || aspect > 1.35) return false;

    const cx = minX + w / 2;
    const cy = minY + h / 2;
    let radiusSum = 0;
    for (const p of pts) {
        radiusSum += Math.hypot(p.x - cx, p.y - cy);
    }
    const avgRadius = radiusSum / pts.length;
    let radiusVariance = 0;
    for (const p of pts) {
        radiusVariance += (Math.hypot(p.x - cx, p.y - cy) - avgRadius) ** 2;
    }
    const radiusStdDev = Math.sqrt(radiusVariance / pts.length);
    const isCircle = radiusStdDev / avgRadius < 0.15;

    const idealRectPerimeter = 2 * (w + h);
    const rectPathRatio = pathLen / idealRectPerimeter;
    const cornerTouchRadius = Math.min(w, h) * 0.35;
    const corners = [
        { x: minX, y: minY }, { x: maxX, y: minY },
        { x: maxX, y: maxY }, { x: minX, y: maxY }
    ];
    const cornersTouched = corners.every(c =>
        pts.some(p => Math.hypot(p.x - c.x, p.y - c.y) < cornerTouchRadius)
    );
    const isRect = cornersTouched && rectPathRatio > 0.85 && rectPathRatio < 1.2;

    if (isCircle && (!isRect || radiusStdDev / avgRadius < 0.08)) {
        let circlePts = [];
        const steps = 48;
        for (let i = 0; i <= steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            circlePts.push({
                x: cx + Math.cos(a) * avgRadius,
                y: cy + Math.sin(a) * avgRadius,
                pressure: 0.5
            });
        }
        stroke.points = circlePts;
        showToast('Forma: Cerchio', '⭕');
        triggerSnapAnimation(pageData);
        return true;
    }

    if (isRect) {
        stroke.points = [
            { x: minX, y: minY, pressure: 0.5 },
            { x: maxX, y: minY, pressure: 0.5 },
            { x: maxX, y: maxY, pressure: 0.5 },
            { x: minX, y: maxY, pressure: 0.5 },
            { x: minX, y: minY, pressure: 0.5 }
        ];
        showToast('Forma: Rettangolo', '⬛');
        triggerSnapAnimation(pageData);
        return true;
    }

    return false;
}

function triggerSnapAnimation(pageData) {
    pageData.wrapper.classList.add('shape-snapped');
    setTimeout(() => pageData.wrapper.classList.remove('shape-snapped'), 250);
}

// ============================================================
// HIGHLIGHTER SNAP (orizzontale / verticale)
// Se il tratto highlighter è quasi orizzontale (|dy|/|dx| < 0.3)
// o quasi verticale, lo raddrizza a y media (o x media).
// ============================================================

function trySnapHighlighter(stroke) {
    const pts = stroke.points;
    if (pts.length < 6) return false;

    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const len = Math.hypot(dx, dy);

    if (len < 80) return false;

    const angle = Math.atan2(dy, dx);
    const absCos = Math.abs(Math.cos(angle));
    const absSin = Math.abs(Math.sin(angle));

    // Quasi orizzontale: |sin| < 0.3 (angolo < ~17°)
    const isHorizontal = absSin < 0.3;
    // Quasi verticale: |cos| < 0.3
    const isVertical = absCos < 0.3;

    if (!isHorizontal && !isVertical) return false;

    const steps = Math.max(8, Math.floor(len / 4));
    const straightPts = [];

    if (isHorizontal) {
        let sumY = 0;
        for (const p of pts) sumY += p.y;
        const avgY = sumY / pts.length;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            straightPts.push({
                x: startPt.x + dx * t,
                y: avgY,
                pressure: 0.5
            });
        }
    } else {
        let sumX = 0;
        for (const p of pts) sumX += p.x;
        const avgX = sumX / pts.length;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            straightPts.push({
                x: avgX,
                y: startPt.y + dy * t,
                pressure: 0.5
            });
        }
    }

    stroke.points = straightPts;
    return true;
}