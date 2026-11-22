/**
 * @module features/backup/serialization-cloud-core
 *
 * Logica pura di compressione/decompressione pagine.
 * Importata sia dal worker che dal main thread (fallback).
 *
 * Formato quantizzato (9 byte/punto):
 *   0-1: x         Uint16 LE (scalato da 0..1200)
 *   2-3: y         Uint16 LE (scalato da 0..1200)
 *   4:   pressure  Uint8 (0..1 → 0..255)
 *   5:   tiltX     Int8 (-90..90 → -128..127)
 *   6:   tiltY     Int8
 *   7:   speed     Uint8 (0..10 → 0..255)
 *   8:   pointerType Uint8 (0..3)
 *
 * Struttura buffer compresso:
 *   strokeCount: uint32
 *   per ogni stroke:
 *     metaLen: uint16
 *     meta: JSON UTF-8 {tool, color, size, opacity}
 *     pointCount: uint32
 *     pointBytes: pointCount * 9
 *   → gzip di tutto
 */

import { PACKED_STRIDE, packStroke, unpackStroke } from '../persistence/serialization.js';

const QUANT_STRIDE = 9;
const X_SCALE = 65535 / 1200;
const Y_SCALE = 65535 / 1200;
const TILT_SCALE = 128 / 90;
const SPEED_SCALE = 255 / 10;

function _isLegacyBlack(c) {
  return !c || c === '#000000' || c === '#000' || c === 'black';
}

/**
 * Normalizza uno stroke (packed v4 o legacy con `points`) nel formato
 * trasferibile verso il worker di compressione.
 *
 * @param {object} raw
 * @returns {{tool: string, color: string, size: number, opacity: number, style: string, packedBuffer: ArrayBuffer, count: number}}
 */
export function prepareCloudStrokePayload(raw) {
  const needsUpgrade =
    !raw.packed ||
    raw.count == null ||
    raw.opacity == null ||
    (raw.tool === 'highlighter' && _isLegacyBlack(raw.color));

  const s = needsUpgrade ? packStroke(unpackStroke(raw)) : raw;
  // Copia il buffer: gli strokes originali servono ancora al main thread
  // (IDB, rendering). Non possiamo trasferirli direttamente.
  const copy = new Float32Array(s.packed || 0);
  const maxByBuf = Math.floor(copy.length / PACKED_STRIDE);
  const safeCount = Math.max(0, Math.min(s.count != null ? s.count : maxByBuf, maxByBuf));

  return {
    tool: s.tool,
    color: s.color,
    size: s.size,
    opacity: s.opacity != null ? s.opacity : 1.0,
    style: s.style || 'solid',
    packedBuffer: copy.buffer,
    count: safeCount
  };
}

function quantizeStroke(stroke, outBuffer, outOffset) {
  const packed = new Float32Array(stroke.packedBuffer);
  const maxByBuf = Math.floor(packed.length / PACKED_STRIDE);
  const count = Math.max(0, Math.min(stroke.count || 0, maxByBuf));
  let o = outOffset;
  for (let i = 0; i < count; i++) {
    const pi = i * PACKED_STRIDE;
    const xq = Math.max(0, Math.min(65535, Math.round(packed[pi] * X_SCALE)));
    const yq = Math.max(0, Math.min(65535, Math.round(packed[pi + 1] * Y_SCALE)));
    const pq = Math.max(0, Math.min(255, Math.round(packed[pi + 2] * 255)));
    const txq = Math.max(-128, Math.min(127, Math.round(packed[pi + 3] * TILT_SCALE)));
    const tyq = Math.max(-128, Math.min(127, Math.round(packed[pi + 4] * TILT_SCALE)));
    const spq = Math.max(0, Math.min(255, Math.round(packed[pi + 5] * SPEED_SCALE)));
    const ptq = Math.max(0, Math.min(3, Math.round(packed[pi + 6])));

    outBuffer[o]     = xq & 0xFF;
    outBuffer[o + 1] = (xq >> 8) & 0xFF;
    outBuffer[o + 2] = yq & 0xFF;
    outBuffer[o + 3] = (yq >> 8) & 0xFF;
    outBuffer[o + 4] = pq;
    outBuffer[o + 5] = txq & 0xFF;
    outBuffer[o + 6] = tyq & 0xFF;
    outBuffer[o + 7] = spq;
    outBuffer[o + 8] = ptq;
    o += QUANT_STRIDE;
  }
  return o - outOffset;
}

function dequantizeStroke(buffer, pointCount) {
  const out = new Float32Array(pointCount * PACKED_STRIDE);
  for (let i = 0; i < pointCount; i++) {
    const o = i * QUANT_STRIDE;
    const pi = i * PACKED_STRIDE;
    const xq = buffer[o] | (buffer[o + 1] << 8);
    const yq = buffer[o + 2] | (buffer[o + 3] << 8);
    out[pi]     = xq / X_SCALE;
    out[pi + 1] = yq / Y_SCALE;
    out[pi + 2] = buffer[o + 4] / 255;
    let txq = buffer[o + 5]; if (txq > 127) txq -= 256;
    let tyq = buffer[o + 6]; if (tyq > 127) tyq -= 256;
    out[pi + 3] = txq / TILT_SCALE;
    out[pi + 4] = tyq / TILT_SCALE;
    out[pi + 5] = buffer[o + 7] / SPEED_SCALE;
    out[pi + 6] = buffer[o + 8];
  }
  return out;
}

async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') {
    // Browser molto vecchi: nessuna compressione (funziona, occupa più spazio)
    return bytes;
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    return bytes;
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const TEXTBOX_TRAILER_MAGIC = 0x54585442; // "TXTB"
const VALID_TEXT_FONTS = new Set(['sans', 'serif', 'mono', 'hand']);
const VALID_TEXT_ALIGNS = new Set(['left', 'center', 'right']);

function _normalizeCloudTextBoxes(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text.trim()) continue;
    const fontSize = typeof raw.fontSize === 'number'
      ? Math.max(10, Math.min(72, Math.round(raw.fontSize)))
      : 18;
    const width = typeof raw.width === 'number'
      ? Math.max(80, Math.min(778, raw.width))
      : 260;
    const height = typeof raw.height === 'number'
      ? Math.max(24, raw.height)
      : Math.ceil(fontSize * 1.35 + 16);
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `tb_${i}_${Date.now().toString(36)}`,
      x: typeof raw.x === 'number' ? raw.x : 40,
      y: typeof raw.y === 'number' ? raw.y : 60,
      width,
      height,
      text,
      fontFamily: VALID_TEXT_FONTS.has(raw.fontFamily) ? raw.fontFamily : 'sans',
      fontSize,
      bold: !!raw.bold,
      italic: !!raw.italic,
      align: VALID_TEXT_ALIGNS.has(raw.align) ? raw.align : 'left',
      color: typeof raw.color === 'string' && raw.color ? raw.color : '#000000'
    });
  }
  return out;
}

/**
 * Comprime tratti + caselle di testo (trailer 'TXTB' opzionale) in Uint8Array gzip-ato.
 * @param {Array<{tool, color, size, opacity, style, packedBuffer: ArrayBuffer, count: number}>} strokes
 * @param {Array<object>} [textBoxes]
 * @returns {Promise<Uint8Array>}
 */
export async function compressPageBundle(strokes, textBoxes = []) {
  const list = Array.isArray(strokes) ? strokes : [];
  let totalPoints = 0;
  for (const s of list) totalPoints += (s.count || 0);

  const encoder = new TextEncoder();
  const metaBuffers = [];
  let totalMetaLen = 0;
  for (const s of list) {
    const metaObj = {
      tool: s.tool,
      color: s.color,
      size: s.size,
      opacity: s.opacity != null ? s.opacity : 1.0,
      style: s.style || 'solid'
    };
    const metaBytes = encoder.encode(JSON.stringify(metaObj));
    metaBuffers.push(metaBytes);
    totalMetaLen += 2 + metaBytes.length + 4;
  }

  const normalizedTB = _normalizeCloudTextBoxes(textBoxes);
  const tbBytes = normalizedTB.length > 0
    ? encoder.encode(JSON.stringify(normalizedTB))
    : null;
  const trailerLen = tbBytes ? (4 + 4 + tbBytes.length) : 0;

  const totalLen = 4 + totalMetaLen + totalPoints * QUANT_STRIDE + trailerLen;
  const buffer = new Uint8Array(totalLen);
  const dv = new DataView(buffer.buffer);

  let o = 0;
  dv.setUint32(o, list.length, true); o += 4;

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const metaBytes = metaBuffers[i];
    dv.setUint16(o, metaBytes.length, true); o += 2;
    buffer.set(metaBytes, o); o += metaBytes.length;
    dv.setUint32(o, s.count || 0, true); o += 4;
    o += quantizeStroke(s, buffer, o);
  }

  if (tbBytes) {
    dv.setUint32(o, TEXTBOX_TRAILER_MAGIC, true); o += 4;
    dv.setUint32(o, tbBytes.length, true); o += 4;
    buffer.set(tbBytes, o); o += tbBytes.length;
  }

  return gzip(buffer);
}

/**
 * Comprime un array di PackedStroke in Uint8Array gzip-ato.
 * @param {Array<{tool, color, size, opacity, style, packedBuffer: ArrayBuffer, count: number}>} strokes
 * @returns {Promise<Uint8Array>}
 */
export async function compressPageData(strokes) {
  return compressPageBundle(strokes, []);
}

/**
 * Decomprime Uint8Array gzip-ato in `{ strokes, textBoxes }`.
 * Retrocompatibile con chunk privi di trailer 'TXTB'.
 * @param {ArrayBuffer} compressedBuf
 * @returns {Promise<{strokes: Array, textBoxes: Array}>}
 */
export async function decompressPageBundle(compressedBuf) {
  const bytes = new Uint8Array(compressedBuf);
  const raw = await gunzip(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let o = 0;
  const strokeCount = dv.getUint32(o, true); o += 4;

  const decoder = new TextDecoder();
  const strokes = [];

  for (let i = 0; i < strokeCount; i++) {
    const metaLen = dv.getUint16(o, true); o += 2;
    const metaBytes = raw.subarray(o, o + metaLen); o += metaLen;
    const meta = JSON.parse(decoder.decode(metaBytes));

    const pointCount = dv.getUint32(o, true); o += 4;
    const pointBytes = raw.subarray(o, o + pointCount * QUANT_STRIDE); o += pointCount * QUANT_STRIDE;
    const packed = dequantizeStroke(pointBytes, pointCount);

    strokes.push({
      tool: meta.tool,
      color: meta.color,
      size: meta.size,
      opacity: meta.opacity != null ? meta.opacity : 1.0,
      style: meta.style || 'solid',
      packed: packed,
      count: pointCount
    });
  }

  let textBoxes = [];
  if (o + 8 <= raw.byteLength) {
    const magic = dv.getUint32(o, true);
    if (magic === TEXTBOX_TRAILER_MAGIC) {
      o += 4;
      const tbLen = dv.getUint32(o, true); o += 4;
      if (tbLen > 0 && o + tbLen <= raw.byteLength) {
        try {
          const parsed = JSON.parse(decoder.decode(raw.subarray(o, o + tbLen)));
          textBoxes = _normalizeCloudTextBoxes(parsed);
        } catch {
          textBoxes = [];
        }
      }
    }
  }

  return { strokes, textBoxes };
}

/**
 * Decomprime Uint8Array gzip-ato in array di PackedStroke.
 * @param {ArrayBuffer} compressedBuf
 * @returns {Promise<Array<{tool, color, size, opacity, style, packed: Float32Array, count: number}>>}
 */
export async function decompressPageData(compressedBuf) {
  const bundle = await decompressPageBundle(compressedBuf);
  return bundle.strokes;
}