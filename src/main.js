// ============================================================
// COMPOSITION ROOT
// ============================================================

import { initDB } from './services/db.js';
import {
  loadSettings, applySettings, initSettingsListeners, setDarkModeHandler
} from './services/preferences.js';
import {
  centerViewport, refreshCanvasResolution
} from './features/editor/pages.js';
import { setupViewportGestures } from './features/editor/gestures.js';
import { setupKeyboardShortcuts } from './features/editor/keyboard.js';
import {
  updateAutoShapeButtonUI, renderRecentColors, setDarkMode
} from './features/editor/toolbar.js';
import { flushHistory } from './features/editor/history.js';
import { flushAutoSave } from './features/editor/autosave.js';
import { initEditorHandlers } from './features/editor/editor.js';
import { bindEditorUI } from './features/editor/bindings.js';
import { renderLibraryView, bindLibraryUI } from './features/library/library.js';
import { initSettingsModal, bindSettingsUI } from './features/settings/settings.js';

window.addEventListener('load', async () => {
  // Registra l'handler del tema PRIMA di applySettings
  setDarkModeHandler(setDarkMode);

  applySettings(loadSettings());
  initSettingsListeners();
  initSettingsModal();
  initEditorHandlers();

  // Bind UI (una sola volta, dopo il load del DOM)
  bindEditorUI();
  bindLibraryUI();
  bindSettingsUI();

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