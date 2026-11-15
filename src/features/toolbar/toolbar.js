/**
 * @module features/toolbar/toolbar
 *
 * FEATURE TOOLBAR — markup + UI + azioni utente.
 *
 * Layout priority+:
 *   - Ogni elemento ha data-priority (100 = essentials, mai nel panel;
 *     numeri più bassi = meno importanti, primi a essere spostati).
 *   - _layoutToolbar() riporta TUTTI gli opzionali in toolbar, poi
 *     sposta nel panel quelli che non ci stanno (priorità minima prima).
 *   - Se anche gli essentials (pen, lasso, eraser, swatch) non ci stanno,
 *     vengono spostati nel panel con priorità più bassa di menuBtn.
 *     menuBtn non viene MAI spostato: è sempre visibile in toolbar.
 *   - Quando lo spazio aumenta, gli elementi riappaiono uno ad uno
 *     in ordine di priorità.
 *
 * Trigger di _layoutToolbar():
 *   - ResizeObserver su wrapper + toolbar
 *   - window.resize
 *   - MutationObserver su body (data-dock-size, class dark/light)
 *   - document.fonts.ready
 *   - window.load
 *   - Timer di safety a 100ms, 300ms, 600ms, 1000ms dopo il mount
 *   - Chiamata esplicita dopo setTool (cambia la visibilità degli
 *     elementi in base al tool attivo, es. opacity)
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
import { clearSelection } from '../tools/lazo.js';

let _mounted = false;

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
  _setupEraserButton();
  _setupColorPopover();
  _setupResponsiveToolbar();
  _mounted = true;
}

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

  // Il cambio tool può cambiare la visibilità degli elementi
  // (es. opacity diversa nel popover, palette highlighter).
  // Rilayout per sicurezza.
  _requestLayout();
}

export function applyActiveToolToUI() {
  if (state.activeTool === 'eraser' || state.activeTool === 'lasso') {
    _updateCurrentColorSwatch();
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

  _updateCurrentColorSwatch();
}

function _updateCurrentColorSwatch() {
  const el = document.getElementById('currentColorSwatch');
  if (!el) return;
  const conf = getActiveToolConfig();
  el.style.backgroundColor = conf.color;
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
  _updateCurrentColorSwatch();
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
}

// ============================================================
// AUTO-SHAPE / SMOOTHING / SUBBAR / COMPACT / THEME
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

export function toggleTheme() {
  const next = state.isDarkMode ? 'light' : 'dark';
  updateSettings({ theme: next });
}

// ============================================================
// ERASER MENU
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
// RESPONSIVE TOOLBAR (priority+ pattern)
// ============================================================
//
// Bug fix (menuBtn che "non sempre compare"):
//   1. _layoutToolbar() ora è triggerata da più fonti (ResizeObserver
//      wrapper+toolbar, window.resize, MutationObserver su body per
//      data-dock-size e class, document.fonts.ready, window.load,
//      timer multipli 100/300/600/1000ms).
//   2. menuBtn viene mostrato SEMPRE se c'è overflow residuo
//      (anche con panel vuoto), così l'utente ha un punto di
//      accesso anche se gli essentials non ci stanno tutti.
//   3. Se dopo aver spostato tutti gli opzionali la toolbar è
//      ancora in overflow, vengono spostati nel panel anche gli
//      essentials (pen, lasso, eraser, swatch) tranne menuBtn.
//      Così menuBtn non viene MAI tagliato da overflow: hidden.

let _layoutResizeTimer = null;
let _layoutRO = null;
let _layoutSafetyTimers = [];
let _layoutMO = null;
let _toolbarMenuOpen = false;
let _toolbarItemsInOrder = [];
let _layoutRafId = null;

function _requestLayout() {
  if (_layoutRafId !== null) return;
  _layoutRafId = requestAnimationFrame(() => {
    _layoutRafId = null;
    _layoutToolbar();
  });
}

function _setupResponsiveToolbar() {
  const btn = document.getElementById('toolbarMenuBtn');
  const backdrop = document.getElementById('toolbarMenuBackdrop');
  const swatch = document.getElementById('currentColorSwatch');
  if (!btn || !backdrop) return;

  // Snapshot degli opzionali in ordine originale (tutti in toolbar al setup)
  const toolbar = document.getElementById('drawingToolbar');
  if (toolbar) {
    _toolbarItemsInOrder = Array.from(toolbar.querySelectorAll('[data-priority]'))
      .filter(el => parseInt(el.dataset.priority, 10) < 100);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleToolbarMenu();
  });

  backdrop.addEventListener('click', _closeToolbarMenu);

  swatch?.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorPickerPopover(swatch);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!_toolbarMenuOpen) return;
    const panel = document.getElementById('toolbarMenuPanel');
    const button = document.getElementById('toolbarMenuBtn');
    if (!panel || !button) return;
    if (panel.contains(e.target) || button.contains(e.target)) return;
    _closeToolbarMenu();
  });

  // ResizeObserver su wrapper + toolbar
  const wrapper = document.getElementById('toolbarCenterWrapper');
  if (toolbar && wrapper && typeof ResizeObserver !== 'undefined') {
    _layoutRO = new ResizeObserver(() => {
      if (_layoutResizeTimer) clearTimeout(_layoutResizeTimer);
      _layoutResizeTimer = setTimeout(_layoutToolbar, 80);
    });
    _layoutRO.observe(wrapper);
    _layoutRO.observe(toolbar);
  }

  // Fallback e re-check su resize finestra
  window.addEventListener('resize', () => {
    if (_layoutResizeTimer) clearTimeout(_layoutResizeTimer);
    _layoutResizeTimer = setTimeout(_layoutToolbar, 80);
  });

  // MutationObserver: quando cambia data-dock-size o la classe dark
  // sul body, la dimensione dei bottoni cambia ma il wrapper no.
  // Il ResizeObserver non triggera → serve questo observer.
  if (typeof MutationObserver !== 'undefined') {
    _layoutMO = new MutationObserver(() => {
      if (_layoutResizeTimer) clearTimeout(_layoutResizeTimer);
      _layoutResizeTimer = setTimeout(_layoutToolbar, 80);
    });
    _layoutMO.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-dock-size', 'class']
    });
  }

  // Primo layout
  _requestLayout();

  // Re-check dopo il caricamento dei font
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => _requestLayout());
  }

  // Re-check dopo il load completo
  if (document.readyState === 'complete') {
    _requestLayout();
  } else {
    window.addEventListener('load', () => _requestLayout(), { once: true });
  }

  // Safety net: più tentativi per coprire device lenti e reflow
  // successivi al mount (canvas, prediction, ecc.)
  [100, 300, 600, 1000, 2000].forEach(ms => {
    const t = setTimeout(_layoutToolbar, ms);
    _layoutSafetyTimers.push(t);
  });

  _updateCurrentColorSwatch();
}

/**
 * Elementi spostabili nel panel: prima gli opzionali (priority < 100),
 * poi gli essentials in caso di necessità (pen, lasso, eraser, swatch).
 * menuBtn non è MAI spostabile.
 */
function _getMoveableElements(toolbar) {
  const order = [];
  // 1. Opzionali in ordine di priorità crescente (i meno prioritari
  //    vengono spostati per primi)
  const optionals = _toolbarItemsInOrder
    .filter(el => el.parentElement === toolbar)
    .sort((a, b) =>
      parseInt(a.dataset.priority, 10) - parseInt(b.dataset.priority, 10)
    );
  order.push(...optionals);

  // 2. Essentials in ordine di priorità crescente, escluso menuBtn
  const essentials = Array.from(toolbar.querySelectorAll('[data-priority]'))
    .filter(el => {
      const p = parseInt(el.dataset.priority, 10);
      return p >= 100 && el.id !== 'toolbarMenuBtn';
    })
    .sort((a, b) =>
      parseInt(a.dataset.priority, 10) - parseInt(b.dataset.priority, 10)
    );
  order.push(...essentials);

  return order;
}

function _layoutToolbar() {
  const toolbar = document.getElementById('drawingToolbar');
  const panel = document.getElementById('toolbarMenuPanel');
  const menuBtn = document.getElementById('toolbarMenuBtn');
  const swatch = document.getElementById('currentColorSwatch');
  const palette = document.getElementById('colorPalette');
  if (!toolbar || !panel || !menuBtn || !swatch || !palette) return;

  if (toolbar.clientWidth === 0) return;

  // Fase 1: riporta TUTTI gli elementi spostabili in toolbar,
  // in ordine originale, con DocumentFragment.
  // (Include essentials spostati in caso di overflow estremo.)
  if (panel.children.length > 0) {
    const fragment = document.createDocumentFragment();
    // Ordine: opzionali nell'ordine originale di _toolbarItemsInOrder,
    // poi essentials nell'ordine originale del DOM (prima di swatch).
    for (const el of _toolbarItemsInOrder) {
      fragment.appendChild(el);
    }
    // Riporta anche eventuali essentials spostati (escluso menuBtn),
    // nella loro posizione originale (prima di swatch).
    const essentialsMoved = Array.from(panel.querySelectorAll('[data-priority]'))
      .filter(el => parseInt(el.dataset.priority, 10) >= 100);
    for (const el of essentialsMoved) {
      fragment.appendChild(el);
    }
    toolbar.insertBefore(fragment, swatch);
  }

  // Fase 2: while overflow, sposta nel panel l'elemento spostabile
  // con priorità minima. Include essentials in caso di necessità.
  let iterations = 0;
  while (toolbar.scrollWidth > toolbar.clientWidth + 1 && iterations < 40) {
    iterations++;
    const moveable = _getMoveableElements(toolbar);
    const victim = moveable[0];
    if (!victim) break;
    panel.appendChild(victim);
  }

  // Fase 3: currentColorSwatch visibile solo se palette è nel panel
  const paletteInToolbar = palette.parentElement === toolbar;
  swatch.style.display = paletteInToolbar ? 'none' : '';

  // Fase 4: menuBtn visibile SEMPRE se:
  //   - c'è almeno un elemento nel panel, OPPURE
  //   - c'è overflow residuo (toolbar tagliata)
  // Così l'utente ha sempre un punto di accesso quando qualcosa
  // non ci sta, anche se il panel è vuoto (caso limite).
  const overflow = toolbar.scrollWidth > toolbar.clientWidth + 1;
  const shouldShowMenu = panel.children.length > 0 || overflow;
  menuBtn.style.display = shouldShowMenu ? '' : 'none';

  if (!shouldShowMenu && _toolbarMenuOpen) {
    _closeToolbarMenu();
  }

  if (_toolbarMenuOpen) {
    _positionMenuPanel();
  }
}

function _positionMenuPanel() {
  const toolbar = document.getElementById('drawingToolbar');
  const panel = document.getElementById('toolbarMenuPanel');
  if (!toolbar || !panel) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;

  const maxW = Math.min(480, vw - margin * 2);
  const minW = Math.min(260, vw - margin * 2);
  panel.style.width = '';
  panel.style.maxWidth = `${maxW}px`;
  panel.style.minWidth = `${minW}px`;
  panel.style.right = 'auto';

  const panelRect = panel.getBoundingClientRect();
  const toolbarRect = toolbar.getBoundingClientRect();

  let left = toolbarRect.left + toolbarRect.width / 2 - panelRect.width / 2;
  left = Math.max(margin, Math.min(vw - panelRect.width - margin, left));

  let top = toolbarRect.bottom + 8;
  if (top + panelRect.height > vh - margin) {
    const topAbove = toolbarRect.top - panelRect.height - 8;
    if (topAbove >= margin) {
      top = topAbove;
    } else {
      top = Math.max(margin, Math.min(vh - panelRect.height - margin, top));
    }
  }

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function _toggleToolbarMenu() {
  if (_toolbarMenuOpen) _closeToolbarMenu();
  else _openToolbarMenu();
}

function _openToolbarMenu() {
  const panel = document.getElementById('toolbarMenuPanel');
  const backdrop = document.getElementById('toolbarMenuBackdrop');
  if (!panel || !backdrop) return;
  if (panel.children.length === 0) return;

  // Rendi visibile il panel (con visibility hidden) per misurarlo
  panel.style.visibility = 'hidden';
  panel.classList.add('open');
  backdrop.classList.add('open');

  _positionMenuPanel();

  panel.style.visibility = '';
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