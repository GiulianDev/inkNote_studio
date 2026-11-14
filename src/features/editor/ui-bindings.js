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
  initCompactFullscreenSync
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
  // (applyActiveToolToUI è chiamato da setTool + toolbar-settings init;
  // qui non serve ripeterlo.)
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

// ============================================================
// UNDO/REDO DRAG — spostabile con long-press
// ============================================================

const UNDO_REDO_POS_KEY = 'inknote_undo_redo_pos';
const UNDO_REDO_DRAG_PRESS_MS = 350;
const UNDO_REDO_MARGIN = 8;

function initUndoRedoDrag() {
  const el = document.getElementById('undoRedoContainer');
  if (!el) return;

  // Clamp ai bordi del viewport: usato sia al restore iniziale
  // sia durante il drag, per evitare che il container finisca
  // fuori schermo su resize.
  const clampToViewport = (x, y) => {
    const w = el.offsetWidth || 100;
    const h = el.offsetHeight || 44;
    const maxX = window.innerWidth - w - UNDO_REDO_MARGIN;
    const maxY = window.innerHeight - h - UNDO_REDO_MARGIN;
    return {
      x: Math.max(UNDO_REDO_MARGIN, Math.min(maxX, x)),
      y: Math.max(UNDO_REDO_MARGIN, Math.min(maxY, y))
    };
  };

  // Ripristina posizione salvata (se presente). Se fuori viewport
  // (es. resize), clampa.
  try {
    const raw = localStorage.getItem(UNDO_REDO_POS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        const pos = clampToViewport(saved.x, saved.y);
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
      }
    }
  } catch {}

  let pressTimer = null;
  let dragging = false;
  let startX = 0, startY = 0;
  let origX = 0, origY = 0;
  let skipNextClick = false;

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  el.addEventListener('pointerdown', (e) => {
    // Solo click sinistro (mouse). Touch/penna sempre validi.
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origX = rect.left;
    origY = rect.top;
    dragging = false;
    skipNextClick = false;

    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      dragging = true;
      skipNextClick = true;
      el.style.cursor = 'grabbing';
      el.style.transition = 'none';
      el.style.willChange = 'left, top';
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
    }, UNDO_REDO_DRAG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) {
      // Se l'utente muove prima del long-press (>8px), annulla il
      // press: probabilmente è un movimento/scroll, non un long-press.
      if (pressTimer) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.hypot(dx, dy) > 8) cancelPress();
      }
      return;
    }
    // Trascinamento attivo: aggiorna posizione con clamp.
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const pos = clampToViewport(origX + dx, origY + dy);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  });

  const endDrag = (e) => {
    cancelPress();
    if (!dragging) return;
    dragging = false;
    el.style.cursor = '';
    el.style.transition = '';
    el.style.willChange = '';
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}

    // Salva la nuova posizione
    const rect = el.getBoundingClientRect();
    try {
      localStorage.setItem(UNDO_REDO_POS_KEY, JSON.stringify({
        x: Math.round(rect.left),
        y: Math.round(rect.top)
      }));
    } catch {}

    // Lascia passare il click successivo (evita undo/redo accidentale)
    setTimeout(() => { skipNextClick = false; }, 50);
  };

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  // Blocca il click generato dall'evento che ha chiuso il drag,
  // così non viene attivato undo/redo per errore.
  el.addEventListener('click', (e) => {
    if (skipNextClick) {
      e.preventDefault();
      e.stopPropagation();
      skipNextClick = false;
    }
  }, true);
}