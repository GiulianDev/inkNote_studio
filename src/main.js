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
  initToolbarSettings, onToolbarSettingsChanged,
  getToolbarSettingsForSave, getInitialNewNotebookToolbarSettings
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
import {
  initEditorHandlers, returnToLibrary, isEditorActive,
  openNotebook, closeNotebookIfOpen, flushActiveEditorBeforeLeave
} from './notebook/editor/editor.js';
import { bindEditorUI } from './notebook/editor/ui-bindings.js';
import { mountLibraryPage } from './library/library-page.js';
import { mountNotebookPage } from './notebook/notebook-page.js';
import { mountSettingsModal } from './shared/settings/settings-modal.js';
import { initSettingsPressurePreview } from './notebook/tools/pressure-preview.js';
import { mountPagesSidebar } from './notebook/pages-sidebar/pages-sidebar.js';
import {
  renderLibraryView, bindLibraryUI,
  registerLibraryNotebookHandlers,
  setLibraryLoading, resetLibraryForAccountSwitch,
  getCurrentFolderId, setCurrentFolderId, getParentFolderId,
  isSelectionModeActive, exitSelectionMode,
  hasActiveLibrarySearch, clearLibrarySearch
} from './library/library.js';
import { scheduleSave } from './shared/persistence/autosave.js';
import { registerSessionAdapters, getCurrentNotebook } from './shared/persistence/session.js';
import { registerSyncNotebookHandlers } from './shared/sync/sync-ui.js';
import { registerBackupNotebookHandlers } from './shared/backup/backup-import.js';
import {
  closeAllAuthDropdowns,
  registerAuthLifecycleHandlers,
  waitForInitialAuthTransition
} from './shared/auth/library-auth.js';
import { isUserMenuOpen } from './shared/components/user-menu.js';
import { terminateWorker } from './shared/backup/serialization-cloud.js';
import { handleRedirectResult, waitForInitialAuth } from './shared/services/firebase.js';
import { showToast, on } from './shared/core/utils.js';
import { getSettings, updateSettings } from './shared/core/app-settings.js';
import { initBackNavigation } from './shared/core/back-navigation.js';
import { setupSystemMenuSuppression } from './shared/core/system-menu-guard.js';
import { closeTopModal } from './shared/components/modal.js';
import { initTabSync } from './shared/core/tab-sync.js';
import { initPWA } from './shared/pwa/pwa.js';

window.addEventListener('load', async () => {
  // 0. Piattaforma e listener input runtime (OS, device, hybrid, DPR, lastPointerType).
  initPlatform({ targetState: state });
  initDeviceProfile(state.platform);

  // 1. Pagine e componenti grafiche. Devono esistere PRIMA di initSettings():
  //    lo store applica tema/dock al DOM e cerca gli elementi della toolbar.
  //    Ordine: pagine (library + notebook) → toolbar → settings modal → pages sidebar.
  //    La sidebar misura #mainHeader al mount, quindi va DOPO la toolbar.
  mountLibraryPage();
  setLibraryLoading(true, {
    title: 'Caricamento libreria...',
    subtitle: 'Verifica account e archivio locale in corso'
  });
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

  // 4. Init IndexedDB + eventi multi-tab DB.
  window.addEventListener('inknote:db-blocked', () => {
    showToast('Database bloccato da un’altra scheda. Chiudi o ricarica le altre schede.', '⚠️', 6000);
  });
  window.addEventListener('inknote:db-version-change', () => {
    showToast('App aggiornata in un’altra scheda. Ricarica questa pagina.', '⚠️', 7000);
  });

  try {
    await initDB();
  } catch (err) {
    console.error('[main] initDB failed:', err);
    showToast('Archivio locale non disponibile: impossibile salvare o aprire i quaderni.', '❌', 7000);
  }

  // 4b. Gestisci il ritorno dal redirect Google (mobile).
  // Su desktop è no-op (nessun redirect).
  try {
    await handleRedirectResult();
  } catch (err) {
    console.error('[main] redirect handler failed:', err);
  }

  // 5. Handler editor + adapter cross-layer + binding UI (ora tutti gli id esistono).
  registerSessionAdapters({ getToolbarSettingsForSave, normalizeTextBoxes });
  registerSyncNotebookHandlers({ openNotebook, closeNotebookIfOpen });
  registerBackupNotebookHandlers({ closeNotebookIfOpen });
  registerLibraryNotebookHandlers({
    openNotebook,
    closeNotebookIfOpen,
    getInitialNewNotebookToolbarSettings
  });
  registerAuthLifecycleHandlers({
    onBeforeAccountSwitch: async () => {
      const current = getCurrentNotebook();
      if (current || isEditorActive()) {
        try {
          await flushActiveEditorBeforeLeave({ deselect: true });
        } catch (err) {
          console.warn('[main] flush before account switch failed:', err);
        }
        if (current?.id) {
          closeNotebookIfOpen(current.id);
        }
        document.getElementById('libraryView')?.classList.remove('hidden');
      }
    },
    onResetLibrary: resetLibraryForAccountSwitch,
    onSetLoading: setLibraryLoading,
    onAccountChanged: async () => {
      await renderLibraryView();
    }
  });
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

  // 8. Attendi la prima risoluzione Auth + primo rendering della libreria scoped,
  //    quindi attiva gesti / tastiera / tasto Indietro.
  await waitForInitialAuth(2500);
  let initialTransitionResolved = false;
  await Promise.race([
    waitForInitialAuthTransition().then(() => { initialTransitionResolved = true; }),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  if (!initialTransitionResolved) {
    setLibraryLoading(false);
    await renderLibraryView();
  }
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

  // 9. Coordinamento multi-tab (BroadcastChannel) e supporto PWA offline/installabile.
  initTabSync({
    'library:mutated': (payload) => {
      const current = getCurrentNotebook();
      if (current && Array.isArray(payload?.overwrittenIds) && payload.overwrittenIds.includes(current.id)) {
        closeNotebookIfOpen(current.id);
        showToast('Quaderno sovrascritto da un’altra scheda.', 'ℹ️', 5000);
      }
      if (!isEditorActive()) {
        renderLibraryView();
      }
    },
    'notebook:deleted': (payload) => {
      const deletedIds = Array.isArray(payload?.notebookIds) ? payload.notebookIds : [];
      const current = getCurrentNotebook();
      if (current && deletedIds.includes(current.id)) {
        closeNotebookIfOpen(current.id);
        showToast('Quaderno eliminato da un’altra scheda.', '⚠️', 5000);
      }
      if (!isEditorActive()) {
        renderLibraryView();
      }
    },
    'notebook:saved': (payload) => {
      const current = getCurrentNotebook();
      if (current && payload?.notebookId === current.id) {
        showToast('Attenzione: questo quaderno è stato modificato anche in un’altra scheda.', '⚠️', 5000);
      } else if (!isEditorActive()) {
        renderLibraryView();
      }
    },
    'cloud:sync-completed': (payload) => {
      const current = getCurrentNotebook();
      if (current && payload?.openNotebookId && payload.openNotebookId === current.id) {
        if (payload.deletedOpenNotebook) {
          closeNotebookIfOpen(current.id);
          showToast('Quaderno rimosso dalla sincronizzazione in un’altra scheda.', '⚠️', 5000);
        } else if (payload.updatedOpenNotebook) {
          showToast('Quaderno aggiornato dal cloud in un’altra scheda. Riaprilo dalla libreria.', 'ℹ️', 6000);
        }
      }
      if (!isEditorActive()) {
        renderLibraryView();
      }
    }
  });

  initPWA({
    installBtn: document.getElementById('pwaInstallBtn'),
    offlineIndicator: document.getElementById('offlineStatusBadge'),
    onUpdateAvailable: () => {
      showToast('Nuova versione disponibile: ricarica per aggiornare.', '✨', 6000);
    }
  });

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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushActiveEditorBeforeLeave({ deselect: false });
  }
});

window.addEventListener('pagehide', (e) => {
  flushActiveEditorBeforeLeave({ deselect: !e.persisted });
  if (!e.persisted) {
    terminateWorker();
  }
});

window.addEventListener('beforeunload', () => {
  flushActiveEditorBeforeLeave({ deselect: true });
  terminateWorker();
});