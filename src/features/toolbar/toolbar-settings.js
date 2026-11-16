// ============================================================
// TOOLBAR SETTINGS — impostazioni per-notebook della toolbar.
//
// Novità v2 (mainbar + dock contestuali):
//   - snapLines / snapShapes sostituiscono autoShapeEnabled
//     (migrazione soft: autoShapeEnabled → entrambi con lo stesso valore)
//   - opacity per ogni tool (invariato)
//   - highlighter default giallo (invariato)
//   - rimosso subbarVisible (la subbar non esiste più in v2)
//
// NOTE:
//   - `mainMenu` è runtime-only e vive in toolbar.js (non qui)
//   - `autoShapeEnabled` è deprecato, viene migrato in _normalize
// ============================================================

import { state } from '../../core/state.js';
import { emit, on } from '../../core/utils.js';

export const HIGHLIGHTER_COLORS = ['#FFEB3B', '#7CFF7C', '#FF7CBE', '#7CD4FF', '#FFA97C'];
export const HIGHLIGHTER_DEFAULT_COLOR = HIGHLIGHTER_COLORS[0];

export const DEFAULT_TOOLBAR_SETTINGS = {
  tools: {
    pen:         { color: '#000000', width: 3, opacity: 1.0 },
    pencil:      { color: '#000000', width: 3, opacity: 1.0 },
    marker:      { color: '#000000', width: 3, opacity: 0.9 },
    highlighter: { color: HIGHLIGHTER_DEFAULT_COLOR, width: 3, opacity: 0.35 }
  },
  eraserSize: 3,
  eraserMode: 'stroke',
  snapLines: true,
  snapShapes: true,
  smoothing: 50,
  compactMode: false,
  recentColors: []
};

export const ERASER_RADII = [3, 8, 16, 30, 50];

let _current = null;
let _activeTool = 'pen';

function _isLegacyHighlighterBlack(c) {
  return !c || c === '#000000' || c === '#000' || c === 'black';
}

function _defaultOpacityFor(name) {
  return DEFAULT_TOOLBAR_SETTINGS.tools[name]?.opacity ?? 1.0;
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
  state.smoothing   = _current.smoothing / 100;
  state.compactMode = !!_current.compactMode;
  state.eraserSize  = _current.eraserSize;
  state.eraserMode  = _current.eraserMode;
  state.snapLines   = !!_current.snapLines;
  state.snapShapes  = !!_current.snapShapes;
  // Legacy alias: alcuni file storici potrebbero ancora leggerlo.
  // Verrà rimosso quando tutti i consumatori useranno snapLines/snapShapes.
  state.autoShapeEnabled = state.snapLines || state.snapShapes;
  state.activeTool  = _activeTool;

  const conf = _current.tools[_activeTool];
  if (conf) {
    state.currentColor   = conf.color;
    state.strokeWidth    = conf.width;
    state.currentOpacity = conf.opacity != null ? conf.opacity : 1.0;
  }
}

function _normalize(raw) {
  const merged = {
    ...DEFAULT_TOOLBAR_SETTINGS,
    ...(raw || {}),
    tools: { ...DEFAULT_TOOLBAR_SETTINGS.tools, ...((raw && raw.tools) || {}) }
  };
  for (const name of ['pen', 'pencil', 'marker']) {
    const t = merged.tools[name] || {};
    merged.tools[name] = {
      color: typeof t.color === 'string' ? t.color : DEFAULT_TOOLBAR_SETTINGS.tools[name].color,
      width: typeof t.width === 'number' ? t.width : DEFAULT_TOOLBAR_SETTINGS.tools[name].width,
      opacity: typeof t.opacity === 'number'
        ? Math.max(0.1, Math.min(1.0, t.opacity))
        : _defaultOpacityFor(name)
    };
  }
  const hl = merged.tools.highlighter || {};
  const hlColor = _isLegacyHighlighterBlack(hl.color) ? HIGHLIGHTER_DEFAULT_COLOR : hl.color;
  merged.tools.highlighter = {
    color: typeof hlColor === 'string' ? hlColor : HIGHLIGHTER_DEFAULT_COLOR,
    width: typeof hl.width === 'number' ? hl.width : 3,
    opacity: typeof hl.opacity === 'number'
      ? Math.max(0.1, Math.min(1.0, hl.opacity))
      : _defaultOpacityFor('highlighter')
  };

  // --- Migrazione legacy: autoShapeEnabled → snapLines/snapShapes
  // Se il notebook ha solo autoShapeEnabled, lo espandiamo in due flag.
  // Se ha già snapLines/snapShapes (nuova versione), non tocchiamo nulla.
  if (raw && typeof raw.snapLines !== 'boolean' && typeof raw.snapShapes !== 'boolean') {
    if (typeof raw.autoShapeEnabled === 'boolean') {
      merged.snapLines  = raw.autoShapeEnabled;
      merged.snapShapes = raw.autoShapeEnabled;
    }
  }
  merged.snapLines  = merged.snapLines  !== false;
  merged.snapShapes = merged.snapShapes !== false;

  merged.eraserSize   = Math.max(1, Math.min(5, merged.eraserSize || 3));
  merged.eraserMode   = merged.eraserMode === 'point' ? 'point' : 'stroke';
  merged.smoothing    = Math.max(0, Math.min(100, merged.smoothing ?? 50));
  merged.recentColors = Array.isArray(merged.recentColors) ? merged.recentColors.slice() : [];

  delete merged.autoShapeEnabled;
  delete merged.subbarVisible;
  return merged;
}

export function initToolbarSettings(notebookSettings = null) {
  _current = _normalize(notebookSettings);
  _activeTool = 'pen';
  _syncRuntime();
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
  return _current.tools[_activeTool] || { color: '#000000', width: 3, opacity: 1.0 };
}

export function getEraserRadius() {
  const lvl = Math.max(1, Math.min(5, state.eraserSize || 3));
  return ERASER_RADII[lvl - 1];
}

export function getToolbarSettingsForSave() {
  if (!_current) initToolbarSettings(null);
  return {
    tools:        JSON.parse(JSON.stringify(_current.tools)),
    eraserSize:   _current.eraserSize,
    eraserMode:   _current.eraserMode,
    snapLines:    _current.snapLines,
    snapShapes:   _current.snapShapes,
    smoothing:    _current.smoothing,
    compactMode:  _current.compactMode,
    recentColors: _current.recentColors.slice()
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
  _applyCompactToDOM(!!_current.compactMode);
  emit('toolbar-settings:changed', { changed: ['reset'], settings: _current, activeTool: _activeTool });
  return _current;
}

export function onToolbarSettingsChanged(fn) {
  return on('toolbar-settings:changed', fn);
}