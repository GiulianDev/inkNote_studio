// ============================================================
// SCRIBBLE-TO-ERASE
// Riconosce uno scarabocchio a zig-zag durante il disegno
// e cancella gli stroke che interseca.
// ============================================================

const SCRIBBLE_MIN_POINTS = 12;
const SCRIBBLE_MIN_REVERSALS = 4;
const SCRIBBLE_MIN_PATH_RATIO = 2.5;
const SCRIBBLE_MIN_REVERSAL_DENSITY = 0.15;
const SCRIBBLE_HIT_RADIUS = 20;

// Contatore per ricalcolare i target ogni N punti durante lo scribble.
let _lastScribbleTargetCheck = 0;

function isScribbleShape(pts) {
    if (pts.length < SCRIBBLE_MIN_POINTS) return false;

    let reversalCount = 0;
    let pathLen = 0;
    const start = pts[0];
    const end = pts[pts.length - 1];

    for (let i = 1; i < pts.length; i++) {
        pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (i >= 2) {
            const v1x = pts[i - 1].x - pts[i - 2].x;
            const v1y = pts[i - 1].y - pts[i - 2].y;
            const v2x = pts[i].x - pts[i - 1].x;
            const v2y = pts[i].y - pts[i - 1].y;
            if (Math.hypot(v1x, v1y) > 1 && Math.hypot(v2x, v2y) > 1) {
                if (v1x * v2x + v1y * v2y < 0) reversalCount++;
            }
        }
    }

    if (reversalCount < SCRIBBLE_MIN_REVERSALS) return false;

    const chordLen = Math.hypot(end.x - start.x, end.y - start.y);
    if (chordLen < 5) {
        return reversalCount >= 6;
    }

    const pathRatio = pathLen / chordLen;
    const reversalDensity = reversalCount / (pts.length - 1);

    return pathRatio >= SCRIBBLE_MIN_PATH_RATIO
        && reversalDensity >= SCRIBBLE_MIN_REVERSAL_DENSITY;
}

// FIX: al rilevamento iniziale calcola subito i target e li salva in
// appState.scribbleTargets (così redrawPageCanvas li evidenzia in rosso).
// Durante lo scribble, ricalcola ogni 15 punti per aggiornare i target
// se il gesto si estende su altri stroke.
function checkForScribble(pageData) {
    if (!appState.currentStroke) return;
    if (appState.activeTool === 'eraser' || appState.activeTool === 'lasso') return;

    const pts = appState.currentStroke.points;
    if (pts.length < SCRIBBLE_MIN_POINTS) return;

    if (!appState.scribbleMode) {
        if (pts.length % 3 !== 0) return;
        if (!isScribbleShape(pts)) return;
        appState.scribbleMode = true;
        appState.scribbleTargets = findStrokesIntersectingScribble(pts, pageData);
        _lastScribbleTargetCheck = pts.length;
        redrawPageCanvas(pageData);
    } else {
        if (pts.length - _lastScribbleTargetCheck < 15) return;
        _lastScribbleTargetCheck = pts.length;
        const newTargets = findStrokesIntersectingScribble(pts, pageData);
        if (newTargets.length !== appState.scribbleTargets.length) {
            appState.scribbleTargets = newTargets;
            redrawPageCanvas(pageData);
        }
    }
}

function findStrokesIntersectingScribble(scribblePoints, pageData) {
    if (scribblePoints.length === 0 || pageData.strokes.length === 0) return [];

    let sbMinX = Infinity, sbMaxX = -Infinity, sbMinY = Infinity, sbMaxY = -Infinity;
    for (const p of scribblePoints) {
        if (p.x < sbMinX) sbMinX = p.x;
        if (p.x > sbMaxX) sbMaxX = p.x;
        if (p.y < sbMinY) sbMinY = p.y;
        if (p.y > sbMaxY) sbMaxY = p.y;
    }
    const pad = SCRIBBLE_HIT_RADIUS;
    sbMinX -= pad; sbMaxX += pad; sbMinY -= pad; sbMaxY += pad;

    const targets = [];
    for (const stroke of pageData.strokes) {
        let stMinX = Infinity, stMaxX = -Infinity, stMinY = Infinity, stMaxY = -Infinity;
        for (const p of stroke.points) {
            if (p.x < stMinX) stMinX = p.x;
            if (p.x > stMaxX) stMaxX = p.x;
            if (p.y < stMinY) stMinY = p.y;
            if (p.y > stMaxY) stMaxY = p.y;
        }
        if (stMaxX < sbMinX || stMinX > sbMaxX || stMaxY < sbMinY || stMinY > sbMaxY) {
            continue;
        }

        let hit = false;
        for (const sp of stroke.points) {
            for (const xp of scribblePoints) {
                if (Math.hypot(sp.x - xp.x, sp.y - xp.y) < SCRIBBLE_HIT_RADIUS) {
                    hit = true;
                    break;
                }
            }
            if (hit) break;
        }
        if (hit) targets.push(stroke);
    }
    return targets;
}

function finalizeScribble(pageData) {
    if (!appState.scribbleMode) return false;

    // Ricalcola i target sull'intero path per essere sicuri di averli tutti,
    // anche se il gesto è proseguito oltre l'ultimo check periodico.
    const targets = findStrokesIntersectingScribble(
        appState.currentStroke ? appState.currentStroke.points : [],
        pageData
    );

    if (targets.length > 0) {
        pageData.strokes = pageData.strokes.filter(s => !targets.includes(s));
        redrawPageCanvas(pageData);
        autoSaveTrigger();
        pushHistory();
        showToast(
            targets.length === 1
                ? 'Tratto cancellato'
                : `${targets.length} tratti cancellati`,
            '🧹'
        );
    }

    appState.scribbleMode = false;
    appState.scribbleTargets = [];
    _lastScribbleTargetCheck = 0;
    return true;
}