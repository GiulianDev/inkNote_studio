// ============================================================
// LIBRERIA QUADERNI + BACKUP EXPORT/IMPORT
// ============================================================

import { escapeHtml, showToast, showConfirmDialog, on, generatePageId } from '../../core/utils.js';
import { loadAllNotebooksFromDB, saveNotebookToDB, deleteNotebookFromDB, loadNotebookWithPages } from '../../services/db.js';
import {
  signInWithGoogle, signOutGoogle, onAuthChange
} from '../../services/firebase.js';
import { authState } from '../../core/state.js';
import { openNotebook, closeNotebookIfOpen } from '../editor/editor.js';
import { openSettingsModal } from '../settings/settings-modal.js';
import { exportNotebooks } from '../backup/backup-export.js';
import { importNotebooks } from '../backup/backup-import.js';
import { showProgressDialog } from '../backup/backup-progress.js';

let selectedCoverColor = '#4f46e5';

let _selectionMode = false;
let _isDuplicating = false;
let _isCreatingNotebook = false;
let _renderRequestToken = 0;
const selectedNotebookIds = new Set();

const LP_PRESS_MS = 500;
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
// SELEZIONE
// ============================================================

function _enterSelectionMode(initialId = null) {
  if (_selectionMode) return;
  _selectionMode = true;

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

  const duplicateBtn = document.getElementById('selectionDuplicateBtn');
  const exportBtn = document.getElementById('selectionExportBtn');
  const deleteBtn = document.getElementById('selectionDeleteBtn');
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
    if (e.target.closest('.delete-nb-btn')) return;

    cancelPress();
    pressPointerId = e.pointerId;
    pressStart = { x: e.clientX, y: e.clientY };
    skipClickAfterLongPress = false;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (pressPointerId !== e.pointerId) return;
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
    if (!pressStart || e.pointerId !== pressPointerId) return;
    const dx = e.clientX - pressStart.x;
    const dy = e.clientY - pressStart.y;
    if (Math.hypot(dx, dy) > LP_MOVE_CANCEL_PX) cancelPress();
  });

  card.addEventListener('pointerup', cancelPress);
  card.addEventListener('pointercancel', cancelPress);
  card.addEventListener('pointerleave', cancelPress);

  card.addEventListener('click', (e) => {
    if (e.target.closest('.delete-nb-btn')) return;

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
// LIBRERIA — rendering
// ============================================================

export function renderLibraryView() {
  const token = ++_renderRequestToken;
  loadAllNotebooksFromDB().then(notebooks => {
    if (token !== _renderRequestToken) return;
    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    grid.innerHTML = '';

    for (const id of Array.from(selectedNotebookIds)) {
      if (!notebooks.some(n => n.id === id)) selectedNotebookIds.delete(id);
    }
    if (_selectionMode && selectedNotebookIds.size === 0) {
      _exitSelectionMode();
    }

    if (notebooks.length === 0) {
      emptyMsg.classList.remove('hidden');
      emptyMsg.classList.add('flex');
    } else {
      emptyMsg.classList.add('hidden');
      emptyMsg.classList.remove('flex');
      notebooks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      notebooks.forEach(nb => {
        const editIso = nb.lastEditAt || nb.updatedAt;
        const dateStr = new Date(editIso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
        const pageCount = nb.pageCount || 1;

        const card = document.createElement('div');
        card.className = 'notebook-card group relative';
        card.dataset.nbId = nb.id;

        card.innerHTML = `
          <div class="selection-dot" aria-hidden="true">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </div>

          <div class="notebook-cover" style="background-color: ${nb.coverColor || '#4f46e5'};">
            <div class="notebook-spine"></div>
            <div class="notebook-cover-content">
              <div class="notebook-badge">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
                  <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
                </svg>
                <span>${pageCount} pag.</span>
              </div>
              <div class="notebook-cover-footer">
                <h4 class="notebook-title">${escapeHtml(nb.title)}</h4>
                <span class="notebook-date">${dateStr}</span>
              </div>
            </div>
          </div>

          <button class="delete-nb-btn" data-delete-id="${nb.id}" title="Elimina Quaderno">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        `;

        _bindCardInteractions(card, nb);

        card.querySelector('.delete-nb-btn').addEventListener('click', (ev) => {
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
// AZIONI SELEZIONE (export, delete, select all)
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
        return cloned;
      });
      if (newPages.length === 0) {
        newPages.push({ pageId: generatePageId(), strokes: [] });
      }
      const newPageIds = newPages.map(p => p.pageId);

      const { pages: _ignoredPages, pageOrder: _ignoredOrder, ...restSrc } = src;
      const dupNb = {
        ..._deepClone(restSrc),
        id: `nb_${baseTs}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        title: newTitle,
        coverColor: src.coverColor || '#4f46e5',
        pattern: src.pattern || 'ruled',
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

export function openNewNotebookModal() {
  const modal = document.getElementById('newNotebookModal');
  if (!modal) return;

  selectedCoverColor = '#4f46e5';
  document.querySelectorAll('#coverColorOptions button').forEach(b =>
    b.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110'));
  const first = document.querySelector('#coverColorOptions button');
  if (first) first.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'scale-110');

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const body = modal.querySelector('.overflow-y-auto');
  if (body) body.scrollTop = 0;
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
    const firstPageId = generatePageId();
    const rand = Math.random().toString(36).slice(2, 7);
    const newNb = {
      id: `nb_${Date.now()}_${rand}`,
      title, coverColor: selectedCoverColor, pattern,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageOrder: [firstPageId],
      pages: [{ pageId: firstPageId, strokes: [] }],
      lastPageIndex: 0
    };
    await saveNotebookToDB(newNb, [firstPageId], { saveOrder: true });
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
  document.getElementById('selectionExportBtn')
    ?.addEventListener('click', handleExportSelection);
  document.getElementById('selectionDeleteBtn')
    ?.addEventListener('click', handleDeleteSelection);

  document.getElementById('selectionDuplicateBtn')
    ?.addEventListener('click', handleDuplicateSelection);

  document.addEventListener('click', (e) => {
    if (!_selectionMode) return;
    if (e.target.closest('.notebook-card')) return;
    if (e.target.closest('#librarySelectionBar')) return;
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
    if (e.key === 'Escape' && _selectionMode) {
      _exitSelectionMode();
    }
  });
}

on('library:refresh', renderLibraryView);