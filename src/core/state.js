// ============================================================
// STATO GLOBALE (plain object, mutabile, no Proxy/reactivity)
// ============================================================

export const state = {
  pages: [],
  activePageIndex: 0,

  activeTool: 'pen',
  currentColor: '#000000',
  strokeWidth: 3,
  autoShapeEnabled: true,
  smoothing: 0.5,
  bgPattern: 'ruled',
  isDarkMode: false,

  isDrawing: false,
  currentStroke: null,
  currentPointerId: null,
  currentPageForPointer: null,

  lassoPath: [],
  selectedStrokes: [],
  isDraggingSelection: false,
  dragStartPoint: null,
  selectionMoved: false,

  isResizingSelection: false,
  resizeHandle: null,
  resizePivot: null,
  resizeAnchor: null,
  resizeOffset: null,
  resizeBaseAngle: 0,
  resizeBaseDist: 0,
  resizeCurrentAngle: 0,
  initialStrokesSnapshot: null,

  scribbleMode: false,
  scribbleTargets: [],

  pullOverscrollY: 0,
  pendingShape: null,

  // UI flags globali
  subbarVisible: true,
  compactMode: false
};

export const viewport = {
  scale: 1.0,
  x: 0,
  y: 0,
  minScale: 0.5,
  maxScale: 4.0,

  activePointers: new Map(),
  isPanning: false,
  isPinching: false,
  panStart: { x: 0, y: 0 },
  panStartTransform: { x: 0, y: 0 },
  pinchStartDist: 0,
  pinchStartCenter: { x: 0, y: 0 },
  pinchStartTransform: { x: 0, y: 0, scale: 1 }
};