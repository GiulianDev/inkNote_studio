// ============================================================
// TOOLBAR SETTINGS — impostazioni per-notebook della toolbar.
// Sorgente di verità per:
//   - tools.{pen,pencil,marker,highlighter}.{color,width}
//   - eraserSize, eraserMode
//   - autoShapeEnabled, smoothing
//   - subbarVisible, compactMode
//   - recentColors
//   - activeTool (RUNTIME ONLY, non persistito)
//
// Persistenza: dentro `notebook.toolbarSettings` (IndexedDB).
// Cleanup automatico al delete del notebook.
// ============================================================

import { state } from '../../core/state.js';
import { emit, on } from '../../core/utils.js';

export const DEFAULT_TOOLBAR_SETTINGS = {
  tools: {
    pen:         { color: '#000000', width: 3 },
    pencil:      { color: '#000000', width: 3 },
    marker:      { color: '#000000', width: 3 },
    highlighter: { color: '#000000', width: 3 }
  },
  eraserSize: 3,              // 1..5
  eraserMode: 'stroke',       // 'stroke' | 'point'
  autoShapeEnabled: true,
  smoothing: 50,              // 0..100
  subbarVisible: true,
  compactMode: false,
  recentColors: []            // array di hex string
};

export const ERASER_RADII = [3, 8, 16, 30, 50];

/** @type {typeof DEFAULT_TOOLBAR_SETTINGS|null} */
let _current = null;
/** @type {'pen'|'pencil'|'marker'|'highlighter'|'lasso'|'eraser'} */
let _activeTool = 'pen';

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

function _syncRuntime() {
  state.smoothing        = _current.smoothing / 100;
  state.subbarVisible    = _current.subbarVisible !== false;
  state.compactMode      = !!_current.compactMode;
  state.eraserSize       = _current.eraserSize;
  state.eraserMode       = _current.eraserMode;
  state.autoShapeEnabled = !!_current.autoShapeEnabled;
  state.activeTool       = _activeTool;

  const conf = _current.tools[_activeTool];
  if (conf) {
    state.currentColor = conf.color;
    state.strokeWidth  = conf.width;
  }
}

function _normalize(raw) {
  const merged = {
    ...DEFAULT_TOOLBAR_SETTINGS,
    ...(raw || {}),
    tools: { ...DEFAULT_TOOLBAR_SETTINGS.tools, ...((raw && raw.tools) || {}) }
  };
  for (const name of ['pen', 'pencil', 'marker', 'highlighter']) {
    const t = merged.tools[name] || {};
    merged.tools[name] = {
      color: typeof t.color === 'string' ? t.color : DEFAULT_TOOLBAR_SETTINGS.tools[name].color,
      width: typeof t.width === 'number' ? t.width : DEFAULT_TOOLBAR_SETTINGS.tools[name].width
    };
  }
  merged.eraserSize   = Math.max(1, Math.min(5, merged.eraserSize || 3));
  merged.eraserMode   = merged.eraserMode === 'point' ? 'point' : 'stroke';
  merged.smoothing    = Math.max(0, Math.min(100, merged.smoothing ?? 50));
  merged.recentColors = Array.isArray(merged.recentColors) ? merged.recentColors.slice() : [];
  return merged;
}

export function initToolbarSettings(notebookSettings = null) {
  _current = _normalize(notebookSettings);
  _activeTool = 'pen';
  _syncRuntime();
  _applySubbarToDOM(_current.subbarVisible !== false);
  _applyCompactToDOM(!!_current.compactMode);
  emit('toolbar-settings:changed', {
    changed: ['init'],
    settings: _current,
    activeTool: _activeTool
  });
  return _current;
}

export function getToolbarSettings() {
  if (!_current) initToolbarSettings(null);
  return _current;
}

export function getActiveTool() { return _activeTool; }

export function getActiveToolConfig() {
  if (!_current) initToolbarSettings(null);
  return _current.tools[_activeTool] || { color: '#000000', width: 3 };
}

export function getEraserRadius() {
  const lvl = Math.max(1, Math.min(5, state.eraserSize || 3));
  return ERASER_RADII[lvl - 1];
}

export function getToolbarSettingsForSave() {
  if (!_current) initToolbarSettings(null);
  return {
    tools:            JSON.parse(JSON.stringify(_current.tools)),
    eraserSize:       _current.eraserSize,
    eraserMode:       _current.eraserMode,
    autoShapeEnabled: _current.autoShapeEnabled,
    smoothing:        _current.smoothing,
    subbarVisible:    _current.subbarVisible,
    compactMode:      _current.compactMode,
    recentColors:     _current.recentColors.slice()
  };
}

export function updateToolbarSettings(partial, opts = {}) {
  if (!_current) initToolbarSettings(null);
  const before = _current;
  const beforeActive = _activeTool;

  if (partial.activeTool) {
    _activeTool = partial.activeTool;
    delete partial.activeTool;
  }

  if (Object.keys(partial).length > 0) {
    _current = _normalize({ ..._current, ...partial });
  }

  _syncRuntime();
  _applySubbarToDOM(_current.subbarVisible !== false);
  _applyCompactToDOM(!!_current.compactMode);

  if (!opts.silent) {
    emit('toolbar-settings:changed', {
      changed: Object.keys(partial).concat(beforeActive !== _activeTool ? ['activeTool'] : []),
      settings: _current,
      activeTool: _activeTool,
      before,
      beforeActive
    });
  }
  return _current;
}

export function resetToolbarSettings() {
  _current = {
    ...DEFAULT_TOOLBAR_SETTINGS,
    tools: JSON.parse(JSON.stringify(DEFAULT_TOOLBAR_SETTINGS.tools))
  };
  _activeTool = 'pen';
  _syncRuntime();
  _applySubbarToDOM(_current.subbarVisible !== false);
  _applyCompactToDOM(!!_current.compactMode);
  emit('toolbar-settings:changed', { changed: ['reset'], settings: _current, activeTool: _activeTool });
  return _current;
}

export function onToolbarSettingsChanged(fn) {
  return on('toolbar-settings:changed', fn);
}