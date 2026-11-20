// ============================================================
// TOOLBAR SETTINGS — impostazioni per-notebook della toolbar.
//
// Novità v2.1:
//   - paperColor / patternColor (colori custom del foglio)
//     - null = usa il default del tema
//     - hex  = override dell'utente
//   - migrazione soft: notebook senza questi campi → null
// ============================================================

import { state } from '../../core/state.js';
import { emit, on } from '../../core/utils.js';

export const HIGHLIGHTER_COLORS = ['#FFEB3B', '#7CFF7C', '#FF7CBE', '#7CD4FF', '#FFA97C'];
export const HIGHLIGHTER_DEFAULT_COLOR = HIGHLIGHTER_COLORS[0];

export const DEFAULT_TOOLBAR_SETTINGS = {
  tools: {
    pen:         { color: '#000000', width: 3, opacity: 1.0, style: 'solid' },
    pencil:      { color: '#000000', width: 3, opacity: 1.0, style: 'solid' },
    marker:      { color: '#000000', width: 3, opacity: 0.9, style: 'solid' },
    highlighter: { color: HIGHLIGHTER_DEFAULT_COLOR, width: 3, opacity: 0.35, style: 'solid' }
  },
  eraserSize: 3,
  eraserMode: 'stroke',
  lassoMode: 'freehand',
  lassoSelectInk: true,
  lassoSelectText: true,
  snapLines: true,
  snapShapes: true,
  snapCircles: true,
  snapRectangles: true,
  snapTriangles: true,
  snapArrows: true,
  smoothing: 50,
  compactMode: false,
  recentColors: [],
  paperColor: null,
  patternColor: null,
  text: {
    fontFamily: 'sans',
    fontSize: 18,
    bold: false,
    italic: false,
    align: 'left',
    color: '#000000'
  }
};

const VALID_TEXT_FONTS = ['sans', 'serif', 'mono', 'hand'];
const VALID_TEXT_ALIGNS = ['left', 'center', 'right'];

export const STROKE_STYLES = ['solid', 'dashed', 'dashed-large', 'dotted', 'dash-dot'];

function _normalizeStyle(v) {
  return STROKE_STYLES.includes(v) ? v : 'solid';
}

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
  state.smoothing    = _current.smoothing / 100;
  state.compactMode  = !!_current.compactMode;
  state.eraserSize   = _current.eraserSize;
  state.eraserMode   = _current.eraserMode;
  state.lassoMode       = _current.lassoMode === 'rect' ? 'rect' : 'freehand';
  state.lassoSelectInk  = _current.lassoSelectInk !== false;
  state.lassoSelectText = _current.lassoSelectText !== false;
  state.snapLines      = !!_current.snapLines;
  state.snapCircles    = !!_current.snapCircles;
  state.snapRectangles = !!_current.snapRectangles;
  state.snapTriangles  = !!_current.snapTriangles;
  state.snapArrows     = !!_current.snapArrows;
  state.snapShapes     = !!(state.snapCircles || state.snapRectangles || state.snapTriangles || state.snapArrows);
  state.autoShapeEnabled = state.snapLines || state.snapShapes;
  state.activeTool   = _activeTool;
  // Colori foglio (null = default del tema, gestito in render.js)
  state.paperColor   = _current.paperColor   || null;
  state.patternColor = _current.patternColor || null;
  state.textStyle    = { ..._current.text };

  const conf = _current.tools[_activeTool];
  if (conf) {
    state.currentColor   = conf.color;
    state.strokeWidth    = conf.width;
    state.currentOpacity = conf.opacity != null ? conf.opacity : 1.0;
    state.currentStyle   = conf.style || 'solid';
  }
}

function _normalizeHexOrNull(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s.slice(1).split('').map(c => c + c).join('').toLowerCase();
  }
  return null;
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
        : _defaultOpacityFor(name),
      style: _normalizeStyle(t.style)
    };
  }
  const hl = merged.tools.highlighter || {};
  const hlColor = _isLegacyHighlighterBlack(hl.color) ? HIGHLIGHTER_DEFAULT_COLOR : hl.color;
  merged.tools.highlighter = {
    color: typeof hlColor === 'string' ? hlColor : HIGHLIGHTER_DEFAULT_COLOR,
    width: typeof hl.width === 'number' ? hl.width : 3,
    opacity: typeof hl.opacity === 'number'
      ? Math.max(0.1, Math.min(1.0, hl.opacity))
      : _defaultOpacityFor('highlighter'),
    style: _normalizeStyle(hl.style)
  };

  // Migrazione legacy: autoShapeEnabled → snapLines/snapShapes
  if (raw && typeof raw.snapLines !== 'boolean' && typeof raw.snapShapes !== 'boolean') {
    if (typeof raw.autoShapeEnabled === 'boolean') {
      merged.snapLines  = raw.autoShapeEnabled;
      merged.snapShapes = raw.autoShapeEnabled;
    }
  }
  merged.snapLines = merged.snapLines !== false;

  // Migrazione soft: snapShapes → snapCircles / snapRectangles / snapTriangles / snapArrows
  const hasPerShape = raw && (
    typeof raw.snapCircles === 'boolean' ||
    typeof raw.snapRectangles === 'boolean' ||
    typeof raw.snapTriangles === 'boolean' ||
    typeof raw.snapArrows === 'boolean'
  );
  if (!hasPerShape && raw && typeof raw.snapShapes === 'boolean') {
    merged.snapCircles    = raw.snapShapes;
    merged.snapRectangles = raw.snapShapes;
    merged.snapTriangles  = raw.snapShapes;
    merged.snapArrows     = raw.snapShapes;
  } else {
    merged.snapCircles    = merged.snapCircles    !== false;
    merged.snapRectangles = merged.snapRectangles !== false;
    merged.snapTriangles  = merged.snapTriangles  !== false;
    merged.snapArrows     = merged.snapArrows     !== false;
  }
  merged.snapShapes = !!(merged.snapCircles || merged.snapRectangles || merged.snapTriangles || merged.snapArrows);

  merged.eraserSize      = Math.max(1, Math.min(5, merged.eraserSize || 3));
  merged.eraserMode      = merged.eraserMode === 'point' ? 'point' : 'stroke';
  merged.lassoMode       = merged.lassoMode === 'rect' ? 'rect' : 'freehand';
  merged.lassoSelectInk  = merged.lassoSelectInk !== false;
  merged.lassoSelectText = merged.lassoSelectText !== false;
  merged.smoothing       = Math.max(0, Math.min(100, merged.smoothing ?? 50));
  merged.recentColors = Array.isArray(merged.recentColors) ? merged.recentColors.slice() : [];

  merged.paperColor   = _normalizeHexOrNull(merged.paperColor);
  merged.patternColor = _normalizeHexOrNull(merged.patternColor);

  const rawText = (raw && raw.text) || {};
  merged.text = {
    fontFamily: VALID_TEXT_FONTS.includes(rawText.fontFamily) ? rawText.fontFamily : 'sans',
    fontSize: typeof rawText.fontSize === 'number'
      ? Math.max(10, Math.min(72, Math.round(rawText.fontSize)))
      : 18,
    bold: !!rawText.bold,
    italic: !!rawText.italic,
    align: VALID_TEXT_ALIGNS.includes(rawText.align) ? rawText.align : 'left',
    color: _normalizeHexOrNull(rawText.color) || '#000000'
  };

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
    text:         { ..._current.text },
    eraserSize:     _current.eraserSize,
    eraserMode:     _current.eraserMode,
    lassoMode:      _current.lassoMode,
    lassoSelectInk: _current.lassoSelectInk,
    lassoSelectText:_current.lassoSelectText,
    snapLines:      _current.snapLines,
    snapShapes:     _current.snapShapes,
    snapCircles:    _current.snapCircles,
    snapRectangles: _current.snapRectangles,
    snapTriangles:  _current.snapTriangles,
    snapArrows:     _current.snapArrows,
    smoothing:    _current.smoothing,
    compactMode:  _current.compactMode,
    recentColors: _current.recentColors.slice(),
    paperColor:   _current.paperColor,
    patternColor: _current.patternColor
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