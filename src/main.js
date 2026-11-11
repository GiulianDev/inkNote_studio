// ============================================================
// COMPOSITION ROOT
// ============================================================

import { initDB } from './services/db.js';
import { initSettings, onSettingsChanged } from './core/app-settings.js';
import { state } from './core/state.js';
import {
  centerViewport, refreshCanvasResolution
} from './features/editor/pages.js';
import { redrawPageCanvas, redrawSelectionOverlay } from './features/editor/render.js';
import { setupViewportGestures } from './features/editor/gestures.js';
import { setupKeyboardShortcuts } from './features/editor/keyboard.js';
import { updateAutoShapeButtonUI, renderRecentColors } from './features/editor/toolbar.js';
import { flushHistory } from './features/editor/history.js';
import { flushAutoSave } from './features/editor/autosave.js';
import { initEditorHandlers } from './features/editor/editor.js';
import { bindEditorUI } from './features/editor/bindings.js';
import { mountSettingsModal } from './features/settings/settings.js';
import { mountToolbar } from './features/toolbar/toolbar.js';
import { renderLibraryView, bindLibraryUI } from './features/library/library.js';

window.addEventListener('load', async () => {
  // 1. Componenti grafiche. Devono esistere PRIMA di initSettings():
  //    lo store applica tema, subbar, compact, dock size al DOM e
  //    cerca #themeToggleBtn, #subbar, #compactExitBtn, ecc.
  mountToolbar();
  mountSettingsModal();

  // 2. Store impostazioni (applica effetti DOM su toolbar e modale).
  initSettings();

  // 3. Init IndexedDB.
  try { await initDB(); } catch (err) { console.error(err); }

  // 4. Handler + binding (ora tutti gli id esistono).
  initEditorHandlers();
  bindEditorUI();
  bindLibraryUI();

  // 5. Al cambio tema effettivo (manuale o da sistema) ridisegna le pagine.
  onSettingsChanged(({ changed }) => {
    if (!changed.includes('theme') && !changed.includes('theme.effective')) return;
    state.pages.forEach(p => {
      if (p._wasVisible !== false) {
        redrawPageCanvas(p);
        if (p.index === state.activePageIndex && state.selectedStrokes.length > 0) {
          redrawSelectionOverlay(p);
        }
      }
    });
  });

  // 6. Vista iniziale e setup gesti / tastiera.
  renderLibraryView();
  centerViewport();
  setupViewportGestures();
  setupKeyboardShortcuts();
  updateAutoShapeButtonUI();
  renderRecentColors();

  window.addEventListener('resize', () => refreshCanvasResolution(true));
});

window.addEventListener('beforeunload', () => {
  flushHistory();
  flushAutoSave();
});