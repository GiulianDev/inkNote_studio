// ============================================================
// LIBRERIA QUADERNI + BACKUP EXPORT/IMPORT
//
// Auth: Firebase (services/firebase.js). Mock services/auth.js
// resta nel progetto per rollback veloce se necessario.
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
const selectedNotebookIds = new Set();

// ============================================================
// AUTH
// ============================================================

// ============================================================
// AUTH — avatar circolare + dropdown
// ============================================================

export function initAuth() {
  onAuthChange((user) => {
    authState.user = user;
    authState.loading = false;
    updateAuthUI();
  });

  // Chiudi il dropdown al click fuori
  document.addEventListener('click', (e) => {
    const container = document.getElementById('authContainer');
    const dropdown = document.getElementById('authDropdown');
    if (!container || !dropdown || dropdown.classList.contains('hidden')) return;
    if (!container.contains(e.target)) dropdown.classList.add('hidden');
  });
}

/**
 * Deriva un colore stabile dall'email/nome dell'utente.
 * Ogni utente ha sempre lo stesso colore, senza storage.
 */
function _colorFromString(str) {
  const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b',
                   '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#a855f7'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 31) + str.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

/**
 * Estrae le iniziali da displayName o email.
 * "Mario Rossi" → "MR" | "mario@x.com" → "MA" | "mario" → "MA"
 */
function _getInitials(user) {
  const name = user.displayName || user.email || '';
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Genera l'HTML per un avatar (foto o iniziali).
 * @param {object} user — Firebase User
 * @param {number} size — dimensione in px (es. 40)
 */
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
    // Loggato: avatar circolare
    btn.title = 'Profilo';
    content.outerHTML = `<span id="authBtnContent">${_renderAvatar(authState.user, 40)}</span>`;

    // Popola dropdown
    const dAvatar = document.getElementById('authDropdownAvatar');
    const dName = document.getElementById('authDropdownName');
    const dEmail = document.getElementById('authDropdownEmail');
    if (dAvatar) dAvatar.outerHTML = `<div id="authDropdownAvatar" class="w-10 h-10 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0">${_renderAvatar(authState.user, 40)}</div>`;
    if (dName) dName.textContent = authState.user.displayName || 'Utente';
    if (dEmail) dEmail.textContent = authState.user.email || '';
  } else {
    // Sloggato: icona 👤
    btn.title = 'Accedi con Google';
    content.outerHTML = `<span id="authBtnContent" class="text-base">👤</span>`;
    if (dropdown) dropdown.classList.add('hidden');
  }
}

export async function handleAuthClick() {
  if (authState.loading) return;

  if (authState.user) {
    // Toggle dropdown
    const dropdown = document.getElementById('authDropdown');
    if (dropdown) dropdown.classList.toggle('hidden');
    return;
  }

  // Login
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

export async function handleGoogleLogin() {
  if (authState.loading) return;

  if (authState.user) {
    try {
      await signOutGoogle();
      showToast('Disconnesso', '👋');
    } catch (err) {
      console.error('[auth] signOut failed:', err);
      showToast('Logout fallito', '❌');
    }
    return;
  }

  try {
    const user = await signInWithGoogle();
    // Su mobile user è null (redirect in corso). Il toast arriva
    // al reload via onAuthChange.
    if (user) {
      showToast(`Benvenuto, ${user.displayName || user.email}!`, '👋');
    }
  } catch (err) {
    console.error('[auth] login failed:', err);
    // Ignora l'errore se l'utente ha chiuso il popup
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      showToast('Login fallito', '❌');
    }
  }
}

// ============================================================
// LIBRERIA
// ============================================================

export function renderLibraryView() {
  loadAllNotebooksFromDB().then(notebooks => {
    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    grid.innerHTML = '';

    for (const id of Array.from(selectedNotebookIds)) {
      if (!notebooks.some(n => n.id === id)) selectedNotebookIds.delete(id);
    }

    if (notebooks.length === 0) {
      emptyMsg.classList.remove('hidden');
      emptyMsg.classList.add('flex');
    } else {
      emptyMsg.classList.add('hidden');
      emptyMsg.classList.remove('flex');
      notebooks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      notebooks.forEach(nb => {
        // lastEditAt: ultima scrittura reale. Fallback a updatedAt
        // per notebook creati prima di questa modifica.
        const editIso = nb.lastEditAt || nb.updatedAt;
        const dateStr = new Date(editIso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
        const pageCount = nb.pageCount || 1;
        const isSelected = selectedNotebookIds.has(nb.id);

        const card = document.createElement('div');
        card.className = 'notebook-card cursor-pointer flex flex-col group relative';
        if (isSelected) card.classList.add('ring-2', 'ring-indigo-500', 'rounded-xl');

        card.innerHTML = `
          <input type="checkbox" data-select-id="${nb.id}" ${isSelected ? 'checked' : ''}
                 class="absolute top-2 left-2 z-10 w-5 h-5 rounded accent-indigo-600 cursor-pointer" />
          <div class="w-full h-52 rounded-r-xl rounded-l-sm shadow-md relative overflow-hidden flex flex-col justify-between p-4"
               style="background-color: ${nb.coverColor || '#4f46e5'}; border-left: 12px solid rgba(0,0,0,0.25);">
            <div class="notebook-spine absolute left-0 top-0 bottom-0 w-3"></div>
            <div class="bg-black/20 backdrop-blur-md rounded-lg p-2.5 text-white border border-white/10">
              <h4 class="font-bold text-sm truncate">${escapeHtml(nb.title)}</h4>
              <span class="text-[10px] opacity-80">${pageCount} pag.</span>
            </div>
            <div class="flex items-center justify-between text-white/90 text-[10px] font-medium">
              <span>${dateStr}</span><span>📖 InkNote</span>
            </div>
          </div>
          <div class="flex items-center justify-between mt-2 px-1 text-xs">
            <span class="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[120px]">${escapeHtml(nb.title)}</span>
            <button data-delete-id="${nb.id}" class="delete-nb-btn text-slate-400 hover:text-rose-600 p-1 transition" title="Elimina Quaderno">🗑️</button>
          </div>
        `;

        const coverEl = card.querySelector('.w-full.h-52');
        coverEl.addEventListener('click', () => openNotebook(nb.id));

        const cb = card.querySelector('input[type="checkbox"]');
        cb.addEventListener('click', (ev) => ev.stopPropagation());
        cb.addEventListener('change', (ev) => {
          ev.stopPropagation();
          if (cb.checked) selectedNotebookIds.add(nb.id);
          else selectedNotebookIds.delete(nb.id);
          updateExportButton();
          card.classList.toggle('ring-2', cb.checked);
          card.classList.toggle('ring-indigo-500', cb.checked);
        });

        card.querySelector('.delete-nb-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          deleteNotebook(ev, nb.id);
        });

        grid.appendChild(card);
      });
    }

    updateExportButton();
    document.getElementById('libraryView').classList.remove('hidden');
  });
}

function updateExportButton() {
  const btn = document.getElementById('exportBackupBtn');
  if (!btn) return;
  if (selectedNotebookIds.size > 0) {
    btn.classList.remove('hidden');
    btn.innerText = `💾 Esporta (${selectedNotebookIds.size})`;
  } else {
    btn.classList.add('hidden');
  }
}

// ============================================================
// BACKUP EXPORT/IMPORT
// ============================================================

async function handleExportClick() {
  if (selectedNotebookIds.size === 0) return;
  const ids = Array.from(selectedNotebookIds);

  const progress = showProgressDialog('Esportazione in corso...');
  try {
    await exportNotebooks(ids, ({ done, total, notebookTitle }) => {
      progress.update({ done, total, label: notebookTitle });
    });
    progress.close();
    selectedNotebookIds.clear();
    renderLibraryView();
  } catch (err) {
    console.error('[export] failed:', err);
    progress.close();
    showToast('Esportazione fallita', '❌');
  }
}

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

  document.getElementById('exportBackupBtn')
    ?.addEventListener('click', handleExportClick);

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
}

on('library:refresh', renderLibraryView);