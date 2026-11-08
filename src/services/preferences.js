// ============================================================
// IMPOSTAZIONI (persistenza + logica, senza UI)
// ============================================================

import { state } from '../core/state.js';
import { emit } from '../core/utils.js';

const DEFAULT_SETTINGS = {
  theme: 'auto',
  printTheme: 'light',
  handedness: 'right',
  smoothing: 50,
  subbarVisible: true,
  compactMode: false,
  pressureLight: 10,
  pressureHeavy: 340,
  pressureCurve: 60
};

let _pressureParamsCache = null;

// Callback injection per rompere il ciclo settings ↔ toolbar.
// main.js chiama setDarkModeHandler(setDarkMode) prima di applySettings.
let _applyDarkModeHandler = null;
export function setDarkModeHandler(fn) { _applyDarkModeHandler = fn; }

export function loadSettings() {
  try {
    const saved = localStorage.getItem('inknote_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem('inknote_settings', JSON.stringify(settings));
  _pressureParamsCache = null;
}

export function getPressureParams() {
  if (_pressureParamsCache) return _pressureParamsCache;
  const s = loadSettings();
  _pressureParamsCache = {
    lightMul: (s.pressureLight / 100) * 0.5,
    heavyMul: s.pressureHeavy / 100,
    curve: 0.5 + (s.pressureCurve / 100) * 2.5
  };
  return _pressureParamsCache;
}

export function applySettings(settings) {
  let shouldBeDark = false;
  if (settings.theme === 'dark') shouldBeDark = true;
  else if (settings.theme === 'light') shouldBeDark = false;
  else shouldBeDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (_applyDarkModeHandler) _applyDarkModeHandler(shouldBeDark);

  document.body.classList.toggle('handed-left', settings.handedness === 'left');

  const smoothingValue = typeof settings.smoothing === 'number' ? settings.smoothing : 50;
  state.smoothing = smoothingValue / 100;
  const slider = document.getElementById('smoothingSlider');
  const label  = document.getElementById('smoothingValue');
  if (slider) slider.value = smoothingValue;
  if (label) label.innerText = smoothingValue;

  state.subbarVisible = settings.subbarVisible !== false;
  const subbar = document.getElementById('subbar');
  if (subbar) subbar.classList.toggle('collapsed', !state.subbarVisible);

  state.compactMode = !!settings.compactMode;
  document.body.classList.toggle('compact-mode', state.compactMode);
  const exitBtn = document.getElementById('compactExitBtn');
  if (exitBtn) {
    exitBtn.classList.remove('hidden');
    exitBtn.title = state.compactMode ? 'Esci da schermo intero' : 'Schermo intero';
  }
  const expandIcon = document.getElementById('compactIconExpand');
  const reduceIcon = document.getElementById('compactIconReduce');
  if (expandIcon) expandIcon.style.display = state.compactMode ? '' : 'none';
  if (reduceIcon) reduceIcon.style.display = state.compactMode ? 'none' : '';

  _updateSubbarExpandBtnVisibility();

  emit('settings:changed', settings);
}

function _updateSubbarExpandBtnVisibility() {
  const expandBtn = document.getElementById('subbarExpandBtn');
  const collapseBtn = document.getElementById('subbarCollapseBtn');
  if (expandBtn) {
    const showExpand = !state.subbarVisible && !state.compactMode;
    expandBtn.classList.toggle('hidden', !showExpand);
  }
  if (collapseBtn) {
    const showCollapse = state.subbarVisible && !state.compactMode;
    collapseBtn.classList.toggle('hidden', !showCollapse);
  }
}

export function initSettingsListeners() {
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      const s = loadSettings();
      if (s.theme === 'auto' && _applyDarkModeHandler) {
        _applyDarkModeHandler(e.matches);
      }
    });
  }
}

export { DEFAULT_SETTINGS };