// ============================================================
// SCRIBBLE-TO-ERASE
// Riconosce uno scarabocchio a zig-zag durante il disegno
// e cancella gli stroke che interseca.
//
// Comportamento target: piccoli movimenti oscillatori molto rapidi,
// come quando si cancella con la penna sul quaderno coprendo le lettere.
// ============================================================

const SCRIBBLE_MIN_POINTS = 8;
const SCRIBBLE_MIN_REVERSALS = 4;
const SCRIBBLE_MIN_PATH_RATIO = 2.0;
const SCRIBBLE_MIN_REVERSAL_DENSITY = 0.05;
const SCRIBBLE_HIT_RADIUS = 20;

const SCRIBBLE_MAX_DURATION_MS = 1500;
const SCRIBBLE_MAX_BBOX_DIAGONAL = 400;
const SCRIBBLE_MAX_PATH_LEN = 4000;
const SCRIBBLE_MIN_REVERSAL_RATE = 2.5;
const SCRIBBLE_MIN_AVG_SPEED = 100;

// Distanza minima tra punti per il resampling.
// Con batching rAF + coalesced events, i punti possono essere molto
// ravvicinati (0.5-1.5px): il resampling li riduce a 2px, rendendo
// stabile il conteggio delle inversioni.
const SCRIBBLE_RESAMPLE_DIST = 2.0;

let _lastScribbleTargetCheck = 0;

// Sottoinsieme dei punti in cui ognuno è almeno SCRIBBLE_RESAMPLE_DIST px
// dal precedente. Include sempre il primo e l'ultimo punto.
function resamplePoints(pts) {
    if (pts.length === 0) return [];
    const out = [pts[0]];
    let last = pts[0];
    for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= SCRIBBLE_RESAMPLE_DIST) {
            out.push(p);
            last = p;
        }
    }
    const lastOrig = pts[pts.length - 1];
    if (out[out.length - 1] !== lastOrig) {
        out.push(lastOrig);
    }
    return out;
}

function isScribbleShape(pts, durationMs) {
    if (pts.length < SCRIBBLE_MIN_POINTS) return false;
    if (!durationMs || durationMs > SCRIBBLE_MAX_DURATION_MS) return false;

    // Resampling per stabilizzare il conteggio delle inversioni.
    const sampled = resamplePoints(pts);
    if (sampled.length < SCRIBBLE_MIN_POINTS) return false;

    let reversalCount = 0;
    let pathLen = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const start = sampled[0];
    const end = sampled[sampled.length - 1];

    for (let i = 0; i < sampled.length; i++) {
        const p = sampled[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;

        if (i > 0) {
            pathLen += Math.hypot(p.x - sampled[i - 1].x, p.y - sampled[i - 1].y);
        }
        if (i >= 2) {
            const v1x = sampled[i - 1].x - sampled[i - 2].x;
            const v1y = sampled[i - 1].y - sampled[i - 2].y;
            const v2x = sampled[i].x - sampled[i - 1].x;
            const v2y = sampled[i].y - sampled[i - 1].y;
            // Prodotto scalare negativo = inversione (angolo > 90°)
            if (v1x * v2x + v1y * v2y < 0) reversalCount++;
        }
    }

    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const bboxDiag = Math.hypot(bboxW, bboxH);
    if (bboxDiag > SCRIBBLE_MAX_BBOX_DIAGONAL) return false;

    if (pathLen > SCRIBBLE_MAX_PATH_LEN) return false;
    if (reversalCount < SCRIBBLE_MIN_REVERSALS) return false;

    const durationSec = durationMs / 1000;
    if (durationSec <= 0) return false;
    const avgSpeed = pathLen / durationSec;
    if (avgSpeed < SCRIBBLE_MIN_AVG_SPEED) return false;

    const reversalRate = reversalCount / durationSec;
    if (reversalRate < SCRIBBLE_MIN_REVERSAL_RATE) return false;

    const chordLen = Math.hypot(end.x - start.x, end.y - start.y);
    if (chordLen < 5) {
        // Cerchio/loop: richiediamo più inversioni per non confonderlo con uno scribble
        return reversalCount >= 6;
    }

    const pathRatio = pathLen / chordLen;
    const reversalDensity = reversalCount / (sampled.length - 1);

    return pathRatio >= SCRIBBLE_MIN_PATH_RATIO
        && reversalDensity >= SCRIBBLE_MIN_REVERSAL_DENSITY;
}

function checkForScribble(pageData) {
    if (!appState.currentStroke) return;
    if (appState.activeTool === 'eraser' || appState.activeTool === 'lasso') return;

    const pts = appState.currentStroke.points;
    if (pts.length < SCRIBBLE_MIN_POINTS) return;

    const startTime = appState.currentStroke.startTime || performance.now();
    const durationMs = performance.now() - startTime;

    if (!appState.scribbleMode) {
        // Check ogni 2 punti (era 3): scatta prima sui gesti brevi.
        if (pts.length % 2 !== 0) return;
        if (!isScribbleShape(pts, durationMs)) return;
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

    const targets = findStrokesIntersectingScribble(
        appState.currentStroke ? appState.currentStroke.points : [],
        pageData
    );

    if (targets.length > 0) {
        pageData.strokes = pageData.strokes.filter(s => !targets.includes(s));
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

    redrawPageCanvas(pageData);
    return true;
}