// ============================================================
// LIBRERIA QUADERNI + BACKUP EXPORT/IMPORT
//
// Auth: Firebase (services/firebase.js).
//
// Pattern selezione (Apple-like):
//   - Long-press (500ms) su una card → entra in selection mode
//     e seleziona la card
//   - In selection mode: tap su una card → toggle selezione
//   - "Fine" o tap fuori dalla griglia → esce
//   - Se rimuovi l'ultima selezione → esce automaticamente
//
// Card moderne:
//   - Cover con angoli arrotondati, dorso ombreggiato (no border-left)
//   - Titolo + pagine sovrapposti in basso
//   - Pallino selezione in alto a destra (visibile solo in selection mode)
//   - Niente checkbox fissa
// ============================================================

import { escapeHtml, showToast, on } from '../../core/utils.js';
import {
  loadAllNotebooksFromDB, saveNotebookToDB, deleteNotebookFromDB
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

let selectedCoverColor = '#4f46e5';

// ------------------------------------------------------------
// STATO SELEZIONE
// ------------------------------------------------------------
let _selectionMode = false;
const selectedNotebookIds = new Set();

// ------------------------------------------------------------
// LONG-PRESS CONFIG
// ------------------------------------------------------------
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
// SELEZIONE — modalità + toggle + barra
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

  // Applica stato visivo a tutte le card
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

  // Auto-exit se la selezione è vuota
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

    // Aggiorna il checkmark del pallino
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

  const exportBtn = document.getElementById('selectionExportBtn');
  const deleteBtn = document.getElementById('selectionDeleteBtn');
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

/**
 * Setup di long-press + click per una card.
 * Cancella il timer se il pointer si sposta > LP_MOVE_CANCEL_PX.
 */
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
    // Ignora il click sul pulsante delete
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

    // Click di coda del long-press: ignora
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

    // Click normale → apri notebook
    openNotebook(nb.id);
  });
}

// ============================================================
// LIBRERIA — rendering
// ============================================================

export function renderLibraryView() {
  loadAllNotebooksFromDB().then(notebooks => {
    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    grid.innerHTML = '';

    // Rimuovi selezioni obsolete
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
          <!-- Pallino selezione (visibile solo in selection-mode) -->
          <div class="selection-dot" aria-hidden="true">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </div>

          <!-- Cover -->
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

          <!-- Azioni hover (nascoste in selection-mode via CSS) -->
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

      // Riapplica stato se eravamo in selection mode (es. dopo export)
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
  const count = selectedNotebookIds.size;
  if (!confirm(`Eliminare ${count} quadern${count === 1 ? 'o' : 'i'} e tutte le sue pagine?`)) return;

  const ids = Array.from(selectedNotebookIds);
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
  const title = document.getElementById('modalNbTitle').value.trim() || 'Nuovo Quaderno';
  const pattern = document.getElementById('modalNbPattern').value;
  const newNb = {
    id: 'nb_' + Date.now(),
    title, coverColor: selectedCoverColor, pattern,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pages: [{ pageIndex: 0, strokes: [] }],
    lastPageIndex: 0
  };
  await saveNotebookToDB(newNb);
  closeNewNotebookModal();
  openNotebook(newNb.id);
}

export async function deleteNotebook(e, id) {
  if (confirm('Sei sicuro di voler eliminare questo quaderno e tutte le sue pagine?')) {
    await deleteNotebookFromDB(id);
    closeNotebookIfOpen(id);
    selectedNotebookIds.delete(id);
    renderLibraryView();
    showToast('Quaderno eliminato', '🗑️');
  }
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

  // Barra selezione
  document.getElementById('selectionDoneBtn')
    ?.addEventListener('click', _exitSelectionMode);
  document.getElementById('selectionSelectAllBtn')
    ?.addEventListener('click', _selectAll);
  document.getElementById('selectionExportBtn')
    ?.addEventListener('click', handleExportSelection);
  document.getElementById('selectionDeleteBtn')
    ?.addEventListener('click', handleDeleteSelection);

  // Click fuori dalla griglia → esci da selection mode
  document.addEventListener('pointerdown', (e) => {
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

  // Esc per uscire dalla selection mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _selectionMode) {
      _exitSelectionMode();
    }
  });
}

on('library:refresh', renderLibraryView);