// ============================================================
// COMPOSITION ROOT
// ============================================================

import { initDB } from './services/db.js';
import { initSettings, onSettingsChanged } from './core/app-settings.js';
import { initToolbarSettings, onToolbarSettingsChanged } from './features/toolbar/toolbar-state.js';
import { state } from './core/state.js';
import {
  centerViewport, refreshCanvasResolution
} from './features/editor/pages.js';
import { redrawPageCanvas, redrawSelectionOverlay } from './features/editor/render.js';
import { setupViewportGestures } from './features/editor/gestures.js';
import { setupKeyboardShortcuts } from './features/editor/keyboard.js';
import {
  updateAutoShapeButtonUI, renderRecentColors, applyActiveToolToUI,
  mountToolbar
} from './features/toolbar/toolbar.js';
import { flushHistory } from './features/editor/history.js';
import { flushAutoSave } from './features/editor/autosave.js';
import { initEditorHandlers } from './features/editor/editor.js';
import { bindEditorUI } from './features/editor/bindings.js';
import { mountSettingsModal } from './features/settings/settings.js';
import { renderLibraryView, bindLibraryUI } from './features/library/library.js';

window.addEventListener('load', async () => {
  // 1. Componenti grafiche. Devono esistere PRIMA di initSettings():
  //    lo store applica tema/dock al DOM e cerca gli elementi della toolbar.
  mountToolbar();
  mountSettingsModal();

  // 2. Store globale impostazioni (tema, dock, handedness, palm rejection).
  initSettings();

  // 3. Store toolbar: default all'avvio (nessun notebook aperto).
  //    Verrà re-inizializzato all'apertura di un notebook con i dati
  //    del notebook.
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
    }
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