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
import { closeAllEditorMenus } from '../../notebook/toolbar/toolbar.js';
import { openHelpModal } from '../../notebook/shortcuts/shortcuts-modal.js';
import { registerModal } from '../components/modal.js';

import settingsHtml from './settings-modal.html?raw';

let _mounted = false;
let _isOpen  = false;
let _settingsModalCtrl = null;
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

export function openSettingsModal() {
  closeAllEditorMenus();
  mountSettingsModal();

  if (!_isOpen) {
    _draftSnapshot = { ...getSettings() };
    _isOpen = true;
  }

  const s = getSettings();
  _setValue('settingTheme',            s.theme);
  _setValue('settingPrintTheme',       s.printTheme);
  _setValue('settingHandedness',       s.handedness);
  _setValue('settingDockSize',         s.dockSize);
  _setValue('settingPagesSidebarPosition', s.pagesSidebar?.position || 'left');
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
  const printTheme   = _getValue('settingPrintTheme') ?? s.printTheme;
  const handedness   = _getValue('settingHandedness') ?? s.handedness;
  const dockSize     = _getValue('settingDockSize')   ?? s.dockSize;
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
    printTheme,
    handedness,
    dockSize,
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

  document.getElementById('settingTheme')
    ?.addEventListener('change', (e) =>
      updateSettings({ theme: e.target.value }, { persist: false }));

  // Sidebar pagine: la posizione è global e persistita subito.
  // La sidebar (feature/pages-sidebar) sottoscrive `settings:changed`
  // e si riposiziona senza rebuild.
  document.getElementById('settingPagesSidebarPosition')
    ?.addEventListener('change', (e) => {
      const pos = e.target.value === 'right' ? 'right' : 'left';
      updateSettings(
        { pagesSidebar: { ...getSettings().pagesSidebar, position: pos } },
        { persist: true }
      );
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

  document.getElementById('confirmSettingsBtn')?.addEventListener('click', confirmSettings);
  document.getElementById('cancelSettingsBtn') ?.addEventListener('click', () => closeSettingsModal());
  document.getElementById('resetPressureBtn')  ?.addEventListener('click', _resetPressureDefaults);
  document.getElementById('settingsHelpBtn')   ?.addEventListener('click', () => {
    openHelpModal({ tab: 'guide' });
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