// ============================================================
// EDITOR: apri/chiudi quaderno + aggiornamento formato + orchestrazione
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast, emit, PAGE_WIDTH } from '../../core/utils.js';
import {
  loadNotebookWithPages, saveNotebookToDB, CURRENT_NOTEBOOK_FORMAT
} from '../../services/db.js';
import { setCurrentNotebook, getCurrentNotebook } from '../persistence/session.js';
import { scheduleSave, forceSave, cancelPendingSave } from '../persistence/autosave.js';
import { packStrokes, unpackStrokes } from '../persistence/serialization.js';
import { showProgressDialog } from '../backup/backup-progress.js';
import {
  createNewPageDOM, scheduleResolutionRefresh, updateActivePageFromViewport,
  installViewportResizeObserver, refreshCanvasResolution, centerViewport
} from './pages.js';
import { pagePool } from './page-pool.js';
import { clearStrokeCache } from '../render/stroke-cache.js';
import {
  refreshPageCounter, setDockDrawingHidden,
  applyBgPatternToUI, applySnapTogglesToUI, applyEraserLevelToUI
} from '../toolbar/toolbar.js';
import { resetHistory } from '../history/history.js';
import {
  setViewportChangeHandler, applyTransform, clampViewport, invalidateClampCache
} from '../viewport/transform.js';
import { clearSelection, hasLassoSelection, updateSelectionMenuPosition } from '../tools/lazo.js';
import { finalizePendingShape } from '../tools/shapes.js';
import {
  commitActiveTextBox, resetTextToolState, updateTextSelectionMenuPosition
} from '../tools/text.js';
import {
  initToolbarSettings, resetToolbarSettings,
  getToolbarSettings, getToolbarSettingsForSave
} from '../toolbar/toolbar-settings.js';
import { getSettings } from '../../core/app-settings.js';
import {
  pushEditorBackState,
  popEditorBackStateIfActive
} from '../../core/back-navigation.js';

let _openToken = 0;
let _isOpeningNotebook = false;
let _returningPromise = null;
let _activeOpenDialog = null;
let _openDialogTimer = null;

const OPEN_DIALOG_DELAY_MS = 120;

function _yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function _ensureOpenDialog(title) {
  if (_openDialogTimer) {
    clearTimeout(_openDialogTimer);
    _openDialogTimer = null;
  }
  if (!_activeOpenDialog) {
    _activeOpenDialog = showProgressDialog(title);
  } else {
    _activeOpenDialog.setTitle(title);
  }
  return _activeOpenDialog;
}

function _closeOpenDialog() {
  if (_openDialogTimer) {
    clearTimeout(_openDialogTimer);
    _openDialogTimer = null;
  }
  if (_activeOpenDialog) {
    _activeOpenDialog.close();
    _activeOpenDialog = null;
  }
}

let _menuPosRaf = null;
function _scheduleSelectionMenuReposition() {
  if (_menuPosRaf !== null) return;
  _menuPosRaf = requestAnimationFrame(() => {
    _menuPosRaf = null;
    if (hasLassoSelection()) updateSelectionMenuPosition();
    if (state.selectedTextBoxId && !state.editingTextBoxId) updateTextSelectionMenuPosition();
  });
}

export function initEditorHandlers() {
  setViewportChangeHandler(() => {
    if (!viewport.isPinching) {
      scheduleResolutionRefresh();
      updateActivePageFromViewport();
    }
    if (hasLassoSelection() || (state.selectedTextBoxId && !state.editingTextBoxId)) {
      _scheduleSelectionMenuReposition();
    }
  });
  window.addEventListener('resize', () => updateActivePageFromViewport());
  installViewportResizeObserver();
}

export function isEditorActive() {
  if (getCurrentNotebook() !== null || _isOpeningNotebook) return true;
  const lib = document.getElementById('libraryView');
  return !!(lib && lib.classList.contains('hidden'));
}

export async function openNotebook(id) {
  const myToken = ++_openToken;
  _isOpeningNotebook = true;
  pushEditorBackState(id);
  _closeOpenDialog();
  cancelPendingSave();

  // Mostra il dialog solo se l'apertura supera 120ms (o subito se c'è un upgrade formato)
  _openDialogTimer = setTimeout(() => {
    _openDialogTimer = null;
    if (myToken !== _openToken) return;
    const dlg = _ensureOpenDialog('Apertura quaderno...');
    dlg.update({ done: 0, total: 0, label: 'Lettura quaderno dal database...' });
  }, OPEN_DIALOG_DELAY_MS);

  let nb;
  try {
    nb = await loadNotebookWithPages(id);
  } catch (err) {
    if (myToken === _openToken) {
      _isOpeningNotebook = false;
      _closeOpenDialog();
      if (!getCurrentNotebook()) popEditorBackStateIfActive();
    }
    console.error('[editor] load failed:', err);
    showToast('Errore nel caricamento del quaderno', '❌');
    return;
  }

  if (myToken !== _openToken) {
    _closeOpenDialog();
    return;
  }
  if (!nb) {
    _isOpeningNotebook = false;
    _closeOpenDialog();
    if (!getCurrentNotebook()) popEditorBackStateIfActive();
    return;
  }

  let wasUpgraded = false;
  const unpackedByPageId = new Map();

  try {
    const needsUpgrade = !!nb._needsFormatUpgrade;
    const orderReconstructed = !!nb._orderReconstructed;
    const legacyPageIds = Array.isArray(nb._legacyPageIds) ? nb._legacyPageIds : [];
    const legacyIdSet = new Set(legacyPageIds);

    initToolbarSettings(nb.toolbarSettings || null);

    if (needsUpgrade) {
      wasUpgraded = true;
      const dlg = _ensureOpenDialog('Aggiornamento quaderno al nuovo formato...');
      const totalPages = nb.pages.length || 1;
      dlg.update({ done: 0, total: totalPages, label: 'Conversione pagine in corso...' });
      await _yieldToUI();
      if (myToken !== _openToken) return;

      const pagesToPersist = [];
      for (let i = 0; i < nb.pages.length; i++) {
        if (myToken !== _openToken) return;
        const pageData = nb.pages[i];
        if (legacyIdSet.has(pageData.pageId)) {
          const unpacked = unpackStrokes(pageData.strokes || []);
          pageData.strokes = packStrokes(unpacked);
          unpackedByPageId.set(pageData.pageId, unpacked);
          pagesToPersist.push(pageData.pageId);
        }
        dlg.update({ done: i + 1, total: totalPages, label: 'Conversione pagine al nuovo formato' });
        if ((i & 3) === 3) await _yieldToUI();
      }

      if (myToken !== _openToken) return;

      nb.pattern = nb.pattern || 'ruled';
      nb.lastEditAt = nb.lastEditAt || nb.updatedAt || nb.createdAt || new Date().toISOString();
      nb.toolbarSettings = getToolbarSettingsForSave();
      nb.formatVersion = CURRENT_NOTEBOOK_FORMAT;

      dlg.update({ done: totalPages, total: totalPages, label: 'Salvataggio nel nuovo formato...' });
      await _yieldToUI();
      if (myToken !== _openToken) return;

      try {
        await saveNotebookToDB(nb, pagesToPersist, {
          saveOrder: true,
          replaceAllPages: orderReconstructed,
          preserveLastEditAt: true,
          preserveUpdatedAt: true
        });
      } catch (saveErr) {
        console.warn('[editor] Salvataggio upgrade fallito:', saveErr);
      }

      if (myToken !== _openToken) return;
    }

    delete nb._needsFormatUpgrade;
    delete nb._orderReconstructed;
    delete nb._legacyPageIds;

    setCurrentNotebook(nb);
    document.getElementById('docTitle').value = nb.title;
    state.bgPattern = nb.pattern || 'ruled';
    applyToolbarControlsToUI();

    pagePool.reset();

    const container = document.getElementById('canvasContainer');
    container.innerHTML = '';
    state.pages = [];
    state.pendingShape = null;
    clearSelection();
    state.currentStroke = null;
    state.currentPointerId = null;
    state.currentPageForPointer = null;
    state.isDrawing = false;
    resetTextToolState();

    if (nb.pages && nb.pages.length > 0) {
      const total = nb.pages.length;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < total; i++) {
        if (myToken !== _openToken) return;
        const pageData = nb.pages[i];
        const preUnpacked = unpackedByPageId.get(pageData.pageId);
        const initialStrokes = preUnpacked || pageData.strokes || [];
        createNewPageDOM(
          pageData.pageIndex,
          initialStrokes,
          pageData.pageId,
          pageData.textBoxes || [],
          { parent: frag, alreadyUnpacked: !!preUnpacked }
        );

        if (_activeOpenDialog) {
          _activeOpenDialog.update({ done: i + 1, total, label: 'Preparazione pagine' });
        }
        if (total > 10 && (i % 8 === 7)) {
          await _yieldToUI();
        }
      }
      if (myToken !== _openToken) return;
      container.appendChild(frag);
    } else {
      createNewPageDOM(0, [], null, []);
    }

    if (myToken !== _openToken) return;

    const targetIndex = Math.min(
      typeof nb.lastPageIndex === 'number' ? nb.lastPageIndex : 0,
      state.pages.length - 1
    );
    state.activePageIndex = Math.max(0, targetIndex);

    if (_activeOpenDialog) {
      _activeOpenDialog.update({
        done: state.pages.length,
        total: state.pages.length,
        label: 'Rendering iniziale...'
      });
    }

    await new Promise(resolve => {
      requestAnimationFrame(() => {
        if (myToken !== _openToken) {
          resolve();
          return;
        }
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

    if (myToken !== _openToken) return;

    refreshPageCounter();
    resetHistory();
    document.getElementById('libraryView').classList.add('hidden');
    window.dispatchEvent(new CustomEvent('inknote:notebook-opened', {
      detail: { id: nb.id }
    }));

    if (wasUpgraded) {
      showToast(`Quaderno "${nb.title}" aggiornato al nuovo formato`, '✨');
    } else {
      showToast(`Quaderno "${nb.title}" aperto`, '📖');
    }
  } finally {
    if (myToken === _openToken) {
      _isOpeningNotebook = false;
      _closeOpenDialog();
    }
  }
}

export async function returnToLibrary({ fromPopstate = false } = {}) {
  if (_returningPromise) return _returningPromise;

  _returningPromise = (async () => {
    _openToken++;
    _isOpeningNotebook = false;
    _closeOpenDialog();

    if (state.pendingShape) finalizePendingShape();
    if (state.editingTextBoxId || state.selectedTextBoxId) {
      commitActiveTextBox({ deselect: true });
    }
    try {
      await forceSave();
    } catch (err) {
      // errore già loggato in autosave; procediamo comunque
    }

    clearSelection();
    pagePool.reset();
    clearStrokeCache();
    const container = document.getElementById('canvasContainer');
    if (container) container.innerHTML = '';
    state.pages = [];
    state.pendingShape = null;
    resetTextToolState();

    setCurrentNotebook(null);
    setDockDrawingHidden(false, { immediate: true });
    resetToolbarSettings();
    resetHistory();

    window.dispatchEvent(new CustomEvent('inknote:notebook-closed'));
    document.getElementById('libraryView').classList.remove('hidden');
    if (!fromPopstate) {
      popEditorBackStateIfActive();
    }
    emit('library:refresh');
  })().finally(() => {
    _returningPromise = null;
  });

  return _returningPromise;
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
    _isOpeningNotebook = false;
    _closeOpenDialog();
    cancelPendingSave();
    clearSelection();
    pagePool.reset();
    clearStrokeCache();
    const container = document.getElementById('canvasContainer');
    if (container) container.innerHTML = '';
    state.pages = [];
    state.pendingShape = null;
    resetTextToolState();
    setDockDrawingHidden(false, { immediate: true });
    resetToolbarSettings();
    resetHistory();
    setCurrentNotebook(null);
    popEditorBackStateIfActive();
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