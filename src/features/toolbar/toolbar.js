/**
 * @module features/toolbar/toolbar
 *
 * FEATURE TOOLBAR v2.2 — mainbar + dock contestuali + colori foglio
 *                          + drag&drop mainbar (long-press).
 *
 * Interazione mainbar:
 *   - Long-press (450ms) su un .main-menu-btn → drag mode
 *   - Trascina orizzontale → riordina
 *   - Trascina giù (sotto la mainbar) → nasconde (con regole min 3 + no attivo)
 *   - Le modalità nascoste appaiono nel menu ⋯ con bottoni "Mostra X"
 *
 * NOTA drag: i listener pointermove/up sono su document (non sul bottone)
 * e NON usiamo setPointerCapture. Motivo: durante il drag, per riordinare
 * chiamiamo insertBefore(), che rimuove e reinserisce il nodo nel DOM.
 * La spec Pointer Events dice che rimuovere un elemento con pointer capture
 * attivo lo rilascia automaticamente → i pointermove successivi non
 * arriverebbero più al bottone e il drag si bloccherebbe dopo il primo move.
 * Con i listener su document il capture non serve e il drag resta stabile.
 */

import './toolbar.css';
import toolbarHtml from './toolbar.html?raw';

import { state } from '../../core/state.js';
import { showToast, hexToRgbA } from '../../core/utils.js';
import {
  updateSettings, getSettings, onSettingsChanged, MAIN_MENU_IDS
} from '../../core/app-settings.js';
import {
  getToolbarSettings, getActiveTool, getActiveToolConfig,
  updateToolbarSettings, getEraserRadius
} from './toolbar-settings.js';
import { changeBackgroundPattern } from '../editor/pages.js';
import { redrawPageCanvas } from '../render/render.js';
import { clearSelection } from '../tools/lazo.js';

let _mounted = false;
let _hintShownThisSession = false;

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

const MENU_META = {
  writing:   { icon: '🖊️', label: 'Scrittura' },
  selection: { icon: '✂️', label: 'Selezione' },
  shapes:    { icon: '◻️', label: 'Forme' },
  eraser:    { icon: '🧹', label: 'Gomma' },
  page:      { icon: '📄', label: 'Foglio' }
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
  _setupMainMenuDrag();
  _setMainMenu('writing', { silent: true });
  applyMainMenuOrderToUI();

  onSettingsChanged(({ changed }) => {
    if (changed.includes('mainMenuOrder') || changed.includes('mainMenuHidden')) {
      applyMainMenuOrderToUI();
      if (_toolbarMenuOpen) _renderOverflowMenu();
    }
  });

  _mounted = true;
}

export function refreshPageCounter() {
  const el = document.getElementById('pageCounterText');
  if (el) el.innerText = `Pagina ${state.activePageIndex + 1} di ${state.pages.length}`;
}

// ============================================================
// PERSONALIZZAZIONE MAINBAR (ordine + nascosti)
// ============================================================

export function applyMainMenuOrderToUI() {
  const mainBar = document.getElementById('mainMenuBar');
  if (!mainBar) return;

  const s = getSettings();
  const order  = s.mainMenuOrder  || MAIN_MENU_IDS;
  const hidden = new Set(s.mainMenuHidden || []);

  order.forEach(menu => {
    const btn = document.getElementById(`menuBtn-${menu}`);
    if (!btn) return;
    const shouldShow = !hidden.has(menu) || menu === _mainMenu;
    btn.style.display = shouldShow ? '' : 'none';
    mainBar.appendChild(btn);
  });
}

// --- Drag & drop sulla mainbar ---

const DRAG_LONG_PRESS_MS = 450;
const DRAG_MOVE_CANCEL_PX = 8;
const DRAG_HIDE_THRESHOLD_PX = 40;

const _drag = {
  btn: null,
  pointerId: null,
  startX: 0,
  startY: 0,
  pressTimer: null,
  isDragging: false,
  skipNextClick: false,
  outside: false
};

function _setupMainMenuDrag() {
  const mainBar = document.getElementById('mainMenuBar');
  if (!mainBar) return;

  // Blocca il click "di uscita dal drag" in capture, prima che
  // arrivi al listener di ui-bindings.js (bubbling).
  mainBar.addEventListener('click', (e) => {
    if (_drag.skipNextClick) {
      e.stopPropagation();
      e.preventDefault();
      _drag.skipNextClick = false;
    }
  }, true);

  mainBar.addEventListener('pointerdown', _onMenuPointerDown);
}

function _onMenuPointerDown(e) {
  const btn = e.target.closest('.main-menu-btn');
  if (!btn) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  _cancelDragPress();
  _detachDragListeners();

  _drag.btn = btn;
  _drag.pointerId = e.pointerId;
  _drag.startX = e.clientX;
  _drag.startY = e.clientY;
  _drag.isDragging = false;
  _drag.skipNextClick = false;
  _drag.outside = false;

  // NIENTE setPointerCapture: insertBefore() durante il drag
  // rilascerebbe il capture e romperebbe il drag dopo il primo move.
  // I listener stanno su document così sopravvivono al riordino.
  document.addEventListener('pointermove', _onMenuPointerMove);
  document.addEventListener('pointerup',   _onMenuPointerUp);
  document.addEventListener('pointercancel', _onMenuPointerUp);

  _drag.pressTimer = setTimeout(() => {
    _drag.pressTimer = null;
    _enterDragMode(btn);
  }, DRAG_LONG_PRESS_MS);
}

function _cancelDragPress() {
  if (_drag.pressTimer) {
    clearTimeout(_drag.pressTimer);
    _drag.pressTimer = null;
  }
}

function _enterDragMode(btn) {
  _drag.isDragging = true;
  _drag.skipNextClick = true;
  btn.classList.add('dragging');
  document.body.classList.add('menu-dragging');
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }

  if (!_hintShownThisSession) {
    _hintShownThisSession = true;
    showToast('Trascina per riordinare, giù per nascondere', '↔️');
  }
}

function _onMenuPointerMove(e) {
  if (!_drag.btn || e.pointerId !== _drag.pointerId) return;

  if (!_drag.isDragging) {
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    if (Math.hypot(dx, dy) > DRAG_MOVE_CANCEL_PX) {
      _cancelDragPress();
      _detachDragListeners();
      _drag.btn = null;
      _drag.pointerId = null;
    }
    return;
  }

  e.preventDefault();
  const mainBar = document.getElementById('mainMenuBar');
  if (!mainBar) return;
  const rect = mainBar.getBoundingClientRect();

  const isOutside = e.clientY > rect.bottom + DRAG_HIDE_THRESHOLD_PX;
  if (isOutside !== _drag.outside) {
    _drag.outside = isOutside;
    mainBar.classList.toggle('drop-outside', isOutside);
    _drag.btn.classList.toggle('will-hide', isOutside);
  }

  if (!isOutside) {
    _updateDragPosition(e.clientX);
  }
}

function _updateDragPosition(clientX) {
  const btn = _drag.btn;
  const mainBar = document.getElementById('mainMenuBar');
  if (!btn || !mainBar) return;

  const siblings = [...mainBar.querySelectorAll('.main-menu-btn')]
    .filter(b => b !== btn && b.style.display !== 'none');

  const next = siblings.find(el => {
    const r = el.getBoundingClientRect();
    return clientX < r.left + r.width / 2;
  });

  if (next) {
    mainBar.insertBefore(btn, next);
  } else if (siblings.length > 0) {
    const last = siblings[siblings.length - 1];
    mainBar.insertBefore(btn, last.nextSibling);
  }
}

function _onMenuPointerUp(e) {
  if (!_drag.btn || e.pointerId !== _drag.pointerId) return;

  const btn = _drag.btn;
  const wasDragging = _drag.isDragging;
  const wasOutside = _drag.outside;

  _cancelDragPress();
  _detachDragListeners();

  if (wasDragging) {
    btn.classList.remove('dragging', 'will-hide');
    document.body.classList.remove('menu-dragging');
    document.getElementById('mainMenuBar')?.classList.remove('drop-outside');

    if (wasOutside) {
      _tryHideMenu(btn.dataset.menu);
    } else {
      _commitMenuOrder();
    }

    setTimeout(() => { _drag.skipNextClick = false; }, 60);
  }

  _drag.btn = null;
  _drag.pointerId = null;
  _drag.isDragging = false;
  _drag.outside = false;
}

function _detachDragListeners() {
  document.removeEventListener('pointermove', _onMenuPointerMove);
  document.removeEventListener('pointerup',   _onMenuPointerUp);
  document.removeEventListener('pointercancel', _onMenuPointerUp);
}

function _commitMenuOrder() {
  const mainBar = document.getElementById('mainMenuBar');
  if (!mainBar) return;
  const newOrder = [...mainBar.querySelectorAll('.main-menu-btn')]
    .map(b => b.dataset.menu)
    .filter(m => m);
  const current = getSettings().mainMenuOrder || [];
  if (newOrder.join('|') === current.join('|')) return;
  updateSettings({ mainMenuOrder: newOrder }, { persist: true });
}

function _tryHideMenu(menu) {
  if (!MENU_META[menu]) return;
  const s = getSettings();
  const order = s.mainMenuOrder || MAIN_MENU_IDS;
  const hidden = new Set(s.mainMenuHidden || []);

  if (menu === _mainMenu) {
    showToast('La modalità attiva non può essere nascosta', '🔒');
    return;
  }
  if (hidden.has(menu)) return;

  const visibleCount = order.filter(m => !hidden.has(m)).length;
  if (visibleCount <= 3) {
    showToast('Devi tenere almeno 3 modalità visibili', '⚠️');
    return;
  }

  hidden.add(menu);
  updateSettings({ mainMenuHidden: [...hidden] }, { persist: true });
  showToast(`Modalità nascosta: ${MENU_META[menu].label}`, '👁️');
}

// ============================================================
// MENU CONTESTUALE
// ============================================================

export function getMainMenu() { return _mainMenu; }

export function setMainMenu(menu, opts = {}) {
  _setMainMenu(menu, opts);
}

function _setMainMenu(menu, opts = {}) {
  if (!MAIN_MENU_IDS.includes(menu)) return;

  const defaultTool = MENU_TO_DEFAULT_TOOL[menu];
  if (defaultTool && state.activeTool !== defaultTool) {
    updateToolbarSettings({ activeTool: defaultTool });
  }

  _mainMenu = menu;
  _applyMenuToDOM();
  applyMainMenuOrderToUI();

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
  applyMainMenuOrderToUI();

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
// SNAP TOGGLES
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
// ERASER
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
// PAGE POPOVER (Foglio)
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
      applyMainMenuOrderToUI();
      document.querySelectorAll('.main-menu-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.menu === 'writing');
      });
    });
  });

  document.getElementById('pagePaperColorInput')
    ?.addEventListener('input', (e) => updatePaperColor(e.target.value));

  document.getElementById('pagePatternColorInput')
    ?.addEventListener('input', (e) => updatePatternColor(e.target.value));

  document.getElementById('pageColorsResetBtn')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      resetPageColors();
    });
}

export function updatePaperColor(hex) {
  const color = (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) ? hex.toLowerCase() : null;
  updateToolbarSettings({ paperColor: color });
  _redrawAllPagesThrottled();
}

export function updatePatternColor(hex) {
  const color = (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) ? hex.toLowerCase() : null;
  updateToolbarSettings({ patternColor: color });
  _redrawAllPagesThrottled();
}

export function resetPageColors() {
  updateToolbarSettings({ paperColor: null, patternColor: null });
  applyPageColorsToUI();
  _redrawAllPagesThrottled();
  showToast('Colori foglio: predefiniti del tema', '↺');
}

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

export function applyBgPatternToUI() {
  _setActivePatternButton(state.bgPattern);
}

// ============================================================
// MENU ⋯ (overflow) — con sezione "Modalità nascoste"
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

  _renderOverflowMenu();
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

function _renderOverflowMenu() {
  const panel = document.getElementById('toolbarMenuPanel');
  if (!panel) return;

  panel.querySelector('#hiddenMenusSection')?.remove();

  const s = getSettings();
  const order  = s.mainMenuOrder  || MAIN_MENU_IDS;
  const hidden = s.mainMenuHidden || [];
  if (hidden.length === 0) return;

  const section = document.createElement('div');
  section.id = 'hiddenMenusSection';
  section.className = 'menu-section';
  section.innerHTML = `<div class="menu-section-title">Modalità nascoste</div>`;

  const hiddenOrdered = order.filter(m => hidden.includes(m));
  hiddenOrdered.forEach(menu => {
    const meta = MENU_META[menu];
    if (!meta) return;
    const btn = document.createElement('button');
    btn.className = 'menu-item menu-hidden-btn';
    btn.dataset.menu = menu;
    btn.innerHTML = `<span>${meta.icon}</span><span>Mostra ${meta.label}</span>`;
    btn.addEventListener('click', () => {
      _tryShowMenu(menu);
      _renderOverflowMenu();
      if (getSettings().mainMenuHidden.length === 0) _closeToolbarMenu();
    });
    section.appendChild(btn);
  });

  const lastSection = panel.querySelector('.menu-section:last-of-type');
  if (lastSection) panel.insertBefore(section, lastSection);
  else panel.appendChild(section);
}

function _tryShowMenu(menu) {
  const s = getSettings();
  const hidden = new Set(s.mainMenuHidden || []);
  if (!hidden.has(menu)) return;
  hidden.delete(menu);
  updateSettings({ mainMenuHidden: [...hidden] }, { persist: true });
  showToast(`${MENU_META[menu].label} di nuovo visibile`, '👁️');
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