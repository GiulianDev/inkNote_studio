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
import {
  compressPageBundle, decompressPageData, decompressPageBundle as decompressPageBundleCore,
  prepareCloudStrokePayload,
  measureFirestorePagePayload,
  splitCompressedPageForFirestore,
  reassembleCompressedPageFromChunks
} from './serialization-cloud-core.js';

export {
  measureFirestorePagePayload,
  splitCompressedPageForFirestore,
  reassembleCompressedPageFromChunks
};

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
    return compressPageBundle(payload.strokes, payload.textBoxes || []);
  }
  if (type === 'decompressPage') {
    return decompressPageData(payload.compressed);
  }
  if (type === 'decompressPageBundle') {
    return decompressPageBundleCore(payload.compressed);
  }
  throw new Error(`Unknown type: ${type}`);
}

/**
 * Comprime una pagina (PackedStroke[] o stroke legacy + textBoxes opzionali) in Uint8Array gzip-ato.
 *
 * @param {Array} strokesPacked — PackedStroke[] (con .packed = Float32Array) o legacy
 * @param {Array} [textBoxes]
 * @returns {Promise<Uint8Array>}
 */
export function compressPage(strokesPacked, textBoxes = []) {
  const transfer = [];
  const payload = (strokesPacked || []).filter(Boolean).map(raw => {
    const item = prepareCloudStrokePayload(raw);
    transfer.push(item.packedBuffer);
    return item;
  });
  return _call('compressPage', {
    strokes: payload,
    textBoxes: Array.isArray(textBoxes) ? textBoxes : []
  }, transfer);
}

/**
 * Comprime una pagina tramite Web Worker (o fallback main thread) e applica
 * il controllo/split sul limite di 1 MiB di Firestore.
 *
 * @param {Array} strokesPacked
 * @param {Array} [textBoxes]
 * @param {object} [opts]
 * @returns {Promise<{compressed: Uint8Array, chunked: boolean, totalBytes: number, chunkCount: number, chunks: Uint8Array[], nearLimit: boolean, exceedsSingleDoc: boolean, metrics: object}>}
 */
export async function compressPageForCloud(strokesPacked, textBoxes = [], opts = {}) {
  const compressed = await compressPage(strokesPacked, textBoxes);
  const split = splitCompressedPageForFirestore(compressed, opts);
  return {
    compressed,
    ...split
  };
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
 * Decomprime Uint8Array gzip-ato in `{ strokes, textBoxes }`.
 *
 * @param {Uint8Array} compressed
 * @returns {Promise<{strokes: Array, textBoxes: Array}>}
 */
export function decompressPageBundle(compressed) {
  const buf = compressed.slice().buffer;
  return _call('decompressPageBundle', { compressed: buf }, [buf]);
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