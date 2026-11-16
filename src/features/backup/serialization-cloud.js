/**
 * @module features/backup/serialization-cloud
 *
 * Dispatcher: usa un Web Worker (inline, blob URL) se disponibile,
 * altrimenti fallback al main thread.
 *
 * Il worker è importato con `?worker&inline`:
 *   - Vite lo bundle e lo inlina come blob URL nel file HTML
 *   - Funziona anche quando l'HTML è aperto da file://
 *   - Se il browser blocca comunque il worker (raro), fallback
 *     al main thread: l'export/import funziona, un po' più lento.
 *
 * La logica vera è in serialization-cloud-core.js, condivisa
 * con il worker.
 */

import SerializationWorker from './serialization-cloud.worker.js?worker&inline';
import { compressPageData, decompressPageData } from './serialization-cloud-core.js';

let _worker = null;
let _workerFailed = false;
let _nextId = 1;
const _pending = new Map();

function _getWorker() {
  if (_workerFailed) return null;
  if (_worker) return _worker;
  try {
    _worker = new SerializationWorker();
    _worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = _pending.get(id);
      if (!p) return;
      _pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error || 'worker error'));
    };
    _worker.onerror = (e) => {
      // Errore fatale del worker (es. import fallito, script bloccato).
      // Rifiuta tutte le richieste pendenti e passa al fallback per le future.
      console.warn('[serialization-cloud] Worker error, fallback main thread:', e.message || e);
      const err = new Error(e.message || 'worker fatal error');
      for (const p of _pending.values()) p.reject(err);
      _pending.clear();
      _worker = null;
      _workerFailed = true;
    };
    return _worker;
  } catch (err) {
    console.warn('[serialization-cloud] Worker non disponibile, fallback main thread:', err);
    _workerFailed = true;
    return null;
  }
}

function _call(type, payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const worker = _getWorker();
    if (!worker) {
      // Fallback: esegui nel main thread (async ma stesso processo)
      _runInMainThread(type, payload).then(resolve, reject);
      return;
    }
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, type, ...payload }, transfer);
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
}

async function _runInMainThread(type, payload) {
  if (type === 'compressPage') {
    return compressPageData(payload.strokes);
  }
  if (type === 'decompressPage') {
    return decompressPageData(payload.compressed);
  }
  throw new Error(`Unknown type: ${type}`);
}

/**
 * Comprime una pagina (PackedStroke[]) in Uint8Array gzip-ato.
 *
 * @param {Array} strokesPacked — PackedStroke[] (con .packed = Float32Array)
 * @returns {Promise<Uint8Array>}
 */
export function compressPage(strokesPacked) {
  const transfer = [];
  const payload = strokesPacked.map(s => {
    // Copia il buffer: gli strokes originali servono ancora al main thread
    // (IDB, rendering). Non possiamo trasferirli direttamente.
    const copy = new Float32Array(s.packed);
    transfer.push(copy.buffer);
    return {
      tool: s.tool,
      color: s.color,
      size: s.size,
      opacity: s.opacity,
      packedBuffer: copy.buffer,
      count: s.count
    };
  });
  return _call('compressPage', { strokes: payload }, transfer);
}

/**
 * Decomprime Uint8Array gzip-ato in PackedStroke[].
 *
 * @param {Uint8Array} compressed
 * @returns {Promise<Array>} — PackedStroke[]
 */
export function decompressPage(compressed) {
  const buf = compressed.slice().buffer;
  return _call('decompressPage', { compressed: buf }, [buf]);
}

/**
 * Chiude il worker (cleanup al beforeunload).
 */
export function terminateWorker() {
  if (_worker) {
    try { _worker.terminate(); } catch (e) {}
    _worker = null;
    for (const p of _pending.values()) p.reject(new Error('worker terminated'));
    _pending.clear();
  }
}