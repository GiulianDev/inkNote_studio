// ============================================================
// SCRIBBLE-TO-ERASE
// Riconosce uno scarabocchio a zig-zag durante il disegno
// e cancella gli stroke che interseca.
//
// Vincoli per evitare falsi positivi durante la scrittura:
// - durata breve (uno scribble è rapido)
// - dimensione contenuta (uno scribble è piccolo)
// - densità di inversioni alta (zigzag serrato)
// - velocità media alta
// ============================================================

const SCRIBBLE_MIN_POINTS = 12;
const SCRIBBLE_MIN_REVERSALS = 6;               // era 4
const SCRIBBLE_MIN_PATH_RATIO = 3.0;            // era 2.5
const SCRIBBLE_MIN_REVERSAL_DENSITY = 0.20;     // era 0.15
const SCRIBBLE_HIT_RADIUS = 20;

// Nuovi vincoli
const SCRIBBLE_MAX_DURATION_MS = 700;           // gesto molto rapido
const SCRIBBLE_MAX_BBOX_DIAGONAL = 320;         // bbox massimo (px canvas)
const SCRIBBLE_MAX_PATH_LEN = 2500;             // lunghezza massima del gesto
const SCRIBBLE_MIN_REVERSAL_RATE = 12;          // inversioni al secondo
const SCRIBBLE_MIN_AVG_SPEED = 400;             // px/s minimo (veloce)

let _lastScribbleTargetCheck = 0;

// pts: punti dello stroke
// durationMs: durata dall'inizio del gesto
function isScribbleShape(pts, durationMs) {
    if (pts.length < SCRIBBLE_MIN_POINTS) return false;

    // Vincolo temporale: lo scribble è molto rapido
    if (!durationMs || durationMs > SCRIBBLE_MAX_DURATION_MS) return false;

    let reversalCount = 0;
    let pathLen = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const start = pts[0];
    const end = pts[pts.length - 1];

    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;

        if (i > 0) {
            pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
        }
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

    // Vincolo dimensione: bbox contenuto
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const bboxDiag = Math.hypot(bboxW, bboxH);
    if (bboxDiag > SCRIBBLE_MAX_BBOX_DIAGONAL) return false;

    // Vincolo lunghezza path
    if (pathLen > SCRIBBLE_MAX_PATH_LEN) return false;

    if (reversalCount < SCRIBBLE_MIN_REVERSALS) return false;

    // Velocità media: uno scribble è veloce
    const durationSec = durationMs / 1000;
    if (durationSec <= 0) return false;
    const avgSpeed = pathLen / durationSec;
    if (avgSpeed < SCRIBBLE_MIN_AVG_SPEED) return false;

    // Rate di inversioni: uno scribble è "serrato"
    const reversalRate = reversalCount / durationSec;
    if (reversalRate < SCRIBBLE_MIN_REVERSAL_RATE) return false;

    const chordLen = Math.hypot(end.x - start.x, end.y - start.y);
    if (chordLen < 5) {
        return reversalCount >= 8;   // era 6
    }

    const pathRatio = pathLen / chordLen;
    const reversalDensity = reversalCount / (pts.length - 1);

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

// FIX: SEMPRE redrawPageCanvas alla fine, anche quando non ci sono target.
// Prima, se non c'erano target, il path rosso rimaneva visibile sul canvas.
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

    // Reset stato PRIMA del redraw, così il path scribble non viene ridisegnato
    appState.scribbleMode = false;
    appState.scribbleTargets = [];
    _lastScribbleTargetCheck = 0;

    redrawPageCanvas(pageData);
    return true;
}