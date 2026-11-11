// ============================================================
// BINDINGS UI EDITOR
// Collega gli elementi DOM dell'editor alle rispettive funzioni.
// Chiamato una volta sola da main.js dopo il load.
//
// NOTA: gli elementi della toolbar (tool buttons, auto-shape,
// smoothing, colori, stroke width, eraser menu) sono gestiti
// internamente da features/toolbar/toolbar.js. Qui restano solo
// i bind "editor-specifici" e gli header/subbar actions.
// ============================================================

import { state } from '../../core/state.js';
import { updateSettings, getSettings } from '../../core/app-settings.js';
import {
  setTool, selectColor, updateStrokeWidth, updateSmoothing,
  toggleAutoShape, toggleTheme, toggleCompactMode, toggleSubbar,
  initCompactFullscreenSync, applyActiveToolToUI
} from '../toolbar/toolbar.js';
import { updateToolbarSettings, getToolbarSettings } from '../toolbar/toolbar-settings.js';
import { openSettingsModal } from '../settings/settings-modal.js';
import { exportToPDF } from './export-pdf.js';
import { undo, redo } from '../history/history.js';
import { returnToLibrary, updateCurrentNotebookTitle } from './editor.js';
import {
  addNewPage, clearCurrentPage, changeBackgroundPattern, resetZoom
} from './pages.js';
import { togglePalmRejection } from '../viewport/gestures.js';
import {
  clearSelection, deleteSelectedStrokes,
  previewSelectionColor, changeSelectionColor,
  previewSelectionWidth, changeSelectionWidth
} from '../tools/lazo.js';

export function bindEditorUI() {
  // --- Toolbar: tool buttons (eraser gestito separatamente in toolbar.js) ---
  document.querySelectorAll('[id^="btnTool-"]').forEach(btn => {
    if (btn.id === 'btnTool-eraser') return;
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

  // Palm rejection: globale (app-settings)
  document.getElementById('palmRejectionCheck')
    ?.addEventListener('change', (e) => {
      updateSettings({ palmRejection: e.target.checked });
      togglePalmRejection(e.target.checked);
    });

  // Eraser mode: per-notebook (toolbar-settings)
  document.getElementById('eraserModeSelect')
    ?.addEventListener('change', (e) => {
      updateToolbarSettings({ eraserMode: e.target.value });
    });

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

  // --- Sincronizza controlli con lo stato corrente ---
  applyActiveToolToUI();
  applySmoothingToUI();
  applyPalmRejectionToUI();
  applyEraserModeToUI();
}

function applySmoothingToUI() {
  const s = getToolbarSettings();
  const slider = document.getElementById('smoothingSlider');
  const label  = document.getElementById('smoothingValue');
  if (slider) slider.value = s.smoothing;
  if (label)  label.innerText = s.smoothing;
}

function applyPalmRejectionToUI() {
  const check = document.getElementById('palmRejectionCheck');
  if (check) check.checked = getSettings().palmRejection !== false;
}

function applyEraserModeToUI() {
  const sel = document.getElementById('eraserModeSelect');
  if (sel) sel.value = getToolbarSettings().eraserMode;
}