/**
 * @module shared/release/release-modal
 *
 * Modale "Info release & Aggiornamenti" aperta cliccando sull'icona o sul titolo
 * della Libreria. Usa esclusivamente i dati statici incorporati a build-time in
 * `RELEASE_INFO` (nessuna lettura di file esterni a runtime) e include una sezione
 * rapida per segnalare bug su Firestore (senza aprire client email esterni).
 */

import { RELEASE_INFO } from '../core/release-info.js';
import { registerModal } from '../components/modal.js';
import { escapeHtml, showToast } from '../core/utils.js';
import { detectPlatformInfo } from '../core/platform.js';
import { state } from '../core/state.js';
import {
  BUG_DESC_MAX_LENGTH,
  BUG_DESC_MIN_LENGTH,
  evaluateClientAntiSpam,
  submitBugReport
} from './bug-report-service.js';

let _modalEl = null;
let _modalCtrl = null;
let _bugPanelOpen = false;
let _bugPanelOpenedAt = 0;
let _isSubmittingBug = false;
let _notebookCountProvider = null;

export function setReleaseNotebookCountProvider(fn) {
  _notebookCountProvider = typeof fn === 'function' ? fn : null;
}

function _formatInlineMarkdown(text) {
  const safe = escapeHtml(text || '');
  return safe
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-slate-200/75 dark:bg-slate-800 text-[11px] font-mono">$1</code>');
}

function _formatBuildDate(isoOrDate) {
  if (!isoOrDate) return '';
  const dt = new Date(isoOrDate);
  if (Number.isNaN(dt.getTime())) return String(isoOrDate);
  try {
    return new Intl.DateTimeFormat('it-IT', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(dt);
  } catch {
    return isoOrDate.slice(0, 10);
  }
}

export function buildBugReportText(description = '', diagnostics = {}) {
  const desc = String(description || '').trim() || '(Descrivi qui cosa stavi facendo e cosa è successo)';
  const lines = [
    `Segnalazione Bug — InkNote Studio v${diagnostics.version || RELEASE_INFO.version}`,
    '',
    'Descrizione:',
    desc,
    '',
    '--- Diagnostica tecnica ---',
    `Versione: v${diagnostics.version || RELEASE_INFO.version}`,
    `Build: ${diagnostics.builtAt || RELEASE_INFO.builtAt}`,
    `Piattaforma: ${diagnostics.os || 'sconosciuta'} (${diagnostics.viewportClass || 'desktop'})`,
    `Schermo: ${diagnostics.viewport || 'n/d'} (DPR ${diagnostics.dpr || 1})`,
    `Tema: ${diagnostics.theme || 'chiaro'}`,
    `Quaderni locali: ${diagnostics.notebooksCount ?? 'n/d'}`,
    `Browser: ${diagnostics.userAgent || 'n/d'}`
  ];
  return lines.join('\n');
}

function _collectDiagnostics() {
  const p = state.platform || detectPlatformInfo();
  let notebooksCount = 'n/d';
  if (_notebookCountProvider) {
    try {
      const count = _notebookCountProvider();
      if (Number.isFinite(count)) notebooksCount = count;
    } catch {}
  }
  return {
    version: RELEASE_INFO.version,
    builtAt: _formatBuildDate(RELEASE_INFO.builtAt),
    os: p.os,
    viewportClass: p.viewportClass,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    theme: state.isDarkMode ? 'scuro' : 'chiaro',
    notebooksCount,
    userAgent: navigator.userAgent
  };
}

function _renderNotesList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<li class="text-xs text-slate-500 dark:text-slate-400">Nessuna nota registrata per questa build.</li>';
  }
  return items
    .map((item) => `<li class="flex items-start gap-2 text-xs sm:text-[13px] leading-relaxed text-slate-700 dark:text-slate-200"><span class="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" aria-hidden="true"></span><span>${_formatInlineMarkdown(item)}</span></li>`)
    .join('');
}

function _renderPreviousReleases() {
  const releases = Array.isArray(RELEASE_INFO.releases) ? RELEASE_INFO.releases : [];
  const previous = releases.filter((entry) => entry.version !== RELEASE_INFO.notesSourceVersion);
  if (previous.length === 0) return '';

  const itemsHtml = previous.map((rel) => `
    <div class="pt-3 first:pt-0 border-t first:border-t-0 border-slate-200/80 dark:border-slate-800">
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <span class="text-xs font-bold text-slate-800 dark:text-slate-100 tabular-nums">v${escapeHtml(rel.version)}</span>
        ${rel.date ? `<span class="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">${escapeHtml(rel.date)}</span>` : ''}
      </div>
      <ul class="space-y-1.5">
        ${_renderNotesList(rel.items)}
      </ul>
    </div>
  `).join('');

  return `
    <details class="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 px-3.5 py-2.5 group">
      <summary class="flex items-center justify-between cursor-pointer select-none text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
        <span>Versioni precedenti (${previous.length})</span>
        <svg class="w-4 h-4 transition-transform group-open:rotate-180 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="mt-3 space-y-3 max-h-44 overflow-y-auto pr-1">
        ${itemsHtml}
      </div>
    </details>
  `;
}

function _setBugStatusHint(message = '', tone = 'neutral') {
  const hintEl = _modalEl?.querySelector('#releaseBugStatusHint');
  if (!hintEl) return;
  hintEl.textContent = message;
  hintEl.classList.toggle('hidden', !message);
  hintEl.classList.remove('text-rose-600', 'dark:text-rose-400', 'text-emerald-600', 'dark:text-emerald-400', 'text-slate-500', 'dark:text-slate-400');
  if (tone === 'error') {
    hintEl.classList.add('text-rose-600', 'dark:text-rose-400');
  } else if (tone === 'success') {
    hintEl.classList.add('text-emerald-600', 'dark:text-emerald-400');
  } else {
    hintEl.classList.add('text-slate-500', 'dark:text-slate-400');
  }
}

function _syncBugFormState() {
  if (!_modalEl) return;
  const textarea = _modalEl.querySelector('#releaseBugDescription');
  const counterEl = _modalEl.querySelector('#releaseBugCharCounter');
  const submitBtn = _modalEl.querySelector('#releaseSubmitBugBtn');
  const len = (textarea?.value || '').trim().length;

  if (counterEl) {
    counterEl.textContent = `${len}/${BUG_DESC_MAX_LENGTH} · min ${BUG_DESC_MIN_LENGTH}`;
    counterEl.classList.toggle('text-amber-600', len > 0 && len < BUG_DESC_MIN_LENGTH);
    counterEl.classList.toggle('dark:text-amber-400', len > 0 && len < BUG_DESC_MIN_LENGTH);
    counterEl.classList.toggle('text-emerald-600', len >= BUG_DESC_MIN_LENGTH);
    counterEl.classList.toggle('dark:text-emerald-400', len >= BUG_DESC_MIN_LENGTH);
  }

  if (submitBtn) {
    submitBtn.disabled = _isSubmittingBug;
    submitBtn.textContent = _isSubmittingBug ? 'Invio in corso...' : 'Invia segnalazione';
    submitBtn.classList.toggle('opacity-60', _isSubmittingBug);
    submitBtn.classList.toggle('cursor-wait', _isSubmittingBug);
  }
}

function _syncBugPanelVisibility() {
  if (!_modalEl) return;
  const panel = _modalEl.querySelector('#releaseBugReportPanel');
  const toggleBtn = _modalEl.querySelector('#releaseToggleBugBtn');
  if (panel) panel.classList.toggle('hidden', !_bugPanelOpen);
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', _bugPanelOpen ? 'true' : 'false');
  if (_bugPanelOpen) {
    _bugPanelOpenedAt = Date.now();
    const diag = _collectDiagnostics();
    const diagEl = _modalEl.querySelector('#releaseBugDiagnosticsPreview');
    if (diagEl) {
      diagEl.textContent = `v${diag.version} · ${diag.os} (${diag.viewportClass}) · ${diag.viewport} · Quaderni: ${diag.notebooksCount}`;
    }
    _setBugStatusHint('');
    _syncBugFormState();
    _modalEl.querySelector('#releaseBugDescription')?.focus();
  }
}

async function _copyBugReport() {
  const desc = _modalEl?.querySelector('#releaseBugDescription')?.value || '';
  const report = buildBugReportText(desc, _collectDiagnostics());
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(report);
      showToast('Report copiato negli appunti', '📋');
      return;
    }
  } catch {}

  const ta = document.createElement('textarea');
  ta.value = report;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Report copiato negli appunti', '📋');
  } catch {
    showToast('Impossibile copiare automaticamente', '⚠️');
  } finally {
    ta.remove();
  }
}

async function _submitBugReport() {
  if (_isSubmittingBug || !_modalEl) return;

  const textarea = _modalEl.querySelector('#releaseBugDescription');
  const honeypot = _modalEl.querySelector('#releaseBugWebsite');
  const description = textarea?.value || '';
  const honeypotValue = honeypot?.value || '';

  const precheck = evaluateClientAntiSpam({
    description,
    honeypotValue,
    panelOpenedAt: _bugPanelOpenedAt
  });
  if (!precheck.ok) {
    _setBugStatusHint(precheck.message, 'error');
    if (precheck.code === 'too_short' || precheck.code === 'too_long') {
      textarea?.focus();
    }
    return;
  }

  _isSubmittingBug = true;
  _setBugStatusHint('');
  _syncBugFormState();

  try {
    await submitBugReport({
      description,
      diagnostics: _collectDiagnostics(),
      honeypotValue,
      panelOpenedAt: _bugPanelOpenedAt
    });
    if (textarea) textarea.value = '';
    _setBugStatusHint('Segnalazione inviata con successo. Grazie!', 'success');
    showToast('Segnalazione inviata', '✅');
  } catch (err) {
    const msg = err?.message || 'Invio non riuscito. Usa "Copia report".';
    _setBugStatusHint(msg, 'error');
    showToast(msg, '⚠️');
  } finally {
    _isSubmittingBug = false;
    _syncBugFormState();
  }
}

function _ensureModal() {
  if (_modalEl) return _modalCtrl;

  const wrapper = document.createElement('div');
  wrapper.id = 'releaseInfoModal';
  wrapper.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm hidden items-center justify-center z-[80] p-4';
  wrapper.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-lg w-full border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[88vh]">
      <div class="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200/80 dark:border-slate-800">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200/70 dark:border-indigo-800/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>
            </svg>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h2 class="text-base sm:text-lg font-bold text-slate-900 dark:text-white leading-tight">InkNote Studio</h2>
              <span id="releaseModalVersionBadge" class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold tabular-nums bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                v${escapeHtml(RELEASE_INFO.version)}
              </span>
            </div>
            <p id="releaseModalBuildMeta" class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              Build del ${escapeHtml(_formatBuildDate(RELEASE_INFO.builtAt))}
            </p>
          </div>
        </div>
        <button id="releaseModalCloseBtn" type="button" class="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0" title="Chiudi" aria-label="Chiudi">
          <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div class="px-5 py-4 overflow-y-auto flex-1">
        <div class="rounded-xl border border-indigo-200/70 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/25 p-3.5">
          <div class="flex items-center justify-between gap-2 mb-2">
            <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
              Novità v${escapeHtml(RELEASE_INFO.version)}
            </h3>
            ${!RELEASE_INFO.hasExactChangelog && RELEASE_INFO.notesSourceVersion ? `<span class="text-[11px] text-slate-500 dark:text-slate-400">Note da v${escapeHtml(RELEASE_INFO.notesSourceVersion)}</span>` : ''}
          </div>
          <ul class="space-y-2">
            ${_renderNotesList(RELEASE_INFO.currentNotes)}
          </ul>
        </div>

        ${_renderPreviousReleases()}

        <div id="releaseBugReportPanel" class="hidden mt-4 rounded-xl border border-rose-200/80 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/20 p-3.5 space-y-2.5">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs font-bold text-rose-700 dark:text-rose-300">Segnala un problema</h3>
            <span id="releaseBugDiagnosticsPreview" class="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate"></span>
          </div>
          <input id="releaseBugWebsite" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" class="sr-only" placeholder="Non compilare">
          <textarea id="releaseBugDescription" rows="3" maxlength="${BUG_DESC_MAX_LENGTH}" placeholder="Descrivi cosa stavi facendo e il problema riscontrato (min ${BUG_DESC_MIN_LENGTH} caratteri)..." class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"></textarea>
          <div class="flex items-center justify-between gap-2">
            <span id="releaseBugCharCounter" class="text-[11px] font-medium tabular-nums text-slate-500 dark:text-slate-400">0/${BUG_DESC_MAX_LENGTH} · min ${BUG_DESC_MIN_LENGTH}</span>
            <span class="text-[10px] text-slate-400 dark:text-slate-500">Diagnostica inclusa · max 1 ogni 5 min</span>
          </div>
          <p id="releaseBugStatusHint" class="hidden text-[11px] font-medium leading-snug" role="status"></p>
          <div class="flex items-center justify-end gap-2">
            <button id="releaseCopyBugBtn" type="button" class="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              Copia report
            </button>
            <button id="releaseSubmitBugBtn" type="button" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-sm transition-colors">
              Invia segnalazione
            </button>
          </div>
        </div>
      </div>

      <div class="px-5 py-3.5 border-t border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 flex items-center justify-between gap-2">
        <button id="releaseToggleBugBtn" type="button" aria-expanded="false" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-rose-200/70 dark:border-rose-900/50 transition-colors">
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>
            <path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/>
            <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>
          </svg>
          <span>Segnala bug</span>
        </button>
        <button id="releaseModalDoneBtn" type="button" class="px-4 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 dark:bg-indigo-600 text-white hover:bg-slate-800 dark:hover:bg-indigo-500 transition-colors">
          Chiudi
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(wrapper);
  _modalEl = wrapper;

  _modalCtrl = registerModal(wrapper, {
    id: 'releaseInfoModal',
    ariaLabel: 'Informazioni release e aggiornamenti',
    initialFocus: '#releaseModalCloseBtn',
    onClose: () => {
      _bugPanelOpen = false;
      _syncBugPanelVisibility();
    }
  });

  wrapper.querySelector('#releaseModalCloseBtn')?.addEventListener('click', () => _modalCtrl.close('button'));
  wrapper.querySelector('#releaseModalDoneBtn')?.addEventListener('click', () => _modalCtrl.close('button'));
  wrapper.querySelector('#releaseToggleBugBtn')?.addEventListener('click', () => {
    _bugPanelOpen = !_bugPanelOpen;
    _syncBugPanelVisibility();
  });
  wrapper.querySelector('#releaseBugDescription')?.addEventListener('input', () => {
    _setBugStatusHint('');
    _syncBugFormState();
  });
  wrapper.querySelector('#releaseCopyBugBtn')?.addEventListener('click', _copyBugReport);
  wrapper.querySelector('#releaseSubmitBugBtn')?.addEventListener('click', _submitBugReport);

  return _modalCtrl;
}

export function openReleaseModal() {
  const ctrl = _ensureModal();
  _bugPanelOpen = false;
  _syncBugPanelVisibility();
  ctrl.open();
}

export function closeReleaseModal() {
  _modalCtrl?.close('programmatic');
}
