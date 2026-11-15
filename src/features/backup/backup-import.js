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
  const localNames = new Set(local.map(n => (n.title || '').toLowerCase()));

  const conflicts = [];
  preview.forEach((p, idx) => {
    if (localNames.has((p.meta.title || '').toLowerCase())) {
      conflicts.push(idx);
    }
  });

  let strategy = 'rename';
  if (conflicts.length > 0) {
    const result = await showConflictDialog(preview, conflicts);
    if (result === null) return null;
    strategy = result.strategy;
  }

  const { notebooks } = await deserializeBackup(file, onProgress);

  const imported = [];
  const localByName = new Map(local.map(n => [(n.title || '').toLowerCase(), n]));

  for (const nb of notebooks) {
    const nameLower = (nb.title || '').toLowerCase();
    const localNb = localByName.get(nameLower);

    if (!localNb) {
      imported.push(nb);
      continue;
    }

    if (strategy === 'skip') {
      continue;
    }
    if (strategy === 'overwrite') {
      nb.id = localNb.id;
      imported.push(nb);
      continue;
    }
    // rename
    let n = 2;
    let newName = `${nb.title} (${n})`;
    while (localByName.has(newName.toLowerCase())) {
      n++;
      newName = `${nb.title} (${n})`;
    }
    nb.title = newName;
    nb.id = 'nb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    imported.push(nb);
  }

  for (const nb of imported) {
    const dirtyPages = nb.pages.map((_, i) => i);
    await saveNotebookToDB(nb, dirtyPages);
  }

  showToast(`Importati ${imported.length} notebook`, '📥');
  return imported;
}

function showConflictDialog(preview, conflictIdxs) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col">
        <div class="px-6 pt-6 pb-3">
          <h3 class="text-lg font-bold text-slate-900 dark:text-white">Conflitti rilevati</h3>
          <p class="text-xs text-slate-500 mt-1">${conflictIdxs.length} notebook hanno lo stesso nome di notebook esistenti.</p>
        </div>
        <div class="px-6 overflow-y-auto flex-1 max-h-64 custom-scrollbar">
          <ul class="text-xs space-y-1 py-2">
            ${conflictIdxs.map(i => `<li class="text-slate-700 dark:text-slate-300">📓 ${escapeHtml(preview[i].meta.title || '(senza titolo)')}</li>`).join('')}
          </ul>
        </div>
        <div class="px-6 py-3 border-t border-slate-200 dark:border-slate-800">
          <label class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <input type="checkbox" id="applyAllCheck" checked class="accent-indigo-600">
            Applica la scelta a tutti i conflitti
          </label>
        </div>
        <div class="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-200 dark:border-slate-800">
          <button data-action="cancel" class="px-3 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold">Annulla</button>
          <button data-action="skip" class="px-3 py-2 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 text-xs font-semibold">Salta</button>
          <button data-action="rename" class="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold">Rinomina</button>
          <button data-action="overwrite" class="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold">Sovrascrivi</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      try { document.body.removeChild(overlay); } catch (e) {}
      resolve(result);
    };

    const readApplyAll = () => {
      const cb = overlay.querySelector('#applyAllCheck');
      return cb ? cb.checked : true;
    };

    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-action="skip"]').addEventListener('click', () => cleanup({ strategy: 'skip', applyToAll: readApplyAll() }));
    overlay.querySelector('[data-action="rename"]').addEventListener('click', () => cleanup({ strategy: 'rename', applyToAll: readApplyAll() }));
    overlay.querySelector('[data-action="overwrite"]').addEventListener('click', () => cleanup({ strategy: 'overwrite', applyToAll: readApplyAll() }));
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}