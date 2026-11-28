import { loadNotebookWithPages, loadAllFoldersFromDB } from '../services/db.js';
import { serializeBackup } from './backup-format.js';
import { showToast } from '../core/utils.js';
import { buildFolderAncestorPath, collectFoldersForExport } from '../core/folder-tree.js';

export async function exportNotebooks(notebookIds, onProgress, options = {}) {
  const safeNbIds = Array.isArray(notebookIds) ? notebookIds : [];
  const selectedFolderIds = options.selectedFolderIds instanceof Set
    ? options.selectedFolderIds
    : (Array.isArray(options.selectedFolderIds) ? new Set(options.selectedFolderIds) : new Set());

  if (safeNbIds.length === 0 && selectedFolderIds.size === 0) {
    showToast('Nessun elemento selezionato', '⚠️');
    return;
  }

  const folders = Array.isArray(options.folders)
    ? options.folders
    : await loadAllFoldersFromDB();
  const folderMap = new Map(folders.filter(f => f && f.id).map(f => [f.id, f]));

  const notebooks = [];
  for (const id of safeNbIds) {
    const nb = await loadNotebookWithPages(id);
    if (!nb) continue;
    if (nb.folderId && folderMap.has(nb.folderId)) {
      nb.folderPath = buildFolderAncestorPath(nb.folderId, folderMap, selectedFolderIds);
    }
    notebooks.push(nb);
  }

  const exportFolders = collectFoldersForExport({
    selectedFolderIds,
    notebooks,
    folders
  });

  if (notebooks.length === 0 && exportFolders.length === 0) {
    showToast('Nessun elemento da esportare', '⚠️');
    return;
  }

  const blob = await serializeBackup(notebooks, onProgress, { folders: exportFolders });

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const filename = `inknote_backup_${y}-${m}-${d}.inknote`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showToast(`Backup creato: ${filename} (${formatBytes(blob.size)})`, '💾');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}