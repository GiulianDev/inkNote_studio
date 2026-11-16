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

const QUANT_STRIDE = 9;
const X_SCALE = 65535 / 1200;
const Y_SCALE = 65535 / 1200;
const TILT_SCALE = 128 / 90;
const SPEED_SCALE = 255 / 10;

function quantizeStroke(stroke, outBuffer, outOffset) {
  const packed = new Float32Array(stroke.packedBuffer);
  const count = stroke.count;
  let o = outOffset;
  for (let i = 0; i < count; i++) {
    const pi = i * 7;
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
  const out = new Float32Array(pointCount * 7);
  for (let i = 0; i < pointCount; i++) {
    const o = i * QUANT_STRIDE;
    const pi = i * 7;
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

/**
 * Comprime un array di PackedStroke in Uint8Array gzip-ato.
 * @param {Array<{tool, color, size, opacity, packedBuffer: ArrayBuffer, count: number}>} strokes
 * @returns {Promise<Uint8Array>}
 */
export async function compressPageData(strokes) {
  let totalPoints = 0;
  for (const s of strokes) totalPoints += s.count;

  const encoder = new TextEncoder();
  const metaBuffers = [];
  let totalMetaLen = 0;
  for (const s of strokes) {
    const metaObj = { tool: s.tool, color: s.color, size: s.size, opacity: s.opacity };
    const metaBytes = encoder.encode(JSON.stringify(metaObj));
    metaBuffers.push(metaBytes);
    totalMetaLen += 2 + metaBytes.length + 4;
  }

  const totalLen = 4 + totalMetaLen + totalPoints * QUANT_STRIDE;
  const buffer = new Uint8Array(totalLen);
  const dv = new DataView(buffer.buffer);

  let o = 0;
  dv.setUint32(o, strokes.length, true); o += 4;

  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const metaBytes = metaBuffers[i];
    dv.setUint16(o, metaBytes.length, true); o += 2;
    buffer.set(metaBytes, o); o += metaBytes.length;
    dv.setUint32(o, s.count, true); o += 4;
    o += quantizeStroke(s, buffer, o);
  }

  return gzip(buffer);
}

/**
 * Decomprime Uint8Array gzip-ato in array di PackedStroke.
 * @param {ArrayBuffer} compressedBuf
 * @returns {Promise<Array<{tool, color, size, opacity, packed: Float32Array, count: number}>>}
 */
export async function decompressPageData(compressedBuf) {
  const bytes = new Uint8Array(compressedBuf);
  const raw = await gunzip(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let o = 0;
  const strokeCount = dv.getUint32(o, true); o += 4;

  const decoder = new TextDecoder();
  const strokes = [];

  for (let i = 0; i < strokeCount; i++) {
    const metaLen = dv.getUint16(o, true); o += 2;
    const metaBytes = raw.slice(o, o + metaLen); o += metaLen;
    const meta = JSON.parse(decoder.decode(metaBytes));

    const pointCount = dv.getUint32(o, true); o += 4;
    const pointBytes = raw.slice(o, o + pointCount * QUANT_STRIDE); o += pointCount * QUANT_STRIDE;
    const packed = dequantizeStroke(pointBytes, pointCount);

    strokes.push({
      tool: meta.tool,
      color: meta.color,
      size: meta.size,
      opacity: meta.opacity,
      packed: packed,
      count: pointCount
    });
  }

  return strokes;
}