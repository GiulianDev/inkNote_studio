/**
 * @module features/persistence/serialization
 *
 * Serializzazione packed per IDB e history.
 *
 * Problema: 500 stroke × 100 punti = 50.000 oggetti JS per pagina.
 * Lo structured-clone (IDB) e il clone JS (history) fanno traversal
 * di ogni oggetto/property → 100-500ms di freeze su Surface Go 1.
 *
 * Soluzione: pack in Float32Array contiguo (stride 7). Lo
 * structured-clone di un Float32Array è `memcpy` nativo → <1ms
 * per 1.2 MB. Il clone JS è `Array.slice()` → idem.
 *
 * Formato packed:
 *   stride = 7 float32
 *   [x, y, pressure, tiltX, tiltY, speed, pointerTypeInt]
 *
 * pointerType mapping:
 *   0 = pen, 1 = touch, 2 = mouse, 3 = eraser
 *
 * Il runtime continua a usare `{x,y,pressure,...}` (rendering invariato).
 * Pack/unpack avvengono SOLO al confine di persistenza/history.
 *
 * Migrazione soft: gli highlighter legacy con colore nero (#000000)
 * vengono mappati al giallo default (#FFEB3B) al primo unpack.
 */

export const PACKED_STRIDE = 7;

const PT_PEN = 0;
const PT_TOUCH = 1;
const PT_MOUSE = 2;
const PT_ERASER = 3;

const HIGHLIGHTER_DEFAULT_COLOR = '#FFEB3B';

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

/**
 * Packa uno stroke runtime in formato serializzabile.
 * Ritorna { tool, color, size, packed: Float32Array, count: number }.
 */
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
    packed: buf,
    count: n
  };
}

/**
 * Unpacka uno stroke packed in formato runtime.
 * Gestisce anche input già unpacked (retrocompat): se `s.points`
 * esiste e `s.packed` no, ritorna `s` invariato.
 *
 * Migrazione soft: se `tool === 'highlighter'` e il colore è nero
 * (legacy, prima della palette colorata), sostituisce con il giallo
 * default. Questo normalizza gli stroke già salvati senza richiedere
 * una migrazione esplicita in IDB.
 */
export function unpackStroke(s) {
  if (!s) return s;

  // Già unpacked: applica solo la migrazione highlighter se serve
  if (!s.packed) {
    if (s.tool === 'highlighter' && _isLegacyBlack(s.color)) {
      return { ...s, color: HIGHLIGHTER_DEFAULT_COLOR };
    }
    return s;
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

  // Migrazione soft highlighter legacy
  let color = s.color;
  if (s.tool === 'highlighter' && _isLegacyBlack(color)) {
    color = HIGHLIGHTER_DEFAULT_COLOR;
  }

  return {
    tool: s.tool,
    color,
    size: s.size,
    points: pts
  };
}

/**
 * Pack di un array di stroke (per una pagina).
 */
export function packStrokes(strokes) {
  const n = strokes.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = packStroke(strokes[i]);
  return out;
}

/**
 * Unpack di un array di stroke.
 */
export function unpackStrokes(strokes) {
  if (!strokes) return [];
  const n = strokes.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = unpackStroke(strokes[i]);
  return out;
}