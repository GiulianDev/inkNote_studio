// ============================================================
// BINDINGS UI EDITOR
// Collega gli elementi DOM dell'editor alle rispettive funzioni.
// Chiamato una volta sola da main.js dopo il load.
//
// NOTA: gli elementi della toolbar v2 (mainbar, dock, popover
// Foglio, menu Condivisione/Export) sono gestiti internamente da
// features/toolbar/toolbar.js. Qui restano solo i bind
// "editor-specifici" e gli header/menu actions.
// ============================================================

import { state, authState } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import { signInWithGoogle } from '../../services/firebase.js';
import {
  setMainMenu, setTool, selectColor, updateStrokeWidth, updateSmoothing,
  toggleCompactMode, initCompactFullscreenSync,
  applySnapTogglesToUI, applyEraserLevelToUI,
  closeToolbarMenu, closeAllEditorMenus
} from '../toolbar/toolbar.js';
import { updateToolbarSettings, getToolbarSettings } from '../toolbar/toolbar-settings.js';
import { openSettingsModal } from '../settings/settings-modal.js';
import { exportToPDF } from './export-pdf.js';
import { undo, redo } from '../history/history.js';
import { returnToLibrary, updateCurrentNotebookTitle } from './editor.js';
import { clearCurrentPage, resetZoom } from './pages.js';
import {
  clearSelection, deleteSelectedStrokes,
  copySelection, cutSelection, duplicateSelection,
  previewSelectionColor, changeSelectionColor,
  previewSelectionWidth, changeSelectionWidth,
  changeSelectionStyle,
  toggleSelectionStylePopover,
  hideSelectionStylePopover,
  isSelectionStylePopoverOpen,
  hasLassoSelection,
  updateSelectionMenuPosition
} from '../tools/lazo.js';
import { registerExternalMenuCloser } from '../../components/floating-menu.js';
import { finalizePendingShape } from '../tools/shapes.js';
import { commitActiveTextBox } from '../tools/text.js';
import { getCurrentNotebook } from '../persistence/session.js';
import { forceSave } from '../persistence/autosave.js';
import { exportNotebooks } from '../backup/backup-export.js';
import { showProgressDialog } from '../backup/backup-progress.js';
import { openSharingModal, handleGoogleAuthError } from '../sharing/sharing-ui.js';

async function _flushCurrentNotebookForAction() {
  if (state.pendingShape) finalizePendingShape();
  if (state.editingTextBoxId || state.selectedTextBoxId) {
    commitActiveTextBox({ deselect: true });
  }
  const nb = getCurrentNotebook();
  if (!nb) return null;
  await forceSave();
  return getCurrentNotebook();
}

function _openEditorSettings() {
  closeAllEditorMenus();
  if (state.pendingShape) finalizePendingShape();
  if (state.editingTextBoxId || state.selectedTextBoxId) {
    commitActiveTextBox({ deselect: true });
  }
  openSettingsModal();
}

async function _handleExportCurrentNotebook() {
  closeAllEditorMenus();
  let nb;
  try {
    nb = await _flushCurrentNotebookForAction();
  } catch (err) {
    console.error('[editor-export] save before export failed:', err);
    showToast('Salvataggio non riuscito prima dell\'esportazione', '❌');
    return;
  }
  if (!nb) {
    showToast('Nessun quaderno aperto', '⚠️');
    return;
  }

  const progress = showProgressDialog('Esportazione quaderno...');
  try {
    await exportNotebooks(
      [nb.id],
      ({ done, total, notebookTitle }) => {
        progress.update({ done, total, label: notebookTitle });
      }
    );
    progress.close();
  } catch (err) {
    console.error('[editor-export] failed:', err);
    progress.close();
    showToast('Esportazione fallita', '❌');
  }
}

async function _handleSendCurrentNotebook() {
  closeAllEditorMenus();
  if (!authState.user) {
    if (authState.loading) return;
    try {
      const user = await signInWithGoogle();
      if (!user) return;
      showToast(`Benvenuto, ${user.displayName || user.email}!`, '👋');
    } catch (err) {
      await handleGoogleAuthError(err);
      return;
    }
  }

  let nb;
  try {
    nb = await _flushCurrentNotebookForAction();
  } catch (err) {
    console.error('[editor-send] save before share failed:', err);
    showToast('Salvataggio non riuscito prima dell\'invio', '❌');
    return;
  }
  if (!nb) {
    showToast('Nessun quaderno aperto', '⚠️');
    return;
  }
  openSharingModal({ sendNotebooks: [nb] });
}

export function bindEditorUI() {
  // --- Mainbar: 5 menu contestuali (clic sul tab attivo → chiude/riapre dock) ---
  document.querySelectorAll('.main-menu-btn').forEach(btn => {
    btn.addEventListener('click', () => setMainMenu(btn.dataset.menu, { toggle: true }));
  });

  // --- Dock Writing: palette colori ---
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => selectColor(swatch.dataset.color, swatch));
  });

  // --- Dock Writing: stroke width ---
  document.getElementById('strokeWidthSlider')
    ?.addEventListener('input', (e) => updateStrokeWidth(e.target.value));

  // --- Dock Writing: smoothing ---
  document.getElementById('smoothingSlider')
    ?.addEventListener('input', (e) => updateSmoothing(e.target.value));

  // --- Dock Writing: opacity (bottone) → apre popover già bindato in toolbar.js
  // (gestito internamente da toolbar.js::_setupDockButtons)

  // --- Header: back, titolo, compact, impostazioni ---
  document.getElementById('backToLibraryBtn')
    ?.addEventListener('click', returnToLibrary);
  document.getElementById('docTitle')
    ?.addEventListener('change', (e) => updateCurrentNotebookTitle(e.target.value));
  document.getElementById('compactExitBtn')
    ?.addEventListener('click', toggleCompactMode);
  document.getElementById('openSettingsBtnHeader')
    ?.addEventListener('click', _openEditorSettings);

  // --- Menu Esporta e condividi ---
  document.getElementById('exportPdfFromMenu')
    ?.addEventListener('click', () => { closeToolbarMenu(); exportToPDF(); });
  document.getElementById('exportNotebookFromMenu')
    ?.addEventListener('click', _handleExportCurrentNotebook);
  document.getElementById('sendNotebookFromMenu')
    ?.addEventListener('click', _handleSendCurrentNotebook);

  // --- Dock Gomma: eraser mode + pulisci pagina ---
  document.getElementById('eraserModeSelect')
    ?.addEventListener('change', (e) => {
      updateToolbarSettings({ eraserMode: e.target.value });
    });
  document.getElementById('clearPageBtn')
    ?.addEventListener('click', () => clearCurrentPage());

  // --- Zoom badge ---
  document.getElementById('resetZoomBtn')
    ?.addEventListener('click', resetZoom);

  // --- Selection menu ---
  const selMenu = document.getElementById('selectionMenu');
  selMenu?.addEventListener('pointerdown', (e) => {
    const styleBtn = document.getElementById('selectionStyleBtn');
    if (isSelectionStylePopoverOpen() && !styleBtn?.contains(e.target)) {
      hideSelectionStylePopover();
    }
    e.stopPropagation();
  });

  const selColor = document.getElementById('selectionColorPicker');
  selColor?.addEventListener('input', (e) => previewSelectionColor(e.target.value));
  selColor?.addEventListener('change', (e) => changeSelectionColor(e.target.value));

  const selWidth = document.getElementById('selectionWidthSlider');
  selWidth?.addEventListener('input', (e) => previewSelectionWidth(e.target.value));
  selWidth?.addEventListener('change', (e) => changeSelectionWidth(e.target.value));

  const selStyleBtn = document.getElementById('selectionStyleBtn');
  const selStylePopover = document.getElementById('selectionStylePopover');
  registerExternalMenuCloser('selectionStylePopover', hideSelectionStylePopover);

  selStyleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeAllEditorMenus({ keep: 'selectionStylePopover' });
    toggleSelectionStylePopover();
  });

  selStylePopover?.querySelectorAll('[data-selection-style]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      changeSelectionStyle(btn.dataset.selectionStyle);
      hideSelectionStylePopover();
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (!isSelectionStylePopoverOpen()) return;
    if (selStylePopover?.contains(e.target) || selStyleBtn?.contains(e.target)) return;
    hideSelectionStylePopover();
  });

  document.getElementById('copySelectionBtn')
    ?.addEventListener('click', () => copySelection());
  document.getElementById('cutSelectionBtn')
    ?.addEventListener('click', () => cutSelection());
  document.getElementById('duplicateSelectionBtn')
    ?.addEventListener('click', () => duplicateSelection());
  document.getElementById('deleteSelectionBtn')
    ?.addEventListener('click', deleteSelectedStrokes);
  document.getElementById('clearSelectionBtn')
    ?.addEventListener('click', clearSelection);

  window.addEventListener('resize', () => {
    if (hasLassoSelection()) updateSelectionMenuPosition();
  });

  // --- Undo / Redo ---
  document.getElementById('undoBtn')?.addEventListener('click', undo);
  document.getElementById('redoBtn')?.addEventListener('click', redo);

  // --- Sync fullscreen ↔ compact ---
  initCompactFullscreenSync();

  // --- Sincronizza controlli con lo stato corrente ---
  applyEraserModeToUI();
  applySnapTogglesToUI();
  applyEraserLevelToUI();
  initUndoRedoDrag();
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
const UNDO_REDO_MOVE_CANCEL_PX = 8;

function initUndoRedoDrag() {
  const el = document.getElementById('undoRedoContainer');
  if (!el) return;

  const clampToViewport = (x, y) => {
    const w = el.offsetWidth || 100;
    const h = el.offsetHeight || 56;
    const maxX = window.innerWidth - w - UNDO_REDO_MARGIN;
    const maxY = window.innerHeight - h - UNDO_REDO_MARGIN;
    return {
      x: Math.max(UNDO_REDO_MARGIN, Math.min(maxX, x)),
      y: Math.max(UNDO_REDO_MARGIN, Math.min(maxY, y))
    };
  };

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
  let activePointerId = null;
  let startX = 0, startY = 0;
  let origX = 0, origY = 0;
  let skipNextClick = false;

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  const setDraggingVisual = (active) => {
    el.style.cursor = active ? 'grabbing' : '';
    el.querySelectorAll('button').forEach(b => {
      b.style.cursor = active ? 'grabbing' : '';
    });
    el.classList.toggle('undo-redo-dragging', active);
  };

  const onDocumentPointerMove = (e) => {
    if (e.pointerId !== activePointerId) return;

    if (!dragging) {
      if (pressTimer) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.hypot(dx, dy) > UNDO_REDO_MOVE_CANCEL_PX) {
          cancelPress();
          detachDocumentListeners();
          activePointerId = null;
        }
      }
      return;
    }

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const pos = clampToViewport(origX + dx, origY + dy);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  };

  const onDocumentPointerUp = (e) => {
    if (e.pointerId !== activePointerId) return;
    cancelPress();

    if (dragging) {
      dragging = false;
      setDraggingVisual(false);

      try {
        const rect = el.getBoundingClientRect();
        localStorage.setItem(UNDO_REDO_POS_KEY, JSON.stringify({
          x: Math.round(rect.left),
          y: Math.round(rect.top)
        }));
      } catch {}

      setTimeout(() => { skipNextClick = false; }, 50);
    }

    detachDocumentListeners();
    activePointerId = null;
  };

  const detachDocumentListeners = () => {
    document.removeEventListener('pointermove', onDocumentPointerMove);
    document.removeEventListener('pointerup', onDocumentPointerUp);
    document.removeEventListener('pointercancel', onDocumentPointerUp);
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    cancelPress();
    detachDocumentListeners();

    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origX = rect.left;
    origY = rect.top;
    dragging = false;
    skipNextClick = false;
    activePointerId = e.pointerId;

    document.addEventListener('pointermove', onDocumentPointerMove);
    document.addEventListener('pointerup', onDocumentPointerUp);
    document.addEventListener('pointercancel', onDocumentPointerUp);

    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (activePointerId !== e.pointerId) return;
      dragging = true;
      skipNextClick = true;
      setDraggingVisual(true);
    }, UNDO_REDO_DRAG_PRESS_MS);
  });

  el.addEventListener('click', (e) => {
    if (skipNextClick) {
      e.preventDefault();
      e.stopPropagation();
      skipNextClick = false;
    }
  }, true);
}