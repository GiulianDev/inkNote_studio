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

export function computeSegmentSteps(segLen, smoothness) {
  const baseSteps = Math.max(2, Math.min(3, Math.ceil(segLen / 3)));
  return Math.max(1, Math.round(baseSteps * (0.3 + smoothness * 0.7)));
}
