// ============================================================
// LIBRERIA QUADERNI + CARTELLE + RICERCA + ORDINAMENTO + PREFERITI
// ============================================================

import { escapeHtml, showToast, showConfirmDialog, on, generatePageId } from '../../core/utils.js';
import { getSettings, updateSettings, onSettingsChanged } from '../../core/app-settings.js';
import {
  loadAllNotebooksFromDB, saveNotebookToDB, deleteNotebookFromDB, loadNotebookWithPages,
  updateNotebookMetadataInDB, loadAllFoldersFromDB, saveFolderToDB, deleteLibraryItemsFromDB
} from '../../services/db.js';
import { openNotebook, closeNotebookIfOpen } from '../editor/editor.js';
import { DEFAULT_TOOLBAR_SETTINGS } from '../toolbar/toolbar-settings.js';
import { openSettingsModal } from '../settings/settings-modal.js';
import { exportNotebooks } from '../backup/backup-export.js';
import { importNotebooks } from '../backup/backup-import.js';
import { showProgressDialog } from '../backup/backup-progress.js';
import {
  buildFolderTreeList, openFolderEditorModal, openMoveItemsModal
} from './library-modals.js';
import { createLibraryDndController } from './library-dnd.js';
import { bindLibraryAuth } from './library-auth.js';
import { openSharingModal } from '../sharing/sharing-ui.js';
import {
  getFolderPath,
  formatFolderPathLabel,
  getDescendantFolderIds,
  computeFolderCounts,
  buildFolderPreviewMap,
  compareNotebooks,
  compareFolders,
  filterLibraryItems,
  deepClone,
  generateDuplicateTitle,
  collectNotebookIdsInSelection,
  collectSubtreeSummary
} from './library-helpers.js';
import { createFolderCardElement, createNotebookCardElement } from './library-cards.js';
import {
  pushFolderBackState,
  navigateBreadcrumbBackState
} from '../../core/back-navigation.js';

const COVER_COLOR_ACTIVE_CLASSES = ['ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110'];

let selectedCoverColor = '#4f46e5';
let _selectionMode = false;
let _isDuplicating = false;
let _isCreatingNotebook = false;
let _renderRequestToken = 0;
const selectedNotebookIds = new Set();
const selectedFolderIds = new Set();

let _currentFolderId = null;
let _searchQuery = '';
let _cachedFolders = [];
let _cachedNotebooks = [];
let _dndController = null;

// ============================================================
// CONTROLLI & BREADCRUMBS
// ============================================================

function _syncLibraryControlsToUI() {
  const s = getSettings();
  const sortSel = document.getElementById('librarySortSelect');
  if (sortSel) sortSel.value = s.librarySortBy || 'updatedAt';

  const dirIcon = document.getElementById('librarySortDirIcon');
  const dirBtn = document.getElementById('librarySortDirBtn');
  const isAsc = s.librarySortDir === 'asc';
  if (dirIcon) {
    dirIcon.style.transform = isAsc ? 'rotate(180deg)' : 'rotate(0deg)';
  }
  if (dirBtn) {
    dirBtn.title = isAsc ? 'Ordine crescente (clicca per decrescente)' : 'Ordine decrescente (clicca per crescente)';
  }

  document.getElementById('libraryFavFilterBtn')?.classList.toggle('active', !!s.libraryOnlyFavorites);

  const viewMode = s.libraryViewMode === 'list' ? 'list' : 'grid';
  document.getElementById('libraryViewGridBtn')?.classList.toggle('active', viewMode === 'grid');
  document.getElementById('libraryViewListBtn')?.classList.toggle('active', viewMode === 'list');

  const grid = document.getElementById('notebooksGrid');
  if (grid) {
    grid.className = viewMode === 'list'
      ? 'flex flex-col gap-1.5'
      : 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-4';
  }

  const searchInput = document.getElementById('librarySearchInput');
  const clearBtn = document.getElementById('librarySearchClearBtn');
  if (searchInput && searchInput.value !== _searchQuery) {
    searchInput.value = _searchQuery;
  }
  if (clearBtn) {
    const hasQuery = _searchQuery.length > 0;
    clearBtn.classList.toggle('hidden', !hasQuery);
    clearBtn.classList.toggle('flex', hasQuery);
  }
}

function _renderBreadcrumbs(folderMap, query, onlyFavorites) {
  const nav = document.getElementById('libraryBreadcrumbs');
  if (!nav) return;

  const isSearching = query.length > 0;
  const path = getFolderPath(_currentFolderId, folderMap);
  const rootActive = !isSearching && _currentFolderId === null && !onlyFavorites;

  const parts = [`
    <button type="button" data-breadcrumb-id=""
      class="inline-flex items-center gap-1 px-2 py-1 rounded-lg transition cursor-pointer ${
        rootActive
          ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300'
          : 'hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
      }">
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      <span>Libreria</span>
    </button>
  `];

  if (isSearching) {
    parts.push(`<span class="text-slate-400">›</span>`);
    parts.push(`<span class="px-2 py-1 rounded-lg bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300">Ricerca: "${escapeHtml(query)}"</span>`);
  } else if (onlyFavorites && _currentFolderId === null) {
    parts.push(`<span class="text-slate-400">›</span>`);
    parts.push(`<span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300">★ Preferiti</span>`);
  } else {
    path.forEach((f, idx) => {
      const isLast = idx === path.length - 1;
      parts.push(`<span class="text-slate-400">›</span>`);
      parts.push(`
        <button type="button" data-breadcrumb-id="${escapeHtml(f.id)}"
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg transition cursor-pointer max-w-[160px] ${
            isLast
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300'
              : 'hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
          }">
          <span class="w-2 h-2 rounded-full shrink-0" style="background-color: ${escapeHtml(f.color || '#6366f1')};"></span>
          <span class="truncate">${escapeHtml(f.name)}</span>
        </button>
      `);
    });
  }

  nav.innerHTML = parts.join('');
  nav.querySelectorAll('[data-breadcrumb-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.breadcrumbId || null;
      const targetDepth = targetId === null
        ? 0
        : (path.findIndex(f => f.id === targetId) + 1);
      if (_selectionMode) _exitSelectionMode();
      if (_searchQuery) {
        _searchQuery = '';
        _syncLibraryControlsToUI();
      }
      if (targetId === null && getSettings().libraryOnlyFavorites) {
        updateSettings({ libraryOnlyFavorites: false });
      }
      if (targetDepth > 0 && navigateBreadcrumbBackState(targetId, targetDepth)) {
        return;
      }
      if (targetId === null && navigateBreadcrumbBackState(null, 0)) {
        return;
      }
      _currentFolderId = targetId;
      renderLibraryView();
    });
  });
}

export function getCurrentFolderId() {
  return _currentFolderId;
}

export function setCurrentFolderId(folderId, { render = true } = {}) {
  _currentFolderId = folderId || null;
  if (render) renderLibraryView();
}

export function getParentFolderId(folderId) {
  if (!folderId) return null;
  const f = _cachedFolders.find(item => item && item.id === folderId);
  return f?.parentId || null;
}

export function isSelectionModeActive() {
  return _selectionMode;
}

export function exitSelectionMode() {
  if (_selectionMode) _exitSelectionMode();
}

export function hasActiveLibrarySearch() {
  return _searchQuery.length > 0;
}

export function clearLibrarySearch() {
  if (!_searchQuery) return;
  _searchQuery = '';
  const searchInput = document.getElementById('librarySearchInput');
  if (searchInput) searchInput.value = '';
  _syncLibraryControlsToUI();
  renderLibraryView();
}

// ============================================================
// SELEZIONE MULTIPLA
// ============================================================

function _syncHeaderModeUI() {
  const header = document.getElementById('libraryHeader');
  const leadingBtn = document.getElementById('libraryLeadingBtn');
  const titleGroup = document.getElementById('libraryHeaderTitleGroup');
  const titleEl = document.getElementById('libraryHeaderTitle');
  const subtitleEl = document.getElementById('libraryHeaderSubtitle');

  if (header) {
    header.classList.add('has-mode-transition');
    header.classList.toggle('is-selection-mode', _selectionMode);
  }

  if (titleGroup) {
    titleGroup.classList.remove('is-title-swap');
    void titleGroup.offsetWidth;
    titleGroup.classList.add('is-title-swap');
  }

  if (leadingBtn) {
    leadingBtn.tabIndex = _selectionMode ? 0 : -1;
    leadingBtn.setAttribute('aria-hidden', _selectionMode ? 'false' : 'true');
    if (_selectionMode) {
      leadingBtn.title = 'Esci dalla selezione';
      leadingBtn.setAttribute('aria-label', 'Esci dalla selezione');
    } else {
      leadingBtn.removeAttribute('title');
      leadingBtn.removeAttribute('aria-label');
    }
  }

  if (!_selectionMode) {
    if (titleEl) titleEl.textContent = 'InkNote Library';
    if (subtitleEl) subtitleEl.textContent = 'I tuoi blocchetti salvati in locale';
  } else if (subtitleEl) {
    subtitleEl.textContent = 'Tocca quaderni o raccolte';
  }
}

function _enterSelectionMode(initial = null) {
  if (_selectionMode) return;
  _selectionMode = true;
  _dndController?.cancel();

  if (initial && typeof initial === 'object') {
    if (initial.type === 'folder' && initial.id) selectedFolderIds.add(initial.id);
    else if (initial.type === 'notebook' && initial.id) selectedNotebookIds.add(initial.id);
  } else if (typeof initial === 'string' && initial) {
    selectedNotebookIds.add(initial);
  }

  document.getElementById('authDropdown')?.classList.add('hidden');
  _syncHeaderModeUI();
  _applySelectionStateToCards();
  _updateSelectionBar();
}

function _exitSelectionMode() {
  _selectionMode = false;
  selectedNotebookIds.clear();
  selectedFolderIds.clear();

  _syncHeaderModeUI();
  _applySelectionStateToCards();
}

function _toggleSelection(type, id) {
  if (!_selectionMode || !id) return;

  const targetSet = type === 'folder' ? selectedFolderIds : selectedNotebookIds;
  if (targetSet.has(id)) {
    targetSet.delete(id);
  } else {
    targetSet.add(id);
  }

  _applySelectionStateToCards();
  _updateSelectionBar();

  if (selectedNotebookIds.size === 0 && selectedFolderIds.size === 0) {
    _exitSelectionMode();
  }
}

function _applySelectionStateToCards() {
  document.querySelectorAll('.notebook-card').forEach(card => {
    const id = card.dataset.nbId;
    if (!id) return;
    const isSelected = selectedNotebookIds.has(id);
    card.classList.toggle('is-selected', isSelected);
    card.classList.toggle('selection-mode', _selectionMode);
    card.querySelector('.selection-dot')?.classList.toggle('active', isSelected);
  });

  document.querySelectorAll('.folder-card').forEach(card => {
    const id = card.dataset.folderId;
    if (!id) return;
    const isSelected = selectedFolderIds.has(id);
    card.classList.toggle('is-selected', isSelected);
    card.classList.toggle('selection-mode', _selectionMode);
    card.querySelector('.selection-dot')?.classList.toggle('active', isSelected);
  });
}

function _updateSelectionBar() {
  const count = selectedNotebookIds.size + selectedFolderIds.size;
  const titleEl = document.getElementById('libraryHeaderTitle');
  if (titleEl && _selectionMode) {
    titleEl.textContent = `${count} selezionat${count === 1 ? 'o' : 'i'}`;
  }

  const moveBtn = document.getElementById('selectionMoveBtn');
  const duplicateBtn = document.getElementById('selectionDuplicateBtn');
  const sendBtn = document.getElementById('selectionSendBtn');
  const exportBtn = document.getElementById('selectionExportBtn');
  const deleteBtn = document.getElementById('selectionDeleteBtn');
  const sendableNbIds = collectNotebookIdsInSelection({
    selectedNotebookIds,
    selectedFolderIds,
    folders: _cachedFolders,
    notebooks: _cachedNotebooks
  });
  if (moveBtn) moveBtn.disabled = count === 0;
  if (duplicateBtn) duplicateBtn.disabled = count === 0 || _isDuplicating;
  if (sendBtn) sendBtn.disabled = sendableNbIds.length === 0;
  if (exportBtn) exportBtn.disabled = count === 0;
  if (deleteBtn) deleteBtn.disabled = count === 0;
}

function _selectAll() {
  document.querySelectorAll('.notebook-card').forEach(card => {
    if (card.dataset.nbId) selectedNotebookIds.add(card.dataset.nbId);
  });
  document.querySelectorAll('.folder-card').forEach(card => {
    if (card.dataset.folderId) selectedFolderIds.add(card.dataset.folderId);
  });
  _applySelectionStateToCards();
  _updateSelectionBar();
}

// ============================================================
// RENDERING LIBRERIA
// ============================================================

function _updateEmptyState({ isVisible, isSearching, onlyFavorites, rawQuery }) {
  const emptyMsg = document.getElementById('emptyLibraryMessage');
  if (!emptyMsg) return;

  if (!isVisible) {
    emptyMsg.classList.add('hidden');
    emptyMsg.classList.remove('flex');
    return;
  }

  const iconEl = document.getElementById('emptyLibraryIcon');
  const titleEl = document.getElementById('emptyLibraryTitle');
  const subEl = document.getElementById('emptyLibrarySubtitle');

  if (isSearching) {
    if (iconEl) iconEl.textContent = '🔍';
    if (titleEl) titleEl.textContent = 'Nessun risultato trovato';
    if (subEl) subEl.textContent = `Nessuna raccolta o quaderno corrisponde a "${rawQuery}".`;
  } else if (onlyFavorites) {
    if (iconEl) iconEl.textContent = '⭐';
    if (titleEl) titleEl.textContent = 'Nessun quaderno preferito';
    if (subEl) subEl.textContent = 'Clicca sulla stella di un quaderno per aggiungerlo ai preferiti.';
  } else if (_currentFolderId !== null) {
    if (iconEl) iconEl.textContent = '🗂️';
    if (titleEl) titleEl.textContent = 'Questa raccolta è vuota';
    if (subEl) subEl.textContent = 'Crea un quaderno, una sottoraccolta o trascina qui i tuoi appunti.';
  } else {
    if (iconEl) iconEl.textContent = '📓';
    if (titleEl) titleEl.textContent = 'Nessun quaderno presente';
    if (subEl) subEl.textContent = 'Clicca su "Nuovo Quaderno" per iniziare a prendere appunti.';
  }

  emptyMsg.classList.remove('hidden');
  emptyMsg.classList.add('flex');
}

export function renderLibraryView() {
  const token = ++_renderRequestToken;
  Promise.all([loadAllNotebooksFromDB(), loadAllFoldersFromDB()]).then(([notebooks, folders]) => {
    if (token !== _renderRequestToken) return;

    _cachedNotebooks = notebooks || [];
    _cachedFolders = folders || [];

    const folderMap = new Map();
    for (const f of _cachedFolders) {
      if (f && f.id) folderMap.set(f.id, f);
    }

    if (_currentFolderId && !folderMap.has(_currentFolderId)) {
      _currentFolderId = null;
    }

    const s = getSettings();
    const sortBy = s.librarySortBy || 'updatedAt';
    const sortDir = s.librarySortDir || 'desc';
    const onlyFavorites = !!s.libraryOnlyFavorites;
    const viewMode = s.libraryViewMode === 'list' ? 'list' : 'grid';
    const showTextBelow = !!s.libraryShowTextBelow;
    const rawQuery = _searchQuery.trim();
    const isSearching = rawQuery.length > 0;

    _syncLibraryControlsToUI();
    _renderBreadcrumbs(folderMap, rawQuery, onlyFavorites);

    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    if (!grid || !emptyMsg) return;
    grid.innerHTML = '';

    const folderCounts = computeFolderCounts(_cachedFolders, _cachedNotebooks, folderMap);
    const previewMap = buildFolderPreviewMap(_cachedFolders, _cachedNotebooks, folderMap);

    const { visibleFolders, visibleNotebooks } = filterLibraryItems({
      folders: _cachedFolders,
      notebooks: _cachedNotebooks,
      folderMap,
      currentFolderId: _currentFolderId,
      query: rawQuery,
      onlyFavorites
    });

    visibleFolders.sort((a, b) => compareFolders(a, b, sortBy, sortDir, folderCounts));
    visibleNotebooks.sort((a, b) => compareNotebooks(a, b, sortBy, sortDir));

    const visibleNbIds = new Set(visibleNotebooks.map(n => n.id));
    for (const id of Array.from(selectedNotebookIds)) {
      if (!visibleNbIds.has(id)) selectedNotebookIds.delete(id);
    }
    const visibleFolderIds = new Set(visibleFolders.map(f => f.id));
    for (const fid of Array.from(selectedFolderIds)) {
      if (!visibleFolderIds.has(fid)) selectedFolderIds.delete(fid);
    }
    if (_selectionMode && selectedNotebookIds.size === 0 && selectedFolderIds.size === 0) {
      _exitSelectionMode();
    }

    const selectBtn = document.getElementById('librarySelectBtn');
    if (selectBtn) {
      const noItems = visibleFolders.length === 0 && visibleNotebooks.length === 0;
      selectBtn.disabled = noItems;
      selectBtn.classList.toggle('opacity-40', noItems);
      selectBtn.classList.toggle('cursor-not-allowed', noItems);
      selectBtn.title = noItems
        ? 'Nessun elemento da selezionare in questa vista'
        : 'Seleziona quaderni o raccolte';
    }

    const summaryEl = document.getElementById('libraryItemsSummary');
    if (summaryEl) {
      const sumParts = [];
      if (visibleFolders.length > 0) {
        sumParts.push(`${visibleFolders.length} raccolt${visibleFolders.length === 1 ? 'a' : 'e'}`);
      }
      sumParts.push(`${visibleNotebooks.length} quadern${visibleNotebooks.length === 1 ? 'o' : 'i'}`);
      summaryEl.textContent = sumParts.join(' · ');
    }

    const showPathTags = isSearching || (onlyFavorites && _currentFolderId === null);
    const isEmpty = visibleFolders.length === 0 && visibleNotebooks.length === 0;

    _updateEmptyState({ isVisible: isEmpty, isSearching, onlyFavorites, rawQuery });

    if (!isEmpty) {
      const fragment = document.createDocumentFragment();

      for (const folder of visibleFolders) {
        fragment.appendChild(createFolderCardElement({
          folder,
          counts: folderCounts,
          folderMap,
          previewMap,
          showParentBadge: isSearching,
          viewMode,
          showTextBelow,
          getDndController: () => _dndController,
          onLongPress: (targetFolder) => {
            if (!_selectionMode) {
              _enterSelectionMode({ type: 'folder', id: targetFolder.id });
            } else {
              _toggleSelection('folder', targetFolder.id);
            }
          },
          onClick: (e, targetFolder) => {
            if (_selectionMode) {
              e.preventDefault();
              e.stopPropagation();
              _toggleSelection('folder', targetFolder.id);
              return;
            }
            if (_searchQuery) {
              _searchQuery = '';
              _syncLibraryControlsToUI();
            }
            pushFolderBackState(targetFolder.id);
            _currentFolderId = targetFolder.id;
            renderLibraryView();
          },
          onEdit: _handleEditFolder,
          onMove: _handleMoveFolder,
          onDelete: _handleDeleteFolder
        }));
      }

      for (const nb of visibleNotebooks) {
        fragment.appendChild(createNotebookCardElement({
          nb,
          folderMap,
          showPathTags,
          viewMode,
          showTextBelow,
          getDndController: () => _dndController,
          onLongPress: (targetNb) => {
            if (!_selectionMode) {
              _enterSelectionMode({ type: 'notebook', id: targetNb.id });
            } else {
              _toggleSelection('notebook', targetNb.id);
            }
          },
          onClick: (e, targetNb) => {
            if (_selectionMode) {
              e.preventDefault();
              e.stopPropagation();
              _toggleSelection('notebook', targetNb.id);
              return;
            }
            openNotebook(targetNb.id);
          },
          onToggleFavorite: _toggleNotebookFavorite,
          onDelete: _deleteNotebook
        }));
      }

      grid.appendChild(fragment);

      if (_selectionMode) {
        _applySelectionStateToCards();
        _updateSelectionBar();
      }
    }

    document.getElementById('libraryView')?.classList.remove('hidden');
  });
}

// ============================================================
// AZIONI RACCOLTE, DRAG & DROP & PREFERITI
// ============================================================

async function _toggleNotebookFavorite(nb) {
  const next = !nb.isFavorite;
  try {
    await updateNotebookMetadataInDB(nb.id, { isFavorite: next });
    nb.isFavorite = next;
    renderLibraryView();
    showToast(next ? 'Aggiunto ai preferiti' : 'Rimosso dai preferiti', next ? '⭐' : '☆');
  } catch (err) {
    console.error('[library] toggle favorite failed:', err);
    showToast('Errore aggiornamento preferiti', '❌');
  }
}

async function _handleCreateFolder() {
  const folderMap = new Map(_cachedFolders.map(f => [f.id, f]));
  const parentName = _currentFolderId
    ? formatFolderPathLabel(_currentFolderId, folderMap)
    : 'Libreria (principale)';

  const res = await openFolderEditorModal({
    mode: 'create',
    parentName
  });
  if (!res) return;

  const folder = {
    id: `fld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: res.name,
    parentId: _currentFolderId || null,
    color: res.color
  };

  try {
    await saveFolderToDB(folder);
    if (getSettings().libraryOnlyFavorites) {
      updateSettings({ libraryOnlyFavorites: false });
    }
    if (_searchQuery) {
      _searchQuery = '';
      _syncLibraryControlsToUI();
    }
    renderLibraryView();
    showToast(`Raccolta "${folder.name}" creata`, '🗂️');
  } catch (err) {
    console.error('[library] create collection failed:', err);
    showToast('Creazione raccolta fallita', '❌');
  }
}

async function _handleEditFolder(folder) {
  const res = await openFolderEditorModal({
    mode: 'edit',
    folder
  });
  if (!res) return;

  try {
    await saveFolderToDB({
      ...folder,
      name: res.name,
      color: res.color
    });
    renderLibraryView();
    showToast('Raccolta aggiornata', '🗂️');
  } catch (err) {
    console.error('[library] edit collection failed:', err);
    showToast('Modifica raccolta fallita', '❌');
  }
}

async function _handleMoveFolder(folder) {
  const excluded = getDescendantFolderIds(folder.id, _cachedFolders);
  const destId = await openMoveItemsModal({
    folders: _cachedFolders,
    initialTargetId: folder.parentId || null,
    excludedFolderIds: excluded,
    title: `Sposta "${folder.name}"`,
    subtitle: 'Scegli la raccolta di destinazione'
  });
  if (destId === undefined) return;
  if ((folder.parentId || null) === destId) return;

  try {
    await saveFolderToDB({
      ...folder,
      parentId: destId
    });
    renderLibraryView();
    showToast('Raccolta spostata', '🗂️');
  } catch (err) {
    console.error('[library] move collection failed:', err);
    showToast('Spostamento fallito', '❌');
  }
}

function _formatSubtreeContentsLabel(subCount, nbCount) {
  const parts = [];
  if (subCount > 0) parts.push(`${subCount} sottoraccolt${subCount === 1 ? 'a' : 'e'}`);
  if (nbCount > 0) parts.push(`${nbCount} quadern${nbCount === 1 ? 'o' : 'i'}`);
  return parts.join(' e ');
}

async function _handleDeleteFolder(folder) {
  const subtree = collectSubtreeSummary({
    folderIds: [folder.id],
    folders: _cachedFolders,
    notebooks: _cachedNotebooks
  });
  const subCount = subtree.subfolderCount;
  const nbCount = subtree.nestedNotebooks.length;
  const hasContents = subCount > 0 || nbCount > 0;

  let confirmed = false;
  let deleteContents = true;

  if (!hasContents) {
    confirmed = await showConfirmDialog({
      title: `Eliminare la raccolta "${folder.name}"?`,
      message: 'Questa raccolta è vuota.',
      confirmText: 'Elimina raccolta',
      danger: true
    });
  } else {
    const contentLabel = _formatSubtreeContentsLabel(subCount, nbCount);
    const res = await showConfirmDialog({
      title: `Eliminare la raccolta "${folder.name}"?`,
      message: `Contiene ${contentLabel}. Verranno eliminati definitivamente anche tutto il suo contenuto e le relative pagine.`,
      confirmText: 'Elimina tutto',
      danger: true,
      checkbox: {
        label: 'Mantieni i contenuti (spostali nella raccolta superiore)',
        checked: false,
        checkedMessage: `Contiene ${contentLabel}. Verrà eliminata solo la raccolta: quaderni e sottoraccolte saranno spostati nella raccolta superiore.`,
        checkedConfirmText: 'Elimina solo raccolta'
      }
    });
    confirmed = !!res?.confirmed;
    deleteContents = !res?.checked;
  }

  if (!confirmed) return;

  try {
    const { deletedFolderIds, deletedNotebookIds } = await deleteLibraryItemsFromDB({
      folderIds: [folder.id],
      deleteFolderContents: deleteContents
    });
    for (const delFldId of deletedFolderIds) selectedFolderIds.delete(delFldId);
    for (const delNbId of deletedNotebookIds) {
      selectedNotebookIds.delete(delNbId);
      closeNotebookIfOpen(delNbId);
    }
    if (_currentFolderId && deletedFolderIds.includes(_currentFolderId)) {
      _currentFolderId = folder.parentId || null;
    }
    renderLibraryView();
    if (hasContents && deleteContents) {
      showToast('Raccolta e contenuti eliminati', '🗑️');
    } else {
      showToast('Raccolta eliminata', '🗑️');
    }
  } catch (err) {
    console.error('[library] delete collection failed:', err);
    showToast('Eliminazione raccolta fallita', '❌');
  }
}

async function _handleMoveSelection() {
  const nbIds = Array.from(selectedNotebookIds);
  const fldIds = Array.from(selectedFolderIds);
  const total = nbIds.length + fldIds.length;
  if (total === 0) return;

  const excludedFolderIds = new Set();
  for (const fid of fldIds) {
    for (const descId of getDescendantFolderIds(fid, _cachedFolders)) {
      excludedFolderIds.add(descId);
    }
  }

  let modalTitle;
  if (nbIds.length > 0 && fldIds.length === 0) {
    modalTitle = `Sposta ${nbIds.length} quadern${nbIds.length === 1 ? 'o' : 'i'}`;
  } else if (fldIds.length > 0 && nbIds.length === 0) {
    modalTitle = `Sposta ${fldIds.length} raccolt${fldIds.length === 1 ? 'a' : 'e'}`;
  } else {
    modalTitle = `Sposta ${total} elementi selezionati`;
  }

  const destId = await openMoveItemsModal({
    folders: _cachedFolders,
    initialTargetId: _currentFolderId,
    excludedFolderIds,
    title: modalTitle,
    subtitle: 'Scegli la raccolta di destinazione'
  });
  if (destId === undefined) return;

  try {
    for (const id of nbIds) {
      await updateNotebookMetadataInDB(id, { folderId: destId });
    }
    for (const fid of fldIds) {
      const folder = _cachedFolders.find(f => f.id === fid);
      if (folder && (folder.parentId || null) !== destId) {
        await saveFolderToDB({ ...folder, parentId: destId });
      }
    }
    const destName = destId
      ? (_cachedFolders.find(f => f.id === destId)?.name || 'Raccolta')
      : 'Libreria';
    _exitSelectionMode();
    renderLibraryView();
    showToast(
      total === 1
        ? `Elemento spostato in "${destName}"`
        : `${total} elementi spostati in "${destName}"`,
      '🗂️'
    );
  } catch (err) {
    console.error('[library] move selection failed:', err);
    showToast('Spostamento fallito', '❌');
  }
}

function _canMoveDraggedToFolder(dragged, destId, allowRoot) {
  if (!dragged) return false;
  if (dragged.type === 'notebook') {
    const nb = _cachedNotebooks.find(n => n.id === dragged.id);
    return !!nb && (nb.folderId || null) !== destId;
  }
  if (dragged.type === 'folder') {
    if (!allowRoot && dragged.id === destId) return false;
    const folder = _cachedFolders.find(f => f.id === dragged.id);
    if (!folder || (folder.parentId || null) === destId) return false;
    if (!destId) return allowRoot;
    const excluded = getDescendantFolderIds(dragged.id, _cachedFolders);
    return !excluded.has(destId);
  }
  return false;
}

async function _moveDraggedItemToFolder(dragged, destId, targetLabel) {
  try {
    if (dragged.type === 'notebook') {
      const nb = _cachedNotebooks.find(n => n.id === dragged.id);
      if (!nb || (nb.folderId || null) === destId) return;
      await updateNotebookMetadataInDB(dragged.id, { folderId: destId });
      renderLibraryView();
      showToast(`"${nb.title}" spostato in "${targetLabel}"`, '🗂️');
    } else if (dragged.type === 'folder') {
      const folder = _cachedFolders.find(f => f.id === dragged.id);
      if (!folder || (folder.parentId || null) === destId) return;
      if (destId) {
        const excluded = getDescendantFolderIds(folder.id, _cachedFolders);
        if (excluded.has(destId)) return;
      }
      await saveFolderToDB({ ...folder, parentId: destId });
      renderLibraryView();
      showToast(`"${folder.name}" spostata in "${targetLabel}"`, '🗂️');
    }
  } catch (err) {
    console.error('[library-dnd] move item failed:', err);
    showToast('Spostamento fallito', '❌');
  }
}

async function _handleDndDropOnCollection(dragged, targetFolderId) {
  const targetFolder = _cachedFolders.find(f => f.id === targetFolderId);
  if (!targetFolder) return;
  await _moveDraggedItemToFolder(dragged, targetFolderId, targetFolder.name);
}

async function _handleDndDropOnBreadcrumb(dragged, targetFolderId) {
  const destId = targetFolderId || null;
  const targetName = destId
    ? (_cachedFolders.find(f => f.id === destId)?.name || 'Raccolta')
    : 'Libreria';
  await _moveDraggedItemToFolder(dragged, destId, targetName);
}

async function _handleDndMergeNotebooks(sourceNbId, targetNbId) {
  if (!sourceNbId || !targetNbId || sourceNbId === targetNbId) return;
  const sourceNb = _cachedNotebooks.find(n => n.id === sourceNbId);
  const targetNb = _cachedNotebooks.find(n => n.id === targetNbId);
  if (!sourceNb || !targetNb) return;

  const res = await openFolderEditorModal({
    mode: 'create',
    title: 'Crea Nuova Raccolta',
    subtitle: `Raggruppa "${sourceNb.title}" e "${targetNb.title}"`,
    initialName: 'Nuova raccolta'
  });
  if (!res) return;

  const parentId = (targetNb.folderId && _cachedFolders.some(f => f.id === targetNb.folderId))
    ? targetNb.folderId
    : (_currentFolderId || null);

  const newFolder = {
    id: `fld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: res.name,
    parentId,
    color: res.color
  };

  try {
    await saveFolderToDB(newFolder);
    await updateNotebookMetadataInDB(targetNb.id, { folderId: newFolder.id });
    await updateNotebookMetadataInDB(sourceNb.id, { folderId: newFolder.id });
    renderLibraryView();
    showToast(`Raccolta "${newFolder.name}" creata`, '🗂️');
  } catch (err) {
    console.error('[library-dnd] merge notebooks failed:', err);
    showToast('Creazione raccolta fallita', '❌');
  }
}

// ============================================================
// AZIONI SELEZIONE (duplicate, export, delete) & IMPORT
// ============================================================

async function _handleDuplicateSelection() {
  if (_isDuplicating || (selectedNotebookIds.size === 0 && selectedFolderIds.size === 0)) return;

  _isDuplicating = true;
  _updateSelectionBar();

  const directNbIds = Array.from(selectedNotebookIds);
  const directFldIds = Array.from(selectedFolderIds);
  try {
    const [allNotebooks, allFolders] = await Promise.all([
      loadAllNotebooksFromDB(),
      loadAllFoldersFromDB()
    ]);

    const existingTitles = new Set(
      allNotebooks.map(n => (n.title || '').trim().toLowerCase())
    );
    const originalFolders = allFolders.slice();
    const folderMap = new Map(originalFolders.filter(f => f && f.id).map(f => [f.id, f]));
    const selectedFolderSet = new Set(directFldIds);

    const rootSelectedFolderIds = directFldIds.filter(fid => {
      const f = folderMap.get(fid);
      if (!f || !f.parentId) return true;
      return !getFolderPath(f.parentId, folderMap).some(anc => selectedFolderSet.has(anc.id));
    });

    const oldToNewFolderId = new Map();
    const baseTs = Date.now();
    let seq = 0;

    const cloneFolderRecursive = async (srcFolder, newParentId, isRootClone) => {
      let nextName = srcFolder.name || 'Raccolta';
      if (isRootClone) {
        const siblingNames = new Set(
          allFolders
            .filter(f => (f.parentId || null) === (newParentId || null))
            .map(f => (f.name || '').trim().toLowerCase())
        );
        nextName = generateDuplicateTitle(nextName, siblingNames);
      }
      const newFolder = {
        id: `fld_${baseTs}_${seq++}_${Math.random().toString(36).slice(2, 6)}`,
        name: nextName,
        parentId: newParentId || null,
        color: srcFolder.color || '#6366f1'
      };
      const saved = await saveFolderToDB(newFolder);
      if (saved) allFolders.push(saved);
      oldToNewFolderId.set(srcFolder.id, newFolder.id);

      const children = originalFolders.filter(
        f => (f.parentId || null) === srcFolder.id && !oldToNewFolderId.has(f.id)
      );
      for (const child of children) {
        await cloneFolderRecursive(child, newFolder.id, false);
      }
    };

    for (const rootFid of rootSelectedFolderIds) {
      const srcFolder = folderMap.get(rootFid);
      if (srcFolder) {
        await cloneFolderRecursive(srcFolder, srcFolder.parentId || null, true);
      }
    }

    const cloneNotebookIntoFolder = async (nbId, targetFolderId) => {
      const src = await loadNotebookWithPages(nbId);
      if (!src) return false;

      const newTitle = generateDuplicateTitle(src.title, existingTitles);
      existingTitles.add(newTitle.toLowerCase());

      const now = new Date().toISOString();
      const newPages = (src.pages || []).map(p => {
        const cloned = deepClone(p || {});
        delete cloned.pageIndex;
        delete cloned.notebookId;
        cloned.pageId = generatePageId();
        if (!Array.isArray(cloned.strokes)) cloned.strokes = [];
        if (!Array.isArray(cloned.textBoxes)) cloned.textBoxes = [];
        return cloned;
      });
      if (newPages.length === 0) {
        newPages.push({ pageId: generatePageId(), strokes: [], textBoxes: [] });
      }
      const newPageIds = newPages.map(p => p.pageId);

      const { pages: _ignoredPages, pageOrder: _ignoredOrder, ...restSrc } = src;
      const dupNb = {
        ...deepClone(restSrc),
        id: `nb_${baseTs}_${seq++}_${Math.random().toString(36).slice(2, 6)}`,
        title: newTitle,
        coverColor: src.coverColor || '#4f46e5',
        pattern: src.pattern || 'ruled',
        folderId: targetFolderId || null,
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
        lastEditAt: now,
        toolbarSettings: src.toolbarSettings ? deepClone(src.toolbarSettings) : null,
        pageOrder: newPageIds.slice(),
        pages: newPages,
        lastPageIndex: typeof src.lastPageIndex === 'number'
          ? Math.min(Math.max(0, src.lastPageIndex), newPages.length - 1)
          : 0
      };

      await saveNotebookToDB(dupNb, newPageIds, { saveOrder: true });
      return true;
    };

    let duplicatedNbs = 0;
    const clonedSrcNbIds = new Set();

    for (const nb of allNotebooks) {
      if (nb.folderId && oldToNewFolderId.has(nb.folderId)) {
        if (await cloneNotebookIntoFolder(nb.id, oldToNewFolderId.get(nb.folderId))) {
          duplicatedNbs++;
          clonedSrcNbIds.add(nb.id);
        }
      }
    }

    for (const nbId of directNbIds) {
      if (clonedSrcNbIds.has(nbId)) continue;
      const srcMeta = allNotebooks.find(n => n.id === nbId);
      const targetFld = (srcMeta && oldToNewFolderId.has(srcMeta.folderId))
        ? oldToNewFolderId.get(srcMeta.folderId)
        : (srcMeta?.folderId || null);
      if (await cloneNotebookIntoFolder(nbId, targetFld)) {
        duplicatedNbs++;
      }
    }

    const duplicatedFolders = oldToNewFolderId.size;
    _exitSelectionMode();
    renderLibraryView();

    if (duplicatedFolders > 0 && duplicatedNbs > 0) {
      showToast(
        `Duplicat${duplicatedFolders === 1 ? 'a' : 'e'} ${duplicatedFolders} raccolt${duplicatedFolders === 1 ? 'a' : 'e'} e ${duplicatedNbs} quadern${duplicatedNbs === 1 ? 'o' : 'i'}`,
        '📄'
      );
    } else if (duplicatedFolders > 0) {
      showToast(
        duplicatedFolders === 1 ? 'Raccolta duplicata' : `${duplicatedFolders} raccolte duplicate`,
        '🗂️'
      );
    } else if (duplicatedNbs > 0) {
      showToast(
        duplicatedNbs === 1 ? 'Quaderno duplicato' : `${duplicatedNbs} quaderni duplicati`,
        '📄'
      );
    }
  } catch (err) {
    console.error('[duplicate-selection] failed:', err);
    showToast('Duplicazione fallita', '❌');
  } finally {
    _isDuplicating = false;
    _updateSelectionBar();
  }
}

async function _handleSendSelection() {
  const ids = collectNotebookIdsInSelection({
    selectedNotebookIds,
    selectedFolderIds,
    folders: _cachedFolders,
    notebooks: _cachedNotebooks
  });
  if (ids.length === 0) {
    showToast('Seleziona almeno un quaderno da inviare', '⚠️');
    return;
  }
  const nbMap = new Map(_cachedNotebooks.map(n => [n.id, n]));
  const sendNotebooks = ids.map(id => nbMap.get(id)).filter(Boolean);
  if (sendNotebooks.length === 0) return;
  openSharingModal({ sendNotebooks });
}

async function _handleExportSelection() {
  const nbCount = selectedNotebookIds.size;
  const fldCount = selectedFolderIds.size;
  if (nbCount === 0 && fldCount === 0) return;

  const ids = collectNotebookIdsInSelection({
    selectedNotebookIds,
    selectedFolderIds,
    folders: _cachedFolders,
    notebooks: _cachedNotebooks
  });

  const progress = showProgressDialog('Esportazione in corso...');
  try {
    await exportNotebooks(
      ids,
      ({ done, total, notebookTitle }) => {
        progress.update({ done, total, label: notebookTitle });
      },
      {
        folders: _cachedFolders,
        selectedFolderIds: new Set(selectedFolderIds)
      }
    );
    progress.close();
    _exitSelectionMode();
    renderLibraryView();
  } catch (err) {
    console.error('[export] failed:', err);
    progress.close();
    showToast('Esportazione fallita', '❌');
  }
}

async function _handleDeleteSelection() {
  const nbIds = Array.from(selectedNotebookIds);
  const fldIds = Array.from(selectedFolderIds);
  if (nbIds.length === 0 && fldIds.length === 0) return;

  const subtree = fldIds.length > 0
    ? collectSubtreeSummary({ folderIds: fldIds, folders: _cachedFolders, notebooks: _cachedNotebooks })
    : { subfolderCount: 0, nestedNotebooks: [] };

  const subCount = subtree.subfolderCount;
  const nestedNbCount = subtree.nestedNotebooks.length;
  const hasFolderContents = fldIds.length > 0 && (subCount > 0 || nestedNbCount > 0);

  let title;
  if (nbIds.length > 0 && fldIds.length === 0) {
    title = `Eliminare ${nbIds.length} quadern${nbIds.length === 1 ? 'o' : 'i'}?`;
  } else if (fldIds.length > 0 && nbIds.length === 0) {
    title = `Eliminare ${fldIds.length} raccolt${fldIds.length === 1 ? 'a' : 'e'}?`;
  } else {
    title = `Eliminare ${nbIds.length} quadern${nbIds.length === 1 ? 'o' : 'i'} e ${fldIds.length} raccolt${fldIds.length === 1 ? 'a' : 'e'}?`;
  }

  let confirmed = false;
  let deleteContents = true;

  if (!hasFolderContents) {
    const message = fldIds.length === 0
      ? 'Verranno eliminate definitivamente anche tutte le relative pagine.'
      : (nbIds.length > 0
          ? 'Le raccolte sono vuote; i quaderni selezionati e le loro pagine verranno eliminati definitivamente.'
          : 'Le raccolte selezionate sono vuote.');
    confirmed = await showConfirmDialog({
      title,
      message,
      confirmText: 'Elimina',
      danger: true
    });
  } else {
    const contentLabel = _formatSubtreeContentsLabel(subCount, nestedNbCount);
    const res = await showConfirmDialog({
      title,
      message: `Le raccolte contengono ${contentLabel}. Verranno eliminati definitivamente tutto il contenuto e le relative pagine.`,
      confirmText: 'Elimina tutto',
      danger: true,
      checkbox: {
        label: 'Mantieni i contenuti delle raccolte (sposta quaderni e sottoraccolte nella raccolta superiore)',
        checked: false,
        checkedMessage: 'Verranno eliminate solo le raccolte selezionate (e gli eventuali quaderni selezionati direttamente), spostando gli altri contenuti nella raccolta superiore.',
        checkedConfirmText: 'Elimina raccolte'
      }
    });
    confirmed = !!res?.confirmed;
    deleteContents = !res?.checked;
  }

  if (!confirmed) return;

  try {
    const { deletedFolderIds, deletedNotebookIds } = await deleteLibraryItemsFromDB({
      folderIds: fldIds,
      notebookIds: nbIds,
      deleteFolderContents: deleteContents
    });
    for (const delNbId of deletedNotebookIds) {
      closeNotebookIfOpen(delNbId);
    }
    const deletedCount = deletedFolderIds.length + deletedNotebookIds.length;
    _exitSelectionMode();
    renderLibraryView();
    showToast(
      deletedCount === 1 ? 'Elemento eliminato' : `${deletedCount} elementi eliminati`,
      '🗑️'
    );
  } catch (err) {
    console.error('[delete-selection] failed:', err);
    showToast('Eliminazione fallita', '❌');
  }
}

async function _handleImportFile(file) {
  if (!file) return;

  const progress = showProgressDialog('Importazione in corso...');
  try {
    const result = await importNotebooks(file, ({ done, total, notebookTitle }) => {
      progress.update({ done, total, label: notebookTitle });
    });
    progress.close();
    if (result && (result.notebooks?.length > 0 || result.createdFoldersCount > 0 || result.length > 0)) {
      renderLibraryView();
    }
  } catch (err) {
    console.error('[import] failed:', err);
    progress.close();
    showToast(`Importazione fallita: ${err.message || 'file non valido'}`, '❌');
  }
}

// ============================================================
// MODALE NUOVO QUADERNO
// ============================================================

function _setActiveCoverColorBtn(activeBtn) {
  document.querySelectorAll('#coverColorOptions button').forEach(b => {
    b.classList.remove(...COVER_COLOR_ACTIVE_CLASSES);
  });
  activeBtn?.classList.add(...COVER_COLOR_ACTIVE_CLASSES);
}

function _populateModalFolderSelect(folders, targetFolderId) {
  const sel = document.getElementById('modalNbFolder');
  if (!sel) return;
  const tree = buildFolderTreeList(folders);
  sel.innerHTML = `<option value="">Libreria (principale)</option>`;
  for (const f of tree) {
    const opt = document.createElement('option');
    opt.value = f.id;
    const prefix = f.depth > 0 ? `${'— '.repeat(Math.min(f.depth, 5))}` : '';
    opt.textContent = `${prefix}${f.name}`;
    sel.appendChild(opt);
  }
  sel.value = (targetFolderId && tree.some(f => f.id === targetFolderId)) ? targetFolderId : '';
}

async function _openNewNotebookModal() {
  const modal = document.getElementById('newNotebookModal');
  if (!modal) return;

  selectedCoverColor = '#4f46e5';
  _setActiveCoverColorBtn(document.querySelector('#coverColorOptions button'));
  _populateModalFolderSelect(_cachedFolders, _currentFolderId);

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const body = modal.querySelector('.overflow-y-auto');
  if (body) body.scrollTop = 0;

  try {
    const latestFolders = await loadAllFoldersFromDB();
    _cachedFolders = latestFolders || [];
    _populateModalFolderSelect(_cachedFolders, _currentFolderId);
  } catch {}
}

export function closeNewNotebookModal() {
  const modal = document.getElementById('newNotebookModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function _selectCoverColor(btn) {
  _setActiveCoverColorBtn(btn);
  selectedCoverColor = btn.dataset.color;
}

async function _confirmCreateNotebook() {
  if (_isCreatingNotebook) return;
  _isCreatingNotebook = true;
  const confirmBtn = document.getElementById('confirmCreateNbBtn');
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const title = document.getElementById('modalNbTitle')?.value.trim() || 'Nuovo Quaderno';
    const pattern = document.getElementById('modalNbPattern')?.value || 'ruled';
    const folderId = document.getElementById('modalNbFolder')?.value || null;
    const firstPageId = generatePageId();
    const rand = Math.random().toString(36).slice(2, 7);
    const now = new Date().toISOString();
    const newNb = {
      id: `nb_${Date.now()}_${rand}`,
      title,
      coverColor: selectedCoverColor,
      pattern,
      folderId,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
      lastEditAt: now,
      toolbarSettings: deepClone(DEFAULT_TOOLBAR_SETTINGS),
      pageOrder: [firstPageId],
      pages: [{ pageId: firstPageId, strokes: [], textBoxes: [] }],
      lastPageIndex: 0
    };
    await saveNotebookToDB(newNb, [firstPageId], { saveOrder: true });
    if (folderId !== _currentFolderId) {
      _currentFolderId = folderId;
    }
    closeNewNotebookModal();
    openNotebook(newNb.id);
  } finally {
    _isCreatingNotebook = false;
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

async function _deleteNotebook(_e, id) {
  const confirmed = await showConfirmDialog({
    title: 'Eliminare questo quaderno?',
    message: 'Verranno eliminate definitivamente anche tutte le sue pagine.',
    confirmText: 'Elimina',
    danger: true
  });
  if (!confirmed) return;

  await deleteNotebookFromDB(id);
  closeNotebookIfOpen(id);
  selectedNotebookIds.delete(id);
  renderLibraryView();
  showToast('Quaderno eliminato', '🗑️');
}

// ============================================================
// BINDINGS UI LIBRERIA
// ============================================================

export function bindLibraryUI() {
  bindLibraryAuth();

  document.getElementById('newNotebookBtn')?.addEventListener('click', _openNewNotebookModal);
  document.getElementById('newFolderBtn')?.addEventListener('click', _handleCreateFolder);
  document.getElementById('librarySelectBtn')?.addEventListener('click', () => {
    if (_selectionMode) {
      _exitSelectionMode();
    } else {
      _enterSelectionMode(null);
    }
  });
  document.getElementById('openSettingsBtnLib')?.addEventListener('click', openSettingsModal);
  document.getElementById('confirmCreateNbBtn')?.addEventListener('click', _confirmCreateNotebook);
  document.getElementById('cancelNewNbBtn')?.addEventListener('click', closeNewNotebookModal);

  document.getElementById('libraryLeadingBtn')?.addEventListener('click', () => {
    if (_selectionMode) _exitSelectionMode();
  });
  document.getElementById('selectionSelectAllBtn')?.addEventListener('click', _selectAll);
  document.getElementById('selectionMoveBtn')?.addEventListener('click', _handleMoveSelection);
  document.getElementById('selectionDuplicateBtn')?.addEventListener('click', _handleDuplicateSelection);
  document.getElementById('selectionSendBtn')?.addEventListener('click', _handleSendSelection);
  document.getElementById('selectionExportBtn')?.addEventListener('click', _handleExportSelection);
  document.getElementById('selectionDeleteBtn')?.addEventListener('click', _handleDeleteSelection);

  const searchInput = document.getElementById('librarySearchInput');
  const searchClearBtn = document.getElementById('librarySearchClearBtn');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _searchQuery = searchInput.value;
      _syncLibraryControlsToUI();
      renderLibraryView();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _searchQuery) {
        e.preventDefault();
        e.stopPropagation();
        _searchQuery = '';
        searchInput.value = '';
        _syncLibraryControlsToUI();
        renderLibraryView();
      }
    });
  }
  searchClearBtn?.addEventListener('click', () => {
    _searchQuery = '';
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    _syncLibraryControlsToUI();
    renderLibraryView();
  });

  document.getElementById('libraryFavFilterBtn')?.addEventListener('click', () => {
    updateSettings({ libraryOnlyFavorites: !getSettings().libraryOnlyFavorites });
    renderLibraryView();
  });

  document.getElementById('librarySortSelect')?.addEventListener('change', (e) => {
    const nextSort = e.target.value;
    const prevSort = getSettings().librarySortBy;
    let nextDir = getSettings().librarySortDir;
    if (nextSort === 'title' && prevSort !== 'title') nextDir = 'asc';
    else if (nextSort !== 'title' && prevSort === 'title') nextDir = 'desc';
    updateSettings({ librarySortBy: nextSort, librarySortDir: nextDir });
    renderLibraryView();
  });

  document.getElementById('librarySortDirBtn')?.addEventListener('click', () => {
    const nextDir = getSettings().librarySortDir === 'asc' ? 'desc' : 'asc';
    updateSettings({ librarySortDir: nextDir });
    renderLibraryView();
  });

  document.getElementById('libraryViewGridBtn')?.addEventListener('click', () => {
    if (getSettings().libraryViewMode === 'grid') return;
    updateSettings({ libraryViewMode: 'grid' });
    renderLibraryView();
  });

  document.getElementById('libraryViewListBtn')?.addEventListener('click', () => {
    if (getSettings().libraryViewMode === 'list') return;
    updateSettings({ libraryViewMode: 'list' });
    renderLibraryView();
  });

  onSettingsChanged(({ changed }) => {
    if (
      changed.includes('librarySortBy') ||
      changed.includes('librarySortDir') ||
      changed.includes('libraryOnlyFavorites') ||
      changed.includes('libraryViewMode')
    ) {
      _syncLibraryControlsToUI();
    }
    if (changed.includes('libraryShowTextBelow')) {
      const libView = document.getElementById('libraryView');
      if (libView && !libView.classList.contains('hidden')) {
        renderLibraryView();
      }
    }
  });

  const grid = document.getElementById('notebooksGrid');
  if (grid && !_dndController) {
    _dndController = createLibraryDndController(grid, {
      isEnabled: () => !document.getElementById('libraryView')?.classList.contains('hidden'),
      isSelectionMode: () => _selectionMode,
      getItemInfo: (card) => {
        if (card.dataset.nbId) {
          return {
            type: 'notebook',
            id: card.dataset.nbId,
            title: card.dataset.nbTitle || 'Quaderno',
            color: card.dataset.nbColor || '#4f46e5'
          };
        }
        if (card.dataset.folderId) {
          return {
            type: 'folder',
            id: card.dataset.folderId,
            title: card.dataset.folderName || 'Raccolta',
            color: card.dataset.folderColor || '#6366f1'
          };
        }
        return null;
      },
      canDropOnCollection: (dragged, targetFolderId) => _canMoveDraggedToFolder(dragged, targetFolderId, false),
      canDropOnBreadcrumb: (dragged, targetFolderId) => _canMoveDraggedToFolder(dragged, targetFolderId || null, true),
      canMergeNotebooks: (sourceNbId, targetNbId) => {
        if (!sourceNbId || !targetNbId || sourceNbId === targetNbId) return false;
        if (_searchQuery.trim().length > 0) return false;
        return !getSettings().libraryOnlyFavorites;
      },
      onDropOnCollection: _handleDndDropOnCollection,
      onDropOnBreadcrumb: _handleDndDropOnBreadcrumb,
      onMergeNotebooks: _handleDndMergeNotebooks
    });
  }

  const libViewEl = document.getElementById('libraryView');
  const topBarWrap = document.getElementById('libraryTopBarWrap');
  if (libViewEl && topBarWrap) {
    const syncScrollShadow = () => {
      topBarWrap.classList.toggle('is-scrolled', libViewEl.scrollTop > 4);
    };
    libViewEl.addEventListener('scroll', syncScrollShadow, { passive: true });
    syncScrollShadow();
  }

  document.addEventListener('click', (e) => {
    if (!_selectionMode) return;
    if (document.querySelector('.library-modal')) return;
    if (e.target.closest('.notebook-card, .folder-card, #libraryHeader')) return;
    _exitSelectionMode();
  });

  const importBtn = document.getElementById('importBackupBtn');
  const fileInput = document.getElementById('importFileInput');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) _handleImportFile(file);
      fileInput.value = '';
    });
  }

  document.querySelectorAll('#coverColorOptions button').forEach(btn => {
    btn.addEventListener('click', () => _selectCoverColor(btn));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _selectionMode && !document.querySelector('.library-modal')) {
      _exitSelectionMode();
    }
  });

  _syncLibraryControlsToUI();
}

on('library:refresh', renderLibraryView);
on('library:open-notebook', (nbId) => {
  if (nbId) openNotebook(nbId);
});