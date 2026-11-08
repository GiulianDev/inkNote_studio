// ============================================================
// COMPOSITION ROOT
// ============================================================

import { initDB } from './services/db.js';
import {
  loadSettings, applySettings, initSettingsListeners, setDarkModeHandler
} from './services/settings.js';
import {
  centerViewport, addNewPage, clearCurrentPage, changeBackgroundPattern,
  refreshCanvasResolution, resetZoom
} from './features/editor/pages.js';
import { setupViewportGestures, togglePalmRejection } from './features/editor/gestures.js';
import { setupKeyboardShortcuts } from './features/editor/keyboard.js';
import {
  setTool, toggleAutoShape, selectColor, updateSmoothing,
  updateStrokeWidth, updateAutoShapeButtonUI, renderRecentColors,
  toggleTheme, toggleSubbar, toggleCompactMode, setDarkMode
} from './features/editor/toolbar.js';
import { undo, redo, flushHistory } from './features/editor/history.js';
import { flushAutoSave } from './features/editor/autosave.js';
import { toggleFullscreen, exportToPDF } from './features/editor/export.js';
import {
  openNotebook, returnToLibrary, updateCurrentNotebookTitle, initEditorHandlers
} from './features/editor/editor.js';
import {
  clearSelection, deleteSelectedStrokes,
  previewSelectionColor, changeSelectionColor,
  previewSelectionWidth, changeSelectionWidth
} from './features/editor/lasso.js';
import {
  renderLibraryView, openNewNotebookModal, closeNewNotebookModal,
  confirmCreateNotebook, selectCoverColor, deleteNotebook
} from './features/library/library.js';
import { handleGoogleLogin } from './services/auth.js';
import {
  openSettingsModal, closeSettingsModal, confirmSettings,
  resetPressureDefaults, clearPressureTest, initSettingsModal
} from './features/settings/settings.js';

window.addEventListener('load', async () => {
  // Registra l'handler del tema PRIMA di applySettings: applySettings
  // lo usa per applicare il tema al primo avvio.
  setDarkModeHandler(setDarkMode);

  applySettings(loadSettings());
  initSettingsListeners();
  initSettingsModal();
  initEditorHandlers();

  try {
    await initDB();
    renderLibraryView();
  } catch (err) {
    console.error(err);
  }

  centerViewport();
  setupViewportGestures();
  setupKeyboardShortcuts();
  updateAutoShapeButtonUI();
  renderRecentColors();

  window.addEventListener('resize', () => refreshCanvasResolution(true));
});

window.addEventListener('beforeunload', (e) => {
  flushHistory();
  flushAutoSave();
});

// ============================================================
// BRIDGE TEMPORANEO (rimosso in Fase 4)
// Espone le funzioni usate dagli onclick nell'HTML.
// ============================================================

Object.assign(window, {
  // library
  renderLibraryView, openNewNotebookModal, closeNewNotebookModal,
  confirmCreateNotebook, selectCoverColor, deleteNotebook,
  openNotebook, handleGoogleLogin,
  // settings
  openSettingsModal, closeSettingsModal, confirmSettings,
  resetPressureDefaults, clearPressureTest,
  // toolbar
  setTool, toggleAutoShape, selectColor, updateSmoothing, updateStrokeWidth,
  toggleTheme, toggleSubbar, toggleCompactMode,
  // editor
  returnToLibrary, updateCurrentNotebookTitle,
  // pages
  addNewPage, clearCurrentPage, changeBackgroundPattern, resetZoom,
  // gestures
  togglePalmRejection,
  // history
  undo, redo,
  // export
  toggleFullscreen, exportToPDF,
  // lasso
  clearSelection, deleteSelectedStrokes,
  previewSelectionColor, changeSelectionColor,
  previewSelectionWidth, changeSelectionWidth
});