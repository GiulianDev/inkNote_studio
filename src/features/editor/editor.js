// ============================================================
// EDITOR: apri/chiudi quaderno + orchestrazione
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast, emit } from '../../core/utils.js';
import { loadAllNotebooksFromDB } from '../../services/db.js';
import { setCurrentNotebook, getCurrentNotebook, syncCurrentState, saveCurrentNotebook } from '../persistence/session.js';
import { scheduleSave, flushAutoSave } from '../persistence/autosave.js';
import {
  createNewPageDOM, scheduleResolutionRefresh, updateActivePageFromViewport,
  installViewportResizeObserver, refreshCanvasResolution
} from './pages.js';
import { pagePool } from './page-pool.js';
import { refreshPageCounter } from '../toolbar/toolbar.js';
import { resetHistory, pushHistory } from '../history/history.js';
import { setViewportChangeHandler } from '../viewport/transform.js';
import { updateSelectionMenuPosition } from '../tools/lazo.js';
import { finalizePendingShape } from '../tools/shapes.js';
import {
  initToolbarSettings, resetToolbarSettings, getToolbarSettings
} from '../toolbar/toolbar-settings.js';
import { getSettings } from '../../core/app-settings.js';

export function initEditorHandlers() {
  setViewportChangeHandler(() => {
    if (!viewport.isPinching) {
      scheduleResolutionRefresh();
      updateActivePageFromViewport();
    }
    updateSelectionMenuPosition();
  });
  window.addEventListener('resize', () => updateActivePageFromViewport());
  installViewportResizeObserver();
}

export async function openNotebook(id) {
  const notebooks = await loadAllNotebooksFromDB();
  const nb = notebooks.find(n => n.id === id);
  if (!nb) return;

  setCurrentNotebook(nb);
  initToolbarSettings(nb.toolbarSettings || null);
  applyToolbarControlsToUI();

  document.getElementById('docTitle').value = nb.title;
  state.bgPattern = nb.pattern || 'ruled';
  document.getElementById('bgPatternSelect').value = state.bgPattern;

  // Pool: azzera prima di svuotare il container (gli slot puntano a wrapper
  // che stanno per essere rimossi).
  pagePool.reset();

  document.getElementById('canvasContainer').innerHTML = '';
  state.pages = [];
  state.pendingShape = null;
  state.selectedStrokes = [];

  if (nb.pages && nb.pages.length > 0) {
    nb.pages.forEach((pageData, idx) => createNewPageDOM(idx, pageData.strokes || []));
  } else {
    createNewPageDOM(0, []);
  }

  state.activePageIndex = 0;
  refreshPageCounter();
  document.getElementById('libraryView').classList.add('hidden');
  resetHistory();
  // Forza il pool ad assegnare slot alle prime pagine.
  refreshCanvasResolution(true);
  showToast(`Quaderno "${nb.title}" aperto`, '📖');
}

export function returnToLibrary() {
  if (state.pendingShape) finalizePendingShape();
  flushAutoSave();
  if (getCurrentNotebook()) {
    syncCurrentState();
    saveCurrentNotebook().catch(err => console.error('[editor] save before return failed:', err));
  }
  resetToolbarSettings();
  resetHistory();
  document.getElementById('libraryView').classList.remove('hidden');
  emit('library:refresh');
}

export function updateCurrentNotebookTitle(newTitle) {
  const nb = getCurrentNotebook();
  if (!nb) return;
  nb.title = newTitle;
  scheduleSave();
  pushHistory();
}

export function closeNotebookIfOpen(id) {
  const nb = getCurrentNotebook();
  if (nb && nb.id === id) {
    resetToolbarSettings();
    setCurrentNotebook(null);
  }
}

function applyToolbarControlsToUI() {
  const s = getToolbarSettings();
  const slider = document.getElementById('smoothingSlider');
  const label  = document.getElementById('smoothingValue');
  if (slider) slider.value = s.smoothing;
  if (label)  label.innerText = s.smoothing;

  const eraserModeSel = document.getElementById('eraserModeSelect');
  if (eraserModeSel) eraserModeSel.value = s.eraserMode;

  const palmCheck = document.getElementById('palmRejectionCheck');
  if (palmCheck) palmCheck.checked = getSettings().palmRejection !== false;
}