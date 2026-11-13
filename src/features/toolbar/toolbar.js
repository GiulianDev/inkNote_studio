/**
 * @module features/toolbar/toolbar
 *
 * FEATURE TOOLBAR — markup + UI + azioni utente.
 *
 * Responsabilità:
 *   - mountToolbar()          — inietta toolbar.html + setup eraser menu
 *   - refreshPageCounter()    — aggiorna "Pagina X di Y" nell'header
 *   - setTool()               — cambia tool attivo + aggiorna UI + event
 *   - selectColor / updateStrokeWidth — cambia config tool attivo
 *   - toggleAutoShape / updateSmoothing / toggleSubbar / toggleCompactMode
 *   - toggleTheme             — delega a updateSettings (tema è globale)
 *   - eraser menu             — show/hide/selectEraserLevel + long-press wiring
 *
 * Non fa: gestire lo stato persistente (delega a toolbar-settings.js) né
 * applicare effetti DOM su #subbar/#mainHeader (delega a toolbar-settings.js
 * via _applySubbarToDOM/_applyCompactToDOM).
 *
 * Eventi emessi: `inknote:tool-changed` su document (per eraser cursor).
 *
 * @see features/toolbar/toolbar-settings.js
 * @see features/toolbar/toolbar.html
 * @see features/toolbar/toolbar.css
 */

import './toolbar.css';
import toolbarHtml from './toolbar.html?raw';

import { state } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import { updateSettings } from '../../core/app-settings.js';
import {
  getToolbarSettings, getActiveTool, getActiveToolConfig,
  updateToolbarSettings, getEraserRadius
} from './toolbar-settings.js';
import { clearSelection } from '../tools/lazo.js';

let _mounted = false;

// ============================================================
// MOUNT — inietta il markup (idempotente)
// ============================================================

/**
 * Inietta il markup della toolbar nel DOM e collega i suoi eventi
 * interni (eraser menu). Idempotente.
 * Va chiamato PRIMA di initSettings() e dei bind degli editor handler,
 * perché initSettings applica tema/dock al DOM e i bind cercano gli
 * id della toolbar (#themeToggleBtn, #subbar, ecc.).
 */
export function mountToolbar() {
  if (_mounted || document.getElementById('mainHeader')) {
    _mounted = true;
    return;
  }
  const mount = document.getElementById('toolbarMount');
  if (!mount) return;

  // insertAdjacentHTML('beforebegin') mantiene l'header/subbar come
  // figli diretti del <body>: i selettori body.compact-mode #mainHeader,
  // body.handed-left header, @media print header continuano a funzionare
  // senza modifiche.
  mount.insertAdjacentHTML('beforebegin', toolbarHtml);
  mount.remove();

  // Setup eventi interni (il markup ora esiste nel DOM)
  _setupEraserButton();

  _mounted = true;
}

// ============================================================
// PAGE COUNTER (ex editor/header.js)
// ============================================================

/**
 * Aggiorna il testo "Pagina X di Y" nell'header.
 * Vive qui perché #pageCounterText è un elemento della toolbar.
 * Chiamata da editor, pages, tools/dispatcher.
 */
export function refreshPageCounter() {
  const el = document.getElementById('pageCounterText');
  if (el) el.innerText = `Pagina ${state.activePageIndex + 1} di ${state.pages.length}`;
}

// ============================================================
// TOOL
// ============================================================

export function setTool(toolName) {
  updateToolbarSettings({ activeTool: toolName });
  clearSelection();

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.remove('bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  });
  const activeBtn = document.getElementById(`btnTool-${toolName}`);
  if (activeBtn) activeBtn.classList.add('bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');

  applyActiveToolToUI();
  document.dispatchEvent(new CustomEvent('inknote:tool-changed', { detail: { tool: toolName } }));
}

/**
 * Sincronizza slider colore/spessore della toolbar con il tool
 * attivo corrente.
 */
export function applyActiveToolToUI() {
  if (state.activeTool === 'eraser' || state.activeTool === 'lasso') return;

  const conf = getActiveToolConfig();
  const swatch = document.querySelector(`.color-swatch[data-color="${conf.color}"]`);
  document.querySelectorAll('.color-swatch').forEach(el =>
    el.classList.remove('ring-2', 'ring-indigo-500', 'scale-105'));
  if (swatch) swatch.classList.add('ring-2', 'ring-indigo-500', 'scale-105');

  const widthSlider = document.getElementById('strokeWidthSlider');
  const widthLabel  = document.getElementById('strokeWidthValue');
  if (widthSlider) widthSlider.value = conf.width;
  if (widthLabel)  widthLabel.innerText = conf.width;

  const picker = document.getElementById('customColorPicker');
  if (picker) picker.value = conf.color;
}

// ============================================================
// COLORS
// ============================================================

const RECENT_COLORS_MAX = 4;
const DEFAULT_COLORS = ['#000000', '#2563eb', '#059669', '#e11d48', '#d97706'];

export function saveRecentColor(colorHex) {
  const color = colorHex.toLowerCase();
  if (DEFAULT_COLORS.includes(color)) return;
  const current = getToolbarSettings();
  if (current.recentColors.includes(color)) return;
  const recent = [color, ...current.recentColors].slice(0, RECENT_COLORS_MAX);
  updateToolbarSettings({ recentColors: recent });
  renderRecentColors();
}

export function renderRecentColors() {
  const container = document.getElementById('recentColorsContainer');
  if (!container) return;
  const recent = getToolbarSettings().recentColors;
  if (recent.length === 0) { container.classList.add('hidden'); container.classList.remove('flex'); return; }
  container.classList.remove('hidden');
  container.classList.add('flex');
  container.innerHTML = '';
  const sep = document.createElement('div');
  sep.className = 'w-px h-4 bg-slate-300 dark:bg-slate-600 mx-0.5 shrink-0';
  container.appendChild(sep);
  recent.forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'w-4 h-4 rounded-full border border-white dark:border-slate-800 cursor-pointer transition hover:scale-110 shrink-0';
    btn.style.backgroundColor = color;
    btn.title = color;
    btn.addEventListener('click', () => selectColor(color, btn));
    container.appendChild(btn);
  });
}

export function selectColor(colorHex, element) {
  if (state.activeTool === 'eraser' || state.activeTool === 'lasso') {
    setTool('pen');
  }
  const current = getToolbarSettings();
  const toolName = getActiveTool();
  const tool = current.tools[toolName];
  updateToolbarSettings({
    tools: { ...current.tools, [toolName]: { ...tool, color: colorHex } }
  });

  document.querySelectorAll('.color-swatch').forEach(el =>
    el.classList.remove('ring-2', 'ring-indigo-500', 'scale-105'));
  if (element && element.classList.contains('color-swatch'))
    element.classList.add('ring-2', 'ring-indigo-500', 'scale-105');

  saveRecentColor(colorHex);
}

export function updateStrokeWidth(val) {
  const width = parseInt(val);
  const current = getToolbarSettings();
  const toolName = getActiveTool();
  const tool = current.tools[toolName];
  if (!tool) return;
  updateToolbarSettings({
    tools: { ...current.tools, [toolName]: { ...tool, width } }
  });
  const label = document.getElementById('strokeWidthValue');
  if (label) label.innerText = width;
}

// ============================================================
// AUTO-SHAPE
// ============================================================

export function toggleAutoShape() {
  const next = !getToolbarSettings().autoShapeEnabled;
  updateToolbarSettings({ autoShapeEnabled: next });
  updateAutoShapeButtonUI();
  showToast(
    next
      ? 'Auto-Forme ATTIVE: le forme disegnate verranno raddrizzate'
      : 'Auto-Forme DISATTIVATE: disegno libero',
    next ? '✨' : '✏️'
  );
}

export function updateAutoShapeButtonUI() {
  const btn = document.getElementById('btnToggleAutoShape');
  if (!btn) return;
  const icon  = document.getElementById('autoShapeIcon');
  const label = document.getElementById('autoShapeLabel');
  const enabled = getToolbarSettings().autoShapeEnabled;
  if (enabled) {
    btn.classList.add('auto-shape-on'); btn.classList.remove('auto-shape-off');
    if (icon)  icon.innerText  = '✨';
    if (label) label.innerText = 'Auto-Forme';
    btn.title = 'Auto-Forme ATTIVE: clicca per disattivare';
  } else {
    btn.classList.remove('auto-shape-on'); btn.classList.add('auto-shape-off');
    if (icon)  icon.innerText  = '🚫';
    if (label) label.innerText = 'Auto-Forme OFF';
    btn.title = 'Auto-Forme DISATTIVATE: clicca per attivare';
  }
}

// ============================================================
// SMOOTHING / SUBBAR / COMPACT
// ============================================================

export function updateSmoothing(val) {
  const intVal = parseInt(val);
  updateToolbarSettings({ smoothing: intVal });
  const label = document.getElementById('smoothingValue');
  if (label) label.innerText = intVal;
}

export function toggleSubbar() {
  updateToolbarSettings({ subbarVisible: !state.subbarVisible });
  setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
}

export function toggleCompactMode() {
  const next = !state.compactMode;
  updateToolbarSettings({ compactMode: next });
  try {
    if (next && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!next && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  } catch {}
  showToast(
    next ? 'Schermo intero attivo' : 'Modalità completa ripristinata',
    next ? '⛶' : '↩️'
  );
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

export function initCompactFullscreenSync() {
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.compactMode) {
      updateToolbarSettings({ compactMode: false });
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  });
}

// ============================================================
// THEME (globale, app-settings)
// ============================================================

export function toggleTheme() {
  const next = state.isDarkMode ? 'light' : 'dark';
  updateSettings({ theme: next });
}

// ============================================================
// ERASER SIZE MENU
// ============================================================

function _saveEraserSize(level) {
  const n = Math.max(1, Math.min(5, level));
  updateToolbarSettings({ eraserSize: n });
}

function _updateEraserMenuUI() {
  const menu = document.getElementById('eraserSizeMenu');
  if (!menu) return;
  const lvl = state.eraserSize || 3;
  menu.querySelectorAll('[data-eraser-level]').forEach(btn => {
    const isActive = parseInt(btn.dataset.eraserLevel) === lvl;
    btn.classList.toggle('ring-2', isActive);
    btn.classList.toggle('ring-indigo-500', isActive);
    btn.classList.toggle('bg-indigo-50', isActive);
    btn.classList.toggle('dark:bg-indigo-900/40', isActive);
  });
}

export function showEraserSizeMenu() {
  const menu = document.getElementById('eraserSizeMenu');
  const btn  = document.getElementById('btnTool-eraser');
  if (!menu || !btn) return;
  menu.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth  || 220;
  const mh = menu.offsetHeight || 56;
  let left = r.left + r.width / 2 - mw / 2;
  let top  = r.top - mh - 10;
  left = Math.max(8, Math.min(window.innerWidth - mw - 8, left));
  top  = Math.max(8, top);
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;
  _updateEraserMenuUI();
}

export function hideEraserSizeMenu() {
  const menu = document.getElementById('eraserSizeMenu');
  if (menu) menu.classList.add('hidden');
}

export function selectEraserLevel(level) {
  _saveEraserSize(level);
  _updateEraserMenuUI();
  hideEraserSizeMenu();
  const labels = ['Piccola', 'Medio-piccola', 'Media', 'Medio-grande', 'Grande'];
  showToast(`Gomma: ${labels[level - 1] || 'Media'}`, '🧹');
}

// ============================================================
// ERASER BUTTON WIRING (interno alla feature)
// ============================================================

function _setupEraserButton() {
  const btn = document.getElementById('btnTool-eraser');
  const menu = document.getElementById('eraserSizeMenu');
  if (!btn || !menu) return;

  let pressTimer = null;
  let skipNextClick = false;

  const cancelTimer = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    skipNextClick = false;
    cancelTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      skipNextClick = true;
      showEraserSizeMenu();
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (err) {} }
    }, 500);
  });

  btn.addEventListener('pointerup', cancelTimer);
  btn.addEventListener('pointercancel', () => { cancelTimer(); skipNextClick = true; });
  btn.addEventListener('pointerleave', cancelTimer);

  btn.addEventListener('click', (e) => {
    if (skipNextClick) { skipNextClick = false; e.preventDefault(); return; }
    setTool('eraser');
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancelTimer();
    showEraserSizeMenu();
  });

  menu.querySelectorAll('[data-eraser-level]').forEach(levelBtn => {
    levelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lvl = parseInt(levelBtn.dataset.eraserLevel);
      if (lvl >= 1 && lvl <= 5) selectEraserLevel(lvl);
      if (state.activeTool !== 'eraser') setTool('eraser');
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    hideEraserSizeMenu();
  });
}