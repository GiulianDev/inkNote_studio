import { loadNotebookWithPages } from '../../services/db.js';
import { serializeBackup } from './backup-format.js';
import { showToast } from '../../core/utils.js';

export async function exportNotebooks(notebookIds, onProgress) {
  if (!notebookIds || notebookIds.length === 0) {
    showToast('Nessun notebook selezionato', '⚠️');
    return;
  }

  const notebooks = [];
  for (const id of notebookIds) {
    const nb = await loadNotebookWithPages(id);
    if (nb) notebooks.push(nb);
  }

  if (notebooks.length === 0) {
    showToast('Nessun notebook da esportare', '⚠️');
    return;
  }

  const blob = await serializeBackup(notebooks, onProgress);

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