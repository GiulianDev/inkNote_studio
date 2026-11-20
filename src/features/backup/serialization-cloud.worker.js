/**
 * Web Worker thin wrapper.
 * La logica vera è in serialization-cloud-core.js, condivisa
 * con il main thread per il fallback quando il Worker non è
 * disponibile (es. HTML aperto da file://).
 */

import {
  compressPageBundle, decompressPageData, decompressPageBundle
} from './serialization-cloud-core.js';

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'compressPage') {
      const result = await compressPageBundle(e.data.strokes, e.data.textBoxes || []);
      self.postMessage({ id, ok: true, result }, [result.buffer]);
    } else if (type === 'decompressPage') {
      const result = await decompressPageData(e.data.compressed);
      const transfer = result.map(s => s.packed.buffer);
      self.postMessage({ id, ok: true, result }, transfer);
    } else if (type === 'decompressPageBundle') {
      const result = await decompressPageBundle(e.data.compressed);
      const transfer = result.strokes.map(s => s.packed.buffer);
      self.postMessage({ id, ok: true, result }, transfer);
    } else {
      self.postMessage({ id, ok: false, error: `Unknown type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};