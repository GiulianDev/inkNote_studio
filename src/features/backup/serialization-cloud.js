/**
 * @module features/backup/serialization-cloud
 *
 * Serializzazione compressa per backup su file `.inknote`.
 * Isolato dal serialization.js esistente (usato per IDB): nessuna
 * modifica al flusso locale.
 *
 * Trasforma PackedStroke[] (Float32Array stride 7 = 28 byte/punto)
 * in formato quantizzato (9 byte/punto) + gzip. Risparmio ~85-90%.
 *
 * Lavoro delegato a un Web Worker per non bloccare il main thread
 * su notebook grandi.
 */

let _worker = null;
let _nextId = 1;
const _pending = new Map();

function _getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(
    new URL('./serialization-cloud.worker.js', import.meta.url),
    { type: 'module' }
  );
  _worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = _pending.get(id);
    if (!p) return;
    _pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error || 'worker error'));
  };
  _worker.onerror = (e) => {
    const err = new Error(e.message || 'worker fatal error');
    for (const p of _pending.values()) p.reject(err);
    _pending.clear();
    _worker = null;
  };
  return _worker;
}

function _call(type, payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    try {
      _getWorker().postMessage({ id, type, ...payload }, transfer);
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
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
    _worker.terminate();
    _worker = null;
    for (const p of _pending.values()) p.reject(new Error('worker terminated'));
    _pending.clear();
  }
}