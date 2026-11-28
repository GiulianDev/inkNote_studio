/**
 * @module main
 *
 * COMPOSITION ROOT. Unico entry point dell'app.
 *
 * Ordine di boot (non modificare — l'ordine conta):
 *   1. mountLibraryPage() + mountNotebookPage()
 *      + mountToolbar() + mountSettingsModal() + mountPagesSidebar() → markup nel DOM
 *   2. initSettings()                          → applica tema/dock al body
 *   3. initToolbarSettings(null)               → default toolbar (no notebook)
 *   4. initDB()                                → apre IndexedDB
 *   5. initEditorHandlers() + bindEditorUI() + bindLibraryUI()
 *   6. onSettingsChanged / onToolbarSettingsChanged (subscription)
 *   7. renderLibraryView() + setupViewportGestures() + setupKeyboardShortcuts()
 *
 * NOTA ordine mount:
 *   - mountLibraryPage()    → crea #libraryView + #newNotebookModal
 *   - mountNotebookPage()   → crea #toolbarMount, #viewport, lazo bar, zoom, undo/redo
 *   - mountToolbar()        → riempie #toolbarMount e crea #mainHeader (necessario per
 *                             pages-sidebar che misura l'header)
 *   - mountSettingsModal()  → crea il modale impostazioni
 *   - mountPagesSidebar()   → sidebar pagine (dipende dall'header)
 *   Tutti prima di initSettings().
 *
 * Subscription attive:
 *   - settings:changed → ridisegna pagine se cambia tema
 *   - toolbar-settings:changed → riallinea UI + scheduleSave (escluso activeTool)
 *
 * @see core/types.js
 */

import { initDB } from './shared/services/db.js';
import { initPlatform } from './shared/core/platform.js';
import { initDeviceProfile } from './notebook/platform/profiles/index.js';
import { initSettings, onSettingsChanged } from './shared/core/app-settings.js';
import {
  initToolbarSettings, onToolbarSettingsChanged, getToolbarSettingsForSave
} from './notebook/toolbar/toolbar-settings.js';
import { state } from './shared/core/state.js';
import {
  centerViewport, scheduleResolutionRefresh
} from './notebook/editor/pages.js';
import { redrawPageCanvas, redrawSelectionOverlay } from './notebook/render/render.js';
import {
  hasLassoSelection,
  hideSelectionStylePopover,
  isSelectionStylePopoverOpen
} from './notebook/tools/lazo.js';
import { normalizeTextBoxes } from './notebook/tools/text.js';
import { setupViewportGestures } from './notebook/viewport/gestures.js';
import { setupKeyboardShortcuts } from './notebook/shortcuts/keyboard.js';
import { openHelpModal } from './notebook/shortcuts/shortcuts-modal.js';
import {
  renderRecentColors, applyActiveToolToUI,
  applySnapTogglesToUI, applyEraserLevelToUI,
  mountToolbar, hideColorPickerPopover, hidePagePopover, closeToolbarMenu
} from './notebook/toolbar/toolbar.js';
import { flushHistory } from './notebook/history/history.js';
import {
  initEditorHandlers, returnToLibrary, isEditorActive, openNotebook, closeNotebookIfOpen
} from './notebook/editor/editor.js';
import { bindEditorUI } from './notebook/editor/ui-bindings.js';
import { mountLibraryPage } from './library/library-page.js';
import { mountNotebookPage } from './notebook/notebook-page.js';
import { mountSettingsModal } from './shared/settings/settings-modal.js';
import { initSettingsPressurePreview } from './notebook/tools/pressure-preview.js';
import { mountPagesSidebar } from './notebook/pages-sidebar/pages-sidebar.js';
import {
  renderLibraryView, bindLibraryUI,
  getCurrentFolderId, setCurrentFolderId, getParentFolderId,
  isSelectionModeActive, exitSelectionMode,
  hasActiveLibrarySearch, clearLibrarySearch
} from './library/library.js';
import { flushAutoSave, scheduleSave } from './shared/persistence/autosave.js';
import { registerSessionAdapters } from './shared/persistence/session.js';
import { registerSyncNotebookHandlers } from './shared/sync/sync-ui.js';
import { registerBackupNotebookHandlers } from './shared/backup/backup-import.js';
import { closeAllAuthDropdowns } from './shared/auth/library-auth.js';
import { isUserMenuOpen } from './shared/components/user-menu.js';
import { terminateWorker } from './shared/backup/serialization-cloud.js';
import { handleRedirectResult } from './shared/services/firebase.js';
import { showToast, on } from './shared/core/utils.js';
import { getSettings, updateSettings } from './shared/core/app-settings.js';
import { initBackNavigation } from './shared/core/back-navigation.js';
import { setupSystemMenuSuppression } from './shared/core/system-menu-guard.js';
import { closeTopModal } from './shared/components/modal.js';

window.addEventListener('load', async () => {
  // 0. Piattaforma e listener input runtime (OS, device, hybrid, DPR, lastPointerType).
  initPlatform({ targetState: state });
  initDeviceProfile(state.platform);

  // 1. Pagine e componenti grafiche. Devono esistere PRIMA di initSettings():
  //    lo store applica tema/dock al DOM e cerca gli elementi della toolbar.
  //    Ordine: pagine (library + notebook) → toolbar → settings modal → pages sidebar.
  //    La sidebar misura #mainHeader al mount, quindi va DOPO la toolbar.
  mountLibraryPage();
  mountNotebookPage();
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
  registerSessionAdapters({ getToolbarSettingsForSave, normalizeTextBoxes });
  registerSyncNotebookHandlers({ openNotebook, closeNotebookIfOpen });
  registerBackupNotebookHandlers({ closeNotebookIfOpen });
  on('help:open', (detail) => openHelpModal(detail || { tab: 'guide' }));

  initEditorHandlers();
  bindEditorUI();
  initSettingsPressurePreview();
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
  const modalDismiss = closeTopModal('back');
  if (modalDismiss) {
    return modalDismiss.closed
      ? `modal:${modalDismiss.id}`
      : `modal-locked:${modalDismiss.id}`;
  }

  if (isUserMenuOpen()) {
    closeAllAuthDropdowns();
    return 'user-auth-menu';
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