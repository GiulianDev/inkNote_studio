// ============================================================
// SCRIBBLE-TO-ERASE
// Riconosce uno scarabocchio a zig-zag durante il disegno
// e cancella gli stroke che interseca.
// ============================================================

const SCRIBBLE_MIN_POINTS = 12;
const SCRIBBLE_MIN_REVERSALS = 4;
const SCRIBBLE_MIN_PATH_RATIO = 2.5;
const SCRIBBLE_MIN_REVERSAL_DENSITY = 0.15;
const SCRIBBLE_HIT_RADIUS = 20; // px canvas

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

function checkForScribble(pageData) {
    if (appState.scribbleMode) return;
    if (!appState.currentStroke) return;
    if (appState.activeTool === 'eraser' || appState.activeTool === 'lasso') return;

    const pts = appState.currentStroke.points;
    if (pts.length < SCRIBBLE_MIN_POINTS) return;

    // D: check ogni 10 punti invece di ogni 3 (O(n²) → O(n²/3.3))
    if (pts.length % 10 !== 0) return;

    if (!isScribbleShape(pts)) return;

    appState.scribbleMode = true;
    redrawPageCanvas(pageData);
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
    return true;
}