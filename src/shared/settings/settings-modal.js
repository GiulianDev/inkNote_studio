// ============================================================
// SETTINGS MODULE — si autogestisce (markup + binding + stato)
//
// NOTA v2: rimosso backdrop-blur dal markup per evitare il
// flicker dei canvas delle pagine durante lo scroll del modal.
// Inoltre applichiamo un "paint containment" via classe CSS
// (vedi style.css → #settingsModal) per isolare il repaint
// del modal dal resto della pagina.
//
// NOTA sidebar pagine: il select "settingPagesSidebarPosition"
// aggiorna `pagesSidebar.position` in app-settings. La sidebar
// (feature/pages-sidebar) sottoscrive `settings:changed` e si
// riposiziona automaticamente senza rebuild.
// ============================================================

import { state } from '../core/state.js';
import { showToast, emit } from '../core/utils.js';
import {
  DEFAULT_SETTINGS, getSettings, updateSettings
} from '../core/app-settings.js';
import { closeAllFloatingMenus } from '../components/floating-menu.js';
import { registerModal } from '../components/modal.js';
import {
  getPWAInstallState,
  onPWAStatusChanged,
  resolveSettingsInstallPresentation,
  triggerPWAInstall
} from '../pwa/pwa.js';

import settingsHtml from './settings-modal.html?raw';

let _mounted = false;
let _isOpen  = false;
let _settingsModalCtrl = null;
let _activeTab = 'appearance';
/** @type {typeof DEFAULT_SETTINGS|null} */
let _draftSnapshot = null;

function _ensureModalController() {
  if (_settingsModalCtrl) return _settingsModalCtrl;
  const modal = document.getElementById('settingsModal');
  if (!modal) return null;
  _settingsModalCtrl = registerModal(modal, {
    id: 'settingsModal',
    onClose: () => {
      if (_draftSnapshot) {
        updateSettings(_draftSnapshot, { persist: true });
      }
      _draftSnapshot = null;
      _isOpen = false;
    }
  });
  return _settingsModalCtrl;
}

export function mountSettingsModal() {
  if (_mounted || document.getElementById('settingsModal')) {
    _ensureModalController();
    _mounted = true;
    return;
  }
  document.body.insertAdjacentHTML('beforeend', settingsHtml);
  _ensureModalController();
  _bindAll();
  _mounted = true;
}

function _setActiveSettingsTab(tabId = 'appearance') {
  const validTabs = new Set(['appearance', 'input', 'ink']);
  const nextTab = validTabs.has(tabId) ? tabId : 'appearance';
  _activeTab = nextTab;

  document.querySelectorAll('#settingsModal [data-settings-tab]').forEach((btn) => {
    const isActive = btn.dataset.settingsTab === nextTab;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  document.querySelectorAll('#settingsModal [data-settings-panel]').forEach((panel) => {
    const isVisible = panel.dataset.settingsPanel === nextTab;
    panel.classList.toggle('hidden', !isVisible);
  });

  const body = document.querySelector('#settingsModal .overflow-y-auto');
  if (body) body.scrollTop = 0;
  emit('settings:tab-changed', { tab: nextTab });
}

function _syncSegmentedGroup(groupId, value) {
  const input = document.getElementById(groupId);
  if (input && value != null) input.value = String(value);
  const group = document.querySelector(`#settingsModal [data-seg-group="${groupId}"]`);
  if (!group) return;
  group.querySelectorAll('[data-seg-value]').forEach((btn) => {
    const active = btn.dataset.segValue === String(value);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

function _syncSettingsPwaCard() {
  const btn = document.getElementById('settingsPwaInstallBtn');
  const desc = document.getElementById('settingsPwaStatusDesc');
  if (!btn || !desc) return;

  const ui = resolveSettingsInstallPresentation(getPWAInstallState());
  btn.textContent = ui.label;
  btn.disabled = ui.disabled;
  desc.textContent = ui.description;

  btn.classList.remove(
    'bg-indigo-600', 'hover:bg-indigo-700', 'text-white', 'shadow-sm',
    'bg-white', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-200',
    'border', 'border-slate-300', 'dark:border-slate-600', 'hover:bg-slate-100', 'dark:hover:bg-slate-700',
    'bg-emerald-100', 'dark:bg-emerald-900/40', 'text-emerald-700', 'dark:text-emerald-300'
  );

  if (ui.tone === 'installed') {
    btn.classList.add('bg-emerald-100', 'dark:bg-emerald-900/40', 'text-emerald-700', 'dark:text-emerald-300');
  } else if (ui.tone === 'primary') {
    btn.classList.add('bg-indigo-600', 'hover:bg-indigo-700', 'text-white', 'shadow-sm');
  } else {
    btn.classList.add(
      'bg-white', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-200',
      'border', 'border-slate-300', 'dark:border-slate-600', 'hover:bg-slate-100', 'dark:hover:bg-slate-700'
    );
  }
}

export function openSettingsModal() {
  closeAllFloatingMenus();
  mountSettingsModal();

  if (!_isOpen) {
    _draftSnapshot = { ...getSettings() };
    _isOpen = true;
  }

  const s = getSettings();
  _syncSegmentedGroup('settingTheme', s.theme);
  _syncSegmentedGroup('settingPrintTheme', s.printTheme);
  _syncSegmentedGroup('settingHandedness', s.handedness);
  _syncSegmentedGroup('settingDockSize', s.dockSize);
  _syncSegmentedGroup('settingPagesSidebarPosition', s.pagesSidebar?.position || 'left');

  const autoHideEl = document.getElementById('settingAutoHideDock');
  if (autoHideEl) autoHideEl.checked = !!s.autoHideDock;
  const libTextEl = document.getElementById('settingLibraryShowTextBelow');
  if (libTextEl) libTextEl.checked = !!s.libraryShowTextBelow;
  const fingerEl = document.getElementById('palmRejectionCheck');
  if (fingerEl) fingerEl.checked = s.palmRejection === false;

  _setValue('pressureSensitivitySlider', s.pressureSensitivity);
  _setValue('pressureLightSlider',       s.pressureLight);
  _setValue('pressureHeavySlider',       s.pressureHeavy);
  _setValue('pressureCurveSlider',       s.pressureCurve);
  _setValue('pressureSpeedWeightSlider', s.pressureSpeedWeight);
  _setValue('scrollSensitivitySlider',   s.scrollSensitivity);

  const platformBadge = document.getElementById('inkPlatformBadge');
  if (platformBadge) {
    const plat = state.platform.family;
    platformBadge.textContent = plat === 'ios'
      ? 'Profilo iPad / Apple Pencil'
      : (plat === 'android' ? 'Profilo Android' : 'Profilo Desktop / Surface');
  }

  _refreshLabels();
  _syncSettingsPwaCard();
  _setActiveSettingsTab(_activeTab);

  const ctrl = _ensureModalController();
  const modal = document.getElementById('settingsModal');
  if (!modal || !ctrl) return;
  ctrl.open();
  const body = modal.querySelector('.overflow-y-auto');
  if (body) body.scrollTop = 0;
  emit('settings:modal-opened');
}

export function closeSettingsModal({ cancel = true } = {}) {
  if (!cancel) {
    _draftSnapshot = null;
  }
  const ctrl = _ensureModalController();
  if (ctrl && ctrl.isOpen()) {
    ctrl.close(cancel ? 'programmatic' : 'confirm');
    return;
  }
  if (cancel && _draftSnapshot) {
    updateSettings(_draftSnapshot, { persist: true });
  }
  _draftSnapshot = null;
  _isOpen = false;
}

export function confirmSettings() {
  const s = getSettings();
  const theme        = _getValue('settingTheme')      ?? s.theme;
  const printTheme   = _getValue('settingPrintTheme') ?? s.printTheme;
  const handedness   = _getValue('settingHandedness') ?? s.handedness;
  const dockSize     = _getValue('settingDockSize')   ?? s.dockSize;
  const sidebarPos   = _getValue('settingPagesSidebarPosition') === 'right' ? 'right' : 'left';
  const autoHideEl   = document.getElementById('settingAutoHideDock');
  const autoHideDock = autoHideEl ? !!autoHideEl.checked : !!s.autoHideDock;
  const libTextEl    = document.getElementById('settingLibraryShowTextBelow');
  const libraryShowTextBelow = libTextEl ? !!libTextEl.checked : !!s.libraryShowTextBelow;
  const fingerEl     = document.getElementById('palmRejectionCheck');
  const palmRejection = fingerEl ? !fingerEl.checked : s.palmRejection;

  const pressureSensitivity = _getIntValue('pressureSensitivitySlider', s.pressureSensitivity);
  const pressureLight       = _getIntValue('pressureLightSlider', s.pressureLight);
  const pressureHeavy       = _getIntValue('pressureHeavySlider', s.pressureHeavy);
  const pressureCurve       = _getIntValue('pressureCurveSlider', s.pressureCurve);
  const pressureSpeedWeight = _getIntValue('pressureSpeedWeightSlider', s.pressureSpeedWeight);

  updateSettings({
    theme,
    printTheme,
    handedness,
    dockSize,
    pagesSidebar: { ...s.pagesSidebar, position: sidebarPos },
    autoHideDock,
    libraryShowTextBelow,
    palmRejection,
    pressureSensitivity,
    pressureLight,
    pressureHeavy,
    pressureCurve,
    pressureSpeedWeight
  }, { persist: true });

  closeSettingsModal({ cancel: false });
  showToast('Impostazioni salvate', '⚙️');
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
function _setValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function _getValue(id)    { const el = document.getElementById(id); return el ? el.value : null; }
function _getIntValue(id, fallback) {
  const raw = _getValue(id);
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function _setText(id, v)  { const el = document.getElementById(id); if (el) el.innerText = v; }

function _refreshLabels() {
  const s = getSettings();
  _setText('pressureSensitivityValue', s.pressureSensitivity);
  _setText('pressureLightValue',       s.pressureLight);
  _setText('pressureHeavyValue',       s.pressureHeavy);
  _setText('pressureCurveValue',       s.pressureCurve);
  _setText('pressureSpeedWeightValue', s.pressureSpeedWeight);
  _setText('scrollSensitivityValue',   s.scrollSensitivity);
}

// ------------------------------------------------------------
// BINDING
// ------------------------------------------------------------
let _bound = false;

function _bindAll() {
  if (_bound) return;
  _bound = true;

  document.querySelectorAll('#settingsModal [data-settings-tab]').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      _setActiveSettingsTab(tabBtn.dataset.settingsTab);
    });
  });

  document.querySelectorAll('#settingsModal [data-seg-group]').forEach((groupEl) => {
    const groupId = groupEl.dataset.segGroup;
    groupEl.querySelectorAll('[data-seg-value]').forEach((segBtn) => {
      segBtn.addEventListener('click', () => {
        const val = segBtn.dataset.segValue;
        _syncSegmentedGroup(groupId, val);
        if (groupId === 'settingTheme') {
          updateSettings({ theme: val }, { persist: false });
        } else if (groupId === 'settingPagesSidebarPosition') {
          updateSettings(
            { pagesSidebar: { ...getSettings().pagesSidebar, position: val === 'right' ? 'right' : 'left' } },
            { persist: true }
          );
        }
      });
    });
  });

  document.getElementById('settingAutoHideDock')
    ?.addEventListener('change', (e) => {
      updateSettings({ autoHideDock: !!e.target.checked }, { persist: false });
    });

  document.getElementById('settingLibraryShowTextBelow')
    ?.addEventListener('change', (e) => {
      updateSettings({ libraryShowTextBelow: !!e.target.checked }, { persist: false });
    });

  document.getElementById('palmRejectionCheck')
    ?.addEventListener('change', (e) => {
      updateSettings({ palmRejection: !e.target.checked }, { persist: false });
    });

  [
    'pressureSensitivitySlider',
    'pressureLightSlider',
    'pressureHeavySlider',
    'pressureCurveSlider',
    'pressureSpeedWeightSlider'
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      const s = getSettings();
      updateSettings({
        pressureSensitivity: _getIntValue('pressureSensitivitySlider', s.pressureSensitivity),
        pressureLight:       _getIntValue('pressureLightSlider', s.pressureLight),
        pressureHeavy:       _getIntValue('pressureHeavySlider', s.pressureHeavy),
        pressureCurve:       _getIntValue('pressureCurveSlider', s.pressureCurve),
        pressureSpeedWeight: _getIntValue('pressureSpeedWeightSlider', s.pressureSpeedWeight)
      }, { persist: false });
      _refreshLabels();
    });
  });

  document.getElementById('scrollSensitivitySlider')?.addEventListener('input', (e) => {
    updateSettings({ scrollSensitivity: parseInt(e.target.value, 10) }, { persist: false });
    _setText('scrollSensitivityValue', e.target.value);
  });

  document.getElementById('settingsPwaInstallBtn')?.addEventListener('click', async () => {
    await triggerPWAInstall({ allowBrowserGuide: true });
    _syncSettingsPwaCard();
  });

  onPWAStatusChanged(() => {
    if (_isOpen) _syncSettingsPwaCard();
  });

  document.getElementById('confirmSettingsBtn')?.addEventListener('click', confirmSettings);
  document.getElementById('cancelSettingsBtn') ?.addEventListener('click', () => closeSettingsModal());
  document.getElementById('closeSettingsBtn')  ?.addEventListener('click', () => closeSettingsModal());
  document.getElementById('resetPressureBtn')  ?.addEventListener('click', _resetPressureDefaults);
  document.getElementById('settingsHelpBtn')   ?.addEventListener('click', () => {
    emit('help:open', { tab: 'guide' });
  });
}

function _resetPressureDefaults() {
  updateSettings({
    pressureSensitivity: DEFAULT_SETTINGS.pressureSensitivity,
    pressureLight:       DEFAULT_SETTINGS.pressureLight,
    pressureHeavy:       DEFAULT_SETTINGS.pressureHeavy,
    pressureCurve:       DEFAULT_SETTINGS.pressureCurve,
    pressureSpeedWeight: DEFAULT_SETTINGS.pressureSpeedWeight
  }, { persist: false });
  _setValue('pressureSensitivitySlider', DEFAULT_SETTINGS.pressureSensitivity);
  _setValue('pressureLightSlider',       DEFAULT_SETTINGS.pressureLight);
  _setValue('pressureHeavySlider',       DEFAULT_SETTINGS.pressureHeavy);
  _setValue('pressureCurveSlider',       DEFAULT_SETTINGS.pressureCurve);
  _setValue('pressureSpeedWeightSlider', DEFAULT_SETTINGS.pressureSpeedWeight);
  _refreshLabels();
  showToast('Valori di pressione ripristinati', '↩️');
}