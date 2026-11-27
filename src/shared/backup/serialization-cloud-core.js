/**
 * @module features/backup/serialization-cloud-core
 *
 * Logica pura di compressione/decompressione pagine.
 * Importata sia dal worker che dal main thread (fallback).
 *
 * Formato quantizzato (9 byte/punto):
 *   0-1: x         Uint16 LE (scalato da 0..1200, oppure meta.rx [min, max] se fuori range)
 *   2-3: y         Uint16 LE (scalato da 0..1200, oppure meta.ry [min, max] se fuori range)
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
 *     meta: JSON UTF-8 {tool, color, size, opacity, style, smoothing?, inkParams?, rx?, ry?}
 *     pointCount: uint32
 *     pointBytes: pointCount * 9
 *   → gzip di tutto
 */

import { PACKED_STRIDE, packStroke, unpackStroke } from '../persistence/serialization.js';

const QUANT_STRIDE = 9;
const DEFAULT_MAX_COORD = 1200;
const X_SCALE = 65535 / DEFAULT_MAX_COORD;
const Y_SCALE = 65535 / DEFAULT_MAX_COORD;
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

  const out = {
    tool: s.tool,
    color: s.color,
    size: s.size,
    opacity: s.opacity != null ? s.opacity : 1.0,
    style: s.style || 'solid',
    packedBuffer: copy.buffer,
    count: safeCount
  };
  if (Number.isFinite(s.smoothing)) {
    out.smoothing = s.smoothing;
  }
  if (s.inkParams && typeof s.inkParams === 'object') {
    out.inkParams = s.inkParams;
  }
  return out;
}

function _makeAxisBounds(minVal, maxVal) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return null;
  if (minVal >= 0 && maxVal <= DEFAULT_MAX_COORD) return null;
  const span = maxVal - minVal;
  const safeMax = span >= 1e-3 ? maxVal : minVal + 1;
  return [minVal, safeMax];
}

function _parseAxisBounds(raw) {
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    Number.isFinite(raw[0]) &&
    Number.isFinite(raw[1]) &&
    raw[1] > raw[0]
  ) {
    return [raw[0], raw[1]];
  }
  return null;
}

function _computeStrokeAxisBounds(stroke) {
  if (!stroke || !stroke.packedBuffer || !stroke.count) {
    return { rx: null, ry: null };
  }
  const packed = new Float32Array(stroke.packedBuffer);
  const maxByBuf = Math.floor(packed.length / PACKED_STRIDE);
  const count = Math.max(0, Math.min(stroke.count || 0, maxByBuf));
  if (count === 0) return { rx: null, ry: null };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < count; i++) {
    const pi = i * PACKED_STRIDE;
    const x = packed[pi];
    const y = packed[pi + 1];
    if (Number.isFinite(x)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (Number.isFinite(y)) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return {
    rx: _makeAxisBounds(minX, maxX),
    ry: _makeAxisBounds(minY, maxY)
  };
}

function quantizeStroke(stroke, outBuffer, outOffset, xBounds = null, yBounds = null) {
  const packed = new Float32Array(stroke.packedBuffer);
  const maxByBuf = Math.floor(packed.length / PACKED_STRIDE);
  const count = Math.max(0, Math.min(stroke.count || 0, maxByBuf));
  const xMin = xBounds ? xBounds[0] : 0;
  const xScale = xBounds ? (65535 / (xBounds[1] - xBounds[0])) : X_SCALE;
  const yMin = yBounds ? yBounds[0] : 0;
  const yScale = yBounds ? (65535 / (yBounds[1] - yBounds[0])) : Y_SCALE;

  let o = outOffset;
  for (let i = 0; i < count; i++) {
    const pi = i * PACKED_STRIDE;
    const rawX = Number.isFinite(packed[pi]) ? packed[pi] : xMin;
    const rawY = Number.isFinite(packed[pi + 1]) ? packed[pi + 1] : yMin;
    const xq = Math.max(0, Math.min(65535, Math.round((rawX - xMin) * xScale)));
    const yq = Math.max(0, Math.min(65535, Math.round((rawY - yMin) * yScale)));
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

function dequantizeStroke(buffer, pointCount, xBounds = null, yBounds = null) {
  const out = new Float32Array(pointCount * PACKED_STRIDE);
  const xMin = xBounds ? xBounds[0] : 0;
  const xSpan = xBounds ? (xBounds[1] - xBounds[0]) : DEFAULT_MAX_COORD;
  const yMin = yBounds ? yBounds[0] : 0;
  const ySpan = yBounds ? (yBounds[1] - yBounds[0]) : DEFAULT_MAX_COORD;

  for (let i = 0; i < pointCount; i++) {
    const o = i * QUANT_STRIDE;
    const pi = i * PACKED_STRIDE;
    const xq = buffer[o] | (buffer[o + 1] << 8);
    const yq = buffer[o + 2] | (buffer[o + 3] << 8);
    out[pi]     = xBounds ? (xMin + (xq / 65535) * xSpan) : (xq / X_SCALE);
    out[pi + 1] = yBounds ? (yMin + (yq / 65535) * ySpan) : (yq / Y_SCALE);
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
  const strokeBounds = [];
  let totalMetaLen = 0;
  for (const s of list) {
    const bounds = _computeStrokeAxisBounds(s);
    strokeBounds.push(bounds);
    const metaObj = {
      tool: s.tool,
      color: s.color,
      size: s.size,
      opacity: s.opacity != null ? s.opacity : 1.0,
      style: s.style || 'solid'
    };
    if (Number.isFinite(s.smoothing)) {
      metaObj.smoothing = s.smoothing;
    }
    if (s.inkParams && typeof s.inkParams === 'object') {
      metaObj.inkParams = s.inkParams;
    }
    if (bounds.rx) metaObj.rx = bounds.rx;
    if (bounds.ry) metaObj.ry = bounds.ry;
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
    const bounds = strokeBounds[i];
    dv.setUint16(o, metaBytes.length, true); o += 2;
    buffer.set(metaBytes, o); o += metaBytes.length;
    dv.setUint32(o, s.count || 0, true); o += 4;
    o += quantizeStroke(s, buffer, o, bounds.rx, bounds.ry);
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
    const xBounds = _parseAxisBounds(meta.rx);
    const yBounds = _parseAxisBounds(meta.ry);
    const packed = dequantizeStroke(pointBytes, pointCount, xBounds, yBounds);

    const strokeEntry = {
      tool: meta.tool,
      color: meta.color,
      size: meta.size,
      opacity: meta.opacity != null ? meta.opacity : 1.0,
      style: meta.style || 'solid',
      packed: packed,
      count: pointCount
    };
    if (Number.isFinite(meta.smoothing)) {
      strokeEntry.smoothing = meta.smoothing;
    }
    if (meta.inkParams && typeof meta.inkParams === 'object') {
      strokeEntry.inkParams = meta.inkParams;
    }
    strokes.push(strokeEntry);
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
 * @returns {Promise<Array<{tool, color, size, opacity, style, smoothing?, packed: Float32Array, count: number}>>}
 */
export async function decompressPageData(compressedBuf) {
  const bundle = await decompressPageBundle(compressedBuf);
  return bundle.strokes;
}

// ============================================================
// GUARD LIMITE 1 MiB FIRESTORE E CHUNKING PER SINGOLA PAGINA
// ============================================================

export const FIRESTORE_DOC_HARD_LIMIT_BYTES = 1048576; // 1 MiB limite rigido Firestore
export const FIRESTORE_PAGE_SOFT_WARNING_BYTES = 700 * 1024;
export const FIRESTORE_PAGE_MAX_SINGLE_DOC_BYTES = 850 * 1024;
export const FIRESTORE_PAGE_CHUNK_BYTES = 750 * 1024;
export const FIRESTORE_PAGE_MAX_CHUNKS = 32;

const BASE64_SOFT_WARNING_BYTES = 450 * 1024;
const BASE64_MAX_SINGLE_DOC_BYTES = 560 * 1024;
const BASE64_CHUNK_BYTES = 500 * 1024;

function _toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input && typeof input.toUint8Array === 'function') {
    return input.toUint8Array();
  }
  return new Uint8Array(0);
}

/**
 * Valuta la dimensione del bundle compresso rispetto ai limiti di Firestore.
 * Supporta sia salvataggio binario `bytes` (Firestore Bytes) sia `base64`.
 *
 * @param {Uint8Array|ArrayBuffer} compressedBytes
 * @param {object} [opts]
 * @returns {{
 *   byteLength: number,
 *   estimatedWireBytes: number,
 *   encoding: 'bytes'|'base64',
 *   warningThresholdBytes: number,
 *   singleDocLimitBytes: number,
 *   chunkByteSize: number,
 *   nearLimit: boolean,
 *   exceedsSingleDoc: boolean,
 *   utilizationRatio: number,
 *   recommendedChunkCount: number
 * }}
 */
export function measureFirestorePagePayload(compressedBytes, opts = {}) {
  const bytes = _toUint8Array(compressedBytes);
  const encoding = opts.encoding === 'base64' ? 'base64' : 'bytes';
  const defaultWarn = encoding === 'base64' ? BASE64_SOFT_WARNING_BYTES : FIRESTORE_PAGE_SOFT_WARNING_BYTES;
  const defaultMaxSingle = encoding === 'base64' ? BASE64_MAX_SINGLE_DOC_BYTES : FIRESTORE_PAGE_MAX_SINGLE_DOC_BYTES;
  const defaultChunk = encoding === 'base64' ? BASE64_CHUNK_BYTES : FIRESTORE_PAGE_CHUNK_BYTES;

  const singleDocLimitBytes = Math.max(
    1024,
    Math.min(
      FIRESTORE_DOC_HARD_LIMIT_BYTES - 32 * 1024,
      Number.isFinite(opts.maxSingleDocBytes) ? opts.maxSingleDocBytes : defaultMaxSingle
    )
  );
  const warningThresholdBytes = Math.max(
    512,
    Math.min(
      singleDocLimitBytes,
      Number.isFinite(opts.warningThresholdBytes) ? opts.warningThresholdBytes : defaultWarn
    )
  );
  const chunkByteSize = Math.max(
    1024,
    Math.min(
      singleDocLimitBytes,
      Number.isFinite(opts.chunkBytes) ? opts.chunkBytes : defaultChunk
    )
  );

  const byteLength = bytes.byteLength;
  const estimatedWireBytes = encoding === 'base64'
    ? Math.ceil(byteLength / 3) * 4
    : byteLength;
  const exceedsSingleDoc = byteLength > singleDocLimitBytes;
  const nearLimit = byteLength >= warningThresholdBytes;
  const recommendedChunkCount = exceedsSingleDoc
    ? Math.ceil(byteLength / chunkByteSize)
    : 1;

  return {
    byteLength,
    estimatedWireBytes,
    encoding,
    warningThresholdBytes,
    singleDocLimitBytes,
    chunkByteSize,
    nearLimit,
    exceedsSingleDoc,
    utilizationRatio: Math.min(10, byteLength / FIRESTORE_DOC_HARD_LIMIT_BYTES),
    recommendedChunkCount
  };
}

/**
 * Suddivide un bundle compresso in uno o più chunk binari sicuri per Firestore.
 * Se il payload rientra nel limite singolo e `forceChunking` è false, restituisce
 * un solo blocco (`chunked: false`).
 *
 * @param {Uint8Array|ArrayBuffer} compressedBytes
 * @param {object} [opts]
 * @returns {{
 *   chunked: boolean,
 *   totalBytes: number,
 *   chunkCount: number,
 *   chunks: Uint8Array[],
 *   nearLimit: boolean,
 *   exceedsSingleDoc: boolean,
 *   metrics: ReturnType<typeof measureFirestorePagePayload>
 * }}
 */
export function splitCompressedPageForFirestore(compressedBytes, opts = {}) {
  const bytes = _toUint8Array(compressedBytes);
  const metrics = measureFirestorePagePayload(bytes, opts);
  const maxChunks = Math.max(
    1,
    Number.isFinite(opts.maxChunks) ? Math.floor(opts.maxChunks) : FIRESTORE_PAGE_MAX_CHUNKS
  );

  if (metrics.exceedsSingleDoc && opts.strictSingleDoc) {
    const err = new Error(
      `La pagina supera il limite di sicurezza Firestore per singolo documento (${metrics.byteLength} B > ${metrics.singleDocLimitBytes} B)`
    );
    err.code = 'FIRESTORE_PAGE_LIMIT_EXCEEDED';
    err.byteLength = metrics.byteLength;
    err.limitBytes = metrics.singleDocLimitBytes;
    throw err;
  }

  if (!metrics.exceedsSingleDoc && !opts.forceChunking) {
    return {
      chunked: false,
      totalBytes: bytes.byteLength,
      chunkCount: 1,
      chunks: [bytes],
      nearLimit: metrics.nearLimit,
      exceedsSingleDoc: false,
      metrics
    };
  }

  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += metrics.chunkByteSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + metrics.chunkByteSize, bytes.byteLength)));
  }
  if (chunks.length === 0) {
    chunks.push(bytes);
  }

  if (chunks.length > maxChunks) {
    const err = new Error(
      `La pagina è troppo complessa per la sincronizzazione cloud (${chunks.length} chunk richiesti, massimo ${maxChunks})`
    );
    err.code = 'PAGE_PAYLOAD_TOO_LARGE';
    err.byteLength = bytes.byteLength;
    err.chunkCount = chunks.length;
    err.maxChunks = maxChunks;
    throw err;
  }

  return {
    chunked: true,
    totalBytes: bytes.byteLength,
    chunkCount: chunks.length,
    chunks,
    nearLimit: true,
    exceedsSingleDoc: metrics.exceedsSingleDoc,
    metrics
  };
}

/**
 * Ricompone i chunk binari di una pagina salvata su Firestore nell'Uint8Array originale.
 * Supporta sia array ordinati di Uint8Array/ArrayBuffer sia oggetti `{ index, data }`.
 *
 * @param {Array<Uint8Array|ArrayBuffer|{index: number, data: Uint8Array|ArrayBuffer}>} rawChunks
 * @returns {Uint8Array}
 */
export function reassembleCompressedPageFromChunks(rawChunks) {
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    throw new Error('Dati pagina mancanti');
  }

  const hasIndexedObjects = rawChunks.some(
    c => c && typeof c === 'object' && !(c instanceof Uint8Array) && !(c instanceof ArrayBuffer) && !ArrayBuffer.isView(c)
  );

  let orderedParts;
  if (hasIndexedObjects) {
    const sorted = rawChunks
      .filter(c => c && typeof c === 'object' && typeof c.index === 'number' && c.data != null)
      .slice()
      .sort((a, b) => a.index - b.index);
    if (sorted.length !== rawChunks.length) {
      throw new Error('Frammenti pagina non validi o incompleti');
    }
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].index !== i) {
        throw new Error(`Frammento pagina ${i} mancante`);
      }
    }
    orderedParts = sorted.map(c => _toUint8Array(c.data));
  } else {
    orderedParts = rawChunks.map(_toUint8Array);
  }

  const totalLen = orderedParts.reduce((sum, part) => sum + part.byteLength, 0);
  if (totalLen === 0) {
    throw new Error('Frammenti pagina vuoti');
  }

  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of orderedParts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Comprime una pagina e applica il guard sul limite Firestore (con split automatico
 * in chunk se supera la soglia di sicurezza per singolo documento).
 *
 * @param {Array} strokes
 * @param {Array} [textBoxes]
 * @param {object} [opts]
 * @returns {Promise<{
 *   compressed: Uint8Array,
 *   chunked: boolean,
 *   totalBytes: number,
 *   chunkCount: number,
 *   chunks: Uint8Array[],
 *   nearLimit: boolean,
 *   exceedsSingleDoc: boolean,
 *   metrics: ReturnType<typeof measureFirestorePagePayload>
 * }>}
 */
export async function compressPageBundleForCloud(strokes, textBoxes = [], opts = {}) {
  const compressed = await compressPageBundle(strokes, textBoxes);
  const split = splitCompressedPageForFirestore(compressed, opts);
  return {
    compressed,
    ...split
  };
}