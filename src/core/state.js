/**
 * @module core/state
 *
 * STATO GLOBALE mutabile (plain object, no Proxy/reactive).
 *
 * Due oggetti esportati:
 *   - `state`    → stato applicativo (pagine, tool, selezione, cache runtime)
 *   - `viewport` → stato pan/zoom (scale, x, y, gesture in corso)
 *
 * IMPORTANTE — ownership:
 *   Alcuni campi di `state` sono CACHE scritte SOLO dai rispettivi store:
 *     - activeTool, currentColor, strokeWidth, eraserSize, eraserMode,
 *       autoShapeEnabled, smoothing, subbarVisible, compactMode
 *       ← scritti da features/toolbar/toolbar-settings.js
 *     - isDarkMode, palmRejection, settings
 *       ← scritti da core/app-settings.js
 *   NON scriverli direttamente da altri moduli: usare gli store.
 *
 *   Tutti gli altri campi (pages, activePageIndex, selectedStrokes,
 *   lassoPath, currentStroke, pendingShape, …) sono stato runtime
 *   dell'editor e vengono scritti dai tool e dalle gesture.
 *
 * @see core/types.js  — typedef di Point, Stroke, PageData, Snapshot
 * @see core/app-settings.js
 * @see features/toolbar/toolbar-settings.js
 */

/**
 * @typedef {Object} Point
 * @property {number} x            Posizione X in coordinate canvas (0..PAGE_WIDTH)
 * @property {number} y            Posizione Y in coordinate canvas (0..PAGE_HEIGHT)
 * @property {number} [pressure]   0..1 (0.5 se non pen)
 * @property {number} [tiltX]      Gradi di inclinazione X
 * @property {number} [tiltY]      Gradi di inclinazione Y
 * @property {number} [speed]      Distanza dall'ultimo punto (px)
 * @property {string} [pointerType] 'pen' | 'touch' | 'mouse'
 */

/**
 * @typedef {Object} Stroke
 * @property {'pen'|'pencil'|'marker'|'highlighter'} tool
 * @property {string} color        Hex (#rrggbb)
 * @property {number} size         Valore slider 1..25
 * @property {Point[]} points
 * @property {number} [startTime]  performance.now() al pointerdown
 * @property {Object} [_styleCache] Cache rendering (invalicata da cambio tema)
 * @property {number} [_pathLen]   Lunghezza cumulativa del path (cache forme)
*/

/**
 * @typedef {Object} PageData
 * @property {number} index
 * @property {HTMLDivElement} wrapper
 * @property {HTMLCanvasElement} canvas
 * @property {CanvasRenderingContext2D} ctx
 * @property {HTMLCanvasElement} overlayCanvas
 * @property {CanvasRenderingContext2D} overlayCtx
 * @property {Stroke[]} strokes
 * @property {number} [dpr]
 * @property {boolean} [_wasVisible]
 * @property {number} [overlayDpr]  DPR usata per l'overlay (limitata a 2)
 */

/**
 * @typedef {Object} Snapshot
 * @property {number} pageIndex
 * @property {Stroke[]} strokes
 * @property {string} bgPattern
 */

/**
 * Le impostazioni persistenti GLOBALI vivono in `core/app-settings.js`:
 *   - theme, printTheme, handedness, dockSize
 *   - pressureLight/Heavy/Curve, scrollSensitivity
 *   - palmRejection
 * `state.settings` è uno snapshot read-only dell'oggetto corrente
 * (aggiornato dallo store ad ogni `updateSettings`).
 * NON scrivere direttamente su `state.settings`: usa `updateSettings`.
 *
 * Le impostazioni per-notebook della TOOLBAR vivono in
 * `features/toolbar/toolbar-state.js`:
 *   - tools.{pen,pencil,marker,highlighter}.{color,width}
 *   - eraserSize, eraserMode, autoShapeEnabled, smoothing
 *   - subbarVisible, compactMode, recentColors
 *   - activeTool (RUNTIME ONLY, non persistito)
 *
 * I campi seguenti di `state` sono CACHE di lettura veloce sincronizzate
 * dagli store: NON vanno scritti da fuori.
 *   - activeTool, currentColor, strokeWidth
 *   - eraserSize, eraserMode, autoShapeEnabled
 *   - smoothing, subbarVisible, compactMode   ← toolbar-state
 *   - isDarkMode, palmRejection               ← app-settings
 *   - settings                                ← app-settings (snapshot)
 */

// ------------------------------------------------------------
// Stato applicativo principale
// ------------------------------------------------------------
export const state = {
  // --- Editor ---
  /** @type {PageData[]} */
  pages: [],
  /** @type {number} */
  activePageIndex: 0,

  // --- Impostazioni globali (snapshot read-only, vedi core/app-settings.js) ---
  /** @type {import('../core/app-settings.js').DEFAULT_SETTINGS|null} */
  settings: null,

  // --- Tool corrente (cache, vedi features/toolbar/toolbar-state.js) ---
  /** @type {'pen'|'pencil'|'marker'|'highlighter'|'lasso'|'eraser'} */
  activeTool: 'pen',
  /** @type {string} hex */
  currentColor: '#000000',
  /** @type {number} 1..25 */
  strokeWidth: 3,
  /** @type {number} 1..5 livello dimensione gomma (1=piccola, 5=grande) */
  eraserSize: 3,
  /** @type {'stroke'|'point'} modalità gomma */
  eraserMode: 'stroke',
  /** @type {boolean} */
  autoShapeEnabled: true,
  /** @type {number} 0..1 (frazione dello slider 0..100) */
  smoothing: 0.5,
  /** @type {'ruled'|'grid'|'dots'|'blank'} */
  bgPattern: 'ruled',
  /** @type {boolean} */
  isDarkMode: false,
  /** @type {boolean} */
  palmRejection: true,

  // --- Disegno in corso (hot path) ---
  /** @type {boolean} */
  isDrawing: false,
  /** @type {boolean} true quando l'utente preme il tasto eraser della penna */
  _penEraserActive: false,
  /** @type {Stroke|null} */
  currentStroke: null,
  /** @type {number|null} */
  currentPointerId: null,
  /** @type {PageData|null} */
  currentPageForPointer: null,

  // --- Lasso / selezione ---
  /** @type {Point[]} */
  lassoPath: [],
  /** @type {Stroke[]} */
  selectedStrokes: [],
  /** @type {boolean} */
  isDraggingSelection: false,
  /** @type {Point|null} */
  dragStartPoint: null,
  /** @type {boolean} */
  selectionMoved: false,

  // --- Resize selezione ---
  /** @type {boolean} */
  isResizingSelection: false,
  /** @type {'nw'|'se'|null} */
  resizeHandle: null,
  /** @type {Point|null} */
  resizePivot: null,
  /** @type {Point|null} */
  resizeAnchor: null,
  /** @type {Point|null} */
  resizeOffset: null,
  /** @type {number} */
  resizeBaseAngle: 0,
  /** @type {number} */
  resizeBaseDist: 0,
  /** @type {number} */
  resizeCurrentAngle: 0,
  /** @type {Array<{color:string, size:number, tool:string, points:Point[]}>|null} */
  initialStrokesSnapshot: null,

  // --- Scribble-to-erase ---
  /** @type {boolean} */
  scribbleMode: false,
  /** @type {Stroke[]} */
  scribbleTargets: [],

  // --- Varie ---
  /** @type {number} */
  pullOverscrollY: 0,
  /**
   * @type {{start:Point, end:Point, tool:string, color:string, size:number, activeHandle:'start'|'end'}|null}
   */
  pendingShape: null,

  // --- UI flags globali ---
  /** @type {boolean} */
  subbarVisible: true,
  /** @type {boolean} */
  compactMode: false
};

// ------------------------------------------------------------
// Stato del viewport (pan/zoom) e gesti multi-touch
// ------------------------------------------------------------
export const viewport = {
  /** @type {number} */
  scale: 1.0,
  /** @type {number} */
  x: 0,
  /** @type {number} */
  y: 0,
  // Limiti di zoom fissi (in stile GoodNotes/OneNote):
  // 25% minimo, 200% massimo.
  /** @type {number} */
  minScale: 0.25,
  /** @type {number} */
  maxScale: 4.0,

  /** @type {Map<number, {x:number, y:number, pointerType:string}>} */
  activePointers: new Map(),
  /** @type {boolean} */
  isPanning: false,
  /** @type {boolean} */
  isPinching: false,
  /** @type {{x:number, y:number}} */
  panStart: { x: 0, y: 0 },
  /** @type {{x:number, y:number}} */
  panStartTransform: { x: 0, y: 0 },
  /** @type {number} */
  pinchStartDist: 0,
  /** @type {{x:number, y:number}} */
  pinchStartCenter: { x: 0, y: 0 },
  /** @type {{x:number, y:number, scale:number}} */
  pinchStartTransform: { x: 0, y: 0, scale: 1 }
};