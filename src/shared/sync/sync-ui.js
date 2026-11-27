/**
 * @module shared/sync/sync-ui
 *
 * Modale per la sincronizzazione Cloud MANUALE con Firestore.
 *   - Mostra account connesso, riepilogo locale, ultimo sync e stima consumi odierni.
 *   - Avvia `runManualCloudSync` solo su click esplicito dell'utente.
 *   - Gestisce la risoluzione interattiva dei conflitti (Mantieni locale / Usa cloud / Mantieni entrambi / Salta).
 */

import { escapeHtml, showToast, emit } from '../core/utils.js';
import { authState } from '../core/state.js';
import {
  isFirestoreReady,
  getActiveFirebaseProjectId,
  getActiveFirebaseDatabaseId,
  signInWithGoogle
} from '../services/firebase.js';
import { getManualSyncOverview, runManualCloudSync, isCloudSyncRunning } from '../services/sync-cloud.js';
import { formatFirestoreErrorMessage, formatAuthErrorMessage } from '../sharing/sharing-helpers.js';
import {
  formatBytesCompact,
  formatSyncTimestampIt,
  loadUserSyncState,
  parseSyncTimestampMs
} from './sync-helpers.js';
import { openModalOverlay } from '../components/modal.js';
import { syncUserMenuCloudStatus } from '../components/user-menu.js';
import { closeAllEditorMenus } from '../../notebook/toolbar/toolbar.js';
import { openNotebook, closeNotebookIfOpen } from '../../notebook/editor/editor.js';

let _activeState = null;

function _formatSyncError(err) {
  const authMsg = formatAuthErrorMessage(err);
  if (authMsg) return authMsg;

  const rawMsg = typeof err?.message === 'string' ? err.message : String(err || '');
  let innerMsg = rawMsg;
  if (rawMsg.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawMsg);
      if (typeof parsed?.error === 'string') innerMsg = parsed.error;
    } catch {
      // ignore malformed JSON
    }
  }

  const lower = innerMsg.toLowerCase();
  const projectId = getActiveFirebaseProjectId();
  const databaseId = getActiveFirebaseDatabaseId();

  if (lower.includes('quota exceeded')) {
    const isDailyReadMetric = lower.includes('free daily read units');
    const upgradeUrl = (projectId && databaseId && databaseId !== '(default)')
      ? `https://console.firebase.google.com/project/${projectId}/firestore/databases/${databaseId}/data?openUpgradeDialog=true`
      : '';
    return {
      text: 'Quota giornaliera gratuita di Firestore esaurita (si azzera domani). I dati locali restano al sicuro sul dispositivo.',
      linkUrl: isDailyReadMetric ? upgradeUrl : 'https://firebase.google.com/pricing#cloud-firestore',
      linkLabel: isDailyReadMetric ? 'Apri dettagli quota in Firebase Console' : 'Dettagli piano Spark Enterprise'
    };
  }

  return {
    text: formatFirestoreErrorMessage(err, {
      projectId,
      databaseId,
      fallback: innerMsg || 'Sincronizzazione non riuscita. Riprova tra poco.'
    }),
    linkUrl: '',
    linkLabel: ''
  };
}

function _buildSyncSubtitle(uid) {
  if (!uid) return 'Manuale';
  const s = loadUserSyncState(uid);
  if (!s.lastSyncAt) return 'Manuale · Mai eseguito';
  return `Ultimo: ${formatSyncTimestampIt(s.lastSyncAt)}`;
}

export function refreshUserMenuSyncBadge(user = authState.user) {
  const uid = user && !user.isAnonymous ? user.uid : '';
  syncUserMenuCloudStatus({ subtitle: _buildSyncSubtitle(uid) });
}

function _conflictReasonLabel(reason) {
  switch (reason) {
    case 'deleted_locally_modified_cloud':
      return 'Eliminato su questo dispositivo, ma modificato altrove nel cloud.';
    case 'modified_locally_deleted_cloud':
      return 'Modificato su questo dispositivo, ma eliminato nel cloud.';
    case 'local_exists_cloud_deleted':
      return 'Presente localmente, ma segnato come eliminato nel cloud.';
    case 'both_exist_first_sync':
      return 'Presente sia qui che nel cloud con contenuti o metadati diversi.';
    default:
      return 'Modificato su entrambi i dispositivi dopo l’ultima sincronizzazione.';
  }
}

function _buildSummaryLines(res) {
  const parts = [];
  if (res.uploadedNotebooks > 0) parts.push(`${res.uploadedNotebooks} quad. caricati`);
  if (res.downloadedNotebooks > 0) parts.push(`${res.downloadedNotebooks} quad. scaricati`);
  if (res.uploadedFolders > 0 || res.downloadedFolders > 0) {
    parts.push(`${res.uploadedFolders + res.downloadedFolders} raccolte aggiornate`);
  }
  if (res.deletedCloud > 0) parts.push(`${res.deletedCloud} rimossi dal cloud`);
  if (res.deletedLocal > 0) parts.push(`${res.deletedLocal} rimossi localmente`);
  if (res.skippedPages > 0 && res.uploadedPages === 0 && res.downloadedPages === 0 && parts.length === 0) {
    return 'Tutto è già sincronizzato e aggiornato.';
  }
  if (parts.length === 0) {
    return 'Nessuna modifica da trasferire: tutto allineato.';
  }
  return parts.join(' · ');
}

function _renderModalBody() {
  if (!_activeState) return;
  const { bodyEl, modalCtrl, user, overview, syncing, progressText, result, errorInfo, conflicts, conflictResolve } = _activeState;
  if (!bodyEl) return;

  modalCtrl.updateOptions({
    canClose: () => !syncing && !conflictResolve
  });

  if (conflicts && conflicts.length > 0 && conflictResolve) {
    _renderConflictPicker();
    return;
  }

  const daily = overview?.dailyUsage || {
    syncCount: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    readsApprox: 0,
    writesApprox: 0
  };

  const firestoreAvailable = isFirestoreReady();
  const isSignedIn = !!(user && !user.isAnonymous);

  bodyEl.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/50 p-3.5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Account & Stato Locale</p>
            <p class="text-sm font-semibold text-slate-900 dark:text-white truncate mt-0.5">
              ${isSignedIn ? escapeHtml(user.displayName || user.email || 'Account Google') : 'Non connesso'}
            </p>
            ${isSignedIn && user.email ? `<p class="text-xs text-slate-500 dark:text-slate-400 truncate">${escapeHtml(user.email)}</p>` : ''}
          </div>
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300 shrink-0">
            Solo manuale
          </span>
        </div>
        <div class="mt-3 pt-2.5 border-t border-slate-200/80 dark:border-slate-700/70 grid grid-cols-2 gap-2 text-xs">
          <div>
            <span class="text-slate-500 dark:text-slate-400">Archivio locale:</span>
            <span class="font-semibold text-slate-800 dark:text-slate-200">
              ${overview ? `${overview.localNotebooksCount} quaderni · ${overview.localFoldersCount} raccolte` : '—'}
            </span>
          </div>
          <div class="text-right">
            <span class="text-slate-500 dark:text-slate-400">Ultimo sync:</span>
            <span class="font-semibold text-slate-800 dark:text-slate-200">${escapeHtml(formatSyncTimestampIt(overview?.lastSyncAt))}</span>
          </div>
        </div>
        ${overview?.pendingTombstonesCount > 0 ? `
          <p class="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
            ${overview.pendingTombstonesCount} ${overview.pendingTombstonesCount === 1 ? 'eliminazione locale in attesa' : 'eliminazioni locali in attesa'} di allineamento al prossimo sync.
          </p>
        ` : ''}
      </div>

      <div class="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
        <div class="flex items-center justify-between gap-2 mb-2.5">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Consumi di oggi (stima locale)</p>
          <span class="text-[10px] text-slate-400 dark:text-slate-500">0 operazioni in background</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="rounded-lg bg-slate-50 dark:bg-slate-800/70 px-2.5 py-2">
            <div class="text-[10px] text-slate-500 dark:text-slate-400">Sync oggi</div>
            <div class="text-sm font-bold text-slate-900 dark:text-white mt-0.5">${daily.syncCount}</div>
          </div>
          <div class="rounded-lg bg-slate-50 dark:bg-slate-800/70 px-2.5 py-2">
            <div class="text-[10px] text-slate-500 dark:text-slate-400">Caricati</div>
            <div class="text-sm font-bold text-slate-900 dark:text-white mt-0.5">${escapeHtml(formatBytesCompact(daily.bytesUploaded))}</div>
          </div>
          <div class="rounded-lg bg-slate-50 dark:bg-slate-800/70 px-2.5 py-2">
            <div class="text-[10px] text-slate-500 dark:text-slate-400">Scaricati</div>
            <div class="text-sm font-bold text-slate-900 dark:text-white mt-0.5">${escapeHtml(formatBytesCompact(daily.bytesDownloaded))}</div>
          </div>
          <div class="rounded-lg bg-slate-50 dark:bg-slate-800/70 px-2.5 py-2">
            <div class="text-[10px] text-slate-500 dark:text-slate-400">Ops Firestore</div>
            <div class="text-sm font-bold text-slate-900 dark:text-white mt-0.5">${daily.readsApprox}L / ${daily.writesApprox}S</div>
          </div>
        </div>
      </div>

      ${syncing ? `
        <div class="rounded-xl border border-indigo-200 dark:border-indigo-800/70 bg-indigo-50/70 dark:bg-indigo-950/30 p-3.5">
          <div class="flex items-center gap-2.5">
            <span class="w-4 h-4 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin shrink-0" aria-hidden="true"></span>
            <p class="text-xs font-medium text-indigo-900 dark:text-indigo-200">${escapeHtml(progressText || 'Sincronizzazione in corso...')}</p>
          </div>
        </div>
      ` : ''}

      ${errorInfo ? `
        <div class="rounded-xl border border-rose-200 dark:border-rose-800/70 bg-rose-50 dark:bg-rose-950/40 p-3.5 text-xs text-rose-800 dark:text-rose-200 space-y-1.5">
          <p class="font-semibold">Errore sincronizzazione</p>
          <p class="leading-relaxed">${escapeHtml(errorInfo.text)}</p>
          ${errorInfo.linkUrl ? `
            <a href="${escapeHtml(errorInfo.linkUrl)}" target="_blank" rel="noopener noreferrer"
              class="inline-block font-semibold underline text-rose-700 dark:text-rose-300">
              ${escapeHtml(errorInfo.linkLabel || 'Approfondisci')}
            </a>
          ` : ''}
        </div>
      ` : ''}

      ${result && !syncing ? `
        <div class="rounded-xl border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/80 dark:bg-emerald-950/30 p-3.5 text-xs text-emerald-900 dark:text-emerald-200 space-y-1.5">
          <p class="font-semibold">${result.abortedByUser ? 'Sincronizzazione annullata' : 'Sincronizzazione completata'}</p>
          ${!result.abortedByUser ? `
            <p>${escapeHtml(_buildSummaryLines(result))}</p>
            <p class="text-[11px] text-emerald-700 dark:text-emerald-300">
              Pagine inviate: ${result.uploadedPages} · Scaricate: ${result.downloadedPages} · Saltate (invariate): ${result.skippedPages} · Ops: ${result.readsApprox}L / ${result.writesApprox}S
            </p>
          ` : ''}
          ${Array.isArray(result.nearLimitPages) && result.nearLimitPages.length > 0 ? `
            <div class="mt-2 pt-2 border-t border-emerald-200/80 dark:border-emerald-800/60 text-[11px] text-amber-800 dark:text-amber-300">
              Attenzione: ${result.nearLimitPages.length} ${result.nearLimitPages.length === 1 ? 'pagina è vicina o superiore' : 'pagine sono vicine o superiori'} al limite 1 MiB di Firestore (${result.nearLimitPages.map(p => `${p.notebookTitle} pag. ${p.pageNumber} (${formatBytesCompact(p.byteLength)}${p.chunked ? `, ${p.chunkCount} frammenti` : ''})`).join(', ')}).
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="flex items-center justify-end gap-2 pt-1">
        <button type="button" data-sync-close ${syncing ? 'disabled' : ''}
          style="touch-action: manipulation;"
          class="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition cursor-pointer">
          Chiudi
        </button>
        ${!firestoreAvailable ? `
          <span class="text-xs font-semibold text-amber-600 dark:text-amber-400">Firebase non configurato</span>
        ` : !isSignedIn ? `
          <button type="button" data-sync-signin
            style="touch-action: manipulation;"
            class="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition cursor-pointer">
            Accedi con Google
          </button>
        ` : `
          <button type="button" data-sync-start ${syncing ? 'disabled' : ''}
            style="touch-action: manipulation;"
            class="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white shadow-sm transition cursor-pointer">
            ${syncing ? 'Sincronizzazione...' : 'Avvia sincronizzazione ora'}
          </button>
        `}
      </div>
    </div>
  `;

  bodyEl.querySelector('[data-sync-close]')?.addEventListener('click', () => {
    if (!_activeState?.syncing) modalCtrl.close('button');
  });

  bodyEl.querySelector('[data-sync-signin]')?.addEventListener('click', async () => {
    try {
      const signed = await signInWithGoogle();
      if (signed && _activeState) {
        _activeState.user = signed;
        _activeState.overview = await getManualSyncOverview(signed.uid);
        _renderModalBody();
      }
    } catch (err) {
      if (_activeState) {
        _activeState.errorInfo = _formatSyncError(err);
        _renderModalBody();
      }
    }
  });

  bodyEl.querySelector('[data-sync-start]')?.addEventListener('click', () => {
    void _executeSyncFromModal();
  });
}

function _renderConflictPicker() {
  if (!_activeState) return;
  const { bodyEl, conflicts, conflictSelections, conflictResolve } = _activeState;
  if (!bodyEl || !conflicts || !conflictResolve) return;

  const rowsHtml = conflicts.map((c, idx) => {
    const key = `${c.kind}:${c.id}`;
    const isFolder = c.kind === 'folder';
    const title = c.local?.title || c.local?.name || c.cloud?.title || c.cloud?.name || (isFolder ? 'Raccolta' : 'Quaderno');
    const localTs = c.local
      ? formatSyncTimestampIt(c.local.lastEditAt || c.local.updatedAt || c.local.createdAt)
      : 'Eliminato';
    const cloudTs = c.cloud?.deleted
      ? 'Eliminato nel cloud'
      : formatSyncTimestampIt(c.cloud?.lastEditAt || c.cloud?.clientUpdatedAt || c.cloud?.updatedAt);
    const localPages = !isFolder && c.local ? ` · ${c.local.pageCount || c.local.pageOrder?.length || 1} pag.` : '';
    const cloudPages = !isFolder && c.cloud && !c.cloud.deleted ? ` · ${c.cloud.pageCount || c.cloud.pageOrder?.length || 1} pag.` : '';
    const canKeepBoth = !isFolder && !!c.local && !!c.cloud && !c.cloud.deleted;
    const selected = conflictSelections[key] || 'keep_local';

    return `
      <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              ${isFolder ? 'Raccolta' : 'Quaderno'}
            </span>
            <h4 class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(title)}</h4>
            <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(_conflictReasonLabel(c.reason))}</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 text-[11px] bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2">
          <div>
            <span class="block text-slate-400">Locale</span>
            <span class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(localTs + localPages)}</span>
          </div>
          <div>
            <span class="block text-slate-400">Cloud</span>
            <span class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(cloudTs + cloudPages)}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Risoluzione conflitto ${escapeHtml(title)}">
          <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] cursor-pointer">
            <input type="radio" name="conflict_${idx}" value="keep_local" data-conflict-key="${escapeHtml(key)}" ${selected === 'keep_local' ? 'checked' : ''}>
            <span>Mantieni locale</span>
          </label>
          <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] cursor-pointer">
            <input type="radio" name="conflict_${idx}" value="use_cloud" data-conflict-key="${escapeHtml(key)}" ${selected === 'use_cloud' ? 'checked' : ''}>
            <span>Usa cloud</span>
          </label>
          ${canKeepBoth ? `
            <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] cursor-pointer">
              <input type="radio" name="conflict_${idx}" value="keep_both" data-conflict-key="${escapeHtml(key)}" ${selected === 'keep_both' ? 'checked' : ''}>
              <span>Mantieni entrambi</span>
            </label>
          ` : ''}
          <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] cursor-pointer">
            <input type="radio" name="conflict_${idx}" value="skip" data-conflict-key="${escapeHtml(key)}" ${selected === 'skip' ? 'checked' : ''}>
            <span>Salta</span>
          </label>
        </div>
      </div>
    `;
  }).join('');

  bodyEl.innerHTML = `
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs font-semibold text-slate-800 dark:text-slate-100">
          Trovati ${conflicts.length} ${conflicts.length === 1 ? 'elemento con conflitto' : 'elementi con conflitti'}
        </p>
        <div class="flex items-center gap-1.5">
          <button type="button" data-all-choice="keep_local"
            class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-[11px] font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
            Tutti locali
          </button>
          <button type="button" data-all-choice="use_cloud"
            class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-[11px] font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
            Tutti cloud
          </button>
        </div>
      </div>
      <div class="max-h-72 overflow-y-auto custom-scrollbar space-y-2.5 pr-1">
        ${rowsHtml}
      </div>
      <div class="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
        <button type="button" data-conflict-cancel
          style="touch-action: manipulation;"
          class="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
          Annulla sync
        </button>
        <button type="button" data-conflict-apply
          style="touch-action: manipulation;"
          class="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm cursor-pointer">
          Conferma e continua
        </button>
      </div>
    </div>
  `;

  bodyEl.querySelectorAll('input[data-conflict-key]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!_activeState) return;
      _activeState.conflictSelections[input.dataset.conflictKey] = input.value;
    });
  });

  bodyEl.querySelectorAll('[data-all-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!_activeState) return;
      const val = btn.dataset.allChoice;
      for (const c of conflicts) {
        _activeState.conflictSelections[`${c.kind}:${c.id}`] = val;
      }
      _renderConflictPicker();
    });
  });

  bodyEl.querySelector('[data-conflict-cancel]')?.addEventListener('click', () => {
    if (!_activeState) return;
    const resolve = _activeState.conflictResolve;
    _activeState.conflicts = null;
    _activeState.conflictResolve = null;
    _renderModalBody();
    resolve(null);
  });

  bodyEl.querySelector('[data-conflict-apply]')?.addEventListener('click', () => {
    if (!_activeState) return;
    const resolve = _activeState.conflictResolve;
    const choices = { ..._activeState.conflictSelections };
    _activeState.conflicts = null;
    _activeState.conflictResolve = null;
    _renderModalBody();
    resolve(choices);
  });
}

async function _executeSyncFromModal() {
  if (!_activeState || _activeState.syncing || isCloudSyncRunning()) return;
  _activeState.syncing = true;
  _activeState.errorInfo = null;
  _activeState.result = null;
  _activeState.progressText = 'Preparazione sincronizzazione...';
  _renderModalBody();

  try {
    const res = await runManualCloudSync({
      onProgress: ({ label }) => {
        if (!_activeState) return;
        _activeState.progressText = label || 'Sincronizzazione in corso...';
        _renderModalBody();
      },
      onConflicts: (conflicts) => new Promise((resolve) => {
        if (!_activeState) {
          resolve(null);
          return;
        }
        const defaults = {};
        for (const c of conflicts) {
          const key = `${c.kind}:${c.id}`;
          const localMs = c.local ? parseSyncTimestampMs(c.local.lastEditAt || c.local.updatedAt) : (c.tombstoneMs || 0);
          const cloudMs = c.cloud ? parseSyncTimestampMs(c.cloud.lastEditAt || c.cloud.clientUpdatedAt || c.cloud.updatedAt) : 0;
          defaults[key] = cloudMs > localMs + 1000 ? 'use_cloud' : 'keep_local';
        }
        _activeState.conflicts = conflicts;
        _activeState.conflictSelections = defaults;
        _activeState.conflictResolve = resolve;
        _renderModalBody();
      })
    });

    const uid = authState.user?.uid || '';
    const updatedOverview = await getManualSyncOverview(uid);

    if (_activeState) {
      _activeState.overview = updatedOverview;
      _activeState.result = res;
    }

    refreshUserMenuSyncBadge();

    if (!res.abortedByUser) {
      emit('library:refresh');

      if (res.deletedOpenNotebook && res.openNotebookId) {
        closeNotebookIfOpen(res.openNotebookId);
        document.getElementById('libraryView')?.classList.remove('hidden');
        showToast('Il quaderno aperto è stato rimosso dal cloud', 'ℹ️');
      } else if (res.updatedOpenNotebook && res.openNotebookId) {
        await openNotebook(res.openNotebookId);
        showToast('Quaderno aperto aggiornato dal cloud', '☁️');
      } else {
        showToast('Sincronizzazione cloud completata', '☁️');
      }
    }
  } catch (err) {
    console.error('[sync] manual cloud sync failed:', err);
    if (_activeState) {
      _activeState.errorInfo = _formatSyncError(err);
    }
    showToast('Sincronizzazione cloud non riuscita', '❌');
  } finally {
    if (_activeState) {
      _activeState.syncing = false;
      _activeState.conflicts = null;
      _activeState.conflictResolve = null;
      _renderModalBody();
    }
  }
}

/**
 * Apre la modale dedicata alla sincronizzazione manuale cloud.
 */
export async function openCloudSyncModal() {
  if (_activeState?.modalCtrl?.isOpen()) return;

  closeAllEditorMenus();

  const overlay = document.createElement('div');
  overlay.id = 'cloudSyncModal';
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[105] flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-lg w-full shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
              <path d="M12 13v6"/>
              <path d="m9.5 15.5 2.5-2.5 2.5 2.5"/>
            </svg>
          </div>
          <div class="min-w-0">
            <h2 class="text-sm font-bold text-slate-900 dark:text-white truncate">Sincronizzazione Cloud</h2>
            <p class="text-[11px] text-slate-500 dark:text-slate-400 truncate">Controllo manuale per ottimizzare i consumi Firebase</p>
          </div>
        </div>
        <button type="button" id="cloudSyncCloseX" aria-label="Chiudi finestra sincronizzazione"
          style="touch-action: manipulation;"
          class="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div id="cloudSyncModalBody" class="p-5"></div>
    </div>
  `;

  const bodyEl = overlay.querySelector('#cloudSyncModalBody');
  const user = authState.user && !authState.user.isAnonymous ? authState.user : null;

  const modalCtrl = openModalOverlay(overlay, {
    id: 'cloudSyncModal',
    ariaLabel: 'Sincronizzazione Cloud',
    onClose: () => {
      if (_activeState?.conflictResolve) {
        _activeState.conflictResolve(null);
      }
      _activeState = null;
    }
  });

  _activeState = {
    overlay,
    bodyEl,
    modalCtrl,
    user,
    overview: null,
    syncing: false,
    progressText: '',
    result: null,
    errorInfo: null,
    conflicts: null,
    conflictSelections: {},
    conflictResolve: null
  };

  overlay.querySelector('#cloudSyncCloseX')?.addEventListener('click', () => {
    if (!_activeState?.syncing && !_activeState?.conflictResolve) {
      modalCtrl.close('close-x');
    }
  });

  _renderModalBody();

  const overview = await getManualSyncOverview(user?.uid || '');
  if (_activeState && _activeState.modalCtrl === modalCtrl) {
    _activeState.overview = overview;
    _renderModalBody();
  }
}
