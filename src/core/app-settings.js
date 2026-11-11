// ============================================================
// APP SETTINGS STORE
// Sorgente unica di verità per le impostazioni persistenti.
// Carica da localStorage una sola volta all'avvio, mantiene
// l'oggetto in memoria, propaga i cambiamenti via event bus,
// sincronizza i valori "caldi" dello state runtime.
// ============================================================

import { state } from './state.js';
import { emit, on } from './utils.js';

const STORAGE_KEY = 'inknote_settings';

export const DEFAULT_SETTINGS = {
  theme: 'auto',              // 'auto' | 'light' | 'dark'
  printTheme: 'light',        // 'light' | 'dark'
  handedness: 'right',        // 'right' | 'left'
  smoothing: 50,              // 0..100
  subbarVisible: true,
  compactMode: false,
  dockSize: 'medium',         // 'small' | 'medium' | 'large'
  pressureLight: 10,          // 0..100
  pressureHeavy: 340,         // 100..500
  pressureCurve: 60,          // 0..100
  scrollSensitivity: 50       // 0..100
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
// Derivazioni (valori "caldi" dello state, DPR e tema effettivo)
// ------------------------------------------------------------
function _computeIsDark(settings) {
  if (settings.theme === 'dark')  return true;
  if (settings.theme === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function _syncRuntime(settings) {
  // Cache in `state` per letture O(1) nel hot path (render/input).
  // `state.settings` è uno snapshot read-only dell'oggetto completo.
  state.smoothing     = settings.smoothing / 100;
  state.subbarVisible = settings.subbarVisible !== false;
  state.compactMode   = !!settings.compactMode;
  state.isDarkMode    = _computeIsDark(settings);
  state.settings      = settings;
}

// ------------------------------------------------------------
// Applicazione effetti DOM (una funzione per concern)
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

function _applySubbarToDOM(visible) {
  const subbar = document.getElementById('subbar');
  if (subbar) subbar.classList.toggle('collapsed', !visible);

  const expandBtn   = document.getElementById('subbarExpandBtn');
  const collapseBtn = document.getElementById('subbarCollapseBtn');
  if (expandBtn)   expandBtn.classList.toggle('hidden',   visible || state.compactMode);
  if (collapseBtn) collapseBtn.classList.toggle('hidden', !visible || state.compactMode);
}

function _applyCompactToDOM(compact) {
  document.body.classList.toggle('compact-mode', compact);
  const btn = document.getElementById('compactExitBtn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.title = compact ? 'Esci da schermo intero' : 'Schermo intero';
  }
  const expandIcon = document.getElementById('compactIconExpand');
  const reduceIcon = document.getElementById('compactIconReduce');
  if (expandIcon) expandIcon.style.display = compact ? '' : 'none';
  if (reduceIcon) reduceIcon.style.display = compact ? 'none' : '';
}

function _applyAllToDOM(settings) {
  _applyThemeToDOM(_computeIsDark(settings));
  _applyHandednessToDOM(settings.handedness);
  _applyDockSizeToDOM(settings.dockSize);
  _applySubbarToDOM(settings.subbarVisible !== false);
  _applyCompactToDOM(!!settings.compactMode);
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
  _applyAllToDOM(_current);

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

  // Persistenza (disattivabile per l'anteprima live nella modale)
  const shouldPersist = opts.persist !== false;
  if (shouldPersist) _writeToStorage();

  const changed = Object.keys(partial);
  if (changed.includes('theme'))                      _applyThemeToDOM(state.isDarkMode);
  else if (wasDark !== state.isDarkMode)              _applyThemeToDOM(state.isDarkMode);
  if (changed.includes('handedness'))                 _applyHandednessToDOM(_current.handedness);
  if (changed.includes('dockSize'))                   _applyDockSizeToDOM(_current.dockSize);
  if (changed.includes('subbarVisible') ||
      changed.includes('compactMode'))                _applySubbarToDOM(_current.subbarVisible !== false);
  if (changed.includes('compactMode'))                _applyCompactToDOM(!!_current.compactMode);

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
// Derivati puri (nessuna cache manuale: `_current` è già in memoria)
// ------------------------------------------------------------

export function getPressureParams() {
  const s = _current || getSettings();
  return {
    lightMul: (s.pressureLight / 100) * 0.5,
    heavyMul: s.pressureHeavy / 100,
    curve:    0.5 + (s.pressureCurve / 100) * 2.5
  };
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