// ============================================================
// BINDINGS UI EDITOR
// Collega gli elementi DOM dell'editor alle rispettive funzioni.
// Chiamato una volta sola da main.js dopo il load.
// ============================================================

import {
  setTool, selectColor, updateStrokeWidth, updateSmoothing,
  toggleAutoShape, toggleTheme, toggleCompactMode, toggleSubbar,
  initCompactFullscreenSync
} from './toolbar.js';
import { openSettingsModal } from '../settings/settings.js';
import { exportToPDF } from './export.js';
import { undo, redo } from './history.js';
import { returnToLibrary, updateCurrentNotebookTitle } from './editor.js';
import {
  addNewPage, clearCurrentPage, changeBackgroundPattern, resetZoom
} from './pages.js';
import { togglePalmRejection } from './gestures.js';
import {
  clearSelection, deleteSelectedStrokes,
  previewSelectionColor, changeSelectionColor,
  previewSelectionWidth, changeSelectionWidth
} from './lasso.js';

export function bindEditorUI() {
  // --- Toolbar: tool buttons ---
  document.querySelectorAll('[id^="btnTool-"]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.id.replace('btnTool-', '')));
  });

  // --- Toolbar: auto-shape ---
  document.getElementById('btnToggleAutoShape')
    ?.addEventListener('click', toggleAutoShape);

  // --- Toolbar: smoothing ---
  document.getElementById('smoothingSlider')
    ?.addEventListener('input', (e) => updateSmoothing(e.target.value));

  // --- Toolbar: color swatches ---
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => selectColor(swatch.dataset.color, swatch));
  });

  // --- Toolbar: custom color picker ---
  document.getElementById('customColorPicker')
    ?.addEventListener('change', (e) => selectColor(e.target.value, e.target));

  // --- Toolbar: stroke width ---
  document.getElementById('strokeWidthSlider')
    ?.addEventListener('input', (e) => updateStrokeWidth(e.target.value));

  // --- Header ---
  document.getElementById('backToLibraryBtn')
    ?.addEventListener('click', returnToLibrary);
  document.getElementById('docTitle')
    ?.addEventListener('change', (e) => updateCurrentNotebookTitle(e.target.value));
  document.getElementById('compactExitBtn')
    ?.addEventListener('click', toggleCompactMode);
  document.getElementById('openSettingsBtnHeader')
    ?.addEventListener('click', openSettingsModal);
  document.getElementById('themeToggleBtn')
    ?.addEventListener('click', toggleTheme);
  document.getElementById('exportPdfBtn')
    ?.addEventListener('click', exportToPDF);

  // --- Subbar ---
  document.getElementById('addPageBtn')
    ?.addEventListener('click', addNewPage);
  document.getElementById('clearPageBtn')
    ?.addEventListener('click', clearCurrentPage);
  document.getElementById('bgPatternSelect')
    ?.addEventListener('change', (e) => changeBackgroundPattern(e.target.value));
  document.getElementById('palmRejectionCheck')
    ?.addEventListener('change', (e) => togglePalmRejection(e.target.checked));
  document.getElementById('subbarCollapseBtn')
    ?.addEventListener('click', toggleSubbar);
  document.getElementById('subbarExpandBtn')
    ?.addEventListener('click', toggleSubbar);

  // --- Zoom badge ---
  document.getElementById('resetZoomBtn')
    ?.addEventListener('click', resetZoom);

  // --- Selection menu ---
  const selColor = document.getElementById('selectionColorPicker');
  selColor?.addEventListener('input', (e) => previewSelectionColor(e.target.value));
  selColor?.addEventListener('change', (e) => changeSelectionColor(e.target.value));

  const selWidth = document.getElementById('selectionWidthSlider');
  selWidth?.addEventListener('input', (e) => previewSelectionWidth(e.target.value));
  selWidth?.addEventListener('change', (e) => changeSelectionWidth(e.target.value));

  document.getElementById('deleteSelectionBtn')
    ?.addEventListener('click', deleteSelectedStrokes);
  document.getElementById('clearSelectionBtn')
    ?.addEventListener('click', clearSelection);

  // --- Undo / Redo ---
  document.getElementById('undoBtn')?.addEventListener('click', undo);
  document.getElementById('redoBtn')?.addEventListener('click', redo);

  // --- Sync fullscreen ↔ compact ---
  initCompactFullscreenSync();
}