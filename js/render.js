// ============================================================
// RENDERING CANVAS CON GESTIONE PRESSIONE
// ============================================================

// Calcola la larghezza del tratto in base a strumento + pressione.
// La curva non è lineare: più sensibile ai valori bassi, come una penna reale.
function computeStrokeWidth(tool, baseSize, pressure) {
    const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));

    if (tool === 'pen') {
        // Curva non lineare: più sensibile ai valori bassi
        const curved = Math.pow(p, 0.55);
        // Range 35% - 165% del size (come una stilografica)
        return baseSize * (0.35 + curved * 1.3);
    }
    if (tool === 'pencil') {
        // Matita: variazione più contenuta (60% - 120%)
        const curved = Math.pow(p, 0.7);
        return baseSize * (0.6 + curved * 0.6);
    }
    if (tool === 'marker') {
        // Pennarello: variazione minima (uniforme come un vero marker)
        return baseSize * (1.55 + p * 0.35);
    }
    if (tool === 'highlighter') {
        // Evidenziatore: larghezza completamente uniforme
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
        const bbox = getSelectionBoundingBox();
        if (bbox) {
            const scale = transformState.scale;
            ctx.save();
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2 / scale;
            ctx.setLineDash([6 / scale, 6 / scale]);
            ctx.strokeRect(bbox.minX, bbox.minY, bbox.width, bbox.height);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
            ctx.fillRect(bbox.minX, bbox.minY, bbox.width, bbox.height);
            ctx.restore();
            drawSelectionHandles(ctx, bbox);
        }
    }
    ctx.restore();
}

// Prepara stile colore/compositing per lo stroke.
// NOTA: usa sia strokeStyle che fillStyle, perché il rendering tapered
// disegna trapezi riempiti (fill) + cerchi ai giunti.
function setupStrokeStyle(ctx, stroke, forceTargetDark) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

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

// Disegna un segmento con larghezza variabile tra due punti.
// Usa fill (trapezio) invece di stroke con lineWidth, per una transizione fluida.
function drawTaperedSegment(ctx, p0, p1, w0, w1) {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);

    // Punti coincidenti: disegna un cerchio alla media delle larghezze
    if (len < 0.01) {
        const w = Math.max((w0 + w1) / 2, 0.5);
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    // Vettore normale al segmento
    const nx = -dy / len;
    const ny = dx / len;

    const hw0 = Math.max(w0, 0.5) / 2;
    const hw1 = Math.max(w1, 0.5) / 2;

    // Trapezio: 4 vertici
    ctx.beginPath();
    ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
    ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
    ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
    ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
    ctx.closePath();
    ctx.fill();

    // Cerchio al giunto iniziale: copre il gap tra questo trapezio
    // e il precedente (dove le larghezze non combaciano perfettamente)
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, hw0, 0, Math.PI * 2);
    ctx.fill();
}

// Interpola tra due punti per rendere più fluido il cambio di pressione.
// Genera N sub-punti con pressione interpolata linearmente.
function renderSegmentWithInterpolation(ctx, p0, p1, w0, w1, subSteps = 2) {
    for (let s = 0; s < subSteps; s++) {
        const t0 = s / subSteps;
        const t1 = (s + 1) / subSteps;
        const sp0 = {
            x: p0.x + (p1.x - p0.x) * t0,
            y: p0.y + (p1.y - p0.y) * t0
        };
        const sp1 = {
            x: p0.x + (p1.x - p0.x) * t1,
            y: p0.y + (p1.y - p0.y) * t1
        };
        const sw0 = w0 + (w1 - w0) * t0;
        const sw1 = w0 + (w1 - w0) * t1;
        drawTaperedSegment(ctx, sp0, sp1, sw0, sw1);
    }
}

function renderFullStroke(ctx, stroke, forceTargetDark) {
    const pts = stroke.points;
    if (pts.length < 2) return;

    setupStrokeStyle(ctx, stroke, forceTargetDark);

    // Pre-calcola le larghezze
    const widths = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
        widths[i] = computeStrokeWidth(stroke.tool, stroke.size, pts[i].pressure);
    }

    // Sceglie quanti sub-step di interpolazione usare (più punti = meno necessari)
    const steps = pts.length > 200 ? 1 : (pts.length > 60 ? 2 : 3);

    for (let i = 1; i < pts.length; i++) {
        renderSegmentWithInterpolation(ctx, pts[i - 1], pts[i], widths[i - 1], widths[i], steps);
    }

    // Cerchio finale arrotondato
    const lastW = Math.max(widths[widths.length - 1], 0.5);
    ctx.beginPath();
    ctx.arc(pts[pts.length - 1].x, pts[pts.length - 1].y, lastW / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

// Disegno incrementale: solo l'ultimo segmento (performance durante il disegno)
function drawIncrementalSegment(ctx, stroke, dpr = 1) {
    const pts = stroke.points;
    if (pts.length < 2) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setupStrokeStyle(ctx, stroke, appState.isDarkMode);

    const p0 = pts[pts.length - 2];
    const p1 = pts[pts.length - 1];
    const w0 = computeStrokeWidth(stroke.tool, stroke.size, p0.pressure);
    const w1 = computeStrokeWidth(stroke.tool, stroke.size, p1.pressure);

    // Durante il disegno niente interpolazione (già fluido perché i punti sono ravvicinati)
    drawTaperedSegment(ctx, p0, p1, w0, w1);

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

    // Forme geometriche: larghezza fissa (pressione 0.5 = medio)
    const lineW = computeStrokeWidth(ps.tool, ps.size, 0.5);
    ctx.lineWidth = lineW;

    ctx.beginPath();
    ctx.moveTo(startPt.x, startPt.y);
    ctx.lineTo(endPt.x, endPt.y);
    ctx.stroke();

    // Maniglie
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

    // Badge lunghezza/angolo
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

function drawPaperBackground(ctx, isDark) {
    ctx.save();
    ctx.fillStyle = isDark ? '#1E293B' : '#FFFFFF';
    ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    ctx.strokeStyle = isDark ? '#334155' : '#E2E8F0';
    ctx.lineWidth = 1;

    if (appState.bgPattern === 'ruled') {
        for (let y = 60; y < PAGE_HEIGHT; y += 32) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAGE_WIDTH, y); ctx.stroke();
        }
    } else if (appState.bgPattern === 'grid') {
        for (let x = 0; x < PAGE_WIDTH; x += 25) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, PAGE_HEIGHT); ctx.stroke();
        }
        for (let y = 0; y < PAGE_HEIGHT; y += 25) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAGE_WIDTH, y); ctx.stroke();
        }
    } else if (appState.bgPattern === 'dots') {
        ctx.fillStyle = isDark ? '#475569' : '#94A3B8';
        for (let x = 20; x < PAGE_WIDTH; x += 24) {
            for (let y = 20; y < PAGE_HEIGHT; y += 24) {
                ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
            }
        }
    }
    ctx.restore();
}

// Disegna gli handle di resize (quadrati) e rotate (cerchio sopra il bbox).
// Tutte le dimensioni sono in pixel schermo / scale: costanti visivamente.
function drawSelectionHandles(ctx, bbox) {
    const scale = transformState.scale;
    const handleSize = 10 / scale;
    const halfHandle = handleSize / 2;

    const handles = getHandlePositions(bbox);
    const topCenter = handles.n;
    const rotatePos = handles.rotate;

    ctx.save();

    // Linea di connessione al rotate handle
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(topCenter.x, topCenter.y);
    ctx.lineTo(rotatePos.x, rotatePos.y);
    ctx.stroke();

    // 8 handle quadrati
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(name => {
        const p = handles[name];
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2 / scale;
        ctx.beginPath();
        ctx.rect(p.x - halfHandle, p.y - halfHandle, handleSize, handleSize);
        ctx.fill();
        ctx.stroke();
    });

    // Rotate handle (cerchio con freccia circolare)
    const r = handleSize * 0.65;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.arc(rotatePos.x, rotatePos.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Piccola icona di rotazione dentro il cerchio
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / scale;
    ctx.beginPath();
    ctx.arc(rotatePos.x, rotatePos.y, r * 0.55, Math.PI * 0.15, Math.PI * 1.6);
    ctx.stroke();
    // Freccia della rotazione
    const arrowAngle = Math.PI * 1.6;
    const ax = rotatePos.x + Math.cos(arrowAngle) * r * 0.55;
    const ay = rotatePos.y + Math.sin(arrowAngle) * r * 0.55;
    const arrowSize = 3 / scale;
    ctx.beginPath();
    ctx.moveTo(ax - arrowSize, ay - arrowSize * 0.3);
    ctx.lineTo(ax, ay);
    ctx.lineTo(ax + arrowSize * 0.3, ay - arrowSize);
    ctx.stroke();

    ctx.restore();
}