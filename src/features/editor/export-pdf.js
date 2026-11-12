// ============================================================
// EXPORT PDF + FULLSCREEN
// Riscritto per funzionare con il pool: crea canvas offscreen
// per ogni pagina, popola un div di stampa, invoca print().
// ============================================================

import { state } from '../../core/state.js';
import { getSettings } from '../../core/app-settings.js';
import { finalizePendingShape } from '../tools/shapes.js';
import { redrawPageCanvas } from '../render/render.js';
import { PAGE_WIDTH, PAGE_HEIGHT } from '../../core/utils.js';

export function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}

export function exportToPDF() {
  if (state.pendingShape) finalizePendingShape();
  const settings = getSettings();
  const printDark = settings.printTheme === 'dark';

  // Container di stampa
  const printDiv = document.createElement('div');
  printDiv.id = 'printContainer';
  printDiv.className = printDark ? 'print-dark' : 'print-light';

  const dpr = 2;
  state.pages.forEach((pageData) => {
    const c = document.createElement('canvas');
    c.width = Math.floor(PAGE_WIDTH * dpr);
    c.height = Math.floor(PAGE_HEIGHT * dpr);
    const ctx = c.getContext('2d');

    // pageData "fake" con canvas offscreen: redrawPageCanvas usa
    // pageData.ctx/.dpr. Non tocchiamo lo slot reale.
    const fake = {
      canvas: c, ctx, dpr,
      overlayCanvas: null, overlayCtx: null, overlayDpr: 0,
      strokes: pageData.strokes,
      index: pageData.index, wrapper: pageData.wrapper
    };
    pageData.strokes.forEach(s => { s._styleCache = null; });
    redrawPageCanvas(fake, printDark);

    const img = document.createElement('img');
    img.src = c.toDataURL('image/png');
    img.style.width = '100%';
    img.style.display = 'block';
    img.style.pageBreakAfter = 'always';
    printDiv.appendChild(img);
  });

  document.body.appendChild(printDiv);
  document.body.classList.add('printing-pdf');

  const cleanup = () => {
    try { document.body.removeChild(printDiv); } catch (e) {}
    document.body.classList.remove('printing-pdf');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  setTimeout(() => window.print(), 200);
}