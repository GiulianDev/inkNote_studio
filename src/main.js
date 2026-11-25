/**
 * @module main
 *
 * COMPOSITION ROOT. Unico entry point dell'app.
 *
 * Ordine di boot (non modificare — l'ordine conta):
 *   1. mountToolbar() + mountSettingsModal() + mountPagesSidebar()  → markup nel DOM
 *   2. initSettings()                          → applica tema/dock al body
 *   3. initToolbarSettings(null)               → default toolbar (no notebook)
 *   4. initDB()                                → apre IndexedDB
 *   5. initEditorHandlers() + bindEditorUI() + bindLibraryUI()
 *   6. onSettingsChanged / onToolbarSettingsChanged (subscription)
 *   7. renderLibraryView() + setupViewportGestures() + setupKeyboardShortcuts()
 *
 * NOTA ordine mount:
 *   - mountToolbar()        → crea #mainHeader (necessario per
 *                             pages-sidebar che misura l'header)
 *   - mountSettingsModal()  → crea il modale impostazioni
 *   - mountPagesSidebar()   → sidebar pagine (dipende dall'header)
 *   Tutti e tre PRIMA di initSettings().
 *
 * Subscription attive:
 *   - settings:changed → ridisegna pagine se cambia tema
 *   - toolbar-settings:changed → riallinea UI + scheduleSave (escluso activeTool)
 *
 * @see core/types.js
 */

import { initDB } from './services/db.js';
import { initPlatform } from './core/platform.js';
import { initSettings, onSettingsChanged } from './core/app-settings.js';
import { initToolbarSettings, onToolbarSettingsChanged } from './features/toolbar/toolbar-settings.js';
import { state } from './core/state.js';
import {
  centerViewport, scheduleResolutionRefresh
} from './features/editor/pages.js';
import { redrawPageCanvas, redrawSelectionOverlay } from './features/render/render.js';
import {
  hasLassoSelection,
  hideSelectionStylePopover,
  isSelectionStylePopoverOpen
} from './features/tools/lazo.js';
import { setupViewportGestures } from './features/viewport/gestures.js';
import { setupKeyboardShortcuts } from './features/shortcuts/keyboard.js';
import {
  renderRecentColors, applyActiveToolToUI,
  applySnapTogglesToUI, applyEraserLevelToUI,
  mountToolbar, hideColorPickerPopover, hidePagePopover, closeToolbarMenu
} from './features/toolbar/toolbar.js';
import { flushHistory } from './features/history/history.js';
import {
  initEditorHandlers, returnToLibrary, isEditorActive
} from './features/editor/editor.js';
import { bindEditorUI } from './features/editor/ui-bindings.js';
import { mountSettingsModal, closeSettingsModal } from './features/settings/settings-modal.js';
import { mountPagesSidebar } from './features/pages-sidebar/pages-sidebar.js';
import {
  renderLibraryView, bindLibraryUI, closeNewNotebookModal,
  getCurrentFolderId, setCurrentFolderId, getParentFolderId,
  isSelectionModeActive, exitSelectionMode,
  hasActiveLibrarySearch, clearLibrarySearch
} from './features/library/library.js';
import { flushAutoSave, scheduleSave } from './features/persistence/autosave.js';
import { closeAllAuthDropdowns } from './features/library/library-auth.js';
import { terminateWorker } from './features/backup/serialization-cloud.js';
import { handleRedirectResult } from './services/firebase.js';
import { showToast } from './core/utils.js';
import { getSettings, updateSettings } from './core/app-settings.js';
import { initBackNavigation } from './core/back-navigation.js';
import { setupSystemMenuSuppression } from './core/system-menu-guard.js';

window.addEventListener('load', async () => {
  // 0. Piattaforma e listener input runtime (OS, device, hybrid, DPR, lastPointerType).
  initPlatform({ targetState: state });

  // 1. Componenti grafiche. Devono esistere PRIMA di initSettings():
  //    lo store applica tema/dock al DOM e cerca gli elementi della toolbar.
  //    Ordine: toolbar → settings modal → pages sidebar.
  //    La sidebar misura #mainHeader al mount, quindi va DOPO la toolbar.
  mountToolbar();
  mountSettingsModal();
  mountPagesSidebar();

  // 2. Store globale impostazioni (tema, dock, handedness, palm rejection,
  //    sidebar pagine).
  initSettings();

  // 3. Store toolbar: default all'avvio (nessun notebook aperto).
  //    Emette `toolbar-settings:changed` con changed=['init'], ma la
  //    subscription (punto 7) non è ancora registrata: nessuno cattura
  //    l'evento. La UI iniziale viene sincronizzata al punto 8.
  initToolbarSettings(null);

  // 4. Init IndexedDB.
  try { await initDB(); } catch (err) { console.error(err); }

  // 4b. Gestisci il ritorno dal redirect Google (mobile).
  // Su desktop è no-op (nessun redirect).
  try {
    await handleRedirectResult();
  } catch (err) {
    console.error('[main] redirect handler failed:', err);
  }

  // 5. Handler editor + binding UI (ora tutti gli id esistono).
  initEditorHandlers();
  bindEditorUI();
  bindLibraryUI();

  // 6. Al cambio tema effettivo (manuale o da sistema) ridisegna le pagine.
  onSettingsChanged(({ changed }) => {
    if (!changed.includes('theme') && !changed.includes('theme.effective')) return;
    state.pages.forEach(p => {
      if (p._wasVisible !== false && p.canvas) {
        redrawPageCanvas(p);
        if (p.index === state.activePageIndex && hasLassoSelection()) {
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
      applySnapTogglesToUI();
      applyEraserLevelToUI();
      renderRecentColors();
      return;
    }
    // Cambio preferenza toolbar o strumento attivo (activeTool, colore,
    // spessore, smoothing, snap, compact, gomma, colori recenti): persisti.
    scheduleSave({ markDirty: false });
  });

  // 8. Vista iniziale e setup gesti / tastiera / tasto Indietro.
  //    applyActiveToolToUI() è necessario qui perché la subscription
  //    (punto 7) non ha catturato la init del punto 3 (registrata dopo).
  renderLibraryView();
  centerViewport();
  setupSystemMenuSuppression();
  setupViewportGestures();
  setupKeyboardShortcuts();
  initBackNavigation({
    isEditorOpen: isEditorActive,
    onReturnToLibrary: async ({ fromPopstate, targetFolderId }) => {
      setCurrentFolderId(targetFolderId ?? null, { render: false });
      await returnToLibrary({ fromPopstate });
    },
    onNavigateFolder: (folderId) => setCurrentFolderId(folderId, { render: true }),
    getCurrentFolderId,
    getParentFolderId,
    onDismissTransientUI: _dismissTopTransientUI,
    onExitPrompt: () => showToast('Premi ancora Indietro per uscire', '↩️')
  });
  applyActiveToolToUI();
  applySnapTogglesToUI();
  renderRecentColors();

  window.addEventListener('resize', scheduleResolutionRefresh);
});

function _dismissTopTransientUI() {
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  if (dialogs.length > 0) {
    const topDialog = dialogs[dialogs.length - 1];
    const cancelBtn = topDialog.querySelector('[data-confirm-cancel], [data-modal-cancel]');
    if (cancelBtn) {
      cancelBtn.click();
      return 'dialog';
    }
  }

  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal && !settingsModal.classList.contains('hidden')) {
    closeSettingsModal();
    return 'settings-modal';
  }

  const newNbModal = document.getElementById('newNotebookModal');
  if (newNbModal && !newNbModal.classList.contains('hidden')) {
    closeNewNotebookModal();
    return 'new-notebook-modal';
  }

  const authDropdown = document.getElementById('authDropdown');
  if (authDropdown && !authDropdown.classList.contains('hidden')) {
    closeAllAuthDropdowns();
    return 'auth-dropdown';
  }

  const editorAuthDropdown = document.getElementById('editorAuthDropdown');
  if (editorAuthDropdown && !editorAuthDropdown.classList.contains('hidden')) {
    closeAllAuthDropdowns();
    return 'editor-auth-dropdown';
  }

  if (isEditorActive()) {
    const toolbarMenu = document.getElementById('toolbarMenuPanel');
    if (toolbarMenu && !toolbarMenu.classList.contains('hidden')) {
      closeToolbarMenu();
      return 'toolbar-menu';
    }
    const colorPopover = document.getElementById('colorPickerPopover');
    if (colorPopover && !colorPopover.classList.contains('hidden')) {
      hideColorPickerPopover();
      return 'color-popover';
    }
    const pagePopover = document.getElementById('pagePopover');
    if (pagePopover && !pagePopover.classList.contains('hidden')) {
      hidePagePopover();
      return 'page-popover';
    }
    if (isSelectionStylePopoverOpen()) {
      hideSelectionStylePopover();
      return 'selection-style-popover';
    }
    return null;
  }

  if (isSelectionModeActive()) {
    exitSelectionMode();
    return 'selection-mode';
  }
  if (hasActiveLibrarySearch()) {
    clearLibrarySearch();
    return 'library-search';
  }
  if (getCurrentFolderId() === null && getSettings().libraryOnlyFavorites) {
    updateSettings({ libraryOnlyFavorites: false });
    renderLibraryView();
    return 'favorites-filter';
  }
  return null;
}

window.addEventListener('beforeunload', () => {
  flushHistory();
  flushAutoSave();
  terminateWorker();
});