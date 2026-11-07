// ============================================================
// RENDERING CANVAS CON GESTIONE PRESSIONE + CURVE LISCE
// ============================================================

const SCRIBBLE_ERASE_COLOR = 'rgba(220, 38, 38, 0.6)';

// B: cache del tile di pattern. Single-entry, invalidata quando cambia
// la coppia (pattern, isDark). Evita 1518 arc() per pattern dots.
let _patternTileCache = { key: null, tile: null };

function computeStrokeWidth(tool, baseSize, pressure) {
    const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));

    if (tool === 'pen') {
        const curved = Math.pow(p, 0.55);
        return baseSize * (0.35 + curved * 1.3);
    }
    if (tool === 'pencil') {
        const curved = Math.pow(p, 0.7);
        return baseSize * (0.6 + curved * 0.6);
    }
    if (tool === 'marker') {
        return baseSize * (1.55 + p * 0.35);
    }
    if (tool === 'highlighter') {
        return baseSize * 4.0;
    }
    return baseSize;
}

function redrawPageCanvas(pageData, forceTargetDark = appState.isDarkMode) {
    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pageData.canvas.width, pageData.canvas.height);
    ctx.scale(dpr, dpr);

    drawPaperBackground(ctx, forceTargetDark);
    pageData.strokes.forEach(stroke => { renderFullStroke(ctx, stroke, forceTargetDark); });

    if (appState.pendingShape) {
        drawPendingShape(ctx, forceTargetDark);
    }

    if (appState.activeTool === 'lasso' && appState.lassoPath.length > 1) {
        ctx.save();
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        appState.lassoPath.forEach((pt, idx) => {
            if (idx === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
        ctx.restore();
    }

    if (appState.selectedStrokes.length > 0) {
        const visualBBox = getVisualBoundingBox();
        if (visualBBox) {
            const scale = transformState.scale;
            ctx.save();
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2 / scale;
            ctx.setLineDash([6 / scale, 6 / scale]);
            ctx.strokeRect(visualBBox.minX, visualBBox.minY, visualBBox.width, visualBBox.height);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
            ctx.fillRect(visualBBox.minX, visualBBox.minY, visualBBox.width, visualBBox.height);
            ctx.restore();
            drawSelectionHandles(ctx, visualBBox);
        }
    }

    if (appState.scribbleMode && appState.currentStroke && appState.currentStroke.points.length > 1) {
        const pts = appState.currentStroke.points;
        ctx.save();
        ctx.strokeStyle = SCRIBBLE_ERASE_COLOR;
        ctx.fillStyle = SCRIBBLE_ERASE_COLOR;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(appState.currentStroke.size * 2, 4);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
        ctx.restore();
    }

    ctx.restore();
}

// C: disegna un singolo stroke sopra il canvas esistente, senza ridisegnare
// il resto della pagina. Da usare solo quando non ci sono overlay attivi
// (pendingShape, lassoPath, selectedStrokes) perché append non li ripulirebbe.
function appendStrokeToCanvas(pageData, stroke, forceTargetDark = appState.isDarkMode) {
    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderFullStroke(ctx, stroke, forceTargetDark);
    ctx.restore();
}

function setupStrokeStyle(ctx, stroke, forceTargetDark) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (appState.scribbleMode) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = SCRIBBLE_ERASE_COLOR;
        ctx.fillStyle = SCRIBBLE_ERASE_COLOR;
        return;
    }

    if (stroke.tool === 'highlighter') {
        ctx.globalCompositeOperation = forceTargetDark ? 'screen' : 'multiply';
        const c = hexToRgbA(stroke.color, forceTargetDark ? 0.5 : 0.35);
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
    } else if (stroke.tool === 'pencil') {
        ctx.globalCompositeOperation = 'source-over';
        const c = hexToRgbA(getEffectiveColor(stroke.color, forceTargetDark), 0.65);
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
    } else {
        ctx.globalCompositeOperation = 'source-over';
        const c = getEffectiveColor(stroke.color, forceTargetDark);
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
    }
}

// F: 1 fill() per segmento (path composto poligono + cerchio) invece di 2.
// Con 10-50 segmenti per pointermove, sono 10-50 fill risparmiati.
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
    // Poligono
    ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
    ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
    ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
    ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
    ctx.closePath();
    // Cerchio a p0 come secondo subpath dello stesso fill
    ctx.moveTo(p0.x + hw0, p0.y);
    ctx.arc(p0.x, p0.y, hw0, 0, Math.PI * 2);
    ctx.fill();
}

function interpolatePoint(p0, p1, p2, p3, t, smoothness) {
    const lx = p1.x + (p2.x - p1.x) * t;
    const ly = p1.y + (p2.y - p1.y) * t;
    if (smoothness <= 0.01) return { x: lx, y: ly };

    const t2 = t * t;
    const t3 = t2 * t;
    const cx = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
    const cy = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

    return {
        x: lx + (cx - lx) * smoothness,
        y: ly + (cy - ly) * smoothness
    };
}

function renderFullStroke(ctx, stroke, forceTargetDark) {
    const pts = stroke.points;
    if (pts.length < 2) return;

    ctx.save();
    setupStrokeStyle(ctx, stroke, forceTargetDark);

    const smoothness = appState.smoothing;
    const widths = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
        widths[i] = computeStrokeWidth(stroke.tool, stroke.size, pts[i].pressure);
    }

    for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i >= 2 ? i - 2 : 0];
        const p1 = pts[i - 1];
        const p2 = pts[i];
        const p3 = pts[i + 1 < pts.length ? i + 1 : pts.length - 1];

        const w1 = widths[i - 1];
        const w2 = widths[i];

        const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const baseSteps = Math.max(2, Math.min(5, Math.ceil(segLen / 3)));
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
    }

    const lastW = Math.max(widths[widths.length - 1], 0.5);
    ctx.beginPath();
    ctx.arc(pts[pts.length - 1].x, pts[pts.length - 1].y, lastW / 2, 0, Math.PI * 2);
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
    const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure);
    const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure);

    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const baseSteps = Math.max(2, Math.min(5, Math.ceil(segLen / 3)));
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

// B: genera il tile di pattern per la coppia (pattern, isDark).
// Ritorna null per 'blank' (solo background).
function getPatternTile(patternName, isDark) {
    const key = `${patternName}|${isDark ? 'dark' : 'light'}`;
    if (_patternTileCache.key === key) return _patternTileCache.tile;

    let tile = null;
    if (patternName === 'ruled') {
        tile = document.createElement('canvas');
        tile.width = 1;
        tile.height = 32;
        const tctx = tile.getContext('2d');
        tctx.fillStyle = isDark ? '#334155' : '#E2E8F0';
        tctx.fillRect(0, 0, 1, 1);
    } else if (patternName === 'grid') {
        tile = document.createElement('canvas');
        tile.width = 25;
        tile.height = 25;
        const tctx = tile.getContext('2d');
        tctx.fillStyle = isDark ? '#334155' : '#E2E8F0';
        tctx.fillRect(0, 0, 25, 1);
        tctx.fillRect(0, 0, 1, 25);
    } else if (patternName === 'dots') {
        tile = document.createElement('canvas');
        tile.width = 24;
        tile.height = 24;
        const tctx = tile.getContext('2d');
        tctx.fillStyle = isDark ? '#475569' : '#94A3B8';
        tctx.beginPath();
        tctx.arc(20, 20, 1.2, 0, Math.PI * 2);
        tctx.fill();
    }
    _patternTileCache = { key, tile };
    return tile;
}

function drawPaperBackground(ctx, isDark) {
    ctx.save();
    ctx.fillStyle = isDark ? '#1E293B' : '#FFFFFF';
    ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

    const tile = getPatternTile(appState.bgPattern, isDark);
    if (tile) {
        const pattern = ctx.createPattern(tile, 'repeat');
        if (pattern) {
            ctx.fillStyle = pattern;
            if (appState.bgPattern === 'ruled') {
                // L'originale iniziava a y=60 con passo 32: replica l'offset
                ctx.save();
                ctx.translate(0, 60);
                ctx.fillRect(0, -60, PAGE_WIDTH, PAGE_HEIGHT);
                ctx.restore();
            } else {
                ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
            }
        }
    }
    ctx.restore();
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