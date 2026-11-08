// ============================================================
// SCRIBBLE-TO-ERASE
// Distingue scarabocchio (sovrapposizione locale) da scrittura
// (traslazione) tramite metriche indipendenti dall'orientamento:
// - dimensione stretta: solo correzioni piccole (1-2 lettere)
// - return ratio: quanti punti tornano in zone già visitate
// - net ratio 2D: distanza inizio-fine / lunghezza percorso
// ============================================================

const SCRIBBLE_MIN_POINTS = 10;
const SCRIBBLE_MIN_REVERSALS = 5;
const SCRIBBLE_HIT_RADIUS = 20;

const SCRIBBLE_MAX_DURATION_MS = 1200;
const SCRIBBLE_MAX_BBOX_DIAGONAL = 180;
const SCRIBBLE_MAX_PATH_LEN = 1500;
const SCRIBBLE_MIN_AVG_SPEED = 100;

// Return ratio: frazione di punti che cadono in una cella già visitata
// da almeno SCRIBBLE_RETURN_SKIP punti.
const SCRIBBLE_MIN_RETURN_RATIO = 0.40;
const SCRIBBLE_RETURN_RADIUS = 6;
const SCRIBBLE_RETURN_SKIP = 8;

// Net ratio 2D: distanza inizio-fine / lunghezza del percorso.
// - Scarabocchio (qualsiasi inclinazione): ratio basso (0.1-0.3)
// - Scrittura ("molto", "mamma"): ratio alto (0.7-0.9)
const SCRIBBLE_MAX_NET_RATIO_2D = 0.45;

const SCRIBBLE_RESAMPLE_DIST = 2.0;

// Debug: apri con ?scribble=1 per vedere i valori in console.
const _DEBUG_SCRIBBLE = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('scribble');

let _lastScribbleTargetCheck = 0;

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

function computeReturnRatio(sampled, cellSize, skip) {
    const n = sampled.length;
    if (n < skip + 1) return 0;
    const cells = new Map();
    let returns = 0;

    for (let i = 0; i < n; i++) {
        const p = sampled[i];
        const cx = Math.floor(p.x / cellSize);
        const cy = Math.floor(p.y / cellSize);

        let hasReturn = false;
        for (let dx = -1; dx <= 1 && !hasReturn; dx++) {
            for (let dy = -1; dy <= 1 && !hasReturn; dy++) {
                const key = (cx + dx) + ',' + (cy + dy);
                const prevIdx = cells.get(key);
                if (prevIdx !== undefined && i - prevIdx >= skip) {
                    hasReturn = true;
                }
            }
        }
        if (hasReturn) returns++;

        cells.set(cx + ',' + cy, i);
    }
    return returns / n;
}

function computeNetRatio2D(sampled) {
    if (sampled.length < 2) return 1;
    const start = sampled[0];
    const end = sampled[sampled.length - 1];
    let pathLen = 0;
    for (let i = 1; i < sampled.length; i++) {
        pathLen += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
    }
    if (pathLen < 1) return 1;
    return Math.hypot(end.x - start.x, end.y - start.y) / pathLen;
}

function isScribbleShape(pts, durationMs) {
    if (pts.length < SCRIBBLE_MIN_POINTS) return false;
    if (!durationMs || durationMs > SCRIBBLE_MAX_DURATION_MS) {
        if (_DEBUG_SCRIBBLE) console.log('[scribble] FAIL duration', durationMs);
        return false;
    }

    const sampled = resamplePoints(pts);
    if (sampled.length < SCRIBBLE_MIN_POINTS) return false;

    let reversalCount = 0;
    let pathLen = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

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

    const durationSec = durationMs / 1000;
    const avgSpeed = durationSec > 0 ? pathLen / durationSec : 0;

    const returnRatio = computeReturnRatio(sampled, SCRIBBLE_RETURN_RADIUS, SCRIBBLE_RETURN_SKIP);
    const netRatio2D = computeNetRatio2D(sampled);

    if (_DEBUG_SCRIBBLE) {
        console.log('[scribble]', {
            points: pts.length,
            sampled: sampled.length,
            bboxDiag: bboxDiag.toFixed(1),
            pathLen: pathLen.toFixed(1),
            durationMs: durationMs.toFixed(0),
            avgSpeed: avgSpeed.toFixed(0),
            reversalCount,
            returnRatio: returnRatio.toFixed(2),
            netRatio2D: netRatio2D.toFixed(2)
        });
    }

    // Filtri economici
    if (bboxDiag < 15) return false;
    if (bboxDiag > SCRIBBLE_MAX_BBOX_DIAGONAL) {
        if (_DEBUG_SCRIBBLE) console.log('  → FAIL bbox too big');
        return false;
    }
    if (pathLen > SCRIBBLE_MAX_PATH_LEN) return false;
    if (reversalCount < SCRIBBLE_MIN_REVERSALS) {
        if (_DEBUG_SCRIBBLE) console.log('  → FAIL too few reversals');
        return false;
    }
    if (avgSpeed < SCRIBBLE_MIN_AVG_SPEED) {
        if (_DEBUG_SCRIBBLE) console.log('  → FAIL too slow');
        return false;
    }

    // Filtro 1: return ratio (sovrapposizione)
    if (returnRatio < SCRIBBLE_MIN_RETURN_RATIO) {
        if (_DEBUG_SCRIBBLE) console.log('  → FAIL return ratio low');
        return false;
    }

    // Filtro 2: net ratio 2D (avanzamento vs ritorno al punto di partenza)
    if (netRatio2D > SCRIBBLE_MAX_NET_RATIO_2D) {
        if (_DEBUG_SCRIBBLE) console.log('  → FAIL net ratio 2D high');
        return false;
    }

    if (_DEBUG_SCRIBBLE) console.log('  → MATCH');
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
        if (pts.length % 3 !== 0) return;
        if (!isScribbleShape(pts, durationMs)) return;
        appState.scribbleMode = true;
        appState.scribbleTargets = findStrokesIntersectingScribble(pts, pageData);
        _lastScribbleTargetCheck = pts.length;
        // Target evidenziati sul page canvas
        redrawPageCanvas(pageData);
        // Path scribble sull'overlay
        clearOverlay(pageData);
        drawScribblePathOnOverlay(pageData);
    } else {
        if (pts.length - _lastScribbleTargetCheck < 15) return;
        _lastScribbleTargetCheck = pts.length;
        const newTargets = findStrokesIntersectingScribble(pts, pageData);
        if (newTargets.length !== appState.scribbleTargets.length) {
            appState.scribbleTargets = newTargets;
            redrawPageCanvas(pageData);
            clearOverlay(pageData);
            drawScribblePathOnOverlay(pageData);
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
    clearOverlay(pageData);
    return true;
}