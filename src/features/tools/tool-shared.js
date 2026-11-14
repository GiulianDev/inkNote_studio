// ============================================================
// TOOLS COMMON — helper condivisi fra tutti i tool:
// coordinate, smoothing, batching rAF, prediction clear.
//
// Ottimizzazioni applicate:
//   A. getCanvasRect ritorna un wrapper con scaleX/scaleY precalcolati
//      (evita PAGE_WIDTH / rect.width ad ogni punto)
//   B. _processPointerPoint calcola hypot una sola volta per punto
//   C. Buffer di flush con swap preallocato (zero allocazioni array)
//   D. _pointPool cappato a MAX_POOL_SIZE per limitare la memoria
// ============================================================

import { drawPredictions, clearPredictions, isPredictionSupported } from '../render/prediction.js';
import { drawIncrementalBatch, drawScribbleSegment } from '../render/render.js';
import { state, viewport } from '../../core/state.js';
import { PAGE_WIDTH, PAGE_HEIGHT, SHAPE_CAPABLE_TOOLS, fastHypot } from '../../core/utils.js';
import { checkForScribble } from './scribble.js';
import { trySnapToLineDuringDraw } from './shapes.js';

const MAX_BATCH_POINTS = 16;
const MAX_POOL_SIZE = 2000;

export const _useRawPointerUpdate =
  typeof window !== 'undefined' && 'onpointerrawupdate' in window;

// ------------------------------------------------------------
// Riconoscimento pen-eraser (tasto laterale penna)
// ------------------------------------------------------------
export function isPenEraser(e) {
  if (!e) return false;
  if (e.pointerType === 'eraser') return true;
  if (e.button === 5) return true;
  if (typeof e.buttons === 'number' && (e.buttons & 32) !== 0) return true;
  return false;
}

// ------------------------------------------------------------
// Pool di punti (evita allocazioni nel hot path)
//
// Cap a MAX_POOL_SIZE: uno stroke molto lungo (es. 5000 punti) non
// lascia un pool enorme per il resto della sessione. Al reset, se il
// pool supera il cap, viene trimmato. Gli oggetti oltre il cap
// vengono lasciati al GC.
// ------------------------------------------------------------
const _pointPool = [];
let _pointPoolIdx = 0;

export function resetPointPool() {
  _pointPoolIdx = 0;
  if (_pointPool.length > MAX_POOL_SIZE) {
    _pointPool.length = MAX_POOL_SIZE;
  }
}

// ------------------------------------------------------------
// Cache rect canvas
//
// Ritorna un wrapper con gli stessi campi del DOMRect (left/top/
// width/height/right/bottom/x/y) + scaleX/scaleY precalcolati.
// Evita di ripetere PAGE_WIDTH / rect.width per ogni punto.
//
// La cache è valida finché canvas + viewport (scale/x/y) non
// cambiano. Cambio pagina o pan/zoom invalidano automaticamente.
// ------------------------------------------------------------
let _strokeRect = null;

export function invalidateStrokeRect() {
  _strokeRect = null;
}

export function getCanvasRect(canvas) {
  if (_strokeRect &&
      _strokeRect._cacheCanvas === canvas &&
      _strokeRect._cacheVpScale === viewport.scale &&
      _strokeRect._cacheVpX === viewport.x &&
      _strokeRect._cacheVpY === viewport.y) {
    return _strokeRect;
  }
  const r = canvas.getBoundingClientRect();
  // Protezione: canvas appena creato (prima del layout) può avere
  // width/height 0. Uso 1 come fallback per evitare scaleX = Infinity.
  const w = r.width > 0 ? r.width : 1;
  const h = r.height > 0 ? r.height : 1;
  _strokeRect = {
    left: r.left, top: r.top,
    width: r.width, height: r.height,
    right: r.right, bottom: r.bottom,
    x: r.x, y: r.y,
    scaleX: PAGE_WIDTH / w,
    scaleY: PAGE_HEIGHT / h,
    _cacheCanvas: canvas,
    _cacheVpScale: viewport.scale,
    _cacheVpX: viewport.x,
    _cacheVpY: viewport.y
  };
  return _strokeRect;
}

export function getCanvasCoords(e, canvas) {
  const rect = getCanvasRect(canvas);

  let p;
  if (_pointPoolIdx < _pointPool.length) {
    p = _pointPool[_pointPoolIdx++];
  } else {
    p = { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 0, pointerType: 'pen' };
    _pointPool.push(p);
    _pointPoolIdx++;
  }
  p.x = (e.clientX - rect.left) * rect.scaleX;
  p.y = (e.clientY - rect.top) * rect.scaleY;
  p.pressure = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
  p.tiltX = e.tiltX || 0;
  p.tiltY = e.tiltY || 0;
  p.speed = 0;
  p.pointerType = e.pointerType;
  return p;
}

// ------------------------------------------------------------
// Smoothing
// ------------------------------------------------------------
function smoothPressure(points, newPressure) {
  const n = points.length;
  if (n === 0) return newPressure;
  const wNew = 0.6, count = Math.min(3, n), wOld = 0.4 / count;
  let acc = newPressure * wNew;
  for (let i = n - count; i < n; i++) acc += (points[i].pressure || 0.5) * wOld;
  return Math.max(0.05, Math.min(1, acc));
}

/**
 * NOTA: muta `rawPoint` in place (il chiamante deve considerare
 * il punto "consumato" dopo questa chiamata). Sicuro perché
 * `rawPoint` è temporaneo del batch corrente — viene processato
 * una sola volta.
 */
function smoothRawPoint(rawPoint, prevSmoothed) {
  const smoothness = Math.max(0, Math.min(1, state.smoothing));
  if (!prevSmoothed || smoothness <= 0.01) return rawPoint;
  const dx = rawPoint.x - prevSmoothed.x;
  const dy = rawPoint.y - prevSmoothed.y;
  const speed = fastHypot(dx, dy);
  const minAlpha = 0.85 - smoothness * 0.55;
  const alpha = Math.min(1.0, minAlpha + speed * 0.05);
  rawPoint.x = prevSmoothed.x + dx * alpha;
  rawPoint.y = prevSmoothed.y + dy * alpha;
  return rawPoint;
}

// ------------------------------------------------------------
// Batching rAF con buffer swap preallocato
//
// _bufferA e _bufferB si alternano ad ogni _doFlush. Uno è "attivo"
// (riceve i push), l'altro è in processing. Zero allocazioni di
// array: gli array vengono riusati e svuotati con `.length = 0`.
//
// Nota: `_activeBuffer.length = 0` è safe in single-thread. Anche
// se un nuovo pointermove arrivasse durante _doFlush (impossibile:
// è sincrono), il nuovo punto andrebbe sul buffer già swappato,
// non su quello in processing.
// ------------------------------------------------------------
let _bufferA = [];
let _bufferB = [];
let _activeBuffer = _bufferA;

const _flushState = { rafId: null, pageData: null };

/**
 * Prende il buffer attivo e lo sostituisce con l'altro (vuoto).
 * Il chiamante ottiene il buffer "pieno" da processare.
 */
function _takeBuffer() {
  const batch = _activeBuffer;
  _activeBuffer = (_activeBuffer === _bufferA) ? _bufferB : _bufferA;
  _activeBuffer.length = 0;
  return batch;
}

export function pushPointsToBatch(points) {
  for (let i = 0; i < points.length; i++) _activeBuffer.push(points[i]);
}

function _processPointerPoint(rawPoint, pageData) {
  if (state.pendingShape) return;
  if (!state.currentStroke || !state.isDrawing) return;
  const prevSmoothed = state.currentStroke.points[state.currentStroke.points.length - 1];
  const smoothedPos = smoothRawPoint(rawPoint, prevSmoothed);
  let smoothedPressure = rawPoint.pressure;
  if (rawPoint.pointerType === 'pen' && state.currentStroke.points.length > 0) {
    smoothedPressure = smoothPressure(state.currentStroke.points, rawPoint.pressure);
  }
  const minDist = state.smoothing <= 0.01 ? 0.01 : 0.4;
  // Calcolo hypot UNA volta sola: serve sia per il check dist < minDist
  // sia come speedPx per il render.
  let speedPx = 0;
  if (prevSmoothed) {
    const dx = smoothedPos.x - prevSmoothed.x;
    const dy = smoothedPos.y - prevSmoothed.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) return;
    speedPx = dist;
  }
  const smoothedPoint = {
    x: smoothedPos.x, y: smoothedPos.y, pressure: smoothedPressure,
    tiltX: rawPoint.tiltX, tiltY: rawPoint.tiltY, speed: speedPx, pointerType: rawPoint.pointerType
  };
  state.currentStroke.points.push(smoothedPoint);
  if (state.currentStroke._pathLen === undefined) state.currentStroke._pathLen = 0;
  if (state.currentStroke.points.length >= 2) {
    const prev = state.currentStroke.points[state.currentStroke.points.length - 2];
    state.currentStroke._pathLen += fastHypot(smoothedPoint.x - prev.x, smoothedPoint.y - prev.y);
  }
  if (state.scribbleMode) {
    drawScribbleSegment(pageData.overlayCtx, state.currentStroke,
                        pageData.overlayDpr || pageData.dpr);
  }
}

function _runPostBatchChecks(pageData) {
  if (!state.currentStroke || !state.isDrawing) return;
  if (state.pendingShape) return;
  const pts = state.currentStroke.points;
  if (pts.length === 0) return;
  checkForScribble(pageData);
  if (!state.currentStroke || !state.isDrawing) return;
  if (state.pendingShape) return;

  // Batch B: throttle a 1 check ogni 10 punti.
  if (!state.scribbleMode && state.autoShapeEnabled &&
      SHAPE_CAPABLE_TOOLS.includes(state.activeTool) &&
      pts.length >= 6 && pts.length < 200) {
    const lastCheck = state.currentStroke._lastSnapCheck || 0;
    if (pts.length - lastCheck >= 10) {
      state.currentStroke._lastSnapCheck = pts.length;
      trySnapToLineDuringDraw(pageData, pts[pts.length - 1]);
    }
  }
}

function _renderBatchTarget(pageData, drawnIdx) {
  if (!state.currentStroke) return;

  const oc = pageData.overlayCanvas;
  const stroke = state.currentStroke;
  const opacity = stroke.opacity != null ? stroke.opacity : 1.0;

  if (oc) {
    // Applica opacity CSS all'overlay per TUTTI i tool, così
    // l'anteprima durante lo stroke ha la stessa opacità del
    // risultato finale (blit con alpha = opacity).
    if (opacity < 1.0) {
      oc.style.opacity = String(opacity);
    } else {
      oc.style.opacity = '';
    }
    // mixBlendMode solo per highlighter (multiply/screen)
    if (stroke.tool === 'highlighter') {
      oc.style.mixBlendMode = state.isDarkMode ? 'screen' : 'multiply';
    } else {
      oc.style.mixBlendMode = '';
    }
  }

  const targetCtx = pageData.overlayCtx;
  const dpr = pageData.overlayDpr || pageData.dpr;
  drawIncrementalBatch(targetCtx, stroke, drawnIdx, dpr);
  stroke._drawnIdx = stroke.points.length;
}

export function scheduleFlush(pageData) {
  _flushState.pageData = pageData;
  if (_activeBuffer.length >= MAX_BATCH_POINTS) {
    if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
    _doFlush(); return;
  }
  if (_flushState.rafId !== null) return;
  _flushState.rafId = requestAnimationFrame(_doFlush);
}

function _doFlush() {
  _flushState.rafId = null;
  const pageData = _flushState.pageData;
  const batch = _takeBuffer();
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;
    clearPredictions(pageData);

    const drawnIdx = state.currentStroke._drawnIdx || 0;

    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }

    if (state.currentStroke && state.isDrawing &&
        !state.pendingShape && !state.scribbleMode) {
      _renderBatchTarget(pageData, drawnIdx);
    }

    _runPostBatchChecks(pageData);
  } finally {
    // Libera i riferimenti ai punti (il buffer verrà riusato).
    batch.length = 0;
    resetPointPool();
  }
}

export function cancelFlush() {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  _activeBuffer.length = 0;
  _flushState.pageData = null;
  resetPointPool();
}

export function forceFlushNow(pageData) {
  if (_flushState.rafId !== null) { cancelAnimationFrame(_flushState.rafId); _flushState.rafId = null; }
  const batch = _takeBuffer();
  _flushState.pageData = null;
  try {
    if (!pageData || batch.length === 0) return;
    if (!state.currentStroke || !state.isDrawing) return;
    if (state.pendingShape) return;

    const drawnIdx = state.currentStroke._drawnIdx || 0;

    for (const rawPoint of batch) {
      if (state.pendingShape) break;
      if (!state.currentStroke || !state.isDrawing) break;
      _processPointerPoint(rawPoint, pageData);
    }

    if (state.currentStroke && state.isDrawing &&
        !state.pendingShape && !state.scribbleMode) {
      _renderBatchTarget(pageData, drawnIdx);
    }

    if (!state.currentStroke || !state.isDrawing) return;
    checkForScribble(pageData);
  } finally {
    batch.length = 0;
    resetPointPool();
  }
}

export { isPredictionSupported, drawPredictions };