/**
 * @module features/toolbar/toolbar
 *
 * FEATURE TOOLBAR v2.3 — mainbar + dock contestuali + colori foglio
 *                          + drag&drop mainbar (long-press)
 *                          + stile tratto (solid/dashed/dotted/dash-dot).
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
import { showToast, hexToRgbA, on } from '../../core/utils.js';
import {
  updateSettings, getSettings, onSettingsChanged, MAIN_MENU_IDS, WRITING_TOOL_IDS
} from '../../core/app-settings.js';
import {
  getToolbarSettings, getActiveTool, getActiveToolConfig,
  updateToolbarSettings, getEraserRadius, STROKE_STYLES,
  onToolbarSettingsChanged
} from './toolbar-settings.js';
import { changeBackgroundPattern } from '../editor/pages.js';
import { redrawPageCanvas } from '../render/render.js';
import {
  clearSelection, hasLassoSelection, hasLassoClipboard,
  copySelection, cutSelection, pasteSelection, duplicateSelection, deleteSelection
} from '../tools/lazo.js';
import {
  getActiveTextStyle, getActiveTextBox, applyTextStylePatch,
  editSelectedTextBox, deleteSelectedTextBox, clearTextBoxSelection,
  refocusActiveTextEditorIfEditing, refreshActiveTextEditorTheme
} from '../tools/text.js';
import {
  createDockAutoHideController,
  DEFAULT_WRITING_INACTIVITY_MS
} from './dock-autohide.js';
import {
  initAppFullscreenSync,
  toggleAppFullscreen,
  onAppFullscreenChange
} from '../../core/fullscreen.js';
import {
  createFloatingMenu,
  closeAllFloatingMenus,
  registerExternalMenuCloser
} from '../../components/floating-menu.js';

let _mounted = false;
let _hintShownThisSession = false;

// ============================================================
// MENU CONTESTUALE (runtime-only)
// ============================================================

/** @type {'writing'|'text'|'selection'|'shapes'|'eraser'|'page'} */
let _mainMenu = 'writing';
let _dockCollapsed = false;

const _dockAutoHide = createDockAutoHideController({
  inactivityDelayMs: DEFAULT_WRITING_INACTIVITY_MS,
  enabled: false,
  onVisibilityChange: (hidden) => {
    document.body.classList.toggle('dock-auto-hidden', hidden);
  }
});

const WRITING_TOOLS = ['pen', 'pencil', 'marker', 'highlighter'];
const STYLE_CAPABLE_TOOLS = ['pen', 'pencil', 'marker'];

const MENU_TO_DEFAULT_TOOL = {
  writing:   'pen',
  text:      'text',
  selection: 'lasso',
  shapes:    null,
  eraser:    'eraser',
  page:      null
};

const MENU_META = {
  writing: {
    label: 'Scrittura',
    svg: '<svg class="ui-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>'
  },
  text: {
    label: 'Testo',
    svg: '<svg class="ui-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>'
  },
  selection: {
    label: 'Selezione',
    svg: '<svg class="ui-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>'
  },
  shapes: {
    label: 'Forme',
    svg: '<svg class="ui-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>'
  },
  eraser: {
    label: 'Gomma',
    svg: '<svg class="ui-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>'
  },
  page: {
    label: 'Foglio',
    svg: '<svg class="ui-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>'
  }
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
  registerExternalMenuCloser('colorPopover', hideColorPickerPopover);
  registerExternalMenuCloser('pagePopover', hidePagePopover);
  _setupDockButtons();
  _setupMainMenuDrag();
  _setupWritingToolsDrag();
  _setMainMenu('writing', { silent: true });
  applyMainMenuOrderToUI();
  applyWritingToolsOrderToUI();
  _dockAutoHide.setEnabled(!!getSettings().autoHideDock);

  onSettingsChanged(({ changed }) => {
    if (changed.includes('mainMenuOrder') || changed.includes('mainMenuHidden')) {
      applyMainMenuOrderToUI();
      if (_toolbarMenuCtrl?.isOpen()) _renderOverflowMenu();
    }
    if (changed.includes('writingToolsOrder')) {
      applyWritingToolsOrderToUI();
    }
    if (changed.includes('theme') || changed.includes('theme.effective')) {
      applyPageColorsToUI();
      refreshActiveTextEditorTheme();
    }
    if (changed.includes('autoHideDock') && !getSettings().autoHideDock) {
      setDockDrawingHidden(false, { immediate: true });
    }
  });

  onToolbarSettingsChanged(({ changed }) => {
    if (changed.includes('init') || changed.includes('reset')) {
      _syncToolbarModeToActiveTool();
      return;
    }
    if (changed.includes('text')) {
      applyTextControlsToUI();
    }
    if (changed.includes('lassoMode') || changed.includes('lassoSelectInk') || changed.includes('lassoSelectText')) {
      applyLassoControlsToUI();
    }
  });

  window.addEventListener('inknote:text-selection-changed', () => {
    applyTextControlsToUI();
  });

  window.addEventListener('inknote:selection-changed', (e) => {
    if (e.detail && e.detail.activateLasso && state.activeTool !== 'lasso') {
      _activateLassoKeepingSelection();
    } else {
      applyLassoControlsToUI();
    }
  });

  window.addEventListener('blur', () => {
    setDockDrawingHidden(false, { immediate: true });
  });

  on('history:restore', () => {
    applyBgPatternToUI();
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

export function applyWritingToolsOrderToUI() {
  const group = document.getElementById('writingToolsGroup');
  if (!group) return;

  const s = getSettings();
  const order = s.writingToolsOrder || WRITING_TOOL_IDS;
  order.forEach(tool => {
    const btn = document.getElementById(`btnTool-${tool}`);
    if (btn) group.appendChild(btn);
  });
}

// --- Drag & drop sulla mainbar ---

const DRAG_LONG_PRESS_MS = 450;
const DRAG_MOVE_CANCEL_PX = 10;
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
  try { btn.setPointerCapture?.(_drag.pointerId); } catch {}
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
    try {
      if (btn.hasPointerCapture?.(e.pointerId)) btn.releasePointerCapture(e.pointerId);
    } catch {}
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

// --- Drag & drop ordine strumenti scrittura (#writingToolsGroup) ---

let _toolHintShownThisSession = false;
const _toolDrag = {
  btn: null,
  pointerId: null,
  startX: 0,
  startY: 0,
  pressTimer: null,
  isDragging: false,
  skipNextClick: false
};

function _setupWritingToolsDrag() {
  const group = document.getElementById('writingToolsGroup');
  if (!group) return;

  group.addEventListener('click', (e) => {
    if (_toolDrag.skipNextClick) {
      e.stopPropagation();
      e.preventDefault();
      _toolDrag.skipNextClick = false;
    }
  }, true);

  group.addEventListener('pointerdown', _onWritingToolPointerDown);
}

function _onWritingToolPointerDown(e) {
  const btn = e.target.closest('.dock-tool-btn');
  if (!btn || !btn.dataset.tool) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  _cancelToolDragPress();
  _detachToolDragListeners();

  _toolDrag.btn = btn;
  _toolDrag.pointerId = e.pointerId;
  _toolDrag.startX = e.clientX;
  _toolDrag.startY = e.clientY;
  _toolDrag.isDragging = false;
  _toolDrag.skipNextClick = false;

  document.addEventListener('pointermove', _onWritingToolPointerMove);
  document.addEventListener('pointerup', _onWritingToolPointerUp);
  document.addEventListener('pointercancel', _onWritingToolPointerUp);

  _toolDrag.pressTimer = setTimeout(() => {
    _toolDrag.pressTimer = null;
    _enterToolDragMode(btn);
  }, DRAG_LONG_PRESS_MS);
}

function _cancelToolDragPress() {
  if (_toolDrag.pressTimer) {
    clearTimeout(_toolDrag.pressTimer);
    _toolDrag.pressTimer = null;
  }
}

function _enterToolDragMode(btn) {
  _toolDrag.isDragging = true;
  _toolDrag.skipNextClick = true;
  btn.classList.add('dragging');
  document.body.classList.add('tool-dragging');
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }

  if (!_toolHintShownThisSession) {
    _toolHintShownThisSession = true;
    showToast('Trascina orizzontalmente per riordinare gli strumenti', '↔️');
  }
}

function _onWritingToolPointerMove(e) {
  if (!_toolDrag.btn || e.pointerId !== _toolDrag.pointerId) return;

  if (!_toolDrag.isDragging) {
    const dx = e.clientX - _toolDrag.startX;
    const dy = e.clientY - _toolDrag.startY;
    if (Math.hypot(dx, dy) > DRAG_MOVE_CANCEL_PX) {
      _cancelToolDragPress();
      _detachToolDragListeners();
      _toolDrag.btn = null;
      _toolDrag.pointerId = null;
    }
    return;
  }

  e.preventDefault();
  _updateWritingToolDragPosition(e.clientX);
}

function _updateWritingToolDragPosition(clientX) {
  const btn = _toolDrag.btn;
  const group = document.getElementById('writingToolsGroup');
  if (!btn || !group) return;

  const siblings = [...group.querySelectorAll('.dock-tool-btn')].filter(b => b !== btn);
  const next = siblings.find(el => {
    const r = el.getBoundingClientRect();
    return clientX < r.left + r.width / 2;
  });

  if (next) {
    group.insertBefore(btn, next);
  } else if (siblings.length > 0) {
    const last = siblings[siblings.length - 1];
    group.insertBefore(btn, last.nextSibling);
  }
}

function _onWritingToolPointerUp(e) {
  if (!_toolDrag.btn || e.pointerId !== _toolDrag.pointerId) return;

  const btn = _toolDrag.btn;
  const wasDragging = _toolDrag.isDragging;

  _cancelToolDragPress();
  _detachToolDragListeners();

  if (wasDragging) {
    btn.classList.remove('dragging');
    document.body.classList.remove('tool-dragging');
    _commitWritingToolsOrder();
    setTimeout(() => { _toolDrag.skipNextClick = false; }, 60);
  }

  _toolDrag.btn = null;
  _toolDrag.pointerId = null;
  _toolDrag.isDragging = false;
}

function _detachToolDragListeners() {
  document.removeEventListener('pointermove', _onWritingToolPointerMove);
  document.removeEventListener('pointerup', _onWritingToolPointerUp);
  document.removeEventListener('pointercancel', _onWritingToolPointerUp);
}

function _commitWritingToolsOrder() {
  const group = document.getElementById('writingToolsGroup');
  if (!group) return;
  const newOrder = [...group.querySelectorAll('.dock-tool-btn')]
    .map(b => b.dataset.tool)
    .filter(t => t);
  const current = getSettings().writingToolsOrder || [];
  if (newOrder.join('|') === current.join('|')) return;
  updateSettings({ writingToolsOrder: newOrder }, { persist: true });
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

/**
 * Gestisce la visibilità del dock durante la scrittura (autoHideDock) tramite
 * buffer a stati (`idle` → `writing` → `buffering` → `idle`).
 * Il dock riappare solo se l'attività di scrittura resta inattiva in modo
 * continuativo, oppure subito passando `{ immediate: true }`.
 */
export function setDockDrawingHidden(hidden, { immediate = false } = {}) {
  const autoHideEnabled = !!state.settings?.autoHideDock;
  _dockAutoHide.setEnabled(autoHideEnabled);

  if (hidden && autoHideEnabled) {
    _dockAutoHide.beginWriting();
    return;
  }

  if (immediate || !autoHideEnabled) {
    _dockAutoHide.revealNow();
    return;
  }

  _dockAutoHide.endWriting();
}

const TOOL_TO_MENU = {
  pen: 'writing',
  pencil: 'writing',
  marker: 'writing',
  highlighter: 'writing',
  text: 'text',
  lasso: 'selection',
  eraser: 'eraser'
};

function _syncPageCursorsForActiveTool() {
  const nextCursor = state.activeTool === 'text' ? 'text' : 'crosshair';
  state.pages.forEach(p => {
    if (p && p.canvas) p.canvas.style.cursor = nextCursor;
  });
}

function _syncToolbarModeToActiveTool() {
  _mainMenu = TOOL_TO_MENU[state.activeTool] || 'writing';
  _dockCollapsed = false;
  setDockDrawingHidden(false, { immediate: true });
  hidePagePopover();
  _applyMenuToDOM();
  applyMainMenuOrderToUI();

  document.querySelectorAll('.main-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.menu === _mainMenu);
  });

  applyActiveToolToUI();
  applySnapTogglesToUI();
  applyEraserLevelToUI();
  applyStrokeStyleToUI();
  applyTextControlsToUI();
  applyLassoControlsToUI();
  applyPageColorsToUI();
  _syncPageCursorsForActiveTool();
}

function _activateLassoKeepingSelection() {
  if (state.activeTool === 'text') {
    clearTextBoxSelection();
  }
  updateToolbarSettings({ activeTool: 'lasso' });
  _mainMenu = 'selection';
  _dockCollapsed = false;
  setDockDrawingHidden(false, { immediate: true });
  _applyMenuToDOM();
  applyMainMenuOrderToUI();

  document.querySelectorAll('.main-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.menu === _mainMenu);
  });

  applyActiveToolToUI();
  applyEraserLevelToUI();
  applyStrokeStyleToUI();
  applyTextControlsToUI();
  applyLassoControlsToUI();
  _syncPageCursorsForActiveTool();

  document.dispatchEvent(new CustomEvent('inknote:tool-changed', { detail: { tool: 'lasso' } }));
}

function _setMainMenu(menu, opts = {}) {
  if (!MAIN_MENU_IDS.includes(menu)) return;

  const wasDrawingHidden = _dockAutoHide.isHidden();
  if (!opts.silent) {
    setDockDrawingHidden(false, { immediate: true });
  }

  if (opts.toggle && menu === _mainMenu) {
    _dockCollapsed = wasDrawingHidden ? false : !_dockCollapsed;
  } else {
    _dockCollapsed = false;
  }

  const defaultTool = MENU_TO_DEFAULT_TOOL[menu];
  if (defaultTool && state.activeTool !== defaultTool) {
    if (state.activeTool === 'text' && defaultTool !== 'text') {
      clearTextBoxSelection();
    }
    if (state.activeTool === 'lasso' && defaultTool !== 'lasso') {
      clearSelection();
    }
    updateToolbarSettings({ activeTool: defaultTool });
  }

  _mainMenu = menu;
  _applyMenuToDOM();
  applyMainMenuOrderToUI();

  document.querySelectorAll('.main-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.menu === menu);
  });

  if (menu === 'page' && !_dockCollapsed) {
    showPagePopover();
  } else {
    hidePagePopover();
  }

  if (!opts.silent) {
    applyActiveToolToUI();
    applySnapTogglesToUI();
    applyEraserLevelToUI();
    applyStrokeStyleToUI();
    applyTextControlsToUI();
    applyLassoControlsToUI();
    _syncPageCursorsForActiveTool();
  }
}

function _applyMenuToDOM() {
  const docks = {
    writing:   document.getElementById('dockWriting'),
    text:      document.getElementById('dockText'),
    selection: document.getElementById('dockSelection'),
    shapes:    document.getElementById('dockShapes'),
    eraser:    document.getElementById('dockEraser')
  };
  for (const [name, el] of Object.entries(docks)) {
    if (!el) continue;
    el.classList.toggle('hidden', _dockCollapsed || name !== _mainMenu);
  }
  if (_dockCollapsed || _mainMenu !== 'page') hidePagePopover();
}

// ============================================================
// TOOL
// ============================================================

export function setTool(toolName) {
  if (state.activeTool === 'text' && toolName !== 'text') {
    clearTextBoxSelection();
  }
  updateToolbarSettings({ activeTool: toolName });
  clearSelection();

  if (WRITING_TOOLS.includes(toolName)) {
    _mainMenu = 'writing';
  } else if (toolName === 'text') {
    _mainMenu = 'text';
  } else if (toolName === 'lasso') {
    _mainMenu = 'selection';
  } else if (toolName === 'eraser') {
    _mainMenu = 'eraser';
  }

  _dockCollapsed = false;
  setDockDrawingHidden(false, { immediate: true });
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
  // La riga "Stile" va aggiornata/nascosta anche per eraser/lasso,
  // dove applyActiveToolToUI fa return early. Chiamata esplicita.
  applyStrokeStyleToUI();
  applyTextControlsToUI();
  applyLassoControlsToUI();
  _syncPageCursorsForActiveTool();

  document.dispatchEvent(new CustomEvent('inknote:tool-changed', { detail: { tool: toolName } }));
}

export function applyActiveToolToUI() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  });
  const activeBtn = document.getElementById(`btnTool-${state.activeTool}`);
  if (activeBtn) {
    activeBtn.classList.add('active', 'bg-white', 'dark:bg-slate-700', 'text-indigo-600', 'dark:text-indigo-300', 'shadow-sm');
  }

  if (state.activeTool === 'eraser' || state.activeTool === 'lasso' || state.activeTool === 'text') return;

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

  applyStrokeStyleToUI();
}

// ============================================================
// STILE TRATTO (solid/dashed/dotted/dash-dot)
// ============================================================

export function updateStrokeStyle(style) {
  if (!STROKE_STYLES.includes(style)) return;
  const current = getToolbarSettings();
  const toolName = getActiveTool();
  const tool = current.tools[toolName];
  if (!tool) return;
  updateToolbarSettings({
    tools: { ...current.tools, [toolName]: { ...tool, style } }
  });
  applyStrokeStyleToUI();
}

export function applyStrokeStyleToUI() {
  const row = document.getElementById('strokeStyleRow');
  const isStyleCapable = STYLE_CAPABLE_TOOLS.includes(state.activeTool);

  // Highlighter, eraser, lasso: niente stile tratto
  if (row) row.style.display = isStyleCapable ? '' : 'none';
  if (!isStyleCapable) return;

  const conf = getActiveToolConfig();
  const style = conf.style || 'solid';
  document.querySelectorAll('.stroke-style-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.style === style);
  });
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

export function toggleSnapCircles() {
  const next = !getToolbarSettings().snapCircles;
  updateToolbarSettings({ snapCircles: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Cerchi: riconoscimento attivo' : 'Cerchi: riconoscimento disattivato',
    next ? '⭕' : '🚫'
  );
}

export function toggleSnapRectangles() {
  const next = !getToolbarSettings().snapRectangles;
  updateToolbarSettings({ snapRectangles: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Rettangoli: riconoscimento attivo' : 'Rettangoli: riconoscimento disattivato',
    next ? '⬛' : '🚫'
  );
}

export function toggleSnapTriangles() {
  const next = !getToolbarSettings().snapTriangles;
  updateToolbarSettings({ snapTriangles: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Triangoli: riconoscimento attivo' : 'Triangoli: riconoscimento disattivato',
    next ? '🔺' : '🚫'
  );
}

export function toggleSnapArrows() {
  const next = !getToolbarSettings().snapArrows;
  updateToolbarSettings({ snapArrows: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Frecce: riconoscimento attivo' : 'Frecce: riconoscimento disattivato',
    next ? '➡️' : '🚫'
  );
}

export function toggleSnapMathSymbols() {
  const next = !getToolbarSettings().snapMathSymbols;
  updateToolbarSettings({ snapMathSymbols: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Simboli matematici: riconoscimento attivo' : 'Simboli matematici: riconoscimento disattivato',
    next ? '∑' : '🚫'
  );
}

export function toggleSnapGreekLetters() {
  const next = !getToolbarSettings().snapGreekLetters;
  updateToolbarSettings({ snapGreekLetters: next });
  applySnapTogglesToUI();
  showToast(
    next ? 'Lettere greche: riconoscimento attivo' : 'Lettere greche: riconoscimento disattivato',
    next ? 'α' : '🚫'
  );
}

export function toggleSnapShapes() {
  const s = getToolbarSettings();
  const next = !(
    s.snapCircles ||
    s.snapRectangles ||
    s.snapTriangles ||
    s.snapArrows ||
    s.snapMathSymbols ||
    s.snapGreekLetters
  );
  updateToolbarSettings({
    snapShapes: next,
    snapCircles: next,
    snapRectangles: next,
    snapTriangles: next,
    snapArrows: next,
    snapMathSymbols: next,
    snapGreekLetters: next
  });
  applySnapTogglesToUI();
  showToast(
    next ? 'Forme geometriche: riconoscimento attivo' : 'Forme geometriche: riconoscimento disattivato',
    next ? '◻️' : '🚫'
  );
}

export function applySnapTogglesToUI() {
  const s = getToolbarSettings();
  const linesEl = document.getElementById('snapLinesToggle');
  const circlesEl = document.getElementById('snapCirclesToggle');
  const rectsEl = document.getElementById('snapRectanglesToggle');
  const trianglesEl = document.getElementById('snapTrianglesToggle');
  const arrowsEl = document.getElementById('snapArrowsToggle');
  const mathEl = document.getElementById('snapMathSymbolsToggle');
  const greekEl = document.getElementById('snapGreekLettersToggle');
  if (linesEl)     linesEl.checked     = s.snapLines !== false;
  if (circlesEl)   circlesEl.checked   = s.snapCircles !== false;
  if (rectsEl)     rectsEl.checked     = s.snapRectangles !== false;
  if (trianglesEl) trianglesEl.checked = s.snapTriangles !== false;
  if (arrowsEl)    arrowsEl.checked    = s.snapArrows !== false;
  if (mathEl)      mathEl.checked      = s.snapMathSymbols !== false;
  if (greekEl)     greekEl.checked     = s.snapGreekLetters !== false;
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
  closeAllEditorMenus({ keep: 'pagePopover' });
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
// MENU ⋯ (overflow) — delegato al componente globale <ink-menu>
// ============================================================

let _toolbarMenuCtrl = null;

function _setupMenuOverflow() {
  const btn = document.getElementById('toolbarMenuBtn');
  const panel = document.getElementById('toolbarMenuPanel');
  if (!btn || !panel) return;

  _toolbarMenuCtrl = createFloatingMenu({
    id: 'toolbarMenu',
    panel,
    trigger: btn,
    align: 'end',
    gap: 6,
    bindTriggerClick: true,
    onOpen: _renderOverflowMenu
  });
}

export function closeAllEditorMenus({ keep = null } = {}) {
  closeAllFloatingMenus({ exceptId: keep });
}

export function closeToolbarMenu() {
  _toolbarMenuCtrl?.close();
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
  section.className = 'ui-menu-section';
  section.innerHTML = '<div class="ui-menu-section-title">Modalità nascoste</div>';

  const hiddenOrdered = order.filter(m => hidden.includes(m));
  hiddenOrdered.forEach(menu => {
    const meta = MENU_META[menu];
    if (!meta) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ui-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.menu = menu;
    btn.innerHTML = `${meta.svg}<span>Mostra ${meta.label}</span>`;
    btn.addEventListener('click', () => {
      _tryShowMenu(menu);
      _renderOverflowMenu();
      _toolbarMenuCtrl?.reposition();
      if (getSettings().mainMenuHidden.length === 0) closeToolbarMenu();
    });
    section.appendChild(btn);
  });

  const lastSection = panel.querySelector('.ui-menu-section:last-of-type');
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
  document.getElementById('snapCirclesToggle')
    ?.addEventListener('change', toggleSnapCircles);
  document.getElementById('snapRectanglesToggle')
    ?.addEventListener('change', toggleSnapRectangles);
  document.getElementById('snapTrianglesToggle')
    ?.addEventListener('change', toggleSnapTriangles);
  document.getElementById('snapArrowsToggle')
    ?.addEventListener('change', toggleSnapArrows);
  document.getElementById('snapMathSymbolsToggle')
    ?.addEventListener('change', toggleSnapMathSymbols);
  document.getElementById('snapGreekLettersToggle')
    ?.addEventListener('change', toggleSnapGreekLetters);

  document.getElementById('opacityBtn')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      showColorPickerPopover(e.currentTarget);
    });

  // Stile tratto
  document.querySelectorAll('.stroke-style-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      updateStrokeStyle(btn.dataset.style);
    });
  });

  _setupTextDockControls();
  _setupSelectionDockControls();
}

// ============================================================
// DOCK TESTO
// ============================================================

const TEXT_SIZE_PRESETS = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60];

function _setupTextDockControls() {
  const dock = document.getElementById('dockText');
  if (!dock) return;

  // Evita che i click sui pulsanti rubino il focus durante la digitazione
  dock.addEventListener('pointerdown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag !== 'SELECT' && tag !== 'OPTION' && tag !== 'INPUT') {
      e.preventDefault();
    }
  });

  document.getElementById('textFontSelect')?.addEventListener('change', (e) => {
    applyTextStylePatch({ fontFamily: e.target.value });
    refocusActiveTextEditorIfEditing();
  });

  document.getElementById('textSizeSelect')?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (!Number.isNaN(val)) applyTextStylePatch({ fontSize: val });
    refocusActiveTextEditorIfEditing();
  });

  document.getElementById('textSizeDecBtn')?.addEventListener('click', () => {
    const cur = getActiveTextStyle().fontSize || 18;
    const next = Math.max(10, cur - 2);
    applyTextStylePatch({ fontSize: next });
  });

  document.getElementById('textSizeIncBtn')?.addEventListener('click', () => {
    const cur = getActiveTextStyle().fontSize || 18;
    const next = Math.min(72, cur + 2);
    applyTextStylePatch({ fontSize: next });
  });

  document.getElementById('textBoldBtn')?.addEventListener('click', () => {
    const cur = getActiveTextStyle();
    applyTextStylePatch({ bold: !cur.bold });
  });

  document.getElementById('textItalicBtn')?.addEventListener('click', () => {
    const cur = getActiveTextStyle();
    applyTextStylePatch({ italic: !cur.italic });
  });

  dock.querySelectorAll('.text-align-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTextStylePatch({ align: btn.dataset.align });
    });
  });

  dock.querySelectorAll('.text-color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      applyTextStylePatch({ color: swatch.dataset.color });
    });
  });

  document.getElementById('textCustomColorPicker')?.addEventListener('input', (e) => {
    applyTextStylePatch({ color: e.target.value });
  });

  document.getElementById('textEditBtn')?.addEventListener('click', () => {
    editSelectedTextBox();
  });

  document.getElementById('textDeleteBtn')?.addEventListener('click', () => {
    deleteSelectedTextBox();
  });

  applyTextControlsToUI();
}

export function applyTextControlsToUI() {
  const style = getActiveTextStyle();
  const fontSel = document.getElementById('textFontSelect');
  if (fontSel) fontSel.value = style.fontFamily || 'sans';

  const sizeSel = document.getElementById('textSizeSelect');
  if (sizeSel) {
    const sz = Math.round(style.fontSize || 18);
    if (!TEXT_SIZE_PRESETS.includes(sz)) {
      let customOpt = sizeSel.querySelector('option[data-custom="1"]');
      if (!customOpt) {
        customOpt = document.createElement('option');
        customOpt.dataset.custom = '1';
        sizeSel.appendChild(customOpt);
      }
      customOpt.value = String(sz);
      customOpt.textContent = String(sz);
    }
    sizeSel.value = String(sz);
  }

  document.getElementById('textBoldBtn')?.classList.toggle('active', !!style.bold);
  document.getElementById('textItalicBtn')?.classList.toggle('active', !!style.italic);

  document.querySelectorAll('.text-align-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.align === (style.align || 'left'));
  });

  const colorLower = (style.color || '#000000').toLowerCase();
  document.querySelectorAll('.text-color-swatch').forEach(el => {
    const match = (el.dataset.color || '').toLowerCase() === colorLower;
    el.classList.toggle('ring-2', match);
    el.classList.toggle('ring-indigo-500', match);
    el.classList.toggle('scale-105', match);
  });

  const customColor = document.getElementById('textCustomColorPicker');
  if (customColor) customColor.value = style.color || '#000000';

  const activeBox = getActiveTextBox();
  const hasBox = !!(activeBox && activeBox.textBox);
  const editBtn = document.getElementById('textEditBtn');
  const delBtn = document.getElementById('textDeleteBtn');
  if (editBtn) editBtn.disabled = !hasBox || !!state.editingTextBoxId;
  if (delBtn) delBtn.disabled = !hasBox;
}

// ============================================================
// DOCK SELEZIONE (#dockSelection)
// ============================================================

function _setupSelectionDockControls() {
  const dock = document.getElementById('dockSelection');
  if (!dock) return;

  dock.querySelectorAll('.lasso-mode-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = btn.dataset.lassoMode === 'rect' ? 'rect' : 'freehand';
      updateToolbarSettings({ lassoMode: mode });
      applyLassoControlsToUI();
    });
  });

  document.getElementById('lassoFilterInk')?.addEventListener('change', (e) => {
    const nextInk = !!e.target.checked;
    if (!nextInk && state.lassoSelectText === false) {
      updateToolbarSettings({ lassoSelectInk: false, lassoSelectText: true });
    } else {
      updateToolbarSettings({ lassoSelectInk: nextInk });
    }
    applyLassoControlsToUI();
  });

  document.getElementById('lassoFilterText')?.addEventListener('change', (e) => {
    const nextText = !!e.target.checked;
    if (!nextText && state.lassoSelectInk === false) {
      updateToolbarSettings({ lassoSelectInk: true, lassoSelectText: false });
    } else {
      updateToolbarSettings({ lassoSelectText: nextText });
    }
    applyLassoControlsToUI();
  });

  document.getElementById('lassoCopyBtn')?.addEventListener('click', () => copySelection());
  document.getElementById('lassoCutBtn')?.addEventListener('click', () => cutSelection());
  document.getElementById('lassoPasteBtn')?.addEventListener('click', () => pasteSelection());
  document.getElementById('lassoDuplicateBtn')?.addEventListener('click', () => duplicateSelection());
  document.getElementById('lassoDeleteBtn')?.addEventListener('click', () => deleteSelection());

  applyLassoControlsToUI();
}

export function applyLassoControlsToUI() {
  const mode = state.lassoMode === 'rect' ? 'rect' : 'freehand';
  document.querySelectorAll('.lasso-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lassoMode === mode);
  });

  const inkEl = document.getElementById('lassoFilterInk');
  const textEl = document.getElementById('lassoFilterText');
  if (inkEl) inkEl.checked = state.lassoSelectInk !== false;
  if (textEl) textEl.checked = state.lassoSelectText !== false;

  const hasSel = hasLassoSelection();
  const hasClip = hasLassoClipboard();

  const copyBtn = document.getElementById('lassoCopyBtn');
  const cutBtn = document.getElementById('lassoCutBtn');
  const pasteBtn = document.getElementById('lassoPasteBtn');
  const dupBtn = document.getElementById('lassoDuplicateBtn');
  const delBtn = document.getElementById('lassoDeleteBtn');

  if (copyBtn) copyBtn.disabled = !hasSel;
  if (cutBtn) cutBtn.disabled = !hasSel;
  if (dupBtn) dupBtn.disabled = !hasSel;
  if (delBtn) delBtn.disabled = !hasSel;
  if (pasteBtn) pasteBtn.disabled = !hasClip;
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

  closeAllEditorMenus({ keep: 'colorPopover' });
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
  const next = toggleAppFullscreen();
  if (state.compactMode !== next) {
    updateToolbarSettings({ compactMode: next });
  }
  showToast(
    next ? 'Schermo intero attivo' : 'Modalità completa ripristinata',
    next ? '⛶' : '↩️'
  );
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

export function initCompactFullscreenSync() {
  initAppFullscreenSync();
  onAppFullscreenChange((active) => {
    if (state.compactMode !== active) {
      updateToolbarSettings({ compactMode: active });
    }
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  });
}

export function toggleTheme() {
  const next = state.isDarkMode ? 'light' : 'dark';
  updateSettings({ theme: next });
}