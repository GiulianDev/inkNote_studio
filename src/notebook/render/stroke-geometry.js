/**
 * @module features/render/stroke-geometry
 *
 * Logica geometrica pura (zero DOM/state) e cache non-enumerabile dei bounding box
 * per tratti (strokes), selezione lazo e hit-testing broad-phase.
 */

export function setNonEnumerable(obj, key, value) {
  if (!obj || typeof obj !== 'object') return;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (desc && desc.configurable === false) {
    if (desc.writable) obj[key] = value;
    return;
  }
  if (desc && desc.enumerable === false && desc.writable) {
    obj[key] = value;
    return;
  }
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true
  });
}

/**
 * Calcola o restituisce dalla cache non-enumerabile `_bbox` il bounding box
 * esatto dei punti dello stroke (`{ minX, maxX, minY, maxY, len }`).
 * Se `stroke.points.length` è cambiato (es. tratto in corso), ricalcola automaticamente.
 */
export function getRawStrokeBBox(stroke) {
  const pts = stroke && stroke.points;
  if (!pts || pts.length === 0) return null;

  const cached = stroke._bbox;
  const n = pts.length;
  if (cached && cached.len === n) {
    return cached;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const bbox = { minX, maxX, minY, maxY, len: n };
  setNonEnumerable(stroke, '_bbox', bbox);
  return bbox;
}

export function getStrokeBBox(stroke, pad = 0) {
  const raw = getRawStrokeBBox(stroke);
  if (!raw) return null;
  if (!pad) {
    return { minX: raw.minX, maxX: raw.maxX, minY: raw.minY, maxY: raw.maxY };
  }
  return {
    minX: raw.minX - pad,
    maxX: raw.maxX + pad,
    minY: raw.minY - pad,
    maxY: raw.maxY + pad
  };
}

export function getStrokeBBoxRect(stroke, pad = 32) {
  const raw = getRawStrokeBBox(stroke);
  if (!raw) return null;
  const px = pad || 0;
  const x = Math.floor(raw.minX - px);
  const y = Math.floor(raw.minY - px);
  const maxX = Math.ceil(raw.maxX + px);
  const maxY = Math.ceil(raw.maxY + px);
  return {
    x,
    y,
    w: Math.max(1, maxX - x),
    h: Math.max(1, maxY - y)
  };
}

export function invalidateStrokePacked(stroke) {
  if (!stroke || typeof stroke !== 'object') return;
  if (stroke._packedCache !== undefined && stroke._packedCache !== null) {
    setNonEnumerable(stroke, '_packedCache', null);
  }
}

export function invalidateStrokeBBox(stroke) {
  if (!stroke || typeof stroke !== 'object') return;
  if (stroke._bbox !== undefined && stroke._bbox !== null) {
    setNonEnumerable(stroke, '_bbox', null);
  }
  if (stroke._hlPts !== undefined && stroke._hlPts !== null) {
    setNonEnumerable(stroke, '_hlPts', null);
  }
  if (stroke._hlPtsLen !== undefined && stroke._hlPtsLen !== 0) {
    setNonEnumerable(stroke, '_hlPtsLen', 0);
  }
  if (stroke._jitterOffsets !== undefined && stroke._jitterOffsets !== null) {
    setNonEnumerable(stroke, '_jitterOffsets', null);
  }
  invalidateStrokePacked(stroke);
}

/**
 * Trasla uno stroke di `(dx, dy)` aggiornando in-place sia i punti che
 * le cache runtime (`_bbox`, `_hlPts`, `_cacheCanvas.bbox`) senza dover
 * ricostruire la bitmap offscreen.
 */
export function translateStrokeInPlace(stroke, dx, dy) {
  if (!stroke || (dx === 0 && dy === 0)) return;
  const pts = stroke.points;
  if (Array.isArray(pts)) {
    for (let i = 0; i < pts.length; i++) {
      pts[i].x += dx;
      pts[i].y += dy;
    }
  }
  const bbox = stroke._bbox;
  if (bbox) {
    bbox.minX += dx;
    bbox.maxX += dx;
    bbox.minY += dy;
    bbox.maxY += dy;
  }
  const hlPts = stroke._hlPts;
  if (Array.isArray(hlPts)) {
    for (let i = 0; i < hlPts.length; i++) {
      hlPts[i].x += dx;
      hlPts[i].y += dy;
    }
  }
  const cacheEntry = stroke._cacheCanvas;
  if (cacheEntry && cacheEntry.bbox) {
    cacheEntry.bbox.x += dx;
    cacheEntry.bbox.y += dy;
  }
  invalidateStrokePacked(stroke);
}

export function mergeDirtyBBox(acc, minX, maxX, minY, maxY) {
  if (!acc) {
    return { minX, maxX, minY, maxY };
  }
  if (minX < acc.minX) acc.minX = minX;
  if (maxX > acc.maxX) acc.maxX = maxX;
  if (minY < acc.minY) acc.minY = minY;
  if (maxY > acc.maxY) acc.maxY = maxY;
  return acc;
}

export function clampDirtyRect(rect, pageWidth, pageHeight) {
  if (!rect) return null;
  const minX = Math.max(0, rect.minX);
  const minY = Math.max(0, rect.minY);
  const maxX = Math.min(pageWidth, rect.maxX);
  const maxY = Math.min(pageHeight, rect.maxY);
  if (!(maxX > minX && maxY > minY)) return null;
  return { minX, maxX, minY, maxY };
}

export function bboxesOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  return !(
    a.maxX + pad < b.minX ||
    a.minX - pad > b.maxX ||
    a.maxY + pad < b.minY ||
    a.minY - pad > b.maxY
  );
}

export function computePolygonBBox(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

export function isPointInPolygon(point, vs) {
  const x = point.x;
  const y = point.y;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x;
    const yi = vs[i].y;
    const xj = vs[j].x;
    const yj = vs[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function getSelectionBBoxFromItems(strokes, textBoxes, pad = 0) {
  const hasStrokes = Array.isArray(strokes) && strokes.length > 0;
  const hasText = Array.isArray(textBoxes) && textBoxes.length > 0;
  if (!hasStrokes && !hasText) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  if (hasStrokes) {
    for (let i = 0; i < strokes.length; i++) {
      const b = getRawStrokeBBox(strokes[i]);
      if (!b) continue;
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxY > maxY) maxY = b.maxY;
    }
  }

  if (hasText) {
    for (let i = 0; i < textBoxes.length; i++) {
      const tb = textBoxes[i];
      if (!tb) continue;
      const w = Math.max(80, tb.width || 240);
      const h = Math.max(24, tb.height || 32);
      if (tb.x < minX) minX = tb.x;
      if (tb.x + w > maxX) maxX = tb.x + w;
      if (tb.y < minY) minY = tb.y;
      if (tb.y + h > maxY) maxY = tb.y + h;
    }
  }

  if (minX === Infinity) return null;
  const rMinX = minX - pad;
  const rMaxX = maxX + pad;
  const rMinY = minY - pad;
  const rMaxY = maxY + pad;
  return {
    minX: rMinX,
    maxX: rMaxX,
    minY: rMinY,
    maxY: rMaxY,
    width: rMaxX - rMinX,
    height: rMaxY - rMinY
  };
}

/**
 * Calcola il numero di suddivisioni geometriche per segmento riducendo
 * il carico poligonale su CPU lente (Surface Go 1):
 *   - smoothing = 0 o segmenti <= 2.5px -> 1 step lineare
 *   - fascia bassa (0.01..0.30) -> salta suddivisione fino a 10px, max 1..3 step
 *   - fascia medio/alta (> 0.30) -> 1..4 step adattivi alla lunghezza
 */
export function computeSegmentSteps(segLen, smoothness) {
  const s = smoothness == null ? 0.5 : smoothness;
  if (s <= 0.005 || segLen <= 2.5) return 1;
  if (s <= 0.30) {
    if (segLen <= 4.5) return 1;
    if (segLen <= 14) return 2;
    return 3;
  }
  if (segLen <= 4) return 1;
  if (segLen <= 10) return 2;
  if (segLen <= 22) return 3;
  return 4;
}

/**
 * Varianti ottimizzate per piattaforma di `computeSegmentSteps`:
 * su Surface Go 1 (`'desktop'`) limita a 3 step i segmenti standard per risparmiare CPU/GPU;
 * su iOS/Android consente 5 step sui lanci lunghi ad alto smoothing.
 */
export function computePlatformSegmentSteps(segLen, smoothness, platform = 'desktop') {
  const base = computeSegmentSteps(segLen, smoothness);
  if (base <= 1) return 1;
  const s = smoothness == null ? 0.5 : smoothness;
  if (platform === 'desktop') {
    return segLen <= 34 ? Math.min(base, 3) : base;
  }
  if (s > 0.70 && segLen > 34) {
    return 5;
  }
  return base;
}

/**
 * Peso di arrotondamento geometrico [0..1] in funzione dello smoothing:
 * - fascia bassa (1..30%): arrotondamento lieve (0.03..0.18) senza deformare la forma
 * - fascia media (31..65%): 0.18..0.50
 * - fascia alta (> 65%): 0.50..1.00
 */
export function computeCurveWeight(smoothness) {
  const s = smoothness == null ? 0.5 : (smoothness < 0 ? 0 : (smoothness > 1 ? 1 : smoothness));
  if (s <= 0.005) return 0;
  if (s <= 0.30) return 0.03 + (s / 0.30) * 0.15;
  if (s <= 0.65) return 0.18 + ((s - 0.30) / 0.35) * 0.32;
  return 0.50 + ((s - 0.65) / 0.35) * 0.50;
}

/**
 * Pre-calcola le tangenti Centripetal Catmull-Rom (α=0.5, Barry-Goldman) clampate
 * per il segmento `[p1, p2]`: matematicamente privo di loop e overshoot anche con
 * spaziature fortemente irregolari degli stili 60Hz/120Hz.
 */
export function prepareSegmentCurve(out, p0, p1, p2, p3, segLen, smoothness) {
  const s = smoothness == null ? 0.5 : smoothness;
  if (s <= 0.005 || segLen <= 1e-4) {
    out.linear = true;
    return out;
  }
  out.linear = false;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const w = computeCurveWeight(s);

  const l01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const l23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const d12 = Math.sqrt(Math.max(1e-4, segLen));

  let m1x = dx;
  let m1y = dy;
  if (l01 > 1e-3) {
    const d01 = Math.sqrt(l01);
    m1x = d12 * ((p1.x - p0.x) / d01 - (p2.x - p0.x) / (d01 + d12) + dx / d12);
    m1y = d12 * ((p1.y - p0.y) / d01 - (p2.y - p0.y) / (d01 + d12) + dy / d12);
  }

  let m2x = dx;
  let m2y = dy;
  if (l23 > 1e-3) {
    const d23 = Math.sqrt(l23);
    m2x = d12 * ((p3.x - p2.x) / d23 - (p3.x - p1.x) / (d12 + d23) + dx / d12);
    m2y = d12 * ((p3.y - p2.y) / d23 - (p3.y - p1.y) / (d12 + d23) + dy / d12);
  }

  // Clamp di sicurezza + prevenzione inversione all'indietro rispetto alla corda
  const maxMag = Math.max(0.5, segLen * 0.95);
  const m1Len = Math.hypot(m1x, m1y);
  if (m1Len > maxMag) {
    const scale = maxMag / m1Len;
    m1x *= scale;
    m1y *= scale;
  }
  const m2Len = Math.hypot(m2x, m2y);
  if (m2Len > maxMag) {
    const scale = maxMag / m2Len;
    m2x *= scale;
    m2y *= scale;
  }

  const segSq = segLen * segLen;
  if (m1x * dx + m1y * dy < -0.25 * segSq) {
    m1x = dx * 0.5;
    m1y = dy * 0.5;
  }
  if (m2x * dx + m2y * dy < -0.25 * segSq) {
    m2x = dx * 0.5;
    m2y = dy * 0.5;
  }

  // Equivalente al blend lineare->curva via identità Hermite (m=dx => P(t)=p1+t*dx)
  out.m1x = dx + (m1x - dx) * w;
  out.m1y = dy + (m1y - dy) * w;
  out.m2x = dx + (m2x - dx) * w;
  out.m2y = dy + (m2y - dy) * w;
  return out;
}

export function evalSegmentCurveInto(out, p1, p2, curve, t) {
  if (curve.linear) {
    out.x = p1.x + (p2.x - p1.x) * t;
    out.y = p1.y + (p2.y - p1.y) * t;
    return;
  }
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  out.x = h00 * p1.x + h10 * curve.m1x + h01 * p2.x + h11 * curve.m2x;
  out.y = h00 * p1.y + h10 * curve.m1y + h01 * p2.y + h11 * curve.m2y;
}

/**
 * Peso di filtro gaussiano [0..1] per il pass finale indipendente dallo strumento.
 */
export function computeRelaxWeight(smoothness) {
  const s = smoothness == null ? 0.5 : (smoothness < 0 ? 0 : (smoothness > 1 ? 1 : smoothness));
  if (s <= 0.005) return 0;
  if (s <= 0.35) return 0.18 + (s / 0.35) * 0.52;
  if (s <= 0.65) return 0.70 + ((s - 0.35) / 0.30) * 0.25;
  return 0.95;
}

/**
 * Filtro gaussiano spaziale 1D puro (indipendente dallo strumento) applicato al tratto
 * senza mutare `pts`:
 *   - s <= 0.005: nessuna allocazione, punti originali intatti
 *   - 0.005 < s <= 0.35: 1 passata gaussiana 3-tap [0.25, 0.50, 0.25], maxShift 0.45..1.30px,
 *                        preserva spigoli netti (V, L, 7)
 *   - 0.35 < s <= 0.65: 1 passata gaussiana 5-tap [1,4,6,4,1]/16, maxShift 1.30..2.10px
 *   - s > 0.65: 2 passate gaussiane 5-tap [1,4,6,4,1]/16, maxShift 2.10..6.0px
 */
export function buildGaussianSmoothedPoints(pts, smoothness) {
  if (!Array.isArray(pts) || pts.length < 4) return pts;
  const s = smoothness == null ? 0.5 : (smoothness < 0 ? 0 : (smoothness > 1 ? 1 : smoothness));
  if (s <= 0.005) return pts;

  const n = pts.length;
  let passes = 1;
  let useFiveTap = false;
  let blend = 0;
  let maxShift = 0.45;
  let cornerCosLimit = 0.25;
  let cornerMinFactor = 0.10;

  if (s <= 0.35) {
    const u = s / 0.35;
    passes = 1;
    useFiveTap = false;
    blend = 0.32 + u * 0.53;
    maxShift = 0.70 + u * 0.90;
    cornerCosLimit = 0.25;
    cornerMinFactor = 0.06;
  } else if (s <= 0.65) {
    const u = (s - 0.35) / 0.30;
    passes = 1;
    useFiveTap = true;
    blend = 0.85 + u * 0.10;
    maxShift = 1.60 + u * 0.65;
    cornerCosLimit = 0.15;
    cornerMinFactor = 0.10;
  } else {
    const u = (s - 0.65) / 0.35;
    passes = 2;
    useFiveTap = true;
    blend = 0.95;
    maxShift = 2.25 + u * 3.75;
    cornerCosLimit = -0.35;
    cornerMinFactor = 0.30;
  }

  let src = pts;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Array(n);
    out[0] = src[0];
    out[n - 1] = src[n - 1];
    for (let i = 1; i < n - 1; i++) {
      const prev = src[i - 1];
      const curr = src[i];
      const next = src[i + 1];

      let gx, gy;
      if (useFiveTap && i >= 2 && i <= n - 3) {
        const p2 = src[i - 2];
        const n2 = src[i + 2];
        gx = (p2.x + 4 * prev.x + 6 * curr.x + 4 * next.x + n2.x) * 0.0625;
        gy = (p2.y + 4 * prev.y + 6 * curr.y + 4 * next.y + n2.y) * 0.0625;
      } else {
        gx = 0.25 * prev.x + 0.50 * curr.x + 0.25 * next.x;
        gy = 0.25 * prev.y + 0.50 * curr.y + 0.25 * next.y;
      }

      let localBlend = blend;
      const vx1 = curr.x - prev.x;
      const vy1 = curr.y - prev.y;
      const vx2 = next.x - curr.x;
      const vy2 = next.y - curr.y;
      const len1 = Math.hypot(vx1, vy1);
      const len2 = Math.hypot(vx2, vy2);
      const minLeg = Math.min(len1, len2);
      if (minLeg > 3.5) {
        const cosAng = (vx1 * vx2 + vy1 * vy2) / (len1 * len2);
        if (cosAng < cornerCosLimit) {
          const cornerScale = Math.min(1, (minLeg - 3.5) / 5.0);
          const minTurnCos = Math.min(0.08, cornerCosLimit - 0.05);
          const t = Math.max(0, Math.min(1, (cosAng - minTurnCos) / Math.max(0.05, cornerCosLimit - minTurnCos)));
          const factor = cornerMinFactor + (1 - cornerMinFactor) * t;
          localBlend *= 1 - (1 - factor) * cornerScale;
        }
      }

      const shiftX = (gx - curr.x) * localBlend;
      const shiftY = (gy - curr.y) * localBlend;
      const mag = Math.hypot(shiftX, shiftY);
      const scale = mag > maxShift ? (maxShift / mag) : 1;

      let outPressure = curr.pressure;
      if (curr.pointerType === 'pen' &&
          Number.isFinite(prev.pressure) &&
          Number.isFinite(curr.pressure) &&
          Number.isFinite(next.pressure)) {
        const gp = 0.25 * prev.pressure + 0.50 * curr.pressure + 0.25 * next.pressure;
        outPressure = curr.pressure + (gp - curr.pressure) * (localBlend * 0.45);
      }

      out[i] = {
        x: curr.x + shiftX * scale,
        y: curr.y + shiftY * scale,
        pressure: outPressure,
        tiltX: curr.tiltX,
        tiltY: curr.tiltY,
        speed: curr.speed,
        pointerType: curr.pointerType
      };
    }
    src = out;
  }
  return src;
}

export function buildRelaxedPoints(pts, smoothness) {
  return buildGaussianSmoothedPoints(pts, smoothness);
}

