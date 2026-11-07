// ============================================================
// SCRIBBLE-TO-ERASE
// Riconosce uno scarabocchio a zig-zag durante il disegno
// e cancella gli stroke che interseca.
//
// Distinzione chiave:
// - Scarabocchio: l'utente ripassa nella stessa zona. Baricentri dei
//   quarti temporali vicini, chordLen inizio-fine piccola rispetto al bbox.
// - Scrittura: il tratto trasla. Anche se ha inversioni (la "m" ne ha),
//   i baricentri avanzano e inizio-fine sono lontani.
// ============================================================

const SCRIBBLE_MIN_POINTS = 10;
const SCRIBBLE_MIN_REVERSALS = 5;
const SCRIBBLE_MIN_REVERSAL_DENSITY = 0.06;
const SCRIBBLE_HIT_RADIUS = 20;

const SCRIBBLE_MAX_DURATION_MS = 1500;
const SCRIBBLE_MAX_BBOX_DIAGONAL = 400;
const SCRIBBLE_MAX_PATH_LEN = 4000;
const SCRIBBLE_MIN_REVERSAL_RATE = 2.5;
const SCRIBBLE_MIN_AVG_SPEED = 100;

// Range pathRatio: troppo basso → linea/lettera semplice,
// troppo alto → cerchio o loop che torna su sé stesso in modo regolare.
const SCRIBBLE_MIN_PATH_RATIO = 3.0;
const SCRIBBLE_MAX_PATH_RATIO = 15.0;

// Distanza inizio-fine rispetto alla diagonale del bbox.
// Nella "m" inizio e fine sono lontani (0.5-0.8); nello scarabocchio
// vicini (0.1-0.3).
const SCRIBBLE_MAX_CHORD_RATIO = 0.5;

// Progressione dei baricentri: somma delle distanze tra baricentri di
// quarti temporali consecutivi, diviso la diagonale del bbox.
// Nella "m" i baricentri avanzano (0.4-0.7); nello scarabocchio
// oscillano intorno allo stesso punto (0.1-0.25).
const SCRIBBLE_MAX_PROGRESSION_RATIO = 0.35;
const SCRIBBLE_PROGRESSION_BUCKETS = 5;

const SCRIBBLE_RESAMPLE_DIST = 2.0;

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

// Divide i punti in N bucket temporali (uguali per numero di punti) e
// calcola il baricentro di ciascuno.
function computeBucketCentroids(sampled, buckets) {
    const n = sampled.length;
    const centroids = [];
    for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * n / buckets);
        const end = Math.floor((b + 1) * n / buckets);
        if (end <= start) continue;
        let sx = 0, sy = 0;
        for (let i = start; i < end; i++) {
            sx += sampled[i].x;
            sy += sampled[i].y;
        }
        const count = end - start;
        centroids.push({ x: sx / count, y: sy / count });
    }
    return centroids;
}

// Somma delle distanze tra baricentri consecutivi.
function computeProgressionDistance(centroids) {
    let total = 0;
    for (let i = 1; i < centroids.length; i++) {
        const dx = centroids[i].x - centroids[i - 1].x;
        const dy = centroids[i].y - centroids[i - 1].y;
        total += Math.hypot(dx, dy);
    }
    return total;
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

    // Filtri economici
    if (bboxDiag < 20) return false;                       // troppo piccolo
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

    // Filtro chordRatio: nello scarabocchio si torna vicino all'inizio.
    // Esclude "m", "mm", parole scritte (dove la penna avanza).
    const chordRatio = chordLen / bboxDiag;
    if (chordRatio > SCRIBBLE_MAX_CHORD_RATIO) return false;

    // Filtro pathRatio: range tra 3 e 15.
    // < 3 → linea o lettera semplice
    // > 15 → cerchio/loop regolare (inizio e fine coincidono, ma path
    //        percorso una volta sola con andamento circolare)
    const pathRatio = pathLen / Math.max(chordLen, 1);
    if (pathRatio < SCRIBBLE_MIN_PATH_RATIO) return false;
    if (pathRatio > SCRIBBLE_MAX_PATH_RATIO) return false;

    // Filtro densità di inversioni
    const reversalDensity = reversalCount / (sampled.length - 1);
    if (reversalDensity < SCRIBBLE_MIN_REVERSAL_DENSITY) return false;

    // Filtro progressione baricentri: la penna non deve avanzare.
    // Nella "m" i baricentri si spostano in avanti (ratio alto);
    // nello scarabocchio oscillano intorno allo stesso punto (ratio basso).
    const centroids = computeBucketCentroids(sampled, SCRIBBLE_PROGRESSION_BUCKETS);
    if (centroids.length < 2) return false;
    const progression = computeProgressionDistance(centroids);
    const progressionRatio = progression / bboxDiag;
    if (progressionRatio > SCRIBBLE_MAX_PROGRESSION_RATIO) return false;

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