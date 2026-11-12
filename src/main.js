/**
 * @module main
 *
 * COMPOSITION ROOT. Unico entry point dell'app.
 *
 * Ordine di boot (non modificare — l'ordine conta):
 *   1. mountToolbar() + mountSettingsModal()  → markup nel DOM
 *   2. initSettings()                          → applica tema/dock al body
 *   3. initToolbarSettings(null)               → default toolbar (no notebook)
 *   4. initDB()                                → apre IndexedDB
 *   5. initEditorHandlers() + bindEditorUI() + bindLibraryUI()
 *   6. onSettingsChanged / onToolbarSettingsChanged (subscription)
 *   7. renderLibraryView() + setupViewportGestures() + setupKeyboardShortcuts()
 *
 * Subscription attive:
 *   - settings:changed → ridisegna pagine se cambia tema
 *   - toolbar-settings:changed → riallinea UI + scheduleSave (escluso activeTool)
 *
 * @see core/types.js
 */

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
  //    Emette `toolbar-settings:changed` con changed=['init'], ma la
  //    subscription (punto 7) non è ancora registrata: nessuno cattura
  //    l'evento. La UI iniziale viene sincronizzata al punto 8.
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
    // activeTool è runtime-only, non va persistito nel notebook.
    if (changed.length === 1 && changed[0] === 'activeTool') return;
    // Cambio preferenza toolbar (colore, spessore, smoothing,
    // auto-shape, subbar, compact, eraserSize, eraserMode,
    // recentColors): persisti nel notebook.
    scheduleSave();
  });

  // 8. Vista iniziale e setup gesti / tastiera.
  //    applyActiveToolToUI() è necessario qui perché la subscription
  //    (punto 7) non ha catturato la init del punto 3 (registrata dopo).
  renderLibraryView();
  centerViewport();
  setupViewportGestures();
  setupKeyboardShortcuts();
  applyActiveToolToUI();
  updateAutoShapeButtonUI();
  renderRecentColors();

  window.addEventListener('resize', () => refreshCanvasResolution(true));
});

window.addEventListener('beforeunload', () => {
  flushHistory();
  flushAutoSave();
});