/**
 * @module features/backup/backup-import
 *
 * Import di backup `.inknote` con match per ID.
 */

import { deserializeBackup, peekBackup } from './backup-format.js';
import { loadAllNotebooksFromDB, saveNotebookToDB } from '../../services/db.js';
import { showToast } from '../../core/utils.js';

export async function importNotebooks(file, onProgress) {
  const preview = await peekBackup(file);
  if (!preview || preview.length === 0) {
    showToast('File di backup vuoto', '⚠️');
    return null;
  }

  const local = await loadAllNotebooksFromDB();
  const localById = new Map(local.map(n => [n.id, n]));

  const conflicts = [];
  preview.forEach((p, idx) => {
    if (localById.has(p.meta.id)) {
      conflicts.push({
        previewIndex: idx,
        incoming: p.meta,
        local: localById.get(p.meta.id)
      });
    }
  });

  let strategy = 'rename';
  if (conflicts.length > 0) {
    const result = await showConflictDialog(conflicts);
    if (result === null) return null;
    strategy = result.strategy;
  }

  const { notebooks } = await deserializeBackup(file, onProgress);

  const existingNames = new Set(local.map(n => (n.title || '').toLowerCase()));
  const imported = [];

  for (const nb of notebooks) {
    const localNb = localById.get(nb.id);

    if (!localNb) {
      imported.push({ nb, replaceAllPages: false });
      existingNames.add((nb.title || '').toLowerCase());
      continue;
    }

    if (strategy === 'skip') continue;

    if (strategy === 'overwrite') {
      nb.id = localNb.id;
      imported.push({ nb, replaceAllPages: true });
      continue;
    }

    const baseName = nb.title || 'Senza titolo';
    let n = 2;
    let newName = `${baseName} (${n})`;
    while (existingNames.has(newName.toLowerCase())) {
      n++;
      newName = `${baseName} (${n})`;
    }
    nb.title = newName;
    nb.id = 'nb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    existingNames.add(newName.toLowerCase());
    imported.push({ nb, replaceAllPages: false });
  }

  for (const item of imported) {
    const { nb, replaceAllPages } = item;
    const dirtyPageIds = nb.pages.map(p => p.pageId).filter(Boolean);
    await saveNotebookToDB(nb, dirtyPageIds, {
      preserveLastEditAt: true,
      replaceAllPages,
      saveOrder: true
    });
  }

  if (imported.length === 0) {
    showToast('Nessun notebook importato', 'ℹ️');
  } else {
    showToast(`Importati ${imported.length} notebook`, '📥');
  }
  return imported.map(item => item.nb);
}

// ============================================================
// DIALOG CONFLITTI
// ============================================================

function getEditTime(nb) {
  return new Date(nb.lastEditAt || nb.updatedAt || 0).getTime();
}

function showConflictDialog(conflicts) {
  return new Promise((resolve) => {
    let incomingNewerCount = 0;
    conflicts.forEach(c => {
      if (getEditTime(c.incoming) > getEditTime(c.local)) incomingNewerCount++;
    });
    const suggestedStrategy =
      incomingNewerCount > conflicts.length / 2 ? 'overwrite' : 'skip';

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-lg w-full shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col">
        <div class="px-6 pt-6 pb-3">
          <h3 class="text-lg font-bold text-slate-900 dark:text-white">Conflitti rilevati</h3>
          <p class="text-xs text-slate-500 mt-1">
            ${conflicts.length} notebook esistono già con lo stesso ID.
            La scelta si applica a tutti.
          </p>
        </div>
        <div class="px-6 overflow-y-auto flex-1 max-h-80 custom-scrollbar" style="touch-action: pan-y; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;">
          <ul class="text-xs space-y-2 py-2 pointer-events-none">
            ${conflicts.map(c => renderConflictItem(c)).join('')}
          </ul>
        </div>
        <div class="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-200 dark:border-slate-800">
          <button data-action="cancel" class="px-3 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold">
            Annulla
          </button>
          <button data-action="skip" class="relative px-3 py-2 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 text-xs font-semibold">
            Salta
            ${suggestedStrategy === 'skip'
              ? '<span class="absolute -top-1.5 -right-1.5 bg-emerald-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none">★</span>'
              : ''}
          </button>
          <button data-action="rename" class="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold">
            Rinomina
          </button>
          <button data-action="overwrite" class="relative px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold">
            Sovrascrivi
            ${suggestedStrategy === 'overwrite'
              ? '<span class="absolute -top-1.5 -right-1.5 bg-emerald-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none">★</span>'
              : ''}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      try { document.body.removeChild(overlay); } catch (e) {}
      resolve(result);
    };

    overlay.querySelector('[data-action="cancel"]')
      .addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-action="skip"]')
      .addEventListener('click', () => cleanup({ strategy: 'skip' }));
    overlay.querySelector('[data-action="rename"]')
      .addEventListener('click', () => cleanup({ strategy: 'rename' }));
    overlay.querySelector('[data-action="overwrite"]')
      .addEventListener('click', () => cleanup({ strategy: 'overwrite' }));
  });
}

function renderConflictItem(c) {
  const localT = formatDate(c.local.lastEditAt || c.local.updatedAt);
  const incomingT = formatDate(c.incoming.lastEditAt || c.incoming.updatedAt);
  const incomingNewer = getEditTime(c.incoming) > getEditTime(c.local);
  return `
    <li class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
      <div class="font-semibold text-slate-800 dark:text-slate-200 mb-1">
        📓 ${escapeHtml(c.incoming.title || '(senza titolo)')}
      </div>
      <div class="flex flex-col gap-0.5 text-[10px] text-slate-500">
        <div>Ultima modifica locale: <span class="text-slate-700 dark:text-slate-300">${localT}</span></div>
        <div>
          Ultima modifica importata:
          <span class="${incomingNewer ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-slate-700 dark:text-slate-300'}">${incomingT}</span>
          ${incomingNewer ? '<span class="ml-1 text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-bold">· più recente</span>' : ''}
        </div>
      </div>
    </li>
  `;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}