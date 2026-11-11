// ============================================================
// TOOLBAR + SUBBAR + RECENT COLORS
// Le impostazioni (tema, smoothing, subbar, compact) sono
// delegate allo store in core/app-settings.js.
// ============================================================

import { state } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import { getSettings, updateSettings } from '../../core/app-settings.js';
import { clearSelection } from './lasso.js';

// Raggi in pixel canvas (PAGE_WIDTH=794, PAGE_HEIGHT=1123) per livello 1..5.
const ERASER_RADII = [3, 8, 16, 30, 50];
const ERASER_KEY = 'inknote_eraser_size';

const RECENT_COLORS_MAX = 4;
const RECENT_COLORS_KEY = 'inknote_recent_colors';
const DEFAULT_COLORS = ['#000000', '#2563eb', '#059669', '#e11d48', '#d97706'];

// ------------------------------------------------------------
// TOOL
// ------------------------------------------------------------
export function setTool(toolName) {
  state.activeTool = toolName;
  clearSelection();
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.remove('bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  });
  const activeBtn = document.getElementById(`btnTool-${toolName}`);
  if (activeBtn) activeBtn.classList.add('bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  // Notifica input.js di nascondere il cursore gomma (evita ciclo di import)
  document.dispatchEvent(new CustomEvent('inknote:tool-changed', { detail: { tool: toolName } }));
}

// ------------------------------------------------------------
// COLORS
// ------------------------------------------------------------
function loadRecentColors() {
  try {
    const saved = localStorage.getItem(RECENT_COLORS_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (e) { return []; }
}

export function saveRecentColor(colorHex) {
  const color = colorHex.toLowerCase();
  if (DEFAULT_COLORS.includes(color)) return;
  let recent = loadRecentColors();
  if (recent.includes(color)) return;
  recent.unshift(color);
  if (recent.length > RECENT_COLORS_MAX) recent = recent.slice(0, RECENT_COLORS_MAX);
  try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recent)); } catch (e) {}
  renderRecentColors();
}

export function renderRecentColors() {
  const container = document.getElementById('recentColorsContainer');
  if (!container) return;
  const recent = loadRecentColors();
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
  state.currentColor = colorHex;
  document.querySelectorAll('.color-swatch').forEach(el =>
    el.classList.remove('ring-2', 'ring-indigo-500', 'scale-105'));
  if (element && element.classList.contains('color-swatch'))
    element.classList.add('ring-2', 'ring-indigo-500', 'scale-105');
  if (state.activeTool === 'eraser' || state.activeTool === 'lasso') setTool('pen');
  saveRecentColor(colorHex);
}

export function updateStrokeWidth(val) {
  state.strokeWidth = parseInt(val);
  const label = document.getElementById('strokeWidthValue');
  if (label) label.innerText = val;
}

// ------------------------------------------------------------
// AUTO-SHAPE
// ------------------------------------------------------------
export function toggleAutoShape() {
  state.autoShapeEnabled = !state.autoShapeEnabled;
  updateAutoShapeButtonUI();
  showToast(
    state.autoShapeEnabled
      ? 'Auto-Forme ATTIVE: le forme disegnate verranno raddrizzate'
      : 'Auto-Forme DISATTIVATE: disegno libero',
    state.autoShapeEnabled ? '✨' : '✏️'
  );
}

export function updateAutoShapeButtonUI() {
  const btn = document.getElementById('btnToggleAutoShape');
  if (!btn) return;
  const icon  = document.getElementById('autoShapeIcon');
  const label = document.getElementById('autoShapeLabel');
  if (state.autoShapeEnabled) {
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

// ------------------------------------------------------------
// SETTINGS-DRIVEN ACTIONS (tema, smoothing, subbar, compact)
// ------------------------------------------------------------

/**
 * Toggle tema chiaro/scuro. Se eravamo su 'auto' con tema scuro
 * effettivo, andiamo a 'light'; altrimenti 'dark'.
 * La preferenza viene persistita; il tema effettivo lo calcola
 * lo store (_computeIsDark) e lo applica via _applyThemeToDOM.
 */
export function toggleTheme() {
  const next = state.isDarkMode ? 'light' : 'dark';
  updateSettings({ theme: next });
}

export function updateSmoothing(val) {
  const intVal = parseInt(val);
  updateSettings({ smoothing: intVal });
  const label = document.getElementById('smoothingValue');
  if (label) label.innerText = intVal;
}

export function toggleSubbar() {
  updateSettings({ subbarVisible: !state.subbarVisible });
  // Il subbar ha una transizione di 300ms: ricalcola il viewport a fine animazione
  setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
}

export function toggleCompactMode() {
  const next = !state.compactMode;
  updateSettings({ compactMode: next });

  // Sync fullscreen browser con compact (richiede user gesture)
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

/**
 * Se l'utente esce da fullscreen (Esc, F11, gesture OS),
 * riallineiamo lo store (e quindi compactMode) per coerenza.
 */
export function initCompactFullscreenSync() {
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.compactMode) {
      updateSettings({ compactMode: false });
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  });
}

// ------------------------------------------------------------
// ERASER SIZE MENU (long-press / contextmenu sull'icona gomma)
// ------------------------------------------------------------
export function loadEraserSize() {
  try {
    const raw = localStorage.getItem(ERASER_KEY);
    const n = parseInt(raw);
    return (n >= 1 && n <= 5) ? n : 3;
  } catch (e) { return 3; }
}

function _saveEraserSize(level) {
  const n = Math.max(1, Math.min(5, level));
  state.eraserSize = n;
  try { localStorage.setItem(ERASER_KEY, String(n)); } catch (e) {}
}

export function getEraserRadius() {
  const lvl = Math.max(1, Math.min(5, state.eraserSize || 3));
  return ERASER_RADII[lvl - 1];
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