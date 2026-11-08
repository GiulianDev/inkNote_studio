// ============================================================
// RENDERING CANVAS CON GESTIONE PRESSIONE + CURVE LISCE
// ============================================================

const SCRIBBLE_ERASE_COLOR = 'rgba(220, 38, 38, 0.6)';
const SCRIBBLE_TARGET_COLOR = 'rgba(239, 68, 68, 0.75)';

let _bgCache = { key: null, canvas: null };

// Buffer riutilizzabili per evitare allocazioni per punto
const _ptA = { x: 0, y: 0 };
const _ptB = { x: 0, y: 0 };

function getTiltNorm(pt) {
    if (!pt || (!pt.tiltX && !pt.tiltY)) return 0;
    return Math.min(1, Math.hypot(pt.tiltX || 0, pt.tiltY || 0) / 30);
}

function getSpeedNorm(pt) {
    if (!pt || !pt.speed) return 0;
    return Math.min(1, pt.speed / 8);
}

function getTaper(idx, tool) {
    if (tool !== 'pen' && tool !== 'pencil') return 1.0;
    if (idx === 0) return 1.4;
    if (idx === 1) return 1.15;
    return 1.0;
}

// Firma compatibile: precomputedBaseSize opzionale come ultimo param.
function computeStrokeWidth(tool, rawSize, pressure, tiltNorm = 0, speedNorm = 0, taper = 1.0, precomputedBaseSize = null) {
    const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));
    const baseSize = precomputedBaseSize !== null ? precomputedBaseSize : sliderToBaseSize(rawSize);
    let w = baseSize;

    if (tool === 'pen' || tool === 'pencil') {
        const params = getPressureParams();
        const range = params.heavyMul - params.lightMul;
        w = baseSize * (params.lightMul + Math.pow(p, params.curve) * range);
        if (tool === 'pen') {
            w *= (1 + tiltNorm * 0.15);
            w *= (1 - speedNorm * 0.25);
        } else {
            w *= (1 + tiltNorm * 1.5);
            w *= (1 - speedNorm * 0.4);
        }
    } else if (tool === 'marker') {
        w = baseSize * (1.2 + p * 1.0);
        w *= (1 + tiltNorm * 0.50);
        w *= (1 - speedNorm * 0.15);
    } else if (tool === 'highlighter') {
        w = baseSize * 4.0;
    }

    w *= taper;
    return w;
}

// FASE 1: stile cachato per stroke, evitando hexToRgbA/getEffectiveColor
// a ogni chiamata di rendering.
function getStrokeStyle(stroke, isDark) {
    const key = isDark ? 'dark' : 'light';
    const cache = stroke._styleCache;
    if (cache && cache.key === key) return cache;

    let strokeStyle, fillStyle, gco;
    if (stroke.tool === 'highlighter') {
        gco = isDark ? 'screen' : 'multiply';
        const c = hexToRgbA(stroke.color, isDark ? 0.55 : 0.40);
        strokeStyle = c; fillStyle = c;
    } else if (stroke.tool === 'pencil') {
        gco = 'source-over';
        const c = hexToRgbA(getEffectiveColor(stroke.color, isDark), 0.55);
        strokeStyle = c; fillStyle = c;
    } else {
        gco = 'source-over';
        const c = getEffectiveColor(stroke.color, isDark);
        strokeStyle = c; fillStyle = c;
    }

    const result = { key, strokeStyle, fillStyle, gco };
    stroke._styleCache = result;
    return result;
}

function setupStrokeStyle(ctx, stroke, forceTargetDark) {
    const s = getStrokeStyle(stroke, forceTargetDark);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = s.gco;
    ctx.strokeStyle = s.strokeStyle;
    ctx.fillStyle = s.fillStyle;
}

// FASE 1: fill unificabili per pen e marker (alpha=1, source-over).
// Pencil e highlighter usano alpha compositing: fill separati.
function canUnifyFill(tool) {
    return tool === 'pen' || tool === 'marker';
}

// Aggiunge un poligono di segmento al path corrente (senza fill).
// Usa moveTo per iniziare un nuovo subpath, così più segmenti possono
// accumularsi nello stesso path con un singolo fill.
function addTaperedSegmentPolygon(ctx, p0, p1, w0, w1) {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return;

    const nx = -dy / len;
    const ny = dx / len;
    const hw0 = Math.max(w0, 0.5) / 2;
    const hw1 = Math.max(w1, 0.5) / 2;

    ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
    ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
    ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
    ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
    ctx.closePath();
}

// Aggiunge un cerchio di raccordo al path corrente (senza fill).
function addTaperedSegmentCircle(ctx, p0, w0) {
    const hw0 = Math.max(w0, 0.5) / 2;
    ctx.moveTo(p0.x + hw0, p0.y);
    ctx.arc(p0.x, p0.y, hw0, 0, Math.PI * 2);
}

// FASE 1: interpolazione con out-param, nessuna allocazione.
function interpolatePointInto(out, p0, p1, p2, p3, t, smoothness) {
    const lx = p1.x + (p2.x - p1.x) * t;
    const ly = p1.y + (p2.y - p1.y) * t;
    if (smoothness <= 0.01) {
        out.x = lx; out.y = ly;
        return;
    }

    const t2 = t * t;
    const t3 = t2 * t;
    const cx = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
    const cy = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

    out.x = lx + (cx - lx) * smoothness;
    out.y = ly + (cy - ly) * smoothness;
}

// Versione con allocazione, usata dai path non-critical (drawFinalSegmentOnly).
function interpolatePoint(p0, p1, p2, p3, t, smoothness) {
    const o = { x: 0, y: 0 };
    interpolatePointInto(o, p0, p1, p2, p3, t, smoothness);
    return o;
}

// Segmento con fill separati (usato per pencil, highlighter, e in
// drawFinalSegmentOnly). Firma invariata.
function drawTaperedSegment(ctx, p0, p1, w0, w1) {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);

    if (len < 0.01) {
        const w = Math.max((w0 + w1) / 2, 0.5);
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    const nx = -dy / len;
    const ny = dx / len;
    const hw0 = Math.max(w0, 0.5) / 2;
    const hw1 = Math.max(w1, 0.5) / 2;

    ctx.beginPath();
    ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
    ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
    ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
    ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p0.x, p0.y, hw0, 0, Math.PI * 2);
    ctx.fill();
}

function redrawPageCanvas(pageData, forceTargetDark = appState.isDarkMode) {
    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pageData.canvas.width, pageData.canvas.height);
    ctx.scale(dpr, dpr);

    drawPaperBackground(ctx, forceTargetDark, dpr);

    const targetSet = (appState.scribbleMode && appState.scribbleTargets)
        ? new Set(appState.scribbleTargets)
        : null;

    pageData.strokes.forEach(stroke => {
        const isTarget = targetSet && targetSet.has(stroke);
        renderFullStroke(ctx, stroke, forceTargetDark, isTarget ? SCRIBBLE_TARGET_COLOR : null);
    });

    ctx.restore();
}

function drawFinalSegmentOnly(pageData, stroke) {
    const pts = stroke.points;
    const n = pts.length;
    if (n < 2) return;

    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setupStrokeStyle(ctx, stroke, appState.isDarkMode);

    const smoothness = appState.smoothing;
    const baseSize = sliderToBaseSize(stroke.size);
    const i1 = n - 2;
    const i2 = n - 1;
    const p0 = pts[Math.max(0, i1 - 1)];
    const p1 = pts[i1];
    const p2 = pts[i2];
    const p3 = pts[i2];

    const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure, getTiltNorm(p1), getSpeedNorm(p1), getTaper(i1, stroke.tool), baseSize);
    const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, getTiltNorm(p2), getSpeedNorm(p2), getTaper(i2, stroke.tool), baseSize);

    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
    const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));

    for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const sp0 = interpolatePoint(p0, p1, p2, p3, t0, smoothness);
        const sp1 = interpolatePoint(p0, p1, p2, p3, t1, smoothness);
        const sw0 = w1 + (w2 - w1) * t0;
        const sw1 = w1 + (w2 - w1) * t1;
        drawTaperedSegment(ctx, sp0, sp1, sw0, sw1);
    }

    const lastW = Math.max(w2, 0.5);
    ctx.beginPath();
    ctx.arc(p2.x, p2.y, lastW / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

// Disegna un singolo punto (dot). Usato al pointerup quando lo stroke ha
// 1 solo punto (tap breve, tipico dei puntini su "i" e "j").
// Il dot viene disegnato direttamente sul canvas senza passare da
// drawFinalSegmentOnly (che richiede n >= 2).
function drawDotOnly(pageData, stroke) {
    const pts = stroke.points;
    if (pts.length === 0) return;
    const pt = pts[0];

    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setupStrokeStyle(ctx, stroke, appState.isDarkMode);

    const baseSize = sliderToBaseSize(stroke.size);
    const w = computeStrokeWidth(
        stroke.tool, stroke.size, pt.pressure,
        getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize
    );

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function renderFullStroke(ctx, stroke, forceTargetDark, overrideColor = null) {
    const pts = stroke.points;
    const n = pts.length;
    if (n < 1) return;

    // Caso 1 punto: è un dot (es. il puntino sulla "i").
    // Disegna un cerchio pieno alla posizione, con dimensione basata su
    // pressione ma senza taper (che è pensato per il primo punto di uno
    // stroke con movimento).
    if (n === 1) {
        ctx.save();
        if (overrideColor) {
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = overrideColor;
            ctx.fillStyle = overrideColor;
        } else {
            setupStrokeStyle(ctx, stroke, forceTargetDark);
        }
        const baseSize = sliderToBaseSize(stroke.size);
        const pt = pts[0];
        const w = computeStrokeWidth(
            stroke.tool, stroke.size, pt.pressure,
            getTiltNorm(pt), getSpeedNorm(pt), 1.0, baseSize
        );
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(w / 2, 0.6), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
    }

    ctx.save();
    if (overrideColor) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = overrideColor;
        ctx.fillStyle = overrideColor;
    } else {
        setupStrokeStyle(ctx, stroke, forceTargetDark);
    }

    const smoothness = appState.smoothing;
    const baseSize = sliderToBaseSize(stroke.size);
    const widths = new Array(n);
    for (let i = 0; i < n; i++) {
        const pt = pts[i];
        widths[i] = computeStrokeWidth(
            stroke.tool, stroke.size, pt.pressure,
            getTiltNorm(pt), getSpeedNorm(pt), getTaper(i, stroke.tool),
            baseSize
        );
    }

    // Per pen e marker (e per overrideColor, che è monocromatico alpha=1):
    // accumula tutti i poligoni in un unico fill, e tutti i cerchi in un
    // secondo fill. Riduce i fill da ~2×steps×n a 2 per stroke.
    const unified = overrideColor != null || canUnifyFill(stroke.tool);

    if (unified) {
        // Poligoni
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
            const p0 = pts[i >= 2 ? i - 2 : 0];
            const p1 = pts[i - 1];
            const p2 = pts[i];
            const p3 = pts[i + 1 < n ? i + 1 : n - 1];

            const w1 = widths[i - 1];
            const w2 = widths[i];

            const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
            const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));

            for (let s = 0; s < steps; s++) {
                const t0 = s / steps;
                const t1 = (s + 1) / steps;
                interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
                interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
                const sw0 = w1 + (w2 - w1) * t0;
                const sw1 = w1 + (w2 - w1) * t1;
                addTaperedSegmentPolygon(ctx, _ptA, _ptB, sw0, sw1);
            }
        }
        ctx.fill();

        // Cerchi di raccordo
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
            const p0 = pts[i >= 2 ? i - 2 : 0];
            const p1 = pts[i - 1];
            const p2 = pts[i];
            const p3 = pts[i + 1 < n ? i + 1 : n - 1];

            const w1 = widths[i - 1];
            const w2 = widths[i];

            const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
            const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));

            for (let s = 0; s < steps; s++) {
                const t0 = s / steps;
                interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
                const sw0 = w1 + (w2 - w1) * t0;
                addTaperedSegmentCircle(ctx, _ptA, sw0);
            }
        }
        ctx.fill();
    } else {
        // Pencil / highlighter: fill separati per alpha compositing
        for (let i = 1; i < n; i++) {
            const p0 = pts[i >= 2 ? i - 2 : 0];
            const p1 = pts[i - 1];
            const p2 = pts[i];
            const p3 = pts[i + 1 < n ? i + 1 : n - 1];

            const w1 = widths[i - 1];
            const w2 = widths[i];

            const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
            const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));

            for (let s = 0; s < steps; s++) {
                const t0 = s / steps;
                const t1 = (s + 1) / steps;
                interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
                interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
                const sw0 = w1 + (w2 - w1) * t0;
                const sw1 = w1 + (w2 - w1) * t1;
                drawTaperedSegment(ctx, _ptA, _ptB, sw0, sw1);
            }
        }
    }

    const lastW = Math.max(widths[n - 1], 0.5);
    ctx.beginPath();
    ctx.arc(pts[n - 1].x, pts[n - 1].y, lastW / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawIncrementalSegment(ctx, stroke, dpr = 1) {
    const pts = stroke.points;
    const n = pts.length;
    if (n < 3) return;

    const i1 = n - 3;
    const i2 = n - 2;

    const p0 = pts[Math.max(0, i1 - 1)];
    const p1 = pts[i1];
    const p2 = pts[i2];
    const p3 = pts[Math.min(n - 1, i2 + 1)];

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setupStrokeStyle(ctx, stroke, appState.isDarkMode);

    const smoothness = appState.smoothing;
    const baseSize = sliderToBaseSize(stroke.size);
    const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure, getTiltNorm(p1), getSpeedNorm(p1), getTaper(i1, stroke.tool), baseSize);
    const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, getTiltNorm(p2), getSpeedNorm(p2), getTaper(i2, stroke.tool), baseSize);

    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
    const steps = Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));

    const unified = canUnifyFill(stroke.tool);

    if (unified) {
        ctx.beginPath();
        for (let s = 0; s < steps; s++) {
            const t0 = s / steps;
            const t1 = (s + 1) / steps;
            interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
            interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
            const sw0 = w1 + (w2 - w1) * t0;
            const sw1 = w1 + (w2 - w1) * t1;
            addTaperedSegmentPolygon(ctx, _ptA, _ptB, sw0, sw1);
        }
        ctx.fill();

        ctx.beginPath();
        for (let s = 0; s < steps; s++) {
            const t0 = s / steps;
            interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
            const sw0 = w1 + (w2 - w1) * t0;
            addTaperedSegmentCircle(ctx, _ptA, sw0);
        }
        ctx.fill();
    } else {
        for (let s = 0; s < steps; s++) {
            const t0 = s / steps;
            const t1 = (s + 1) / steps;
            interpolatePointInto(_ptA, p0, p1, p2, p3, t0, smoothness);
            interpolatePointInto(_ptB, p0, p1, p2, p3, t1, smoothness);
            const sw0 = w1 + (w2 - w1) * t0;
            const sw1 = w1 + (w2 - w1) * t1;
            drawTaperedSegment(ctx, _ptA, _ptB, sw0, sw1);
        }
    }

    // TIP SEGMENT: solo quando smoothness = 0.
    // Disegna il segmento n-2 → n-1 (l'ultimo punto, la punta della penna)
    // come linea retta. Con smoothness = 0, il prossimo frame disegnerebbe
    // esattamente questa linea (Catmull-Rom con smoothness=0 = lineare),
    // quindi non c'è artefatto: al prossimo evento il segmento coincide.
    // Effetto: l'inchiostro arriva alla punta della penna, non resta 1 punto
    // indietro. Elimina il lag-1 nel caso "no smoothing".
    if (smoothness <= 0.01 && n >= 2) {
        const tipP1 = pts[n - 2];
        const tipP2 = pts[n - 1];
        const tipW1 = computeStrokeWidth(stroke.tool, stroke.size, tipP1.pressure, getTiltNorm(tipP1), getSpeedNorm(tipP1), 1.0, baseSize);
        const tipW2 = computeStrokeWidth(stroke.tool, stroke.size, tipP2.pressure, getTiltNorm(tipP2), getSpeedNorm(tipP2), 1.0, baseSize);

        if (canUnifyFill(stroke.tool)) {
            ctx.beginPath();
            addTaperedSegmentPolygon(ctx, tipP1, tipP2, tipW1, tipW2);
            ctx.fill();
            ctx.beginPath();
            addTaperedSegmentCircle(ctx, tipP1, tipW1);
            ctx.fill();
        } else {
            drawTaperedSegment(ctx, tipP1, tipP2, tipW1, tipW2);
        }
    }

    ctx.restore();
}

function drawScribbleSegment(ctx, stroke, dpr = 1) {
    const pts = stroke.points;
    const n = pts.length;
    if (n < 2) return;
    const p1 = pts[n - 2];
    const p2 = pts[n - 1];

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = SCRIBBLE_ERASE_COLOR;
    ctx.fillStyle = SCRIBBLE_ERASE_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(stroke.size * 2, 4);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
}

function drawPendingShape(ctx, forceTargetDark) {
    const ps = appState.pendingShape;
    if (!ps) return;

    const startPt = ps.start, endPt = ps.end;
    const effectiveColor = getEffectiveColor(ps.color, forceTargetDark);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = effectiveColor;

    const lineW = computeStrokeWidth(ps.tool, ps.size, 0.5);
    ctx.lineWidth = lineW;

    ctx.beginPath();
    ctx.moveTo(startPt.x, startPt.y);
    ctx.lineTo(endPt.x, endPt.y);
    ctx.stroke();

    const handleRadius = 8;
    [startPt, endPt].forEach(pt => {
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 2.5;
        ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });

    const midX = (startPt.x + endPt.x) / 2;
    const midY = (startPt.y + endPt.y) / 2;
    const len = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
    const angle = Math.atan2(endPt.y - startPt.y, endPt.x - startPt.x);
    const angleDeg = Math.round((angle * 180 / Math.PI + 360) % 360);
    const label = `${Math.round(len)}px · ${angleDeg}°`;
    ctx.font = '600 13px Inter, sans-serif';
    const textW = ctx.measureText(label).width;
    const padX = 8;
    const badgeW = textW + padX * 2;
    const badgeH = 22;
    const bx = midX - badgeW / 2;
    const by = midY - 36;
    ctx.save();
    ctx.fillStyle = 'rgba(79, 70, 229, 0.95)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, bx, by, badgeW, badgeH, 11);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, by + badgeH / 2 + 0.5);
    ctx.restore();

    ctx.restore();
}

function getBackgroundCanvas(patternName, isDark, dpr) {
    const key = `${patternName}|${isDark ? 'dark' : 'light'}|${dpr}`;
    if (_bgCache.key === key) return _bgCache.canvas;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(PAGE_WIDTH * dpr);
    canvas.height = Math.floor(PAGE_HEIGHT * dpr);
    const bctx = canvas.getContext('2d');
    bctx.scale(dpr, dpr);

    bctx.fillStyle = isDark ? '#1E293B' : '#FFFFFF';
    bctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    bctx.strokeStyle = isDark ? '#334155' : '#E2E8F0';
    bctx.lineWidth = 1;

    if (patternName === 'ruled') {
        for (let y = 60; y < PAGE_HEIGHT; y += 32) {
            bctx.beginPath(); bctx.moveTo(0, y); bctx.lineTo(PAGE_WIDTH, y); bctx.stroke();
        }
    } else if (patternName === 'grid') {
        for (let x = 0; x < PAGE_WIDTH; x += 25) {
            bctx.beginPath(); bctx.moveTo(x, 0); bctx.lineTo(x, PAGE_HEIGHT); bctx.stroke();
        }
        for (let y = 0; y < PAGE_HEIGHT; y += 25) {
            bctx.beginPath(); bctx.moveTo(0, y); bctx.lineTo(PAGE_WIDTH, y); bctx.stroke();
        }
    } else if (patternName === 'dots') {
        bctx.fillStyle = isDark ? '#475569' : '#94A3B8';
        for (let x = 20; x < PAGE_WIDTH; x += 20) {
            for (let y = 20; y < PAGE_HEIGHT; y += 24) {
                bctx.beginPath(); bctx.arc(x, y, 1.2, 0, Math.PI * 2); bctx.fill();
            }
        }
    }

    _bgCache = { key, canvas };
    return canvas;
}

function drawPaperBackground(ctx, isDark, dpr) {
    const bg = getBackgroundCanvas(appState.bgPattern, isDark, dpr || 1);
    ctx.drawImage(bg, 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
}

function drawSelectionHandles(ctx, visualBBox) {
    const scale = transformState.scale;
    const handles = getHandlePositions(visualBBox);
    const handleSize = 12 / scale;
    const halfHandle = handleSize / 2;

    ctx.save();

    ['nw', 'se'].forEach(name => {
        const p = handles[name];
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2 / scale;
        ctx.beginPath();
        ctx.rect(p.x - halfHandle, p.y - halfHandle, handleSize, handleSize);
        ctx.fill();
        ctx.stroke();
    });

    if (appState.isResizingSelection) {
        const realBBox = getSelectionBoundingBox(false);
        const deg = Math.round(appState.resizeCurrentAngle * 180 / Math.PI);
        const dimLabel = realBBox
            ? `${Math.round(realBBox.width)} × ${Math.round(realBBox.height)} px`
            : '';
        const label = deg !== 0 ? `${dimLabel}  ·  ${deg}°` : dimLabel;
        drawSelectionBadge(ctx, visualBBox, label);
    }

    ctx.restore();
}

function drawSelectionBadge(ctx, bbox, label) {
    if (!label) return;
    const scale = transformState.scale;
    const midX = bbox.minX + bbox.width / 2;
    const by = bbox.minY - 34 / scale;

    ctx.save();
    ctx.font = `600 ${13 / scale}px Inter, sans-serif`;
    const textW = ctx.measureText(label).width;
    const padX = 8 / scale;
    const badgeW = textW + padX * 2;
    const badgeH = 22 / scale;

    ctx.fillStyle = 'rgba(59, 130, 246, 0.95)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5 / scale;
    roundRect(ctx, midX - badgeW / 2, by, badgeW, badgeH, 11 / scale);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, by + badgeH / 2 + 0.5 / scale);
    ctx.restore();
}

// FASE A: struttura overlay pronta ma non ancora usata.
// Da Fase B: qui sposteremo pendingShape, lassoPath, selectedStrokes,
// scribble path e stroke in corso.
function clearOverlay(pageData) {
    if (!pageData.overlayCtx) return;
    const octx = pageData.overlayCtx;
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, pageData.overlayCanvas.width, pageData.overlayCanvas.height);
    octx.restore();
}

// FASE B: disegna solo pendingShape sull'overlay.
// Sostituisce renderPendingShapeOnly (che disegnava sul page canvas).
function renderPendingShapeOnOverlay(pageData) {
    if (!pageData.overlayCtx) return;
    const octx = pageData.overlayCtx;
    const dpr = pageData.dpr || 1;
    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPendingShape(octx, appState.isDarkMode);
    octx.restore();
}

// ============================================================
// FASE C: rendering lasso e bbox di selezione sull'overlay
// ============================================================

// Disegna solo l'ultimo segmento del lasso sull'overlay (incrementale).
// Molto più economico di drawLassoPathOnOverlay per i pointermove:
// O(1) invece di O(n punti del lasso).
function drawLassoIncrementalOnOverlay(pageData) {
    if (!pageData.overlayCtx) return;
    if (appState.activeTool !== 'lasso') return;
    const n = appState.lassoPath.length;
    if (n < 2) return;

    const p1 = appState.lassoPath[n - 2];
    const p2 = appState.lassoPath[n - 1];

    const octx = pageData.overlayCtx;
    const dpr = pageData.dpr || 1;
    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.strokeStyle = '#2563eb';
    octx.lineWidth = 1.5;
    octx.setLineDash([5, 5]);
    octx.beginPath();
    octx.moveTo(p1.x, p1.y);
    octx.lineTo(p2.x, p2.y);
    octx.stroke();
    octx.restore();
}

// Disegna il bbox di selezione (rettangolo tratteggiato + handle + badge)
// sull'overlay. Non tocca il page canvas.
function drawSelectionBBoxOnOverlay(pageData) {
    if (!pageData.overlayCtx) return;
    if (appState.selectedStrokes.length === 0) return;

    const visualBBox = getVisualBoundingBox();
    if (!visualBBox) return;

    const octx = pageData.overlayCtx;
    const dpr = pageData.dpr || 1;
    const scale = transformState.scale;

    octx.save();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Rettangolo tratteggiato
    octx.strokeStyle = '#3b82f6';
    octx.lineWidth = 2 / scale;
    octx.setLineDash([6 / scale, 6 / scale]);
    octx.strokeRect(visualBBox.minX, visualBBox.minY, visualBBox.width, visualBBox.height);
    octx.fillStyle = 'rgba(59, 130, 246, 0.08)';
    octx.fillRect(visualBBox.minX, visualBBox.minY, visualBBox.width, visualBBox.height);
    octx.setLineDash([]);

    // Handle
    drawSelectionHandles(octx, visualBBox);

    octx.restore();
}

// Ridisegna completamente l'overlay per lo stato "selezione".
// Usata ogni volta che la selezione cambia (attivazione, modifica,
// deselezione) e dopo operazioni che azzerano l'overlay.
function redrawSelectionOverlay(pageData) {
    clearOverlay(pageData);
    if (appState.selectedStrokes.length > 0) {
        drawSelectionBBoxOnOverlay(pageData);
    }
}
