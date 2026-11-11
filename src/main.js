// ============================================================
// COMPOSITION ROOT
// ============================================================

import { initDB } from './services/db.js';
import { initSettings, onSettingsChanged } from './core/app-settings.js';
import { initToolbarSettings, onToolbarSettingsChanged } from './features/toolbar/toolbar-settings.js';
import { state } from './core/state.js';
import {
  centerViewport, refreshCanvasResolution
} from './features/editor/pages.js';
import { redrawPageCanvas, redrawSelectionOverlay } from './features/render/render.js';
import { setupViewportGestures } from './features/viewport/gestures.js';
import { setupKeyboardShortcuts } from './features/shortcuts/keyboard.js';
import {
  updateAutoShapeButtonUI, renderRecentColors, applyActiveToolToUI,
  mountToolbar
} from './features/toolbar/toolbar.js';
import { flushHistory } from './features/history/history.js';
import { initEditorHandlers } from './features/editor/editor.js';
import { bindEditorUI } from './features/editor/ui-bindings.js';
import { mountSettingsModal } from './features/settings/settings-modal.js';
import { renderLibraryView, bindLibraryUI } from './features/library/library.js';
import { flushAutoSave, scheduleSave } from './features/persistence/autosave.js';

window.addEventListener('load', async () => {
  // 1. Componenti grafiche. Devono esistere PRIMA di initSettings():
  //    lo store applica tema/dock al DOM e cerca gli elementi della toolbar.
  mountToolbar();
  mountSettingsModal();

  // 2. Store globale impostazioni (tema, dock, handedness, palm rejection).
  initSettings();

  // 3. Store toolbar: default all'avvio (nessun notebook aperto).
  initToolbarSettings(null);

  // 4. Init IndexedDB.
  try { await initDB(); } catch (err) { console.error(err); }

  // 5. Handler editor + binding UI (ora tutti gli id esistono).
  initEditorHandlers();
  bindEditorUI();
  bindLibraryUI();

  // 6. Al cambio tema effettivo (manuale o da sistema) ridisegna le pagine.
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

  // 7. All'init/reset toolbar-settings (openNotebook, resetToolbarSettings)
  //    riallinea la UI della toolbar ai nuovi valori.
  onToolbarSettingsChanged(({ changed }) => {
    if (changed.includes('init') || changed.includes('reset')) {
      applyActiveToolToUI();
      updateAutoShapeButtonUI();
      renderRecentColors();
      return;
    }
    // Cambio preferenza toolbar (colore, spessore, smoothing,
    // auto-shape, subbar, compact, eraserSize, eraserMode,
    // recentColors, activeTool): persisti nel notebook.
    scheduleSave();
  });

  // 8. Vista iniziale e setup gesti / tastiera.
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