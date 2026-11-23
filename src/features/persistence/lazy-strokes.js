/**
 * @module features/persistence/lazy-strokes
 *
 * Definisce una proprietà `strokes` con decompressione lazy su un oggetto pagina:
 * i tratti packed caricati da IndexedDB vengono espansi in oggetti punto solo al
 * primo accesso effettivo (rendering, modifica, export), evitando allocazioni
 * inutili all'apertura di quaderni con molte pagine.
 */

/**
 * Collega la proprietà `strokes` (enumerabile, configurabile) a `target`.
 *
 * @template T extends object
 * @param {T} target
 * @param {Array} rawStrokes
 * @param {(raw: Array) => Array} unpackFn
 * @param {{ alreadyUnpacked?: boolean }} [opts]
 * @returns {T}
 */
export function attachLazyStrokes(target, rawStrokes, unpackFn, opts = {}) {
  const hasRaw = Array.isArray(rawStrokes) && rawStrokes.length > 0;
  if (opts.alreadyUnpacked || !hasRaw || typeof unpackFn !== 'function') {
    target.strokes = Array.isArray(rawStrokes) ? rawStrokes : [];
    return target;
  }

  let pendingRaw = rawStrokes;
  let cached = null;

  Object.defineProperty(target, 'strokes', {
    enumerable: true,
    configurable: true,
    get() {
      if (cached === null) {
        const raw = pendingRaw;
        pendingRaw = null;
        cached = raw ? unpackFn(raw) : [];
      }
      return cached;
    },
    set(val) {
      pendingRaw = null;
      cached = Array.isArray(val) ? val : [];
    }
  });

  return target;
}
