/**
 * @module features/persistence/serialization
 *
 * Serializzazione packed per IDB e history.
 *
 * Novità:
 *   - campo `opacity` per stroke (0.1..1.0), fuori dal packed buffer
 *   - migrazione soft: highlighter legacy nero → giallo, opacity
 *     undefined → default tool
 */

export const PACKED_STRIDE = 7;

const PT_PEN = 0;
const PT_TOUCH = 1;
const PT_MOUSE = 2;
const PT_ERASER = 3;

const HIGHLIGHTER_DEFAULT_COLOR = '#FFEB3B';
const HIGHLIGHTER_LEGACY_OPACITY = 0.4;

function _pointerTypeToInt(pt) {
  switch (pt) {
    case 'touch':  return PT_TOUCH;
    case 'mouse':  return PT_MOUSE;
    case 'eraser': return PT_ERASER;
    default:       return PT_PEN;
  }
}

function _intToPointerType(n) {
  switch (n) {
    case PT_TOUCH:  return 'touch';
    case PT_MOUSE:  return 'mouse';
    case PT_ERASER: return 'eraser';
    default:        return 'pen';
  }
}

function _isLegacyBlack(c) {
  return !c || c === '#000000' || c === '#000' || c === 'black';
}

export function packStroke(s) {
  const pts = s.points;
  const n = pts ? pts.length : 0;
  const buf = new Float32Array(n * PACKED_STRIDE);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const o = i * PACKED_STRIDE;
    buf[o]     = p.x;
    buf[o + 1] = p.y;
    buf[o + 2] = p.pressure != null ? p.pressure : 0.5;
    buf[o + 3] = p.tiltX || 0;
    buf[o + 4] = p.tiltY || 0;
    buf[o + 5] = p.speed || 0;
    buf[o + 6] = _pointerTypeToInt(p.pointerType);
  }
  return {
    tool: s.tool,
    color: s.color,
    size: s.size,
    opacity: s.opacity != null ? s.opacity : 1.0,
    packed: buf,
    count: n
  };
}

export function unpackStroke(s) {
  if (!s) return s;

  // Legacy: stroke highlighter nero pre-palette colorata
  let color = s.color;
  if (s.tool === 'highlighter' && _isLegacyBlack(color)) {
    color = HIGHLIGHTER_DEFAULT_COLOR;
  }

  // Legacy: opacity undefined
  let opacity = s.opacity;
  if (opacity == null) {
    opacity = s.tool === 'highlighter' ? HIGHLIGHTER_LEGACY_OPACITY : 1.0;
  }

  if (!s.packed) {
    return { tool: s.tool, color, size: s.size, opacity, points: s.points };
  }

  const buf = s.packed;
  const n = s.count != null ? s.count : (buf ? (buf.length / PACKED_STRIDE) | 0 : 0);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * PACKED_STRIDE;
    pts[i] = {
      x: buf[o],
      y: buf[o + 1],
      pressure: buf[o + 2],
      tiltX: buf[o + 3],
      tiltY: buf[o + 4],
      speed: buf[o + 5],
      pointerType: _intToPointerType(buf[o + 6])
    };
  }

  return { tool: s.tool, color, size: s.size, opacity, points: pts };
}

export function packStrokes(strokes) {
  const n = strokes.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = packStroke(strokes[i]);
  return out;
}

export function unpackStrokes(strokes) {
  if (!strokes) return [];
  const n = strokes.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = unpackStroke(strokes[i]);
  return out;
}