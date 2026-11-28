/**
 * @module features/backup/backup-import
 *
 * Import di backup `.inknote` con match per ID.
 */

import { deserializeBackup, peekBackup } from './backup-format.js';
import {
  loadAllNotebooksFromDB,
  saveNotebookToDB,
  loadAllFoldersFromDB,
  saveFolderToDB
} from '../services/db.js';
import { showToast, escapeHtml } from '../core/utils.js';
import { openModalOverlay } from '../components/modal.js';
import { getCurrentNotebook, waitForPendingSaves } from '../persistence/session.js';
import { cancelPendingSave } from '../persistence/autosave.js';

let _backupNotebookHandlers = {
  closeNotebookIfOpen: null
};

export function registerBackupNotebookHandlers({ closeNotebookIfOpen } = {}) {
  _backupNotebookHandlers = {
    closeNotebookIfOpen: typeof closeNotebookIfOpen === 'function' ? closeNotebookIfOpen : null
  };
}

async function _resolveImportedFolderId(nb, folderById, folderByParentName) {
  if (Array.isArray(nb.folderPath) && nb.folderPath.length > 0) {
    let parentId = null;
    for (const node of nb.folderPath) {
      if (!node || typeof node !== 'object') continue;
      const name = String(node.name || 'Raccolta').trim() || 'Raccolta';
      const color = node.color || '#6366f1';
      const key = `${parentId || ''}::${name.toLowerCase()}`;

      let target = (node.id && folderById.has(node.id))
        ? folderById.get(node.id)
        : folderByParentName.get(key);

      if (!target) {
        const newId = (node.id && !folderById.has(node.id))
          ? node.id
          : `fld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        target = await saveFolderToDB({ id: newId, name, parentId, color });
        if (target) {
          folderById.set(target.id, target);
          folderByParentName.set(key, target);
        }
      }
      if (target) parentId = target.id;
    }
    return parentId;
  }

  if (typeof nb.folderId === 'string' && nb.folderId && folderById.has(nb.folderId)) {
    return nb.folderId;
  }
  return null;
}

export async function importNotebooks(file, onProgress) {
  const preview = await peekBackup(file);
  const previewFolders = Array.isArray(preview?.folders) ? preview.folders : [];
  if ((!preview || preview.length === 0) && previewFolders.length === 0) {
    showToast('File di backup vuoto', '⚠️');
    return null;
  }

  const local = await loadAllNotebooksFromDB();
  const localById = new Map(local.map(n => [n.id, n]));

  const conflicts = [];
  (preview || []).forEach((p, idx) => {
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

  const { notebooks, folders: backupFolders = [] } = await deserializeBackup(file, onProgress);

  const existingNames = new Set(local.map(n => (n.title || '').toLowerCase()));
  const imported = [];
  const baseTs = Date.now();
  let renameSeq = 0;

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
    nb.id = `nb_${baseTs}_${renameSeq++}_${Math.random().toString(36).slice(2, 8)}`;
    existingNames.add(newName.toLowerCase());
    imported.push({ nb, replaceAllPages: false });
  }

  const existingFolders = await loadAllFoldersFromDB();
  const folderById = new Map(existingFolders.filter(f => f && f.id).map(f => [f.id, f]));
  const folderByParentName = new Map(
    existingFolders
      .filter(f => f && f.id)
      .map(f => [`${f.parentId || ''}::${(f.name || '').trim().toLowerCase()}`, f])
  );

  // Ripristina le raccolte presenti nel trailer FLDR (es. anche sottoraccolte vuote)
  // a meno che l'utente abbia saltato tutti i quaderni in conflitto.
  const exportedIdToLocalId = new Map();
  let createdFoldersCount = 0;
  const shouldRestoreFolders = backupFolders.length > 0 && (notebooks.length === 0 || imported.length > 0);

  if (shouldRestoreFolders) {
    for (const expFld of backupFolders) {
      if (!expFld || !expFld.id) continue;
      const name = String(expFld.name || 'Raccolta').trim() || 'Raccolta';
      const color = expFld.color || '#6366f1';

      let resolvedParentId = null;
      if (expFld.parentId) {
        if (exportedIdToLocalId.has(expFld.parentId)) {
          resolvedParentId = exportedIdToLocalId.get(expFld.parentId);
        } else if (folderById.has(expFld.parentId)) {
          resolvedParentId = expFld.parentId;
        }
      }

      const key = `${resolvedParentId || ''}::${name.toLowerCase()}`;
      let target = folderById.has(expFld.id)
        ? folderById.get(expFld.id)
        : folderByParentName.get(key);

      if (!target) {
        const newId = !folderById.has(expFld.id)
          ? expFld.id
          : `fld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        target = await saveFolderToDB({
          id: newId,
          name,
          parentId: resolvedParentId,
          color,
          createdAt: expFld.createdAt || undefined
        });
        if (target) {
          folderById.set(target.id, target);
          folderByParentName.set(key, target);
          createdFoldersCount++;
        }
      }

      if (target) {
        exportedIdToLocalId.set(expFld.id, target.id);
      }
    }
  }

  for (const item of imported) {
    const { nb, replaceAllPages } = item;
    if (replaceAllPages && getCurrentNotebook()?.id === nb.id) {
      _backupNotebookHandlers.closeNotebookIfOpen?.(nb.id);
      cancelPendingSave();
      await waitForPendingSaves();
    }
    if (typeof nb.folderId === 'string' && exportedIdToLocalId.has(nb.folderId)) {
      nb.folderId = exportedIdToLocalId.get(nb.folderId);
    } else {
      nb.folderId = await _resolveImportedFolderId(nb, folderById, folderByParentName);
    }
    delete nb.folderPath;

    const dirtyPageIds = nb.pages.map(p => p.pageId).filter(Boolean);
    await saveNotebookToDB(nb, dirtyPageIds, {
      preserveLastEditAt: true,
      replaceAllPages,
      saveOrder: true
    });
  }

  if (imported.length === 0 && createdFoldersCount === 0) {
    showToast('Nessun elemento importato', 'ℹ️');
  } else if (imported.length === 1 && createdFoldersCount === 0) {
    showToast(`Quaderno "${imported[0].nb.title || 'Quaderno'}" importato con successo!`, '✅', 3600);
  } else if (imported.length > 0 && createdFoldersCount > 0) {
    showToast(
      `Importati con successo ${imported.length} quadern${imported.length === 1 ? 'o' : 'i'} e ${createdFoldersCount} raccolt${createdFoldersCount === 1 ? 'a' : 'e'}`,
      '✅',
      3600
    );
  } else if (createdFoldersCount > 0) {
    showToast(
      `Importat${createdFoldersCount === 1 ? 'a' : 'e'} con successo ${createdFoldersCount} raccolt${createdFoldersCount === 1 ? 'a' : 'e'}`,
      '✅',
      3600
    );
  } else {
    showToast(`Importati con successo ${imported.length} quadern${imported.length === 1 ? 'o' : 'i'}`, '✅', 3600);
  }

  return { notebooks: imported.map(item => item.nb), createdFoldersCount };
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const modalCtrl = openModalOverlay(overlay, {
      id: 'conflictDialog',
      ariaLabel: 'Conflitti rilevati',
      onClose: () => finish(null)
    });

    const cleanup = (result) => {
      finish(result);
      modalCtrl.close(result === null ? 'cancel' : 'confirm');
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