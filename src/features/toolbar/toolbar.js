/**
 * @module features/toolbar/toolbar
 *
 * FEATURE TOOLBAR v2.1 — mainbar + dock contestuali + colori foglio.
 *
 * Aggiunte v2.1:
 *   - popover Foglio con colori custom (paperColor / patternColor)
 *   - updatePaperColor / updatePatternColor / resetPageColors
 *   - applyPageColorsToUI
 */

import './toolbar.css';
import toolbarHtml from './toolbar.html?raw';

import { state } from '../../core/state.js';
import { showToast, hexToRgbA } from '../../core/utils.js';
import { updateSettings } from '../../core/app-settings.js';
import {
  getToolbarSettings, getActiveTool, getActiveToolConfig,
  updateToolbarSettings, getEraserRadius
} from './toolbar-settings.js';
import { changeBackgroundPattern } from '../editor/pages.js';
import { redrawPageCanvas } from '../render/render.js';
import { clearSelection } from '../tools/lazo.js';

let _mounted = false;

// ============================================================
// MENU CONTESTUALE (runtime-only)
// ============================================================

/** @type {'writing'|'selection'|'shapes'|'eraser'|'page'} */
let _mainMenu = 'writing';

const WRITING_TOOLS = ['pen', 'pencil', 'marker', 'highlighter'];

const MENU_TO_DEFAULT_TOOL = {
  writing:   'pen',
  selection: 'lasso',
  shapes:    null,
  eraser:    'eraser',
  page:      null
};

// ============================================================
// MOUNT
// ============================================================

export function mountToolbar() {
  if (_mounted || document.getElementById('mainHeader')) {
    _mounted = true;
    return;
  }
  const mount = document.getElementById('toolbarMount');
  if (!mount) return;
  mount.insertAdjacentHTML('beforebegin', toolbarHtml);
  mount.remove();
  _setupColorPopover();
  _setupMenuOverflow();
  _setupPagePopover();
  _setupDockButtons();
  _setMainMenu('writing', { silent: true });
  _mounted = true;
}

export function refreshPageCounter() {
  const el = document.getElementById('pageCounterText');
  if (el) el.innerText = `Pagina ${state.activePageIndex + 1} di ${state.pages.length}`;
}

// ============================================================
// MENU CONTESTUALE
// ============================================================

export function getMainMenu() { return _mainMenu; }

export function setMainMenu(menu, opts = {}) {
  _setMainMenu(menu, opts);
}

function _setMainMenu(menu, opts = {}) {
  if (!['writing', 'selection', 'shapes', 'eraser', 'page'].includes(menu)) return;

  const defaultTool = MENU_TO_DEFAULT_TOOL[menu];
  if (defaultTool && state.activeTool !== defaultTool) {
    updateToolbarSettings({ activeTool: defaultTool });
  }

  _mainMenu = menu;
  _applyMenuToDOM();

  document.querySelectorAll('.main-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.menu === menu);
  });

  if (menu === 'page') {
    showPagePopover();
  } else {
    hidePagePopover();
  }

  if (!opts.silent) {
    applyActiveToolToUI();
    applySnapTogglesToUI();
    applyEraserLevelToUI();
  }
}

function _applyMenuToDOM() {
  const docks = {
    writing:   document.getElementById('dockWriting'),
    selection: document.getElementById('dockSelection'),
    shapes:    document.getElementById('dockShapes'),
    eraser:    document.getElementById('dockEraser')
  };
  for (const [name, el] of Object.entries(docks)) {
    if (!el) continue;
    el.classList.toggle('hidden', name !== _mainMenu);
  }
  if (_mainMenu !== 'page') hidePagePopover();
}

// ============================================================
// TOOL
// ============================================================

export function setTool(toolName) {
  updateToolbarSettings({ activeTool: toolName });
  clearSelection();

  if (WRITING_TOOLS.includes(toolName)) {
    _mainMenu = 'writing';
  } else if (toolName === 'lasso') {
    _mainMenu = 'selection';
  } else if (toolName === 'eraser') {
    _mainMenu = 'eraser';
  }

  _applyMenuToDOM();
  document.querySelectorAll('.main-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.menu === _mainMenu);
  });

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  });
  const activeBtn = document.getElementById(`btnTool-${toolName}`);
  if (activeBtn) {
    activeBtn.classList.add('active', 'bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  }

  applyActiveToolToUI();
  applyEraserLevelToUI();
  document.dispatchEvent(new CustomEvent('inknote:tool-changed', { detail: { tool: toolName } }));
}

export function applyActiveToolToUI() {
  if (state.activeTool === 'eraser' || state.activeTool === 'lasso') {
    return;
  }

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

  const opacityVal = conf.opacity != null ? conf.opacity : 1.0;
  const opacityEl = document.getElementById('opacityValue');
  if (opacityEl) opacityEl.innerText = `${Math.round(opacityVal * 100)}%`;
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
  _refreshPopoverPreview();
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

export function updateOpacity(val) {
  const raw = parseInt(val);
  const opacity = Math.max(0.1, Math.min(1.0, raw / 100));
  const current = getToolbarSettings();
  const toolName = getActiveTool();
  const tool = current.tools[toolName];
  if (!tool) return;
  updateToolbarSettings({
    tools: { ...current.tools, [toolName]: { ...tool, opacity } }
  });
  _refreshPopoverPreview();
  const opacityEl = document.getElementById('opacityValue');
  if (opacityEl) opacityEl.innerText = `${Math.round(opacity * 100)}%`;
}

// ============================================================
// SNAP TOGGLES (dock Forme)
// ============================================================

export function toggleSnapLines() {
  const next = !getToolbarSettings().snapLines;
  updateToolbarSettings({ snapLines: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Linee dritte: riconoscimento attivo' : 'Linee dritte: riconoscimento disattivato',
    next ? '📏' : '🚫'
  );
}

export function toggleSnapShapes() {
  const next = !getToolbarSettings().snapShapes;
  updateToolbarSettings({ snapShapes: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Forme geometriche: riconoscimento attivo' : 'Forme geometriche: riconoscimento disattivato',
    next ? '◻️' : '🚫'
  );
}

export function applySnapTogglesToUI() {
  const s = getToolbarSettings();
  const linesEl = document.getElementById('snapLinesToggle');
  const shapesEl = document.getElementById('snapShapesToggle');
  if (linesEl)  linesEl.checked  = s.snapLines !== false;
  if (shapesEl) shapesEl.checked = s.snapShapes !== false;
}

// ============================================================
// SMOOTHING
// ============================================================

export function updateSmoothing(val) {
  const intVal = parseInt(val);
  updateToolbarSettings({ smoothing: intVal });
  const label = document.getElementById('smoothingValue');
  if (label) label.innerText = intVal;
}

// ============================================================
// ERASER (dock Gomma)
// ============================================================

export function applyEraserLevelToUI() {
  const lvl = state.eraserSize || 3;
  document.querySelectorAll('.eraser-level-btn').forEach(btn => {
    const isActive = parseInt(btn.dataset.eraserLevel) === lvl;
    btn.classList.toggle('active', isActive);
  });
  const modeEl = document.getElementById('eraserModeSelect');
  if (modeEl) modeEl.value = getToolbarSettings().eraserMode || 'stroke';
}

export function selectEraserLevel(level) {
  const n = Math.max(1, Math.min(5, level));
  updateToolbarSettings({ eraserSize: n });
  applyEraserLevelToUI();
  if (state.activeTool !== 'eraser') setTool('eraser');
  const labels = ['Piccola', 'Medio-piccola', 'Media', 'Medio-grande', 'Grande'];
  showToast(`Gomma: ${labels[n - 1] || 'Media'}`, '🧹');
}

// ============================================================
// PAGE POPOVER (Foglio) — pattern + colori custom
// ============================================================

function _setupPagePopover() {
  document.querySelectorAll('.page-pattern-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      changeBackgroundPattern(btn.dataset.pattern);
      _setActivePatternButton(btn.dataset.pattern);
      hidePagePopover();
      _mainMenu = 'writing';
      _applyMenuToDOM();
      document.querySelectorAll('.main-menu-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.menu === 'writing');
      });
    });
  });

  // Colore foglio (live)
  document.getElementById('pagePaperColorInput')
    ?.addEventListener('input', (e) => updatePaperColor(e.target.value));

  // Colore linee (live)
  document.getElementById('pagePatternColorInput')
    ?.addEventListener('input', (e) => updatePatternColor(e.target.value));

  // Reset ai default del tema
  document.getElementById('pageColorsResetBtn')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetPageColors();
    });
}

/**
 * Imposta il colore del foglio. `null` = default del tema.
 */
export function updatePaperColor(hex) {
  const color = (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) ? hex.toLowerCase() : null;
  updateToolbarSettings({ paperColor: color });
  _redrawAllPagesThrottled();
}

/**
 * Imposta il colore di linee/quadretti/punti. `null` = default del tema.
 */
export function updatePatternColor(hex) {
  const color = (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) ? hex.toLowerCase() : null;
  updateToolbarSettings({ patternColor: color });
  _redrawAllPagesThrottled();
}

/**
 * Ripristina entrambi i colori al default del tema.
 */
export function resetPageColors() {
  updateToolbarSettings({ paperColor: null, patternColor: null });
  applyPageColorsToUI();
  _redrawAllPagesThrottled();
  showToast('Colori foglio: predefiniti del tema', '↺');
}

/**
 * Riflette `state.paperColor` / `state.patternColor` negli input del
 * popover Foglio. `null` = mostra il default corrente del tema.
 */
export function applyPageColorsToUI() {
  const paperInput   = document.getElementById('pagePaperColorInput');
  const patternInput = document.getElementById('pagePatternColorInput');
  if (!paperInput || !patternInput) return;

  const isDark = state.isDarkMode;
  const defaultPaper   = isDark ? '#1e293b' : '#ffffff';
  const defaultPattern = isDark ? '#475569' : '#cbd5e1';

  paperInput.value   = state.paperColor   || defaultPaper;
  patternInput.value = state.patternColor || defaultPattern;
}

let _redrawRaf = null;
function _redrawAllPagesThrottled() {
  if (_redrawRaf !== null) return;
  _redrawRaf = requestAnimationFrame(() => {
    _redrawRaf = null;
    state.pages.forEach(p => {
      if (p.canvas) redrawPageCanvas(p);
    });
  });
}

export function showPagePopover() {
  const popover = document.getElementById('pagePopover');
  if (!popover) return;
  _setActivePatternButton(state.bgPattern);
  applyPageColorsToUI();
  popover.classList.remove('hidden');
}

export function hidePagePopover() {
  const popover = document.getElementById('pagePopover');
  if (popover) popover.classList.add('hidden');
}

function _setActivePatternButton(pattern) {
  document.querySelectorAll('.page-pattern-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pattern === pattern);
  });
}

/**
 * Riflette `state.bgPattern` nel bottone attivo del popover Foglio.
 * Chiamata da `editor.js` all'apertura di un notebook.
 */
export function applyBgPatternToUI() {
  _setActivePatternButton(state.bgPattern);
}

// ============================================================
// MENU ⋯ (overflow)
// ============================================================

let _toolbarMenuOpen = false;

function _setupMenuOverflow() {
  const btn = document.getElementById('toolbarMenuBtn');
  const backdrop = document.getElementById('toolbarMenuBackdrop');
  if (!btn || !backdrop) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleToolbarMenu();
  });

  backdrop.addEventListener('click', _closeToolbarMenu);

  document.addEventListener('pointerdown', (e) => {
    if (!_toolbarMenuOpen) return;
    const panel = document.getElementById('toolbarMenuPanel');
    const button = document.getElementById('toolbarMenuBtn');
    if (!panel || !button) return;
    if (panel.contains(e.target) || button.contains(e.target)) return;
    _closeToolbarMenu();
  });
}

function _toggleToolbarMenu() {
  if (_toolbarMenuOpen) _closeToolbarMenu();
  else _openToolbarMenu();
}

function _openToolbarMenu() {
  const panel = document.getElementById('toolbarMenuPanel');
  const backdrop = document.getElementById('toolbarMenuBackdrop');
  if (!panel || !backdrop) return;

  panel.classList.add('open');
  backdrop.classList.add('open');
  _positionMenuPanel();
  _toolbarMenuOpen = true;
}

function _closeToolbarMenu() {
  const panel = document.getElementById('toolbarMenuPanel');
  const backdrop = document.getElementById('toolbarMenuBackdrop');
  if (!panel || !backdrop) return;

  panel.classList.remove('open');
  backdrop.classList.remove('open');
  _toolbarMenuOpen = false;
}

function _positionMenuPanel() {
  const btn = document.getElementById('toolbarMenuBtn');
  const panel = document.getElementById('toolbarMenuPanel');
  if (!btn || !panel) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;

  const r = btn.getBoundingClientRect();
  const pw = panel.offsetWidth || 260;
  const ph = panel.offsetHeight || 260;

  let left = r.right - pw;
  left = Math.max(margin, Math.min(vw - pw - margin, left));

  let top = r.bottom + 6;
  if (top + ph > vh - margin) {
    const above = r.top - ph - 6;
    if (above >= margin) top = above;
    else top = Math.max(margin, Math.min(vh - ph - margin, top));
  }

  panel.style.left = `${left}px`;
  panel.style.top  = `${top}px`;
}

// ============================================================
// DOCK BUTTONS
// ============================================================

function _setupDockButtons() {
  ['pen', 'pencil', 'marker', 'highlighter'].forEach(name => {
    const btn = document.getElementById(`btnTool-${name}`);
    if (!btn) return;
    btn.addEventListener('click', () => setTool(name));
  });

  document.querySelectorAll('.eraser-level-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lvl = parseInt(btn.dataset.eraserLevel);
      if (lvl >= 1 && lvl <= 5) selectEraserLevel(lvl);
    });
  });

  document.getElementById('snapLinesToggle')
    ?.addEventListener('change', toggleSnapLines);
  document.getElementById('snapShapesToggle')
    ?.addEventListener('change', toggleSnapShapes);

  document.getElementById('opacityBtn')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      showColorPickerPopover(e.currentTarget);
    });
}

// ============================================================
// COLOR PICKER POPOVER
// ============================================================

function _refreshPopoverPreview() {
  const preview = document.getElementById('colorPickerPreview');
  if (!preview) return;
  const conf = getActiveToolConfig();
  const opacity = conf.opacity != null ? conf.opacity : 1.0;
  const rgba = hexToRgbA(conf.color, opacity);
  preview.style.backgroundColor = rgba;
  preview.style.color = (conf.color === '#FFFFFF' || conf.color === '#ffffff') ? '#000' : '#fff';
  preview.textContent = `${conf.color.toUpperCase()} · ${Math.round(opacity * 100)}%`;
}

function _populatePopoverForActiveTool() {
  const conf = getActiveToolConfig();
  const colorPicker = document.getElementById('popoverColorPicker');
  const opacitySlider = document.getElementById('popoverOpacitySlider');
  const opacityLabel = document.getElementById('popoverOpacityValue');
  const swatches = document.getElementById('popoverHighlighterSwatches');

  if (colorPicker) colorPicker.value = conf.color;
  if (opacitySlider) opacitySlider.value = Math.round((conf.opacity ?? 1.0) * 100);
  if (opacityLabel) opacityLabel.innerText = `${Math.round((conf.opacity ?? 1.0) * 100)}%`;

  if (swatches) {
    const isHL = state.activeTool === 'highlighter';
    swatches.classList.toggle('hidden', !isHL);
    swatches.classList.toggle('flex', isHL);
  }

  _refreshPopoverPreview();
}

export function showColorPickerPopover(triggerEl = null) {
  const popover = document.getElementById('colorPickerPopover');
  const trigger = triggerEl || document.getElementById('customColorPicker');
  if (!popover || !trigger) return;

  _populatePopoverForActiveTool();

  popover.classList.remove('hidden');
  const r = trigger.getBoundingClientRect();
  const mw = popover.offsetWidth || 256;
  const mh = popover.offsetHeight || 260;
  let left = r.left + r.width / 2 - mw / 2;
  let top = r.bottom + 8;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 8;
  left = Math.max(8, Math.min(window.innerWidth - mw - 8, left));
  top = Math.max(8, top);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

export function hideColorPickerPopover() {
  const popover = document.getElementById('colorPickerPopover');
  if (popover) popover.classList.add('hidden');
}

function _setupColorPopover() {
  const trigger = document.getElementById('customColorPicker');
  const popover = document.getElementById('colorPickerPopover');
  if (!trigger || !popover) return;

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showColorPickerPopover();
  });

  document.getElementById('closeColorPickerPopoverBtn')
    ?.addEventListener('click', hideColorPickerPopover);

  const colorPicker = document.getElementById('popoverColorPicker');
  colorPicker?.addEventListener('input', (e) => {
    selectColor(e.target.value, null);
  });

  const opacitySlider = document.getElementById('popoverOpacitySlider');
  const opacityLabel = document.getElementById('popoverOpacityValue');
  opacitySlider?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value);
    if (opacityLabel) opacityLabel.innerText = `${v}%`;
    updateOpacity(v);
  });

  popover.querySelectorAll('[data-popover-color]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectColor(btn.dataset.popoverColor, null);
      _populatePopoverForActiveTool();
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (popover.classList.contains('hidden')) return;
    if (popover.contains(e.target) || trigger.contains(e.target)) return;
    hideColorPickerPopover();
  });
}

// ============================================================
// COMPACT / THEME
// ============================================================

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

export function toggleTheme() {
  const next = state.isDarkMode ? 'light' : 'dark';
  updateSettings({ theme: next });
}