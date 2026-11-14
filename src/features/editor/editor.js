// ============================================================
// EDITOR: apri/chiudi quaderno + orchestrazione
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast, emit, PAGE_WIDTH } from '../../core/utils.js';
import { loadNotebookWithPages } from '../../services/db.js';
import { setCurrentNotebook, getCurrentNotebook, syncCurrentState, saveCurrentNotebook } from '../persistence/session.js';
import { scheduleSave, flushAutoSave } from '../persistence/autosave.js';
import {
  createNewPageDOM, scheduleResolutionRefresh, updateActivePageFromViewport,
  installViewportResizeObserver, refreshCanvasResolution, centerViewport
} from './pages.js';
import { pagePool } from './page-pool.js';
import { refreshPageCounter } from '../toolbar/toolbar.js';
import { resetHistory, pushHistory } from '../history/history.js';
import {
  setViewportChangeHandler, applyTransform, clampViewport, invalidateClampCache
} from '../viewport/transform.js';
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
  const nb = await loadNotebookWithPages(id);
  if (!nb) return;

  setCurrentNotebook(nb);
  initToolbarSettings(nb.toolbarSettings || null);
  applyToolbarControlsToUI();

  document.getElementById('docTitle').value = nb.title;
  state.bgPattern = nb.pattern || 'ruled';
  document.getElementById('bgPatternSelect').value = state.bgPattern;

  pagePool.reset();

  document.getElementById('canvasContainer').innerHTML = '';
  state.pages = [];
  state.pendingShape = null;
  state.selectedStrokes = [];
  state.lassoPath = [];
  state.currentStroke = null;
  state.currentPointerId = null;
  state.currentPageForPointer = null;
  state.isDrawing = false;

  if (nb.pages && nb.pages.length > 0) {
    // Usa `pageData.pageIndex` (posizione originale), non `idx`.
    nb.pages.forEach((pageData) => {
      createNewPageDOM(pageData.pageIndex, pageData.strokes || []);
    });
  } else {
    createNewPageDOM(0, []);
  }

  const targetIndex = Math.min(
    typeof nb.lastPageIndex === 'number' ? nb.lastPageIndex : 0,
    state.pages.length - 1
  );
  state.activePageIndex = Math.max(0, targetIndex);

  await new Promise(resolve => {
    requestAnimationFrame(() => {
      const targetPage = state.pages[state.activePageIndex];
      if (targetPage) {
        const vp = document.getElementById('viewport');
        viewport.scale = 1.0;
        viewport.x = (vp.clientWidth - PAGE_WIDTH) / 2;
        viewport.y = -targetPage.wrapper.offsetTop * viewport.scale + 20;
        invalidateClampCache();
        const c = clampViewport(viewport.x, viewport.y);
        viewport.x = c.x;
        viewport.y = c.y;
        applyTransform(false);
        pagePool.updateAround(state.activePageIndex, true);
      } else {
        centerViewport();
        refreshCanvasResolution(true);
      }
      resolve();
    });
  });

  refreshPageCounter();
  resetHistory();
  document.getElementById('libraryView').classList.add('hidden');
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