// ============================================================
// LIBRERIA QUADERNI + NUOVO QUADERNO MODALE
// ============================================================

import { escapeHtml, showToast, on } from '../../core/utils.js';
import {
  loadAllNotebooksFromDB, saveNotebookToDB, deleteNotebookFromDB
} from '../../services/db.js';
import { handleGoogleLogin } from '../../services/auth.js';
import { openNotebook } from '../editor/editor.js';
import { openSettingsModal } from '../settings/settings.js';
import { closeNotebookIfOpen } from '../editor/editor.js';

let selectedCoverColor = '#4f46e5';

export function renderLibraryView() {
  loadAllNotebooksFromDB().then(notebooks => {
    const grid = document.getElementById('notebooksGrid');
    const emptyMsg = document.getElementById('emptyLibraryMessage');
    grid.innerHTML = '';

    if (notebooks.length === 0) {
      emptyMsg.classList.remove('hidden');
      emptyMsg.classList.add('flex');
    } else {
      emptyMsg.classList.add('hidden');
      emptyMsg.classList.remove('flex');
      notebooks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      notebooks.forEach(nb => {
        const dateStr = new Date(nb.updatedAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
        const card = document.createElement('div');
        card.className = 'notebook-card cursor-pointer flex flex-col group';
        card.innerHTML = `
          <div class="w-full h-52 rounded-r-xl rounded-l-sm shadow-md relative overflow-hidden flex flex-col justify-between p-4"
               style="background-color: ${nb.coverColor || '#4f46e5'}; border-left: 12px solid rgba(0,0,0,0.25);">
            <div class="notebook-spine absolute left-0 top-0 bottom-0 w-3"></div>
            <div class="bg-black/20 backdrop-blur-md rounded-lg p-2.5 text-white border border-white/10">
              <h4 class="font-bold text-sm truncate">${escapeHtml(nb.title)}</h4>
              <span class="text-[10px] opacity-80">${nb.pages ? nb.pages.length : 1} pag.</span>
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
        card.querySelector('.delete-nb-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          deleteNotebook(ev, nb.id);
        });
        grid.appendChild(card);
      });
    }
    document.getElementById('libraryView').classList.remove('hidden');
  });
}

export function openNewNotebookModal() {
  const modal = document.getElementById('newNotebookModal');
  if (!modal) return;

  // Reset colore al default indaco
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
    pages: [{ pageIndex: 0, strokes: [] }]
  };
  await saveNotebookToDB(newNb);
  closeNewNotebookModal();
  openNotebook(newNb.id);
}

export async function deleteNotebook(e, id) {
  if (confirm('Sei sicuro di voler eliminare questo quaderno e tutte le sue pagine?')) {
    await deleteNotebookFromDB(id);
    // Reset dello store toolbar se il notebook cancellato era aperto
    closeNotebookIfOpen(id);
    renderLibraryView();
    showToast('Quaderno eliminato', '🗑️');
  }
}

// ============================================================
// BINDINGS UI LIBRERIA
// ============================================================

export function bindLibraryUI() {
  document.getElementById('googleLoginBtn')
    ?.addEventListener('click', handleGoogleLogin);
  document.getElementById('newNotebookBtn')
    ?.addEventListener('click', openNewNotebookModal);
  document.getElementById('openSettingsBtnLib')
    ?.addEventListener('click', openSettingsModal);
  document.getElementById('confirmCreateNbBtn')
    ?.addEventListener('click', confirmCreateNotebook);
  document.getElementById('cancelNewNbBtn')
    ?.addEventListener('click', closeNewNotebookModal);

  document.querySelectorAll('#coverColorOptions button').forEach(btn => {
    btn.addEventListener('click', () => selectCoverColor(btn));
  });
}

on('library:refresh', renderLibraryView);