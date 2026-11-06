// ============================================================
// STATO GLOBALE DELL'APPLICAZIONE
// ============================================================

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;

const SHAPE_CAPABLE_TOOLS = ['pen', 'pencil', 'marker'];
const PULL_THRESHOLD = 80;

let db = null;
let currentUser = null;
let currentNotebook = null;
let selectedCoverColor = '#4f46e5';

const appState = {
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
    pendingShape: null
};

const transformState = { scale: 1.0, x: 0, y: 0, minScale: 0.5, maxScale: 4.0 };

const activePointers = new Map();
let isPanning = false;
let isPinching = false;
let panStart = { x: 0, y: 0 };
let panStartTransform = { x: 0, y: 0 };
let pinchStartDist = 0;
let pinchStartCenter = { x: 0, y: 0 };
let pinchStartTransform = { x: 0, y: 0, scale: 1 };