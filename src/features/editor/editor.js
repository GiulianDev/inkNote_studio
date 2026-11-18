// ============================================================
// EDITOR: apri/chiudi quaderno + orchestrazione
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast, emit, PAGE_WIDTH } from '../../core/utils.js';
import { loadNotebookWithPages } from '../../services/db.js';
import { setCurrentNotebook, getCurrentNotebook } from '../persistence/session.js';
import { scheduleSave, forceSave, cancelPendingSave } from '../persistence/autosave.js';
import {
  createNewPageDOM, scheduleResolutionRefresh, updateActivePageFromViewport,
  installViewportResizeObserver, refreshCanvasResolution, centerViewport
} from './pages.js';
import { pagePool } from './page-pool.js';
import {
  refreshPageCounter,
  applyBgPatternToUI, applySnapTogglesToUI, applyEraserLevelToUI
} from '../toolbar/toolbar.js';
import { resetHistory } from '../history/history.js';
import {
  setViewportChangeHandler, applyTransform, clampViewport, invalidateClampCache
} from '../viewport/transform.js';
import { updateSelectionMenuPosition } from '../tools/lazo.js';
import { finalizePendingShape } from '../tools/shapes.js';
import {
  initToolbarSettings, resetToolbarSettings, getToolbarSettings
} from '../toolbar/toolbar-settings.js';
import { getSettings } from '../../core/app-settings.js';

let _openToken = 0;

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
  const token = ++_openToken;

  let nb;
  try {
    nb = await loadNotebookWithPages(id);
  } catch (err) {
    console.error('[editor] load failed:', err);
    showToast('Errore nel caricamento del quaderno', '❌');
    return;
  }
  if (token !== _openToken || !nb) return;

  setCurrentNotebook(nb);
  initToolbarSettings(nb.toolbarSettings || null);

  document.getElementById('docTitle').value = nb.title;
  state.bgPattern = nb.pattern || 'ruled';

  applyToolbarControlsToUI();

  pagePool.reset();

  const container = document.getElementById('canvasContainer');
  if (container) container.innerHTML = '';
  state.pages = [];
  state.pendingShape = null;
  state.selectedStrokes = [];
  state.lassoPath = [];
  state.currentStroke = null;
  state.currentPointerId = null;
  state.currentPageForPointer = null;
  state.isDrawing = false;

  if (nb.pages && nb.pages.length > 0) {
    nb.pages.forEach((pageData, idx) => {
      createNewPageDOM(idx, pageData.strokes || [], pageData.pageId);
    });
  } else {
    const first = createNewPageDOM(0, []);
    nb.pageOrder = [first.pageId];
    nb.pages = [{ pageId: first.pageId, strokes: [] }];
    scheduleSave({ pageId: first.pageId, orderDirty: true, immediate: true, silent: true });
  }

  const targetIndex = Math.min(
    typeof nb.lastPageIndex === 'number' ? nb.lastPageIndex : 0,
    state.pages.length - 1
  );
  state.activePageIndex = Math.max(0, targetIndex);

  await new Promise(resolve => {
    requestAnimationFrame(() => {
      if (token !== _openToken) { resolve(); return; }
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

  if (token !== _openToken) return;

  refreshPageCounter();
  resetHistory();
  document.getElementById('libraryView').classList.add('hidden');
  window.dispatchEvent(new CustomEvent('inknote:notebook-opened'));
  showToast(`Quaderno "${nb.title}" aperto`, '📖');
}

export async function returnToLibrary() {
  _openToken++;
  if (state.pendingShape) finalizePendingShape();
  try {
    await forceSave();
  } catch (err) {
    // errore già loggato in autosave; procediamo comunque
  }
  setCurrentNotebook(null);
  pagePool.reset();
  state.pages = [];
  state.activePageIndex = 0;
  const container = document.getElementById('canvasContainer');
  if (container) container.innerHTML = '';

  resetToolbarSettings();
  resetHistory();
  window.dispatchEvent(new CustomEvent('inknote:notebook-closed'));
  document.getElementById('libraryView').classList.remove('hidden');
  emit('library:refresh');
}

export function updateCurrentNotebookTitle(newTitle) {
  const nb = getCurrentNotebook();
  if (!nb) return;
  nb.title = newTitle;
  scheduleSave({ markDirty: false });
}

export function closeNotebookIfOpen(id) {
  const nb = getCurrentNotebook();
  if (nb && nb.id === id) {
    _openToken++;
    cancelPendingSave();
    setCurrentNotebook(null);
    pagePool.reset();
    state.pages = [];
    state.activePageIndex = 0;
    const container = document.getElementById('canvasContainer');
    if (container) container.innerHTML = '';
    resetToolbarSettings();
    window.dispatchEvent(new CustomEvent('inknote:notebook-closed'));
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

  const fingerWritingCheck = document.getElementById('palmRejectionCheck');
  if (fingerWritingCheck) fingerWritingCheck.checked = getSettings().palmRejection === false;

  applySnapTogglesToUI();
  applyEraserLevelToUI();
  applyBgPatternToUI();
}