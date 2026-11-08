// ============================================================
// EDITOR: apri/chiudi quaderno + orchestrazione
// ============================================================

import { state } from '../../core/state.js';
import { showToast, emit } from '../../core/utils.js';
import { loadAllNotebooksFromDB } from '../../services/db.js';
import { setCurrentNotebook, getCurrentNotebook, syncCurrentState, saveCurrentNotebook } from './session.js';
import { scheduleSave, flushAutoSave } from './autosave.js';
import { createNewPageDOM, scheduleResolutionRefresh } from './pages.js';
import { updatePageCounterUI } from './header.js';
import { resetHistory, pushHistory } from './history.js';
import { setViewportChangeHandler } from './transform.js';
import { updateSelectionMenuPosition } from './lasso.js';
import { finalizePendingShape } from './shapes.js';

export function initEditorHandlers() {
  setViewportChangeHandler(() => {
    scheduleResolutionRefresh();
    updateSelectionMenuPosition();
  });
}

export async function openNotebook(id) {
  const notebooks = await loadAllNotebooksFromDB();
  const nb = notebooks.find(n => n.id === id);
  if (!nb) return;

  setCurrentNotebook(nb);
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