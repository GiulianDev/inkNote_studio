// ============================================================
// LIBRERIA QUADERNI + CARTELLE + RICERCA + ORDINAMENTO + PREFERITI
// ============================================================

import { escapeHtml, showToast, showConfirmDialog, on, generatePageId } from '../../core/utils.js';
import { getSettings, updateSettings, onSettingsChanged } from '../../core/app-settings.js';
import {
  loadAllNotebooksFromDB, saveNotebookToDB, deleteNotebookFromDB, loadNotebookWithPages,
  updateNotebookMetadataInDB, loadAllFoldersFromDB, saveFolderToDB, deleteFolderFromDB
} from '../../services/db.js';
import {
  signInWithGoogle, signOutGoogle, onAuthChange
} from '../../services/firebase.js';
import { authState } from '../../core/state.js';
import { openNotebook, closeNotebookIfOpen } from '../editor/editor.js';
import { openSettingsModal } from '../settings/settings-modal.js';
import { exportNotebooks } from '../backup/backup-export.js';
import { importNotebooks } from '../backup/backup-import.js';
import { showProgressDialog } from '../backup/backup-progress.js';
import {
  buildFolderTreeList, openFolderEditorModal, openMoveItemsModal
} from './library-modals.js';
import { createLibraryDndController } from './library-dnd.js';

let selectedCoverColor = '#4f46e5';

let _selectionMode = false;
let _isDuplicating = false;
let _isCreatingNotebook = false;
let _renderRequestToken = 0;
const selectedNotebookIds = new Set();

let _currentFolderId = null;
let _searchQuery = '';
let _cachedFolders = [];
let _cachedNotebooks = [];
let _dndController = null;

const LP_PRESS_MS = 680;
const LP_MOVE_CANCEL_PX = 8;

// ============================================================
// AUTH
// ============================================================

export function initAuth() {
  onAuthChange((user) => {
    authState.user = user;
    authState.loading = false;
    updateAuthUI();
  });

  document.addEventListener('click', (e) => {
    const authContainer = document.getElementById('authContainer');
    const authDropdown = document.getElementById('authDropdown');
    if (authContainer && authDropdown && !authDropdown.classList.contains('hidden')) {
      if (!authContainer.contains(e.target)) authDropdown.classList.add('hidden');
    }
  });
}

function _colorFromString(str) {
  const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
                   '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#a855f7'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 31) + str.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

function _getInitials(user) {
  const name = user.displayName || user.email || '';
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function _renderAvatar(user, size) {
  if (user.photoURL) {
    return `<img src="${user.photoURL}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`;
  }
  const initials = _getInitials(user);
  const bg = _colorFromString(user.email || user.displayName || user.uid);
  return `<span class="flex items-center justify-center w-full h-full text-white font-bold" style="background-color: ${bg}; font-size: ${Math.round(size * 0.4)}px;">${initials}</span>`;
}

function updateAuthUI() {
  const btn = document.getElementById('authBtn');
  const content = document.getElementById('authBtnContent');
  const dropdown = document.getElementById('authDropdown');
  if (!btn || !content) return;

  if (authState.user) {
    btn.title = 'Profilo';
    content.outerHTML = `<span id="authBtnContent" class="w-full h-full">${_renderAvatar(authState.user, 40)}</span>`;

    const dAvatar = document.getElementById('authDropdownAvatar');
    const dName = document.getElementById('authDropdownName');
    const dEmail = document.getElementById('authDropdownEmail');
    if (dAvatar) dAvatar.outerHTML = `<div id="authDropdownAvatar" class="w-10 h-10 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0">${_renderAvatar(authState.user, 40)}</div>`;
    if (dName) dName.textContent = authState.user.displayName || 'Utente';
    if (dEmail) dEmail.textContent = authState.user.email || '';
  } else {
    btn.title = 'Accedi con Google';
    content.outerHTML = `<span id="authBtnContent" class="text-base">
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>
      </svg>
    </span>`;
    if (dropdown) dropdown.classList.add('hidden');
  }
}

export async function handleAuthClick() {
  if (authState.loading) return;

  if (authState.user) {
    const dropdown = document.getElementById('authDropdown');
    if (dropdown) dropdown.classList.toggle('hidden');
    return;
  }

  try {
    const user = await signInWithGoogle();
    if (user) {
      showToast(`Benvenuto, ${user.displayName || user.email}!`, '👋');
    }
  } catch (err) {
    console.error('[auth] login failed:', err);
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      showToast('Login fallito', '❌');
    }
  }
}

async function handleLogout() {
  try {
    await signOutGoogle();
    const dropdown = document.getElementById('authDropdown');
    if (dropdown) dropdown.classList.add('hidden');
    showToast('Disconnesso', '👋');
  } catch (err) {
    console.error('[auth] signOut failed:', err);
    showToast('Logout fallito', '❌');
  }
}

// ============================================================
// HELPER GERARCHIA CARTELLE, ORDINAMENTO & CONTROLLI
// ============================================================

function _getFolderPath(folderId, folderMap) {
  const path = [];
  const visited = new Set();
  let curId = folderId;
  while (curId && !visited.has(curId)) {
    const f = folderMap.get(curId);
    if (!f) break;
    visited.add(curId);
    path.unshift(f);
    curId = f.parentId || null;
  }
  return path;
}

function _formatFolderPathLabel(folderId, folderMap) {
  if (!folderId || !folderMap.has(folderId)) return 'Libreria';
  const path = _getFolderPath(folderId, folderMap);
  return path.map(f => f.name).join(' / ') || 'Libreria';
}

function _getDescendantFolderIds(rootFolderId, folders) {
  const excluded = new Set([rootFolderId]);
  const queue = [rootFolderId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const f of folders) {
      if (f && (f.parentId || null) === cur && !excluded.has(f.id)) {
        excluded.add(f.id);
        queue.push(f.id);
      }
    }
  }
  return excluded;
}

function _computeFolderCounts(folders, notebooks, folderMap) {
  const counts = new Map();
  for (const f of folders) {
    counts.set(f.id, { subfolders: 0, notebooks: 0 });
  }
  for (const f of folders) {
    if (f.parentId && folderMap.has(f.parentId)) {
      counts.get(f.parentId).subfolders++;
    }
  }
  for (const nb of notebooks) {
    if (nb.folderId && folderMap.has(nb.folderId)) {
      counts.get(nb.folderId).notebooks++;
    }
  }
  return counts;
}

function _compareNotebooks(a, b, sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  let cmp = 0;

  if (sortBy === 'title') {
    cmp = (a.title || '').localeCompare(b.title || '', 'it', { sensitivity: 'base' });
  } else if (sortBy === 'createdAt') {
    cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  } else if (sortBy === 'pageCount') {
    cmp = (a.pageCount || 1) - (b.pageCount || 1);
  } else {
    cmp = new Date(a.lastEditAt || a.updatedAt || 0).getTime() -
          new Date(b.lastEditAt || b.updatedAt || 0).getTime();
  }

  if (cmp !== 0) return cmp * dir;
  return (a.title || '').localeCompare(b.title || '', 'it', { sensitivity: 'base' });
}

function _compareFolders(a, b, sortBy, sortDir, folderCounts) {
  const dir = sortDir === 'asc' ? 1 : -1;
  let cmp = 0;

  if (sortBy === 'createdAt') {
    cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  } else if (sortBy === 'updatedAt') {
    cmp = new Date(a.updatedAt || a.createdAt || 0).getTime() -
          new Date(b.updatedAt || b.createdAt || 0).getTime();
  } else if (sortBy === 'pageCount') {
    const ca = folderCounts.get(a.id) || { subfolders: 0, notebooks: 0 };
    const cb = folderCounts.get(b.id) || { subfolders: 0, notebooks: 0 };
    cmp = (ca.notebooks + ca.subfolders) - (cb.notebooks + cb.subfolders);
  } else {
    cmp = (a.name || '').localeCompare(b.name || '', 'it', { sensitivity: 'base' });
  }

  if (cmp !== 0) return cmp * dir;
  return (a.name || '').localeCompare(b.name || '', 'it', { sensitivity: 'base' });
}

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

  const favBtn = document.getElementById('libraryFavFilterBtn');
  if (favBtn) favBtn.classList.toggle('active', !!s.libraryOnlyFavorites);

  const viewMode = s.libraryViewMode === 'list' ? 'list' : 'grid';
  document.getElementById('libraryViewGridBtn')?.classList.toggle('active', viewMode === 'grid');
  document.getElementById('libraryViewListBtn')?.classList.toggle('active', viewMode === 'list');

  const grid = document.getElementById('notebooksGrid');
  if (grid) {
    if (viewMode === 'list') {
      grid.className = 'flex flex-col gap-1.5';
    } else {
      grid.className = 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-4';
    }
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
  const path = _getFolderPath(_currentFolderId, folderMap);

  const parts = [];
  const rootActive = !isSearching && _currentFolderId === null && !onlyFavorites;

  parts.push(`
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
  `);

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
      if (_selectionMode) _exitSelectionMode();
      if (_searchQuery) {
        _searchQuery = '';
        _syncLibraryControlsToUI();
      }
      if (targetId === null && getSettings().libraryOnlyFavorites) {
        updateSettings({ libraryOnlyFavorites: false });
      }
      _currentFolderId = targetId;
      renderLibraryView();
    });
  });
}

// ============================================================
// SELEZIONE
// ============================================================

function _enterSelectionMode(initialId = null) {
  if (_selectionMode) return;
  _selectionMode = true;
  _dndController?.cancel();

  if (initialId) selectedNotebookIds.add(initialId);

  document.getElementById('libraryHeader')?.classList.add('hidden');
  const bar = document.getElementById('librarySelectionBar');
  if (bar) {
    bar.classList.remove('hidden');
    bar.classList.add('flex');
  }

  _applySelectionStateToCards();
  _updateSelectionBar();
}

function _exitSelectionMode() {
  _selectionMode = false;
  selectedNotebookIds.clear();

  document.getElementById('libraryHeader')?.classList.remove('hidden');
  const bar = document.getElementById('librarySelectionBar');
  if (bar) {
    bar.classList.add('hidden');
    bar.classList.remove('flex');
  }

  _applySelectionStateToCards();
}

function _toggleSelection(id) {
  if (!_selectionMode) return;

  if (selectedNotebookIds.has(id)) {
    selectedNotebookIds.delete(id);
  } else {
    selectedNotebookIds.add(id);
  }

  _applySelectionStateToCards();
  _updateSelectionBar();

  if (selectedNotebookIds.size === 0) {
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

    const dot = card.querySelector('.selection-dot');
    if (dot) {
      dot.classList.toggle('active', isSelected);
    }
  });
}

function _updateSelectionBar() {
  const count = selectedNotebookIds.size;
  const countEl = document.getElementById('selectionCount');
  if (countEl) countEl.textContent = `${count} selezionat${count === 1 ? 'o' : 'i'}`;

  const moveBtn = document.getElementById('selectionMoveBtn');
  const duplicateBtn = document.getElementById('selectionDuplicateBtn');
  const exportBtn = document.getElementById('selectionExportBtn');
  const deleteBtn = document.getElementById('selectionDeleteBtn');
  if (moveBtn) moveBtn.disabled = count === 0;
  if (duplicateBtn) duplicateBtn.disabled = count === 0 || _isDuplicating;
  if (exportBtn) exportBtn.disabled = count === 0;
  if (deleteBtn) deleteBtn.disabled = count === 0;
}

function _selectAll() {
  document.querySelectorAll('.notebook-card').forEach(card => {
    if (card.dataset.nbId) selectedNotebookIds.add(card.dataset.nbId);
  });
  _applySelectionStateToCards();
  _updateSelectionBar();
}

// ============================================================
// LONG-PRESS SULLE CARD
// ============================================================

function _bindCardInteractions(card, nb) {
  let pressTimer = null;
  let pressStart = null;
  let pressPointerId = null;
  let skipClickAfterLongPress = false;

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressStart = null;
    pressPointerId = null;
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.delete-nb-btn, .favorite-nb-btn, .dnd-drag-handle')) return;

    cancelPress();
    pressPointerId = e.pointerId;
    pressStart = { x: e.clientX, y: e.clientY };
    skipClickAfterLongPress = false;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (!card.isConnected) return;
      if (pressPointerId !== e.pointerId) return;
      if (_dndController?.isDragging() || _dndController?.wasRecentDrag()) return;
      _dndController?.cancel();
      skipClickAfterLongPress = true;
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }

      if (!_selectionMode) {
        _enterSelectionMode(nb.id);
      } else {
        _toggleSelection(nb.id);
      }
    }, LP_PRESS_MS);
  });

  card.addEventListener('pointermove', (e) => {
    if (_dndController?.isDragging()) {
      cancelPress();
      return;
    }
    if (!pressStart || e.pointerId !== pressPointerId) return;
    const dx = e.clientX - pressStart.x;
    const dy = e.clientY - pressStart.y;
    if (Math.hypot(dx, dy) > LP_MOVE_CANCEL_PX) cancelPress();
  });

  card.addEventListener('pointerup', cancelPress);
  card.addEventListener('pointercancel', cancelPress);
  card.addEventListener('pointerleave', cancelPress);

  card.addEventListener('click', (e) => {
    if (e.target.closest('.delete-nb-btn, .favorite-nb-btn, .dnd-drag-handle')) return;

    if (_dndController?.isDragging() || _dndController?.wasRecentDrag()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (skipClickAfterLongPress) {
      skipClickAfterLongPress = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (_selectionMode) {
      e.preventDefault();
      e.stopPropagation();
      _toggleSelection(nb.id);
      return;
    }

    openNotebook(nb.id);
  });
}

// ============================================================
// LIBRERIA — rendering (Griglia compatta + Lista)
// ============================================================

function _buildFolderPreviewMap(folders, notebooks, folderMap) {
  const map = new Map();
  for (const f of folders) {
    map.set(f.id, { notebooks: [], subfolders: [] });
  }
  for (const nb of notebooks) {
    if (nb.folderId && folderMap.has(nb.folderId)) {
      map.get(nb.folderId).notebooks.push(nb);
    }
  }
  for (const f of folders) {
    if (f.parentId && folderMap.has(f.parentId)) {
      map.get(f.parentId).subfolders.push(f);
    }
  }
  return map;
}

const DRAG_HANDLE_SVG = `
  <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>
    <circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/>
    <circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/>
  </svg>
`;

function _collectionGlyphSvg(className = 'w-6 h-6') {
  return `
    <svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 7V5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/>
      <rect width="18" height="13" x="3" y="8" rx="2.5" fill="currentColor" fill-opacity="0.14"/>
      <rect width="4" height="7" x="6.5" y="11" rx="1" fill="currentColor" fill-opacity="0.35" stroke="none"/>
      <rect width="4" height="7" x="12" y="11" rx="1" fill="currentColor" fill-opacity="0.22" stroke="none"/>
    </svg>
  `;
}

function _renderFolderMiniGrid(preview, color) {
  const nbs = (preview?.notebooks || []).slice(0, 4);
  const subs = (preview?.subfolders || []).slice(0, Math.max(0, 4 - nbs.length));
  const totalSlots = nbs.length + subs.length;

  if (totalSlots === 0) {
    return `
      <div class="folder-empty-glyph" style="color: ${escapeHtml(color)}; background-color: ${escapeHtml(color)}18; border-color: ${escapeHtml(color)}30;">
        ${_collectionGlyphSvg('w-7 h-7')}
      </div>
    `;
  }

  const slots = [];
  for (const nb of nbs) {
    slots.push(`
      <div class="folder-mini-nb" style="background-color: ${escapeHtml(nb.coverColor || '#4f46e5')};">
        <span class="folder-mini-nb-spine"></span>
      </div>
    `);
  }
  for (const sf of subs) {
    const sfColor = sf.color || '#6366f1';
    slots.push(`
      <div class="folder-mini-sub" style="background-color: ${escapeHtml(sfColor)}22; color: ${escapeHtml(sfColor)}; border-color: ${escapeHtml(sfColor)}44;">
        ${_collectionGlyphSvg('w-4 h-4')}
      </div>
    `);
  }
  while (slots.length < 4) {
    slots.push(`<div class="folder-mini-placeholder"></div>`);
  }

  return `<div class="folder-mini-grid">${slots.join('')}</div>`;
}

function _createFolderCardElement(folder, counts, folderMap, previewMap, showParentBadge, viewMode, showTextBelow) {
  const card = document.createElement('div');
  card.className = viewMode === 'list' ? 'folder-card is-list-item group' : 'folder-card group';
  card.dataset.folderId = folder.id;
  card.dataset.folderName = folder.name || 'Raccolta';
  card.dataset.folderColor = folder.color || '#6366f1';

  const color = folder.color || '#6366f1';
  const stat = counts.get(folder.id) || { subfolders: 0, notebooks: 0 };
  const parts = [];
  if (stat.subfolders > 0) parts.push(`${stat.subfolders} raccolt${stat.subfolders === 1 ? 'a' : 'e'}`);
  if (stat.notebooks > 0) parts.push(`${stat.notebooks} quadern${stat.notebooks === 1 ? 'o' : 'i'}`);
  const metaText = parts.length > 0 ? parts.join(' · ') : 'Vuota';

  const parentLabel = showParentBadge && folder.parentId && folderMap.has(folder.parentId)
    ? _formatFolderPathLabel(folder.parentId, folderMap)
    : '';

  const preview = previewMap.get(folder.id);

  if (viewMode === 'list') {
    card.innerHTML = `
      <button type="button" class="dnd-drag-handle is-list" title="Trascina raccolta" aria-label="Trascina raccolta">
        ${DRAG_HANDLE_SVG}
      </button>
      <div class="list-row-thumb is-folder" style="background-color: ${escapeHtml(color)}18; border-color: ${escapeHtml(color)}40; color: ${escapeHtml(color)};">
        ${_collectionGlyphSvg('w-4 h-4')}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <h4 class="folder-name truncate">${escapeHtml(folder.name)}</h4>
          ${parentLabel ? `<span class="list-path-pill truncate">${escapeHtml(parentLabel)}</span>` : ''}
        </div>
        <span class="folder-meta">${escapeHtml(metaText)}</span>
      </div>
      <div class="folder-actions is-list">
        <button type="button" class="folder-action-btn" data-folder-action="edit" title="Modifica raccolta" aria-label="Modifica raccolta">
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
        <button type="button" class="folder-action-btn" data-folder-action="move" title="Sposta raccolta" aria-label="Sposta raccolta">
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7V5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/><rect width="18" height="13" x="3" y="8" rx="2.5"/><path d="M8 14h8"/><path d="m13 11 3 3-3 3"/></svg>
        </button>
        <button type="button" class="folder-action-btn danger" data-folder-action="delete" title="Elimina raccolta" aria-label="Elimina raccolta">
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="folder-shell">
        <div class="folder-tab-ear" style="background-color: ${escapeHtml(color)}26; border-color: ${escapeHtml(color)}48;">
          <span class="folder-tab-dot" style="background-color: ${escapeHtml(color)};"></span>
        </div>
        <div class="folder-cover" style="--folder-color: ${escapeHtml(color)}; border-color: ${escapeHtml(color)}42; background: linear-gradient(155deg, ${escapeHtml(color)}18 0%, ${escapeHtml(color)}08 100%);">
          <div class="folder-preview-area">
            ${_renderFolderMiniGrid(preview, color)}
          </div>

          <div class="folder-cover-footer">
            ${parentLabel && !showTextBelow ? `<span class="folder-cover-path">${escapeHtml(parentLabel)}</span>` : ''}
            <span class="folder-cover-name">${escapeHtml(folder.name || 'Raccolta')}</span>
            <span class="folder-cover-meta">${escapeHtml(metaText)}</span>
          </div>

          <div class="folder-actions">
            <button type="button" class="folder-action-btn" data-folder-action="edit" title="Modifica raccolta" aria-label="Modifica raccolta">
              <svg class="w-3 h-3 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
            <button type="button" class="folder-action-btn" data-folder-action="move" title="Sposta raccolta" aria-label="Sposta raccolta">
              <svg class="w-3 h-3 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7V5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/><rect width="18" height="13" x="3" y="8" rx="2.5"/><path d="M8 14h8"/><path d="m13 11 3 3-3 3"/></svg>
            </button>
            <button type="button" class="folder-action-btn danger" data-folder-action="delete" title="Elimina raccolta" aria-label="Elimina raccolta">
              <svg class="w-3 h-3 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>

          <button type="button" class="dnd-drag-handle is-folder" title="Trascina raccolta" aria-label="Trascina raccolta">
            ${DRAG_HANDLE_SVG}
          </button>
        </div>
      </div>

      ${showTextBelow ? `
      <div class="card-meta-below">
        ${parentLabel ? `<span class="card-path-tag truncate">${escapeHtml(parentLabel)}</span>` : ''}
        <h4 class="folder-name">${escapeHtml(folder.name)}</h4>
        <span class="folder-meta">${escapeHtml(metaText)}</span>
      </div>` : ''}
    `;
  }

  card.addEventListener('click', (e) => {
    if (_dndController?.isDragging() || _dndController?.wasRecentDrag()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.target.closest('.dnd-drag-handle')) {
      e.stopPropagation();
      return;
    }

    const actionBtn = e.target.closest('[data-folder-action]');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.folderAction;
      if (action === 'edit') handleEditFolder(folder);
      else if (action === 'move') handleMoveFolder(folder);
      else if (action === 'delete') handleDeleteFolder(folder);
      return;
    }

    if (_selectionMode) _exitSelectionMode();
    if (_searchQuery) {
      _searchQuery = '';
      _syncLibraryControlsToUI();
    }
    _currentFolderId = folder.id;
    renderLibraryView();
  });

  return card;
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
    const queryLower = rawQuery.toLowerCase();
    const isSearching = queryLower.length > 0;

    _syncLibraryControlsToUI();
    _renderBreadcrumbs(folderMap, rawQuery, onlyFavorites);

    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    if (!grid || !emptyMsg) return;
    grid.innerHTML = '';

    const folderCounts = _computeFolderCounts(_cachedFolders, _cachedNotebooks, folderMap);
    const previewMap = _buildFolderPreviewMap(_cachedFolders, _cachedNotebooks, folderMap);

    let visibleFolders = [];
    let visibleNotebooks = [];

    if (isSearching) {
      visibleFolders = _cachedFolders.filter(f =>
        !onlyFavorites && (f.name || '').toLowerCase().includes(queryLower)
      );
      visibleNotebooks = _cachedNotebooks.filter(nb => {
        if (onlyFavorites && !nb.isFavorite) return false;
        return (nb.title || '').toLowerCase().includes(queryLower);
      });
    } else if (onlyFavorites && _currentFolderId === null) {
      visibleFolders = [];
      visibleNotebooks = _cachedNotebooks.filter(nb => !!nb.isFavorite);
    } else {
      visibleFolders = _cachedFolders.filter(f => {
        const pid = (f.parentId && folderMap.has(f.parentId)) ? f.parentId : null;
        return pid === _currentFolderId;
      });
      visibleNotebooks = _cachedNotebooks.filter(nb => {
        if (onlyFavorites && !nb.isFavorite) return false;
        const fid = (nb.folderId && folderMap.has(nb.folderId)) ? nb.folderId : null;
        return fid === _currentFolderId;
      });
    }

    visibleFolders.sort((a, b) => _compareFolders(a, b, sortBy, sortDir, folderCounts));
    visibleNotebooks.sort((a, b) => _compareNotebooks(a, b, sortBy, sortDir));

    const visibleNbIds = new Set(visibleNotebooks.map(n => n.id));
    for (const id of Array.from(selectedNotebookIds)) {
      if (!visibleNbIds.has(id)) selectedNotebookIds.delete(id);
    }
    if (_selectionMode && selectedNotebookIds.size === 0) {
      _exitSelectionMode();
    }

    const selectBtn = document.getElementById('librarySelectBtn');
    if (selectBtn) {
      const noNotebooks = visibleNotebooks.length === 0;
      selectBtn.disabled = noNotebooks;
      selectBtn.classList.toggle('opacity-40', noNotebooks);
      selectBtn.classList.toggle('cursor-not-allowed', noNotebooks);
      selectBtn.title = noNotebooks ? 'Nessun quaderno da selezionare in questa vista' : 'Seleziona quaderni';
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

    if (visibleFolders.length === 0 && visibleNotebooks.length === 0) {
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
    } else {
      emptyMsg.classList.add('hidden');
      emptyMsg.classList.remove('flex');

      visibleFolders.forEach(folder => {
        grid.appendChild(_createFolderCardElement(folder, folderCounts, folderMap, previewMap, isSearching, viewMode, showTextBelow));
      });

      visibleNotebooks.forEach(nb => {
        const editIso = nb.lastEditAt || nb.updatedAt;
        const dateStr = new Date(editIso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
        const coverDateStr = new Date(editIso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
        const pageCount = nb.pageCount || 1;
        const isFav = !!nb.isFavorite;
        const folderLabel = (showPathTags && nb.folderId && folderMap.has(nb.folderId))
          ? _formatFolderPathLabel(nb.folderId, folderMap)
          : '';
        const coverColor = nb.coverColor || '#4f46e5';

        const card = document.createElement('div');
        card.className = viewMode === 'list' ? 'notebook-card is-list-item group relative' : 'notebook-card group relative';
        card.dataset.nbId = nb.id;
        card.dataset.nbTitle = nb.title || 'Quaderno';
        card.dataset.nbColor = coverColor;

        if (viewMode === 'list') {
          card.innerHTML = `
            <button type="button" class="dnd-drag-handle is-list" title="Trascina quaderno" aria-label="Trascina quaderno">
              ${DRAG_HANDLE_SVG}
            </button>
            <div class="selection-dot is-list" aria-hidden="true">
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6 9 17l-5-5"/>
              </svg>
            </div>
            <div class="list-row-thumb" style="background-color: ${escapeHtml(coverColor)};">
              <span class="list-row-spine"></span>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 min-w-0">
                <h4 class="notebook-title truncate">${escapeHtml(nb.title)}</h4>
                ${folderLabel ? `<span class="list-path-pill truncate">${escapeHtml(folderLabel)}</span>` : ''}
              </div>
              <span class="notebook-date">${pageCount} pag. · ${dateStr}</span>
            </div>
            <div class="list-row-actions">
              <button type="button" class="favorite-nb-btn is-list ${isFav ? 'is-favorite' : ''}" data-fav-id="${nb.id}"
                title="${isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}"
                aria-label="${isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">
                <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
              <button type="button" class="delete-nb-btn is-list" data-delete-id="${nb.id}" title="Elimina Quaderno" aria-label="Elimina Quaderno">
                <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          `;
        } else {
          card.innerHTML = `
            <div class="notebook-cover" style="background-color: ${escapeHtml(coverColor)};">
              <div class="notebook-spine"></div>
              <div class="notebook-paper-edge"></div>

              <div class="selection-dot" aria-hidden="true">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 6 9 17l-5-5"/>
                </svg>
              </div>

              <button type="button" class="dnd-drag-handle is-notebook" title="Trascina quaderno" aria-label="Trascina quaderno">
                ${DRAG_HANDLE_SVG}
              </button>

              <button type="button" class="favorite-nb-btn ${isFav ? 'is-favorite' : ''}" data-fav-id="${nb.id}"
                title="${isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}"
                aria-label="${isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">
                <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>

              <button type="button" class="delete-nb-btn" data-delete-id="${nb.id}" title="Elimina Quaderno" aria-label="Elimina Quaderno">
                <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>

              <div class="notebook-cover-label">
                <span class="notebook-cover-title">${escapeHtml(nb.title || 'Quaderno')}</span>
              </div>

              ${folderLabel && !showTextBelow ? `<div class="notebook-cover-path-pill">${escapeHtml(folderLabel)}</div>` : ''}

              <div class="notebook-cover-date">
                <span>${coverDateStr}</span>
              </div>

              <div class="notebook-badge">
                <span>${pageCount} pag.</span>
              </div>
            </div>

            ${showTextBelow ? `
            <div class="card-meta-below">
              ${folderLabel ? `<span class="card-path-tag truncate">${escapeHtml(folderLabel)}</span>` : ''}
              <h4 class="notebook-title">${escapeHtml(nb.title)}</h4>
              <span class="notebook-date">${dateStr}</span>
            </div>` : ''}
          `;
        }

        _bindCardInteractions(card, nb);

        card.querySelector('.favorite-nb-btn')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleNotebookFavorite(nb);
        });

        card.querySelector('.delete-nb-btn')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          deleteNotebook(ev, nb.id);
        });

        grid.appendChild(card);
      });

      if (_selectionMode) {
        _applySelectionStateToCards();
        _updateSelectionBar();
      }
    }

    document.getElementById('libraryView').classList.remove('hidden');
  });
}

// ============================================================
// AZIONI RACCOLTE, DRAG & DROP & PREFERITI
// ============================================================

async function toggleNotebookFavorite(nb) {
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

async function handleCreateFolder() {
  const folderMap = new Map(_cachedFolders.map(f => [f.id, f]));
  const parentName = _currentFolderId
    ? _formatFolderPathLabel(_currentFolderId, folderMap)
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

async function handleEditFolder(folder) {
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

async function handleMoveFolder(folder) {
  const excluded = _getDescendantFolderIds(folder.id, _cachedFolders);
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

async function handleDeleteFolder(folder) {
  const confirmed = await showConfirmDialog({
    title: `Eliminare la raccolta "${folder.name}"?`,
    message: 'Gli eventuali quaderni e sottoraccolte al suo interno non verranno persi: saranno spostati nella raccolta superiore.',
    confirmText: 'Elimina raccolta',
    danger: true
  });
  if (!confirmed) return;

  try {
    await deleteFolderFromDB(folder.id);
    if (_currentFolderId === folder.id) {
      _currentFolderId = folder.parentId || null;
    }
    renderLibraryView();
    showToast('Raccolta eliminata', '🗑️');
  } catch (err) {
    console.error('[library] delete collection failed:', err);
    showToast('Eliminazione raccolta fallita', '❌');
  }
}

async function handleMoveSelection() {
  const ids = Array.from(selectedNotebookIds);
  if (ids.length === 0) return;
  const count = ids.length;
  const destId = await openMoveItemsModal({
    folders: _cachedFolders,
    initialTargetId: _currentFolderId,
    title: `Sposta ${count} quadern${count === 1 ? 'o' : 'i'}`,
    subtitle: 'Scegli la raccolta di destinazione'
  });
  if (destId === undefined) return;

  try {
    for (const id of ids) {
      await updateNotebookMetadataInDB(id, { folderId: destId });
    }
    const destName = destId
      ? (_cachedFolders.find(f => f.id === destId)?.name || 'Raccolta')
      : 'Libreria';
    _exitSelectionMode();
    renderLibraryView();
    showToast(
      count === 1 ? `Quaderno spostato in "${destName}"` : `${count} quaderni spostati in "${destName}"`,
      '🗂️'
    );
  } catch (err) {
    console.error('[library] move selection failed:', err);
    showToast('Spostamento fallito', '❌');
  }
}

async function _handleDndDropOnCollection(dragged, targetFolderId) {
  const targetFolder = _cachedFolders.find(f => f.id === targetFolderId);
  if (!targetFolder) return;

  try {
    if (dragged.type === 'notebook') {
      const nb = _cachedNotebooks.find(n => n.id === dragged.id);
      if (!nb || (nb.folderId || null) === targetFolderId) return;
      await updateNotebookMetadataInDB(dragged.id, { folderId: targetFolderId });
      renderLibraryView();
      showToast(`"${nb.title}" spostato in "${targetFolder.name}"`, '🗂️');
    } else if (dragged.type === 'folder') {
      const folder = _cachedFolders.find(f => f.id === dragged.id);
      if (!folder || (folder.parentId || null) === targetFolderId) return;
      const excluded = _getDescendantFolderIds(folder.id, _cachedFolders);
      if (excluded.has(targetFolderId)) return;
      await saveFolderToDB({ ...folder, parentId: targetFolderId });
      renderLibraryView();
      showToast(`"${folder.name}" spostata in "${targetFolder.name}"`, '🗂️');
    }
  } catch (err) {
    console.error('[library-dnd] drop on collection failed:', err);
    showToast('Spostamento fallito', '❌');
  }
}

async function _handleDndDropOnBreadcrumb(dragged, targetFolderId) {
  const destId = targetFolderId || null;
  const targetName = destId
    ? (_cachedFolders.find(f => f.id === destId)?.name || 'Raccolta')
    : 'Libreria';

  try {
    if (dragged.type === 'notebook') {
      const nb = _cachedNotebooks.find(n => n.id === dragged.id);
      if (!nb || (nb.folderId || null) === destId) return;
      await updateNotebookMetadataInDB(dragged.id, { folderId: destId });
      renderLibraryView();
      showToast(`"${nb.title}" spostato in "${targetName}"`, '🗂️');
    } else if (dragged.type === 'folder') {
      const folder = _cachedFolders.find(f => f.id === dragged.id);
      if (!folder || (folder.parentId || null) === destId) return;
      const excluded = _getDescendantFolderIds(folder.id, _cachedFolders);
      if (destId && excluded.has(destId)) return;
      await saveFolderToDB({ ...folder, parentId: destId });
      renderLibraryView();
      showToast(`"${folder.name}" spostata in "${targetName}"`, '🗂️');
    }
  } catch (err) {
    console.error('[library-dnd] drop on breadcrumb failed:', err);
    showToast('Spostamento fallito', '❌');
  }
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
// AZIONI SELEZIONE (duplicate, export, delete)
// ============================================================

function _deepClone(val) {
  if (typeof structuredClone === 'function') {
    return structuredClone(val);
  }
  if (val === null || typeof val !== 'object') return val;
  if (ArrayBuffer.isView(val)) {
    return new val.constructor(val);
  }
  if (Array.isArray(val)) {
    return val.map(_deepClone);
  }
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = _deepClone(val[k]);
  }
  return copy;
}

function _generateDuplicateTitle(rawTitle, existingTitles) {
  const trimmed = (rawTitle || 'Senza titolo').trim() || 'Senza titolo';
  const match = trimmed.match(/^(.*?)\s*\(([2-9]\d*)\)$/);

  let baseTitle = trimmed;
  let nextNum = 2;
  if (match && match[1].trim()) {
    baseTitle = match[1].trim();
    nextNum = parseInt(match[2], 10) + 1;
  }

  let candidate = `${baseTitle} (${nextNum})`;
  while (existingTitles.has(candidate.toLowerCase())) {
    nextNum++;
    candidate = `${baseTitle} (${nextNum})`;
  }
  return candidate;
}

async function handleDuplicateSelection() {
  if (_isDuplicating || selectedNotebookIds.size === 0) return;

  _isDuplicating = true;
  _updateSelectionBar();

  const ids = Array.from(selectedNotebookIds);
  try {
    const allNotebooks = await loadAllNotebooksFromDB();
    const existingTitles = new Set(
      allNotebooks.map(n => (n.title || '').trim().toLowerCase())
    );

    let duplicatedCount = 0;
    const baseTs = Date.now();

    for (let i = 0; i < ids.length; i++) {
      const src = await loadNotebookWithPages(ids[i]);
      if (!src) continue;

      const newTitle = _generateDuplicateTitle(src.title, existingTitles);
      existingTitles.add(newTitle.toLowerCase());

      const now = new Date().toISOString();
      const newPages = (src.pages || []).map(p => {
        const cloned = _deepClone(p || {});
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
        ..._deepClone(restSrc),
        id: `nb_${baseTs}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        title: newTitle,
        coverColor: src.coverColor || '#4f46e5',
        pattern: src.pattern || 'ruled',
        folderId: src.folderId || null,
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
        lastEditAt: now,
        toolbarSettings: src.toolbarSettings ? _deepClone(src.toolbarSettings) : null,
        pageOrder: newPageIds.slice(),
        pages: newPages,
        lastPageIndex: typeof src.lastPageIndex === 'number'
          ? Math.min(Math.max(0, src.lastPageIndex), newPages.length - 1)
          : 0
      };

      await saveNotebookToDB(dupNb, newPageIds, { saveOrder: true });
      duplicatedCount++;
    }

    _exitSelectionMode();
    renderLibraryView();

    if (duplicatedCount > 0) {
      showToast(
        duplicatedCount === 1
          ? 'Quaderno duplicato'
          : `${duplicatedCount} quaderni duplicati`,
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

async function handleExportSelection() {
  if (selectedNotebookIds.size === 0) return;
  const ids = Array.from(selectedNotebookIds);

  const progress = showProgressDialog('Esportazione in corso...');
  try {
    await exportNotebooks(ids, ({ done, total, notebookTitle }) => {
      progress.update({ done, total, label: notebookTitle });
    });
    progress.close();
    _exitSelectionMode();
    renderLibraryView();
  } catch (err) {
    console.error('[export] failed:', err);
    progress.close();
    showToast('Esportazione fallita', '❌');
  }
}

async function handleDeleteSelection() {
  if (selectedNotebookIds.size === 0) return;
  const ids = Array.from(selectedNotebookIds);
  const count = ids.length;
  const confirmed = await showConfirmDialog({
    title: `Eliminare ${count} quadern${count === 1 ? 'o' : 'i'}?`,
    message: 'Verranno eliminate definitivamente anche tutte le relative pagine.',
    confirmText: 'Elimina',
    danger: true
  });
  if (!confirmed) return;

  try {
    for (const id of ids) {
      await deleteNotebookFromDB(id);
      closeNotebookIfOpen(id);
    }
    _exitSelectionMode();
    renderLibraryView();
    showToast(`${count} quadern${count === 1 ? 'o eliminato' : 'i eliminati'}`, '🗑️');
  } catch (err) {
    console.error('[delete-selection] failed:', err);
    showToast('Eliminazione fallita', '❌');
  }
}

// ============================================================
// IMPORT
// ============================================================

async function handleImportFile(file) {
  if (!file) return;

  const progress = showProgressDialog('Importazione in corso...');
  try {
    const result = await importNotebooks(file, ({ done, total, notebookTitle }) => {
      progress.update({ done, total, label: notebookTitle });
    });
    progress.close();
    if (result && result.length > 0) {
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

export async function openNewNotebookModal() {
  const modal = document.getElementById('newNotebookModal');
  if (!modal) return;

  selectedCoverColor = '#4f46e5';
  document.querySelectorAll('#coverColorOptions button').forEach(b =>
    b.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110'));
  const first = document.querySelector('#coverColorOptions button');
  if (first) first.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110');

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

export function selectCoverColor(btn) {
  document.querySelectorAll('#coverColorOptions button').forEach(b =>
    b.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110'));
  btn.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110');
  selectedCoverColor = btn.dataset.color;
}

export async function confirmCreateNotebook() {
  if (_isCreatingNotebook) return;
  _isCreatingNotebook = true;
  const confirmBtn = document.getElementById('confirmCreateNbBtn');
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const title = document.getElementById('modalNbTitle').value.trim() || 'Nuovo Quaderno';
    const pattern = document.getElementById('modalNbPattern').value;
    const folderVal = document.getElementById('modalNbFolder')?.value || '';
    const folderId = folderVal ? folderVal : null;
    const firstPageId = generatePageId();
    const rand = Math.random().toString(36).slice(2, 7);
    const newNb = {
      id: `nb_${Date.now()}_${rand}`,
      title, coverColor: selectedCoverColor, pattern,
      folderId,
      isFavorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

export async function deleteNotebook(e, id) {
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
  initAuth();

  document.getElementById('authBtn')
    ?.addEventListener('click', handleAuthClick);
  document.getElementById('authLogoutBtn')
    ?.addEventListener('click', handleLogout);

  document.getElementById('newNotebookBtn')
    ?.addEventListener('click', openNewNotebookModal);
  document.getElementById('newFolderBtn')
    ?.addEventListener('click', handleCreateFolder);
  document.getElementById('librarySelectBtn')
    ?.addEventListener('click', () => {
      if (_selectionMode) {
        _exitSelectionMode();
      } else {
        _enterSelectionMode(null);
      }
    });
  document.getElementById('openSettingsBtnLib')
    ?.addEventListener('click', openSettingsModal);
  document.getElementById('confirmCreateNbBtn')
    ?.addEventListener('click', confirmCreateNotebook);
  document.getElementById('cancelNewNbBtn')
    ?.addEventListener('click', closeNewNotebookModal);

  document.getElementById('selectionDoneBtn')
    ?.addEventListener('click', _exitSelectionMode);
  document.getElementById('selectionSelectAllBtn')
    ?.addEventListener('click', _selectAll);
  document.getElementById('selectionMoveBtn')
    ?.addEventListener('click', handleMoveSelection);
  document.getElementById('selectionDuplicateBtn')
    ?.addEventListener('click', handleDuplicateSelection);
  document.getElementById('selectionExportBtn')
    ?.addEventListener('click', handleExportSelection);
  document.getElementById('selectionDeleteBtn')
    ?.addEventListener('click', handleDeleteSelection);

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
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      _searchQuery = '';
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      _syncLibraryControlsToUI();
      renderLibraryView();
    });
  }

  document.getElementById('libraryFavFilterBtn')?.addEventListener('click', () => {
    const next = !getSettings().libraryOnlyFavorites;
    updateSettings({ libraryOnlyFavorites: next });
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
      canDropOnCollection: (dragged, targetFolderId) => {
        if (!dragged) return false;
        if (dragged.type === 'notebook') {
          const nb = _cachedNotebooks.find(n => n.id === dragged.id);
          return !!nb && (nb.folderId || null) !== targetFolderId;
        }
        if (dragged.type === 'folder') {
          if (dragged.id === targetFolderId) return false;
          const folder = _cachedFolders.find(f => f.id === dragged.id);
          if (!folder || (folder.parentId || null) === targetFolderId) return false;
          const excluded = _getDescendantFolderIds(dragged.id, _cachedFolders);
          return !excluded.has(targetFolderId);
        }
        return false;
      },
      canDropOnBreadcrumb: (dragged, targetFolderId) => {
        if (!dragged) return false;
        const destId = targetFolderId || null;
        if (dragged.type === 'notebook') {
          const nb = _cachedNotebooks.find(n => n.id === dragged.id);
          return !!nb && (nb.folderId || null) !== destId;
        }
        if (dragged.type === 'folder') {
          const folder = _cachedFolders.find(f => f.id === dragged.id);
          if (!folder || (folder.parentId || null) === destId) return false;
          if (!destId) return true;
          const excluded = _getDescendantFolderIds(dragged.id, _cachedFolders);
          return !excluded.has(destId);
        }
        return false;
      },
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

  document.addEventListener('click', (e) => {
    if (!_selectionMode) return;
    if (document.querySelector('.library-modal')) return;
    if (e.target.closest('.notebook-card')) return;
    if (e.target.closest('#librarySelectionBar')) return;
    if (e.target.closest('#librarySelectBtn')) return;
    if (e.target.closest('.library-modal')) return;
    _exitSelectionMode();
  });

  const importBtn = document.getElementById('importBackupBtn');
  const fileInput = document.getElementById('importFileInput');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleImportFile(file);
      fileInput.value = '';
    });
  }

  document.querySelectorAll('#coverColorOptions button').forEach(btn => {
    btn.addEventListener('click', () => selectCoverColor(btn));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _selectionMode && !document.querySelector('.library-modal')) {
      _exitSelectionMode();
    }
  });

  _syncLibraryControlsToUI();
}

on('library:refresh', renderLibraryView);