/**
 * @module core/app-settings
 *
 * STORE IMPOSTAZIONI GLOBALI (cross-notebook).
 *
 * Persistenza: localStorage, chiave `inknote_settings`.
 * Contiene: theme, printTheme, handedness, dockSize, pressure*,
 *           scrollSensitivity, palmRejection,
 *           mainMenuOrder, mainMenuHidden (personalizzazione mainbar).
 *
 * NOTA palmRejection / fingerWriting:
 *   La preferenza salvata è `palmRejection` (storico).
 *   `state.fingerWriting` è il derivato (`!palmRejection`) usato
 *   da gestures.js per decidere se 1 dito disegna o fa pan.
 *
 * @see core/types.js  — AppSettings
 * @see features/toolbar/toolbar-settings.js
 */

import { state } from './state.js';
import { emit, on } from './utils.js';

const STORAGE_KEY = 'inknote_settings';

/** Menu validi per la mainbar (allineato a toolbar.js). */
export const MAIN_MENU_IDS = ['writing', 'selection', 'shapes', 'eraser', 'page'];

export const DEFAULT_SETTINGS = {
  theme: 'auto',
  printTheme: 'light',
  handedness: 'right',
  dockSize: 'medium',
  pressureLight: 10,
  pressureHeavy: 340,
  pressureCurve: 60,
  scrollSensitivity: 50,
  palmRejection: true,

  // Personalizzazione mainbar (gestita da toolbar.js, non da UI)
  mainMenuOrder:  ['writing', 'selection', 'shapes', 'eraser', 'page'],
  mainMenuHidden: []   // max 2 (min 3 visibili)
};

/** @type {typeof DEFAULT_SETTINGS|null} */
let _current = null;

// ------------------------------------------------------------
// Normalizzazione
// ------------------------------------------------------------
function _normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS, ...(raw || {}) };

  // mainMenuOrder: array con tutte e 5 le voci, senza duplicati/invalidi
  const seen = new Set();
  const order = [];
  for (const m of (Array.isArray(out.mainMenuOrder) ? out.mainMenuOrder : [])) {
    if (MAIN_MENU_IDS.includes(m) && !seen.has(m)) {
      order.push(m);
      seen.add(m);
    }
  }
  for (const m of MAIN_MENU_IDS) {
    if (!seen.has(m)) order.push(m);
  }
  out.mainMenuOrder = order;

  // mainMenuHidden: array di nomi validi, max 2 (min 3 visibili)
  const hiddenSet = new Set();
  for (const m of (Array.isArray(out.mainMenuHidden) ? out.mainMenuHidden : [])) {
    if (MAIN_MENU_IDS.includes(m) && !hiddenSet.has(m)) hiddenSet.add(m);
  }
  if (hiddenSet.size > 2) {
    const limited = [...hiddenSet].slice(0, 2);
    hiddenSet.clear();
    limited.forEach(m => hiddenSet.add(m));
  }
  out.mainMenuHidden = [...hiddenSet];

  return out;
}

// ------------------------------------------------------------
// Persistenza
// ------------------------------------------------------------
function _readFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return _normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return _normalizeSettings(null);
  }
}

function _writeToStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_current)); } catch {}
}

// ------------------------------------------------------------
// Derivazioni
// ------------------------------------------------------------
function _computeIsDark(settings) {
  if (settings.theme === 'dark')  return true;
  if (settings.theme === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function _syncRuntime(settings) {
  state.isDarkMode    = _computeIsDark(settings);
  state.palmRejection = settings.palmRejection !== false;
  // Derivato: fingerWriting è l'inverso di palmRejection.
  // Letto da gestures.js e dispatcher.js per decidere chi disegna.
  state.fingerWriting = !state.palmRejection;
  state.settings      = Object.freeze({ ...settings });
}

// ------------------------------------------------------------
// Applicazione effetti DOM
// ------------------------------------------------------------
function _applyThemeToDOM(isDark) {
  document.body.classList.toggle('dark', isDark);
  // L'icona sole/luna in #themeToggleBtn è gestita via CSS
  // (regole body.dark #themeToggleBtn .theme-icon-* in toolbar.css).
  // Non serve cambiare innerHTML del bottone.
}

function _applyHandednessToDOM(handedness) {
  document.body.classList.toggle('handed-left', handedness === 'left');
}

function _applyDockSizeToDOM(dockSize) {
  const size = (dockSize === 'small' || dockSize === 'large') ? dockSize : 'medium';
  document.body.dataset.dockSize = size;
}

// ------------------------------------------------------------
// API pubblica
// ------------------------------------------------------------

export function initSettings() {
  if (_current) return _current;

  _current = _readFromStorage();
  _syncRuntime(_current);
  _applyThemeToDOM(state.isDarkMode);
  _applyHandednessToDOM(_current.handedness);
  _applyDockSizeToDOM(_current.dockSize);

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (_current.theme !== 'auto') return;
      const wasDark = state.isDarkMode;
      state.isDarkMode = _computeIsDark(_current);
      if (wasDark !== state.isDarkMode) {
        _applyThemeToDOM(state.isDarkMode);
        emit('settings:changed', {
          changed: ['theme.effective'],
          settings: _current,
          before: _current
        });
      }
    });
  }

  return _current;
}

export function getSettings() {
  if (!_current) initSettings();
  return _current;
}

export function updateSettings(partial, opts = {}) {
  if (!_current) initSettings();

  const before = _current;
  _current = _normalizeSettings({ ..._current, ...partial });

  const wasDark = state.isDarkMode;
  _syncRuntime(_current);

  const shouldPersist = opts.persist !== false;
  if (shouldPersist) _writeToStorage();

  const changed = Object.keys(partial);
  if (changed.includes('theme'))                      _applyThemeToDOM(state.isDarkMode);
  else if (wasDark !== state.isDarkMode)              _applyThemeToDOM(state.isDarkMode);
  if (changed.includes('handedness'))                 _applyHandednessToDOM(_current.handedness);
  if (changed.includes('dockSize'))                   _applyDockSizeToDOM(_current.dockSize);

  if (!opts.silent) emit('settings:changed', { changed, settings: _current, before });
  return _current;
}

export function resetSettings() {
  return updateSettings({ ...DEFAULT_SETTINGS });
}

export function onSettingsChanged(fn) {
  return on('settings:changed', fn);
}

// ------------------------------------------------------------
// Derivati puri
// ------------------------------------------------------------
let _pressureCache = null;
let _pressureCacheKey = '';

export function getPressureParams() {
  const s = _current || getSettings();
  const key = `${s.pressureLight}|${s.pressureHeavy}|${s.pressureCurve}`;
  if (_pressureCacheKey === key) return _pressureCache;

  _pressureCache = {
    lightMul: (s.pressureLight / 100) * 0.5,
    heavyMul: s.pressureHeavy / 100,
    curve:    0.5 + (s.pressureCurve / 100) * 2.5
  };
  _pressureCacheKey = key;
  return _pressureCache;
}

export function getScrollSensitivity() {
  const s = _current || getSettings();
  const v = (typeof s.scrollSensitivity === 'number') ? s.scrollSensitivity : 50;
  return Math.max(0.2, v / 50);
}