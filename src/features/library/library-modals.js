// ============================================================
// MODALI LIBRERIA: Crea/Modifica Cartella + Sposta in Cartella
// ============================================================

import { escapeHtml } from '../../core/utils.js';

export const FOLDER_COLORS = [
  { color: '#6366f1', label: 'Indigo' },
  { color: '#2563eb', label: 'Blu' },
  { color: '#059669', label: 'Verde' },
  { color: '#e11d48', label: 'Rosa' },
  { color: '#d97706', label: 'Ambra' },
  { color: '#8b5cf6', label: 'Viola' },
  { color: '#0d9488', label: 'Teal' },
  { color: '#475569', label: 'Ardesia' }
];

/**
 * Restituisce una lista piatta ordinata ad albero delle cartelle, sicura contro cicli.
 */
export function buildFolderTreeList(folders, parentId = null, depth = 0, excludedIds = new Set(), visited = new Set()) {
  const children = (folders || [])
    .filter(f => f && (f.parentId || null) === parentId && !excludedIds.has(f.id) && !visited.has(f.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it', { sensitivity: 'base' }));

  const out = [];
  for (const f of children) {
    visited.add(f.id);
    out.push({ ...f, depth });
    out.push(...buildFolderTreeList(folders, f.id, depth + 1, excludedIds, visited));
  }
  return out;
}

export function openFolderEditorModal({
  mode = 'create',
  folder = null,
  parentName = 'Libreria',
  title = null,
  subtitle = null,
  initialName = ''
} = {}) {
  return new Promise((resolve) => {
    const isEdit = mode === 'edit' && folder;
    let chosenColor = (folder && folder.color) || FOLDER_COLORS[0].color;
    const startName = (folder && folder.name) || initialName || '';
    const modalTitle = title || (isEdit ? 'Modifica Raccolta' : 'Nuova Raccolta');
    const modalSubtitle = subtitle !== null
      ? subtitle
      : (!isEdit ? `Posizione: ${parentName}` : '');

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4 library-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col" style="max-height: 90vh;">
        <div class="px-6 pt-6 pb-3 shrink-0">
          <h3 class="text-lg font-bold text-slate-900 dark:text-white">
            ${escapeHtml(modalTitle)}
          </h3>
          ${modalSubtitle ? `<p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(modalSubtitle)}</p>` : ''}
        </div>

        <div class="px-6 py-2 space-y-4 text-xs overflow-y-auto flex-1 custom-scrollbar" style="touch-action: pan-y;">
          <div>
            <label for="folderModalNameInput" class="block font-semibold text-slate-700 dark:text-slate-300 mb-1">Nome Raccolta</label>
            <input id="folderModalNameInput" type="text" maxlength="80"
              value="${escapeHtml(startName)}"
              placeholder="Es. Università, Progetti..."
              class="w-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white">
          </div>
          <div>
            <label class="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Colore Raccolta</label>
            <div id="folderColorSwatches" class="flex items-center flex-wrap gap-2.5 pt-1 pb-2">
              ${FOLDER_COLORS.map(c => {
                const active = c.color.toLowerCase() === chosenColor.toLowerCase();
                return `<button type="button" data-folder-color="${c.color}" title="${c.label}"
                  class="w-7 h-7 rounded-full transition cursor-pointer ${active ? 'ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-slate-900 scale-110' : 'hover:scale-105'}"
                  style="background-color: ${c.color}; touch-action: manipulation;"></button>`;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-200 dark:border-slate-800 shrink-0">
          <button type="button" data-modal-cancel style="touch-action: manipulation;"
            class="px-4 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold text-xs cursor-pointer">
            Annulla
          </button>
          <button type="button" data-modal-save style="touch-action: manipulation;"
            class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-xl shadow-md cursor-pointer">
            ${isEdit ? 'Salva Modifiche' : 'Crea Raccolta'}
          </button>
        </div>
      </div>
    `;

    let closed = false;
    const cleanup = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const nameInput = overlay.querySelector('#folderModalNameInput');
    const submit = () => {
      const name = (nameInput?.value || '').trim();
      if (!name) {
        nameInput?.focus();
        return;
      }
      cleanup({ name, color: chosenColor });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup(null);
      } else if (e.key === 'Enter' && document.activeElement === nameInput) {
        e.preventDefault();
        submit();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });

    overlay.querySelectorAll('[data-folder-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        chosenColor = btn.dataset.folderColor;
        overlay.querySelectorAll('[data-folder-color]').forEach(b => {
          b.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'dark:ring-offset-slate-900', 'scale-110');
          b.classList.add('hover:scale-105');
        });
        btn.classList.remove('hover:scale-105');
        btn.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'dark:ring-offset-slate-900', 'scale-110');
      });
    });

    overlay.querySelector('[data-modal-cancel]')?.addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-modal-save]')?.addEventListener('click', submit);

    document.body.appendChild(overlay);
    setTimeout(() => {
      nameInput?.focus();
      nameInput?.select();
    }, 20);
  });
}

/**
 * Modale "Sposta nella raccolta…": restituisce `undefined` se annullato, `null` per radice Libreria,
 * oppure l'ID della raccolta selezionata.
 */
export function openMoveItemsModal({
  folders = [],
  initialTargetId = null,
  excludedFolderIds = new Set(),
  title = 'Sposta nella raccolta…',
  subtitle = 'Scegli la raccolta di destinazione'
} = {}) {
  return new Promise((resolve) => {
    let selectedId = (initialTargetId && !excludedFolderIds.has(initialTargetId)) ? initialTargetId : null;
    const flatTree = buildFolderTreeList(folders, null, 0, excludedFolderIds);

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4 library-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const renderListHtml = () => {
      const rootSelected = selectedId === null;
      const rootItem = `
        <button type="button" data-dest-id=""
          class="move-dest-row w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-xs font-semibold transition cursor-pointer ${
            rootSelected
              ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-500/40'
              : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
          }"
          style="touch-action: manipulation;">
          <svg class="w-4 h-4 shrink-0 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          <span class="truncate flex-1">Libreria (principale)</span>
          <span data-row-check class="text-indigo-600 dark:text-indigo-400 font-bold ${rootSelected ? '' : 'hidden'}">✓</span>
        </button>
      `;
      const folderItems = flatTree.map(f => {
        const isSel = selectedId === f.id;
        const indentPx = 12 + Math.min(f.depth, 6) * 18;
        return `
          <button type="button" data-dest-id="${escapeHtml(f.id)}"
            class="move-dest-row w-full flex items-center gap-2.5 pr-3 py-2 rounded-xl text-left text-xs font-medium transition cursor-pointer ${
              isSel
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-semibold ring-1 ring-indigo-500/40'
                : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
            }"
            style="padding-left: ${indentPx}px; touch-action: manipulation;">
            <svg class="w-4 h-4 shrink-0" style="color: ${escapeHtml(f.color || '#6366f1')};" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M5 7V5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/>
              <rect width="18" height="13" x="3" y="8" rx="2.5" fill="currentColor" fill-opacity="0.18"/>
              <line x1="8" x2="16" y1="13" y2="13"/>
              <line x1="8" x2="13" y1="16.5" y2="16.5"/>
            </svg>
            <span class="truncate flex-1">${escapeHtml(f.name)}</span>
            <span data-row-check class="text-indigo-600 dark:text-indigo-400 font-bold ${isSel ? '' : 'hidden'}">✓</span>
          </button>
        `;
      }).join('');
      return rootItem + folderItems;
    };

    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col" style="max-height: 85vh;">
        <div class="px-6 pt-5 pb-3 shrink-0 border-b border-slate-200 dark:border-slate-800">
          <h3 class="text-base font-bold text-slate-900 dark:text-white">${escapeHtml(title)}</h3>
          ${subtitle ? `<p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(subtitle)}</p>` : ''}
        </div>

        <div id="moveModalFolderList" class="px-4 py-3 space-y-1 overflow-y-auto flex-1 custom-scrollbar" style="touch-action: pan-y; max-height: 50vh;">
          ${renderListHtml()}
        </div>

        <div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-200 dark:border-slate-800 shrink-0">
          <button type="button" data-modal-cancel style="touch-action: manipulation;"
            class="px-4 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold text-xs cursor-pointer">
            Annulla
          </button>
          <button type="button" data-modal-confirm style="touch-action: manipulation;"
            class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-xl shadow-md cursor-pointer">
            Sposta qui
          </button>
        </div>
      </div>
    `;

    let closed = false;
    const cleanup = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup(undefined);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(undefined);
    });

    const listEl = overlay.querySelector('#moveModalFolderList');

    const syncSelectionUI = () => {
      listEl?.querySelectorAll('.move-dest-row').forEach(row => {
        const rowId = row.dataset.destId ? row.dataset.destId : null;
        const isSel = rowId === selectedId;
        row.classList.toggle('bg-indigo-50', isSel);
        row.classList.toggle('dark:bg-indigo-950/60', isSel);
        row.classList.toggle('text-indigo-700', isSel);
        row.classList.toggle('dark:text-indigo-300', isSel);
        row.classList.toggle('font-semibold', isSel || rowId === null);
        row.classList.toggle('font-medium', !isSel && rowId !== null);
        row.classList.toggle('ring-1', isSel);
        row.classList.toggle('ring-indigo-500/40', isSel);
        row.classList.toggle('text-slate-700', !isSel);
        row.classList.toggle('dark:text-slate-200', !isSel);
        row.classList.toggle('hover:bg-slate-100', !isSel);
        row.classList.toggle('dark:hover:bg-slate-800', !isSel);
        const chk = row.querySelector('[data-row-check]');
        if (chk) chk.classList.toggle('hidden', !isSel);
      });
    };

    listEl?.querySelectorAll('.move-dest-row').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedId = btn.dataset.destId ? btn.dataset.destId : null;
        syncSelectionUI();
      });
    });

    overlay.querySelector('[data-modal-cancel]')?.addEventListener('click', () => cleanup(undefined));
    overlay.querySelector('[data-modal-confirm]')?.addEventListener('click', () => cleanup(selectedId));

    document.body.appendChild(overlay);
  });
}
