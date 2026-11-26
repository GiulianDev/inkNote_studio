/**
 * @module notebook/shortcuts/shortcuts-modal
 *
 * Modale unica "Guida e scorciatoie" apribile:
 *   - dal pulsante `?` dentro Impostazioni (apre su "Guida e trucchi")
 *   - dal tasto `?` da tastiera o dal menu Condividi/Esporta (apre su "Scorciatoie")
 *
 * Usa z-index `z-[120]` (sopra `#settingsModal` `z-[115]`) e si registra su `registerModal`,
 * mantenendo intatte le Impostazioni sottostanti alla chiusura.
 */

import { registerModal, isModalOpen } from '../../shared/components/modal.js';
import { closeAllFloatingMenus } from '../../shared/components/floating-menu.js';
import { detectPlatformInfo } from '../../shared/core/platform.js';
import { state } from '../../shared/core/state.js';
import { escapeHtml } from '../../shared/core/utils.js';
import {
  getAppGuideSections,
  getModifierKeyLabel,
  getShortcutGroups,
  normalizeHelpTab
} from './shortcuts-catalog.js';

const MODAL_ID = 'shortcutsModal';

let _modalEl = null;
let _modalCtrl = null;
let _activeTab = 'shortcuts';

function _renderKbdCap(key) {
  return `<kbd class="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-[11px] font-mono font-semibold leading-tight text-slate-800 dark:text-slate-100 shadow-[0_1px_0_rgba(15,23,42,0.12)]">${escapeHtml(key)}</kbd>`;
}

function _renderCombos(combos) {
  return combos
    .map(combo => {
      const caps = combo
        .map(_renderKbdCap)
        .join('<span class="text-[10px] font-semibold text-slate-400 dark:text-slate-500 mx-0.5">+</span>');
      return `<span class="inline-flex items-center whitespace-nowrap">${caps}</span>`;
    })
    .join('<span class="text-[10px] font-medium text-slate-400 dark:text-slate-500 mx-1">o</span>');
}

function _renderGroupCard(group, { twoColItems = false } = {}) {
  const rowsHtml = group.items.map(item => `
    <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 border-b last:border-b-0 border-slate-100 dark:border-slate-800/80">
      <span class="text-xs font-medium text-slate-700 dark:text-slate-200 leading-snug min-w-0">${escapeHtml(item.label)}</span>
      <span class="flex items-center justify-end flex-wrap gap-y-1 ml-auto">${_renderCombos(item.combos)}</span>
    </li>
  `).join('');

  return `
    <section class="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-3.5 ${twoColItems ? 'md:col-span-2' : ''}">
      <h3 class="text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 mb-2">
        ${escapeHtml(group.title)}
      </h3>
      <ul class="${twoColItems ? 'grid grid-cols-1 sm:grid-cols-2 gap-x-6' : ''}">
        ${rowsHtml}
      </ul>
    </section>
  `;
}

function _renderGuideSectionCard(section) {
  const itemsHtml = section.items.map(item => `
    <li class="py-2 first:pt-0 last:pb-0 border-b last:border-b-0 border-slate-200/70 dark:border-slate-800/80">
      <p class="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-snug">
        ${escapeHtml(item.title)}
      </p>
      <p class="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed mt-0.5">
        ${escapeHtml(item.description)}
      </p>
    </li>
  `).join('');

  return `
    <section class="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-3.5 flex flex-col">
      <div class="flex items-center justify-between gap-2 mb-2.5">
        <h3 class="text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
          ${escapeHtml(section.title)}
        </h3>
        <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100/80 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 shrink-0">
          ${escapeHtml(section.badge)}
        </span>
      </div>
      <ul>
        ${itemsHtml}
      </ul>
    </section>
  `;
}

function _syncTabButtons() {
  if (!_modalEl) return;
  const tabButtons = [
    { id: 'helpTabGuide', tab: 'guide' },
    { id: 'helpTabShortcuts', tab: 'shortcuts' }
  ];

  for (const { id, tab } of tabButtons) {
    const btn = _modalEl.querySelector(`#${id}`);
    if (!btn) continue;
    const isActive = _activeTab === tab;
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.classList.toggle('bg-white', isActive);
    btn.classList.toggle('dark:bg-slate-900', isActive);
    btn.classList.toggle('text-indigo-700', isActive);
    btn.classList.toggle('dark:text-indigo-300', isActive);
    btn.classList.toggle('shadow-sm', isActive);
    btn.classList.toggle('text-slate-600', !isActive);
    btn.classList.toggle('dark:text-slate-400', !isActive);
    btn.classList.toggle('hover:text-slate-900', !isActive);
    btn.classList.toggle('dark:hover:text-slate-200', !isActive);
  }
}

function _refreshModalContent() {
  if (!_modalEl) return;
  const platformInfo = state.platform || detectPlatformInfo();
  const modLabel = getModifierKeyLabel(platformInfo);

  _syncTabButtons();

  const subtitleEl = _modalEl.querySelector('#shortcutsModalSubtitle');
  if (subtitleEl) {
    subtitleEl.textContent = _activeTab === 'guide'
      ? 'Suggerimenti rapidi e funzioni nascoste dell\'app'
      : `Tasti rapidi nell'editor quaderno · Modificatore principale: ${modLabel}`;
  }

  const bodyEl = _modalEl.querySelector('#shortcutsModalBody');
  if (!bodyEl) return;

  if (_activeTab === 'guide') {
    const sections = getAppGuideSections(platformInfo);
    bodyEl.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        ${sections.map(_renderGuideSectionCard).join('')}
      </div>
    `;
  } else {
    const groups = getShortcutGroups(platformInfo);
    const toolsGroup = groups.find(g => g.id === 'tools');
    const editGroup = groups.find(g => g.id === 'edit');
    const viewGroup = groups.find(g => g.id === 'view');

    bodyEl.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        ${toolsGroup ? _renderGroupCard(toolsGroup) : ''}
        ${editGroup ? _renderGroupCard(editGroup) : ''}
        ${viewGroup ? _renderGroupCard(viewGroup, { twoColItems: true }) : ''}
      </div>
    `;
  }

  bodyEl.scrollTop = 0;
}

function _setActiveTab(tab) {
  const next = normalizeHelpTab(tab);
  if (_activeTab === next) return;
  _activeTab = next;
  _refreshModalContent();
}

function _ensureModal() {
  if (_modalEl) return _modalCtrl;

  const wrapper = document.createElement('div');
  wrapper.id = MODAL_ID;
  wrapper.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm hidden items-center justify-center z-[120] p-4';
  wrapper.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-3xl w-full border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[88vh]">
      <div class="px-5 pt-4 pb-3 border-b border-slate-200/80 dark:border-slate-800 space-y-3 shrink-0">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200/70 dark:border-indigo-800/60 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                <path d="M12 17h.01"/>
              </svg>
            </div>
            <div class="min-w-0">
              <h2 class="text-base sm:text-lg font-bold text-slate-900 dark:text-white leading-tight">Guida e scorciatoie</h2>
              <p id="shortcutsModalSubtitle" class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate"></p>
            </div>
          </div>
          <button id="shortcutsModalCloseBtn" type="button" class="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0" title="Chiudi" aria-label="Chiudi">
            <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <div class="inline-flex items-center p-1 rounded-xl bg-slate-100 dark:bg-slate-800/90 border border-slate-200/70 dark:border-slate-700/70 gap-1" role="tablist" aria-label="Sezioni guida">
          <button id="helpTabGuide" type="button" role="tab" aria-selected="false"
            class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer">
            Guida e trucchi
          </button>
          <button id="helpTabShortcuts" type="button" role="tab" aria-selected="true"
            class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer">
            Scorciatoie da tastiera
          </button>
        </div>
      </div>

      <div id="shortcutsModalBody" class="px-5 py-4 overflow-y-auto custom-scrollbar flex-1" style="touch-action: pan-y; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;"></div>

      <div class="px-5 py-3.5 border-t border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 flex items-center justify-between gap-3 shrink-0">
        <p class="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 flex-wrap">
          <span>Premi</span>
          ${_renderKbdCap('?')}
          <span>o</span>
          ${_renderKbdCap('Esc')}
          <span>per chiudere</span>
        </p>
        <button id="shortcutsModalDoneBtn" type="button" class="px-4 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 dark:bg-indigo-600 text-white hover:bg-slate-800 dark:hover:bg-indigo-500 transition-colors shrink-0">
          Chiudi
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(wrapper);
  _modalEl = wrapper;

  _modalCtrl = registerModal(wrapper, {
    id: MODAL_ID,
    ariaLabel: 'Guida e scorciatoie da tastiera',
    initialFocus: '#shortcutsModalCloseBtn'
  });

  wrapper.querySelector('#shortcutsModalCloseBtn')?.addEventListener('click', () => _modalCtrl.close('button'));
  wrapper.querySelector('#shortcutsModalDoneBtn')?.addEventListener('click', () => _modalCtrl.close('button'));
  wrapper.querySelector('#helpTabGuide')?.addEventListener('click', () => _setActiveTab('guide'));
  wrapper.querySelector('#helpTabShortcuts')?.addEventListener('click', () => _setActiveTab('shortcuts'));

  return _modalCtrl;
}

export function isShortcutsModalOpen() {
  return isModalOpen(MODAL_ID);
}

export function openShortcutsModal({ tab = 'shortcuts' } = {}) {
  closeAllFloatingMenus();
  const ctrl = _ensureModal();
  _activeTab = normalizeHelpTab(tab);
  _refreshModalContent();
  ctrl.open();
}

export function openHelpModal({ tab = 'guide' } = {}) {
  openShortcutsModal({ tab });
}

export function closeShortcutsModal() {
  _modalCtrl?.close('programmatic');
}

export function toggleShortcutsModal({ tab = 'shortcuts' } = {}) {
  if (isShortcutsModalOpen()) {
    closeShortcutsModal();
  } else {
    openShortcutsModal({ tab });
  }
}
