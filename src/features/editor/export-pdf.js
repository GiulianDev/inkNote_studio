// ============================================================
// EXPORT PDF + FULLSCREEN
// ============================================================

import { state } from '../../core/state.js';
import { getSettings } from '../../core/app-settings.js';
import { finalizePendingShape } from '../tools/shapes.js';
import { clearOverlay, redrawPageCanvas } from '../render/render.js';
import { resizeCanvasForHDPI, refreshCanvasResolution } from './pages.js';

export function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}

export function exportToPDF() {
  if (state.pendingShape) finalizePendingShape();
  const settings = getSettings();
  const printDark = settings.printTheme === 'dark';
  const PRINT_DPR = Math.min((window.devicePixelRatio || 1) * 2, 4);

  state.pages.forEach(p => {
    p.strokes.forEach(s => { s._styleCache = null; });
    clearOverlay(p);
    resizeCanvasForHDPI(p, PRINT_DPR);
    redrawPageCanvas(p, printDark);
  });
  document.body.classList.toggle('print-dark', printDark);
  document.body.classList.toggle('print-light', !printDark);

  const restore = () => {
    refreshCanvasResolution(true);
    document.body.classList.remove('print-dark', 'print-light');
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  setTimeout(() => window.print(), 150);
}