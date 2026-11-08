// ============================================================
// BINDINGS UI EDITOR
// Collega gli elementi DOM dell'editor alle rispettive funzioni.
// Chiamato una volta sola da main.js dopo il load.
// ============================================================

import { state } from '../../core/state.js';
import {
  setTool, selectColor, updateStrokeWidth, updateSmoothing,
  toggleAutoShape, toggleTheme, toggleCompactMode, toggleSubbar,
  initCompactFullscreenSync, loadEraserSize, showEraserSizeMenu,
  hideEraserSizeMenu, selectEraserLevel
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
  // --- Toolbar: tool buttons (eraser gestito separatamente) ---
  document.querySelectorAll('[id^="btnTool-"]').forEach(btn => {
    if (btn.id === 'btnTool-eraser') return;
    btn.addEventListener('click', () => setTool(btn.id.replace('btnTool-', '')));
  });

  // --- Toolbar: eraser con long-press / contextmenu per il menu spessori ---
  setupEraserButton();

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

  // --- Eraser: carica livello salvato + setup menu ---
  state.eraserSize = loadEraserSize();
}

// ============================================================
// ERASER LONG-PRESS (popup scelta spessore)
// ============================================================

function setupEraserButton() {
  const btn = document.getElementById('btnTool-eraser');
  const menu = document.getElementById('eraserSizeMenu');
  if (!btn || !menu) return;

  let pressTimer = null;
  let skipNextClick = false;

  const cancelTimer = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // solo sinistro
    skipNextClick = false;
    cancelTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      skipNextClick = true;
      showEraserSizeMenu();
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (err) {} }
    }, 500);
  });

  btn.addEventListener('pointerup', cancelTimer);
  btn.addEventListener('pointercancel', () => {
    cancelTimer();
    skipNextClick = true;
  });
  btn.addEventListener('pointerleave', cancelTimer);

  btn.addEventListener('click', (e) => {
    if (skipNextClick) {
      skipNextClick = false;
      e.preventDefault();
      return;
    }
    setTool('eraser');
  });

  // Tasto destro (desktop) → menu
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancelTimer();
    showEraserSizeMenu();
  });

  // Click sui livelli
  menu.querySelectorAll('[data-eraser-level]').forEach(levelBtn => {
    levelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lvl = parseInt(levelBtn.dataset.eraserLevel);
      if (lvl >= 1 && lvl <= 5) selectEraserLevel(lvl);
      // Se non stiamo già usando l'eraser, attivalo
      if (state.activeTool !== 'eraser') setTool('eraser');
    });
  });

  // Click fuori → chiude
  document.addEventListener('pointerdown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    hideEraserSizeMenu();
  });
}