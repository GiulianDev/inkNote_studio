// ============================================================
// RENDERING CANVAS CON GESTIONE PRESSIONE + CURVE LISCE
// ============================================================

const SCRIBBLE_ERASE_COLOR = 'rgba(220, 38, 38, 0.6)';

let _drawBackupCanvas = null;
let _bgCache = { key: null, canvas: null };

// Tilt normalizzato: tilt 30° → 1.0. Surface in scrittura normale sta
// tra 20° e 40°, quindi il range utile è ben coperto.
function getTiltNorm(pt) {
    if (!pt || (!pt.tiltX && !pt.tiltY)) return 0;
    return Math.min(1, Math.hypot(pt.tiltX || 0, pt.tiltY || 0) / 30);
}

// Speed normalizzata: 8px canvas tra due eventi → 1.0.
// Su Surface a 120Hz, scrittura normale sta tra 2-10px.
function getSpeedNorm(pt) {
    if (!pt || !pt.speed) return 0;
    return Math.min(1, pt.speed / 8);
}

// Taper solo per pen e pencil. Highlighter e marker hanno larghezze
// uniformi per definizione: un taper sul primo punto crea un blob visibile.
function getTaper(idx, tool) {
    if (tool !== 'pen' && tool !== 'pencil') return 1.0;
    if (idx === 0) return 1.4;
    if (idx === 1) return 1.15;
    return 1.0;
}

function computeStrokeWidth(tool, baseSize, pressure, tiltNorm = 0, speedNorm = 0, taper = 1.0) {
    const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));
    let w = baseSize;

    if (tool === 'pen') {
        // Stilografica: curva a S accentuata, esponente 2.2.
        // Il tratto resta fine per tutta la prima metà della pressione,
        // poi "esplode" verso la pressione massima.
        // - p=0.1 → 0.15x  (filo, quasi invisibile)
        // - p=0.3 → 0.38x  (fine)
        // - p=0.5 → 0.85x  (normale)
        // - p=0.7 → 1.65x  (spesso)
        // - p=1.0 → 3.50x  (molto spesso)
        w = baseSize * (0.12 + Math.pow(p, 2.2) * 3.5);
        w *= (1 + tiltNorm * 0.15);
        w *= (1 - speedNorm * 0.25);
    } else if (tool === 'pencil') {
        // Matita: base bassa (0.2x, tratto fine a tocco leggero) con
        // esponente 1.3 (crescita moderata all'inizio, sostenuta poi).
        // - p=0.1 → 0.37x  (fine, alpha 0.55 lo rende visibile)
        // - p=0.3 → 0.93x
        // - p=0.5 → 1.62x
        // - p=0.7 → 2.40x
        // - p=1.0 → 3.70x
        // Tilt ×1.3: inclinazione visibile senza diventare una striscia.
        w = baseSize * (0.2 + Math.pow(p, 1.3) * 3.5);
        w *= (1 + tiltNorm * 1.3);
        w *= (1 - speedNorm * 0.4);
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

function redrawPageCanvas(pageData, forceTargetDark = appState.isDarkMode) {
    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pageData.canvas.width, pageData.canvas.height);
    ctx.scale(dpr, dpr);

    drawPaperBackground(ctx, forceTargetDark, dpr);
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

function saveCanvasBackup(pageData) {
    if (!_drawBackupCanvas) {
        _drawBackupCanvas = document.createElement('canvas');
    }
    _drawBackupCanvas.width = pageData.canvas.width;
    _drawBackupCanvas.height = pageData.canvas.height;
    const bctx = _drawBackupCanvas.getContext('2d');
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.drawImage(pageData.canvas, 0, 0);
}

function restoreCanvasFromBackup(pageData) {
    if (!_drawBackupCanvas) return;
    const ctx = pageData.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pageData.canvas.width, pageData.canvas.height);
    ctx.drawImage(_drawBackupCanvas, 0, 0);
    ctx.restore();
}

function renderPendingShapeOnly(pageData) {
    const ctx = pageData.ctx;
    const dpr = pageData.dpr || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPendingShape(ctx, appState.isDarkMode);
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
    const i1 = n - 2;
    const i2 = n - 1;
    const p0 = pts[Math.max(0, i1 - 1)];
    const p1 = pts[i1];
    const p2 = pts[i2];
    const p3 = pts[i2];

    const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure, getTiltNorm(p1), getSpeedNorm(p1), getTaper(i1, stroke.tool));
    const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, getTiltNorm(p2), getSpeedNorm(p2), getTaper(i2, stroke.tool));

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

    const lastW = Math.max(w2, 0.5);
    ctx.beginPath();
    ctx.arc(p2.x, p2.y, lastW / 2, 0, Math.PI * 2);
    ctx.fill();

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
        // Highlighter: alpha 0.4 (era 0.35). Niente taper su questo tool,
        // quindi il tratto è uniforme e il multiply funziona come previsto.
        ctx.globalCompositeOperation = forceTargetDark ? 'screen' : 'multiply';
        const c = hexToRgbA(stroke.color, forceTargetDark ? 0.55 : 0.40);
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
    } else if (stroke.tool === 'pencil') {
        ctx.globalCompositeOperation = 'source-over';
        // Alpha 0.55 (era 0.65): grafite più chiara, dà l'idea del tratto
        // "sfaldato" a pressione leggera, si scurisce visivamente quando i
        // tratti si sovrappongono.
        const c = hexToRgbA(getEffectiveColor(stroke.color, forceTargetDark), 0.55);
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
    } else {
        ctx.globalCompositeOperation = 'source-over';
        const c = getEffectiveColor(stroke.color, forceTargetDark);
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
    }
}

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
    const n = pts.length;
    if (n < 2) return;

    ctx.save();
    setupStrokeStyle(ctx, stroke, forceTargetDark);

    const smoothness = appState.smoothing;
    const widths = new Array(n);
    for (let i = 0; i < n; i++) {
        const pt = pts[i];
        widths[i] = computeStrokeWidth(
            stroke.tool, stroke.size, pt.pressure,
            getTiltNorm(pt), getSpeedNorm(pt), getTaper(i, stroke.tool)
        );
    }

    for (let i = 1; i < n; i++) {
        const p0 = pts[i >= 2 ? i - 2 : 0];
        const p1 = pts[i - 1];
        const p2 = pts[i];
        const p3 = pts[i + 1 < n ? i + 1 : n - 1];

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
    const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure, getTiltNorm(p1), getSpeedNorm(p1), getTaper(i1, stroke.tool));
    const w2 = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, getTiltNorm(p2), getSpeedNorm(p2), getTaper(i2, stroke.tool));

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
        for (let x = 20; x < PAGE_WIDTH; x += 24) {
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