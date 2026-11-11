// ============================================================
// EDITOR: apri/chiudi quaderno + orchestrazione
// Fix 2: durante il pinch non aggiorniamo DPR né pagina attiva.
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast, emit } from '../../core/utils.js';
import { loadAllNotebooksFromDB } from '../../services/db.js';
import { setCurrentNotebook, getCurrentNotebook, syncCurrentState, saveCurrentNotebook } from './session.js';
import { scheduleSave, flushAutoSave } from './autosave.js';
import {
  createNewPageDOM, scheduleResolutionRefresh, updateActivePageFromViewport,
  installViewportResizeObserver
} from './pages.js';
import { updatePageCounterUI } from './header.js';
import { resetHistory, pushHistory } from './history.js';
import { setViewportChangeHandler } from './transform.js';
import { updateSelectionMenuPosition } from './lasso.js';
import { finalizePendingShape } from './shapes.js';
import {
  initToolbarSettings, resetToolbarSettings, getToolbarSettings
} from '../toolbar/toolbar-state.js';
import { applyActiveToolToUI } from '../toolbar/toolbar.js';
import { getSettings } from '../../core/app-settings.js';

export function initEditorHandlers() {
  setViewportChangeHandler(() => {
    // Fix 2: durante il pinch, il redraw completo della pagina (che
    // avviene in scheduleResolutionRefresh se il DPR è cambiato) e la
    // scansione di tutte le pagine per determinare quella attiva sono
    // operazioni pesanti che rendono il pinch a scatti. Le sopprimiamo
    // durante il pinch: il refresh viene fatto al pointerup (gestito
    // da gestures.js, che chiama scheduleResolutionRefresh quando il
    // pinch termina).
    if (!viewport.isPinching) {
      scheduleResolutionRefresh();
      updateActivePageFromViewport();
    }
    updateSelectionMenuPosition();
  });
  // Anche al resize della finestra (cambia la centratura)
  window.addEventListener('resize', () => updateActivePageFromViewport());
  installViewportResizeObserver();
}

export async function openNotebook(id) {
  const notebooks = await loadAllNotebooksFromDB();
  const nb = notebooks.find(n => n.id === id);
  if (!nb) return;

  setCurrentNotebook(nb);

  // Applica impostazioni toolbar del notebook (o default se mancanti:
  // notebook creati prima dell'introduzione di toolbarSettings).
  initToolbarSettings(nb.toolbarSettings || null);
  applyActiveToolToUI();
  applyToolbarControlsToUI();

  document.getElementById('docTitle').value = nb.title;
  state.bgPattern = nb.pattern || 'ruled';
  document.getElementById('bgPatternSelect').value = state.bgPattern;

  document.getElementById('canvasContainer').innerHTML = '';
  state.pages = [];
  state.pendingShape = null;
  state.selectedStrokes = [];

  if (nb.pages && nb.pages.length > 0) {
    nb.pages.forEach((pageData, idx) => createNewPageDOM(idx, pageData.strokes || []));
  } else createNewPageDOM(0, []);

  state.activePageIndex = 0;
  updatePageCounterUI();
  document.getElementById('libraryView').classList.add('hidden');
  resetHistory();
  showToast(`Quaderno "${nb.title}" aperto`, '📖');
}

export function returnToLibrary() {
  if (state.pendingShape) finalizePendingShape();
  flushAutoSave();
  if (getCurrentNotebook()) {
    syncCurrentState();
    saveCurrentNotebook();
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

/**
 * Chiamata da library al delete di un notebook.
 * Se il notebook cancellato è quello aperto, resetta lo store
 * toolbar ai default (evita che l'app mostri le impostazioni di
 * un quaderno cancellato).
 */
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