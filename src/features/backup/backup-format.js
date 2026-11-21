/**
 * @module features/backup/backup-format
 *
 * Container `.inknote` — formato multi-notebook.
 * Supporta lettura v1 (solo pageIndex) e lettura/scrittura v2 (pageOrder con pageId).
 */

import { generatePageId } from '../../core/utils.js';
import { compressPage, decompressPageBundle } from './serialization-cloud.js';

export const MAGIC = 0x494E4B4E; // "INKN"
export const VERSION = 2;

export async function serializeBackup(notebooks, onProgress) {
  const chunks = [];
  const encoder = new TextEncoder();

  let totalPages = 0;
  for (const nb of notebooks) {
    totalPages += (nb.pages && nb.pages.length) || 0;
  }
  let donePages = 0;

  const header = new Uint8Array(12);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, MAGIC, false);
  dv.setUint16(4, VERSION, false);
  dv.setUint16(6, 0, false);
  dv.setUint32(8, notebooks.length, false);
  chunks.push(header);

  for (const nb of notebooks) {
    const pageCount = (nb.pages && nb.pages.length) || 0;
    const pageOrder = new Array(pageCount);
    for (let i = 0; i < pageCount; i++) {
      const p = nb.pages[i];
      pageOrder[i] = (p && p.pageId) || (nb.pageOrder && nb.pageOrder[i]) || generatePageId();
    }

    const meta = {
      id: nb.id,
      title: nb.title || '',
      coverColor: nb.coverColor || '#4f46e5',
      pattern: nb.pattern || 'ruled',
      isFavorite: !!nb.isFavorite,
      createdAt: nb.createdAt || new Date().toISOString(),
      updatedAt: nb.updatedAt || new Date().toISOString(),
      lastEditAt: nb.lastEditAt || nb.updatedAt || new Date().toISOString(),
      pageCount,
      pageOrder,
      lastPageIndex: nb.lastPageIndex || 0,
      toolbarSettings: nb.toolbarSettings || null
    };
    const metaBytes = encoder.encode(JSON.stringify(meta));

    const nbHeader = new Uint8Array(4 + metaBytes.length + 4);
    const nbDv = new DataView(nbHeader.buffer);
    nbDv.setUint32(0, metaBytes.length, false);
    nbHeader.set(metaBytes, 4);
    nbDv.setUint32(4 + metaBytes.length, pageCount, false);
    chunks.push(nbHeader);

    for (let i = 0; i < pageCount; i++) {
      const page = nb.pages[i];
      const strokes = (page && page.strokes) || [];
      const textBoxes = (page && Array.isArray(page.textBoxes)) ? page.textBoxes : [];
      const compressed = await compressPage(strokes, textBoxes);

      const pageHeader = new Uint8Array(8);
      const pageDv = new DataView(pageHeader.buffer);
      pageDv.setUint32(0, i, false);
      pageDv.setUint32(4, compressed.length, false);
      chunks.push(pageHeader);
      chunks.push(compressed);

      donePages++;
      if (onProgress) {
        onProgress({ done: donePages, total: totalPages, notebookTitle: nb.title || '' });
      }
    }
  }

  return new Blob(chunks, { type: 'application/octet-stream' });
}

export async function deserializeBackup(input, onProgress) {
  const buffer = input instanceof Blob ? await input.arrayBuffer() : input;
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  if (bytes.length < 12) throw new Error('File troppo corto');
  const magic = dv.getUint32(0, false);
  if (magic !== MAGIC) throw new Error('File non valido (magic mismatch)');
  const version = dv.getUint16(4, false);
  if (version !== 1 && version !== VERSION) {
    throw new Error(`Versione ${version} non supportata (attesa <= ${VERSION})`);
  }
  const notebookCount = dv.getUint32(8, false);

  let o = 12;
  const decoder = new TextDecoder();
  const notebooks = [];
  let totalPages = 0;

  for (let ni = 0; ni < notebookCount; ni++) {
    if (o + 4 > bytes.length) throw new Error('File troncato (metaLen)');
    const metaLen = dv.getUint32(o, false); o += 4;
    if (o + metaLen + 4 > bytes.length) throw new Error('File troncato (meta)');
    o += metaLen;
    const pageCount = dv.getUint32(o, false); o += 4;
    totalPages += pageCount;
    for (let pi = 0; pi < pageCount; pi++) {
      if (o + 8 > bytes.length) throw new Error('File troncato (pageHeader)');
      const pageLen = dv.getUint32(o + 4, false);
      o += 8;
      if (o + pageLen > bytes.length) throw new Error('File troncato (pageData)');
      o += pageLen;
    }
  }

  o = 12;
  let donePages = 0;
  for (let ni = 0; ni < notebookCount; ni++) {
    const metaLen = dv.getUint32(o, false); o += 4;
    const metaBytes = bytes.slice(o, o + metaLen); o += metaLen;
    const meta = JSON.parse(decoder.decode(metaBytes));

    const order = Array.isArray(meta.pageOrder) ? meta.pageOrder : [];
    const pageCount = dv.getUint32(o, false); o += 4;
    const pages = [];
    const normalizedOrder = [];

    for (let pi = 0; pi < pageCount; pi++) {
      o += 4;
      const pageLen = dv.getUint32(o, false); o += 4;
      const compressed = bytes.slice(o, o + pageLen); o += pageLen;
      const { strokes, textBoxes } = await decompressPageBundle(compressed);

      const pageId = (order[pi] && typeof order[pi] === 'string') ? order[pi] : generatePageId();
      normalizedOrder.push(pageId);
      pages.push({ pageId, strokes, textBoxes });

      donePages++;
      if (onProgress) {
        onProgress({ done: donePages, total: totalPages, notebookTitle: meta.title || '' });
      }
    }

    notebooks.push({
      ...meta,
      pageOrder: normalizedOrder,
      pageCount: normalizedOrder.length,
      pages
    });
  }

  return { notebooks };
}

export async function peekBackup(input) {
  const buffer = input instanceof Blob ? await input.arrayBuffer() : input;
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  if (bytes.length < 12) throw new Error('File troppo corto');
  const magic = dv.getUint32(0, false);
  if (magic !== MAGIC) throw new Error('File non valido (magic mismatch)');
  const version = dv.getUint16(4, false);
  if (version !== 1 && version !== VERSION) {
    throw new Error(`Versione ${version} non supportata`);
  }
  const notebookCount = dv.getUint32(8, false);

  let o = 12;
  const decoder = new TextDecoder();
  const result = [];

  for (let ni = 0; ni < notebookCount; ni++) {
    if (o + 4 > bytes.length) throw new Error('File troncato (metaLen)');
    const metaLen = dv.getUint32(o, false); o += 4;
    if (o + metaLen + 4 > bytes.length) throw new Error('File troncato (meta)');
    const metaBytes = bytes.slice(o, o + metaLen); o += metaLen;
    const meta = JSON.parse(decoder.decode(metaBytes));

    const pageCount = dv.getUint32(o, false); o += 4;
    result.push({ meta, pageCount });

    for (let pi = 0; pi < pageCount; pi++) {
      if (o + 8 > bytes.length) throw new Error('File troncato (pageHeader)');
      o += 4;
      const pageLen = dv.getUint32(o, false); o += 4;
      if (o + pageLen > bytes.length) throw new Error('File troncato (pageData)');
      o += pageLen;
    }
  }

  return result;
}