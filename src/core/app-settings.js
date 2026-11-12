/**
 * @module core/app-settings
 *
 * STORE IMPOSTAZIONI GLOBALI (cross-notebook).
 *
 * Persistenza: localStorage, chiave `inknote_settings`.
 * Contiene: theme, printTheme, handedness, dockSize, pressure*,
 *           scrollSensitivity, palmRejection.
 *
 * NON contiene le impostazioni della toolbar (colore/spessore/
 * smoothing/…): quelle vivono in `features/toolbar/toolbar-settings.js`
 * perché sono per-notebook.
 *
 * API:
 *   - initSettings()        — idempotente, applica tema/dock/handedness al DOM
 *   - getSettings()         — accessor O(1), oggetto in memoria
 *   - updateSettings(partial, {persist?: boolean}) — persiste + sync + emit
 *   - onSettingsChanged(fn) — subscribe event bus
 *   - getPressureParams()   — derivato puro (curve/light/heavy → moltiplicatori)
 *   - getScrollSensitivity() — derivato puro (slider 0..100 → 0.2..2.0)
 *
 * Side effects di updateSettings():
 *   - scrive localStorage (se persist !== false)
 *   - scrive state.isDarkMode, state.palmRejection, state.settings (freeze)
 *   - applica classi CSS al body (dark, handed-left, data-dock-size)
 *   - emette `settings:changed`
 *
 * @see core/types.js  — AppSettings
 * @see features/toolbar/toolbar-settings.js
 */

import { state } from './state.js';
import { emit, on } from './utils.js';

const STORAGE_KEY = 'inknote_settings';

export const DEFAULT_SETTINGS = {
  theme: 'auto',              // 'auto' | 'light' | 'dark'
  printTheme: 'light',        // 'light' | 'dark'
  handedness: 'right',        // 'right' | 'left'
  dockSize: 'medium',         // 'small' | 'medium' | 'large'
  pressureLight: 10,          // 0..100
  pressureHeavy: 340,         // 100..500
  pressureCurve: 60,          // 0..100
  scrollSensitivity: 50,      // 0..100
  palmRejection: true         // palm rejection globale
};

/** @type {typeof DEFAULT_SETTINGS|null} */
let _current = null;

// ------------------------------------------------------------
// Persistenza
// ------------------------------------------------------------
function _readFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function _writeToStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_current)); } catch {}
}

// ------------------------------------------------------------
// Derivazioni (valori "caldi" dello state, tema effettivo)
// ------------------------------------------------------------
function _computeIsDark(settings) {
  if (settings.theme === 'dark')  return true;
  if (settings.theme === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function _syncRuntime(settings) {
  // Cache in `state` per letture O(1) nel hot path (render/input).
  // `state.settings` è uno snapshot read-only dell'oggetto completo:
  // Object.freeze impedisce scritture accidentali (state.settings.x = ...).
  state.isDarkMode    = _computeIsDark(settings);
  state.palmRejection = settings.palmRejection !== false;
  state.settings      = Object.freeze({ ...settings });
}

// ------------------------------------------------------------
// Applicazione effetti DOM
// ------------------------------------------------------------
function _applyThemeToDOM(isDark) {
  document.body.classList.toggle('dark', isDark);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerText = isDark ? '☀️' : '🌙';
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

/**
 * Inizializza lo store. Idempotente: chiamate successive non fanno nulla.
 * Va chiamato una sola volta all'avvio, prima di qualsiasi getSettings().
 */
export function initSettings() {
  if (_current) return _current;

  _current = _readFromStorage();
  _syncRuntime(_current);
  _applyThemeToDOM(state.isDarkMode);
  _applyHandednessToDOM(_current.handedness);
  _applyDockSizeToDOM(_current.dockSize);

  // Segui prefers-color-scheme SOLO quando theme === 'auto'
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

/**
 * Accessor sincrono: O(1), legge dalla variabile in memoria.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function getSettings() {
  if (!_current) initSettings();
  return _current;
}

/**
 * Aggiorna una o più impostazioni.
 * @param {Partial<typeof DEFAULT_SETTINGS>} partial
 * @param {{silent?: boolean, persist?: boolean}} [opts]
 *   - silent:  non emette `settings:changed` (raro; normalmente sempre false)
 *   - persist: se `false`, NON scrive su localStorage. Usato dalla modale
 *              impostazioni per l'anteprima live: `state` e DOM vengono
 *              aggiornati, ma nessun commit finché l'utente non preme Salva.
 *              Default: true.
 */
export function updateSettings(partial, opts = {}) {
  if (!_current) initSettings();

  const before = _current;
  _current = { ..._current, ...partial };

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

/** Subscribe tipizzata (wrapper di `on`). */
export function onSettingsChanged(fn) {
  return on('settings:changed', fn);
}

// ------------------------------------------------------------
// Derivati puri
// ------------------------------------------------------------

// Cache dei parametri pressione. Invalidata automaticamente quando
// pressioneLight/Heavy/Curve cambiano (key cambia → cache miss).
// Evita di allocare un oggetto per ogni punto nel hot path di
// computeStrokeWidth (2 allocazioni per punto → 1000 per stroke 500pt).
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

/**
 * Slider 0-100 → moltiplicatore 0.2x-2.0x.
 *   0 → 0.2x · 25 → 0.5x · 50 → 1.0x · 75 → 1.5x · 100 → 2.0x
 */
export function getScrollSensitivity() {
  const s = _current || getSettings();
  const v = (typeof s.scrollSensitivity === 'number') ? s.scrollSensitivity : 50;
  return Math.max(0.2, v / 50);
}