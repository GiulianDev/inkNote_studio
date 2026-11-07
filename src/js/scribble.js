// ============================================================
// SCRIBBLE-TO-ERASE
// Riconosce uno scarabocchio a zig-zag durante il disegno
// e cancella gli stroke che interseca.
//
// Comportamento target: piccoli movimenti oscillatori molto rapidi,
// come quando si cancella con la penna sul quaderno coprendo le lettere.
// Distinzione critica: lo scarabocchio si auto-interseca (ripassa su sé
// stesso), la scrittura trasla (una "m" ha direzione, non si sovrappone).
// ============================================================

const SCRIBBLE_MIN_POINTS = 10;
const SCRIBBLE_MIN_REVERSALS = 5;
const SCRIBBLE_MIN_PATH_RATIO = 3.0;
const SCRIBBLE_MIN_REVERSAL_DENSITY = 0.06;
const SCRIBBLE_HIT_RADIUS = 20;

const SCRIBBLE_MAX_DURATION_MS = 1500;
const SCRIBBLE_MAX_BBOX_DIAGONAL = 400;
const SCRIBBLE_MAX_PATH_LEN = 4000;
const SCRIBBLE_MIN_REVERSAL_RATE = 2.5;
const SCRIBBLE_MIN_AVG_SPEED = 100;

// NUOVI: distinguono scarabocchio (compatto, auto-intersecante) da
// scrittura (allungata, con traslazione netta).
const SCRIBBLE_MAX_ASPECT_RATIO = 4.0;
const SCRIBBLE_MIN_SELF_INTERSECTIONS = 3;
const SCRIBBLE_SELF_INTERSECT_SKIP = 5;
const SCRIBBLE_SELF_INTERSECT_WINDOW = 30;
const SCRIBBLE_SELF_INTERSECT_DIST = 3.0;

// Distanza minima tra punti per il resampling.
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

// Conta quante volte il path ripassa vicino a sé stesso.
// Confronta punti distanti temporalmente (almeno SKIP passi) ma vicini
// spazialmente. Nella "m" le gambe sono vicine ma non si sovrappongono;
// nello scarabocchio ogni passaggio ripassa sui precedenti.
function countSelfIntersections(sampled) {
    const n = sampled.length;
    const skip = SCRIBBLE_SELF_INTERSECT_SKIP;
    if (n < skip + 2) return 0;

    const distSq = SCRIBBLE_SELF_INTERSECT_DIST * SCRIBBLE_SELF_INTERSECT_DIST;
    const window = SCRIBBLE_SELF_INTERSECT_WINDOW;
    const earlyExit = SCRIBBLE_MIN_SELF_INTERSECTIONS * 2;

    let count = 0;
    for (let i = 0; i < n - skip - 1; i++) {
        const pi = sampled[i];
        const maxJ = Math.min(n, i + skip + window);
        for (let j = i + skip; j < maxJ; j++) {
            const pj = sampled[j];
            const dx = pi.x - pj.x;
            const dy = pi.y - pj.y;
            if (dx * dx + dy * dy < distSq) {
                count++;
                if (count >= earlyExit) return count;
            }
        }
    }
    return count;
}

function isScribbleShape(pts, durationMs) {
    if (pts.length < SCRIBBLE_MIN_POINTS) return false;
    if (!durationMs || durationMs > SCRIBBLE_MAX_DURATION_MS) return false;

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
        // Cerchio/loop: richiediamo più inversioni e self-intersection
        if (reversalCount < 6) return false;
        const loopIntersections = countSelfIntersections(sampled);
        return loopIntersections >= SCRIBBLE_MIN_SELF_INTERSECTIONS;
    }

    const pathRatio = pathLen / chordLen;
    if (pathRatio < SCRIBBLE_MIN_PATH_RATIO) return false;

    const reversalDensity = reversalCount / (sampled.length - 1);
    if (reversalDensity < SCRIBBLE_MIN_REVERSAL_DENSITY) return false;

    // NUOVO: aspect ratio del bbox. La "m" è allungata orizzontalmente
    // (bboxW/bboxH ≈ 2-3), lo scarabocchio è compatto (≈ 1).
    const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));
    if (aspect > SCRIBBLE_MAX_ASPECT_RATIO) return false;

    // NUOVO: self-intersection. Costoso, eseguito solo sui candidati.
    const selfIntersections = countSelfIntersections(sampled);
    if (selfIntersections < SCRIBBLE_MIN_SELF_INTERSECTIONS) return false;

    return true;
}

function checkForScribble(pageData) {
    if (!appState.currentStroke) return;
    if (appState.activeTool === 'eraser' || appState.activeTool === 'lasso') return;

    const pts = appState.currentStroke.points;
    if (pts.length < SCRIBBLE_MIN_POINTS) return;

    const startTime = appState.currentStroke.startTime || performance.now();
    const durationMs = performance.now() - startTime;

    if (!appState.scribbleMode) {
        // Check ogni 3 punti (era 2): il check self-intersection è costoso,
        // meglio non eseguirlo a ogni punto.
        if (pts.length % 3 !== 0) return;
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