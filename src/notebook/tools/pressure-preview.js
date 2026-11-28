/**
 * @module notebook/tools/pressure-preview
 *
 * Controller lato notebook per l'anteprima live di curva e tratto nella modale
 * Impostazioni (`#pressureCurvePath`, `#pressureCurveArea`, `#pressureTestCanvas`).
 *
 * Legge i parametri correnti da `state.settings` tramite `getPressureParams()`
 * e reagisce a `settings:changed` e `settings:modal-opened`, così `shared/settings`
 * non dipende dai moduli di rendering o calibrazione di `notebook/`.
 */

import { state } from '../../shared/core/state.js';
import { on, getEffectiveColor } from '../../shared/core/utils.js';
import { onSettingsChanged } from '../../shared/core/app-settings.js';
import { computeStrokeWidth, renderPencilPreviewStroke } from '../render/render.js';
import {
  getPressureParams,
  normalizePenPressure,
  createStrokeStabilizer,
  samplePressureCurve,
  extractEventTilt,
  computeTiltNorm,
  computeDirectionalNibFactor
} from './ink-calibration.js';

const PRESSURE_KEYS = new Set([
  'pressureSensitivity',
  'pressureLight',
  'pressureHeavy',
  'pressureCurve',
  'pressureSpeedWeight',
  'theme',
  'theme.effective'
]);

const _pressureTestState = {
  strokes: [],
  current: null
};

let _initialized = false;
let _boundCanvas = null;
let _boundClearBtn = null;

function _isSettingsModalVisible() {
  const modal = document.getElementById('settingsModal');
  return !!modal && !modal.classList.contains('hidden');
}

export function renderPressureCurveSvg() {
  const pathEl = document.getElementById('pressureCurvePath');
  const areaEl = document.getElementById('pressureCurveArea');
  if (!pathEl || !areaEl) return;

  const params = getPressureParams();
  const pts = samplePressureCurve({ ...params, platform: state.platform.family }, 28);
  const left = 12, right = 208, bottom = 78, top = 12;
  const w = right - left;
  const h = bottom - top;

  const coords = pts.map(p => ({
    x: +(left + p.x * w).toFixed(1),
    y: +(bottom - p.y * h).toFixed(1)
  }));
  if (!coords.length) return;

  const dLine = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const dArea = `${dLine} L ${coords[coords.length - 1].x} ${bottom} L ${coords[0].x} ${bottom} Z`;
  pathEl.setAttribute('d', dLine);
  areaEl.setAttribute('d', dArea);
}

function _onPressureTestDown(e) {
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const tool = (state.activeTool === 'pen' || state.activeTool === 'pencil' || state.activeTool === 'marker')
    ? state.activeTool
    : 'pen';
  const params = getPressureParams();
  const rawPressure = e.pressure || 0;
  const normP = normalizePenPressure(rawPressure, {
    platform: state.platform.family,
    sensitivity: params.sensitivity,
    isDrawing: false,
    lastValidPressure: 0
  });
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { tiltX, tiltY } = extractEventTilt(e);
  const firstPt = {
    x,
    y,
    rawPressure,
    pressure: normP,
    tiltX,
    tiltY,
    speed: 0,
    timeStamp: e.timeStamp || performance.now()
  };
  _pressureTestState.current = {
    tool,
    size: state.strokeWidth || 4,
    _stabilizer: createStrokeStabilizer(firstPt, { platform: state.platform.family }),
    _lastRawValidPressure: rawPressure > 0 ? normP : 0,
    _pendingInitialPressure: rawPressure <= 0,
    points: [firstPt]
  };
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  redrawPressureTest();
}

function _onPressureTestMove(e) {
  const cur = _pressureTestState.current;
  if (!cur) return;
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const params = getPressureParams();
  const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const events = (coalesced && coalesced.length > 0) ? coalesced : [e];
  let added = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const rawPressure = ev.pressure || 0;
    const isFallback = rawPressure <= 0;
    const normP = normalizePenPressure(rawPressure, {
      platform: state.platform.family,
      sensitivity: params.sensitivity,
      isDrawing: true,
      lastValidPressure: cur._lastRawValidPressure
    });
    if (!isFallback) {
      cur._lastRawValidPressure = normP;
      if (cur._pendingInitialPressure) {
        cur._pendingInitialPressure = false;
        for (let k = 0; k < cur.points.length; k++) {
          cur.points[k].rawPressure = rawPressure;
          cur.points[k].pressure = normP;
        }
        if (typeof cur._stabilizer.seedInitialPressure === 'function') {
          cur._stabilizer.seedInitialPressure(normP);
        }
      }
    }

    const filtered = cur._stabilizer.filterPoint({
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
      pressure: normP,
      _pressureFallback: isFallback,
      timeStamp: ev.timeStamp || performance.now()
    }, {
      smoothing: state.smoothing,
      scale: 1.0
    });
    if (!filtered.accepted) continue;

    const last = cur.points[cur.points.length - 1];
    const dist = Math.hypot(filtered.x - last.x, filtered.y - last.y);
    const speed = dist / Math.max(1, filtered.dtMs / 8.33);
    const { tiltX, tiltY } = extractEventTilt(ev);

    cur.points.push({
      x: filtered.x,
      y: filtered.y,
      rawPressure,
      pressure: filtered.pressure,
      tiltX,
      tiltY,
      speed
    });
    added = true;
  }

  if (added) redrawPressureTest();
}

function _onPressureTestUp(e) {
  if (_pressureTestState.current && _pressureTestState.current.points.length > 0) {
    _pressureTestState.strokes.push(_pressureTestState.current);
    if (_pressureTestState.strokes.length > 20) _pressureTestState.strokes.shift();
  }
  _pressureTestState.current = null;
  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) { try { canvas.releasePointerCapture(e.pointerId); } catch {} }
  redrawPressureTest();
}

function _drawTaperedSegment(ctx, p0, p1, w0, w1) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const nx = -dy / len, ny = dx / len;
  const hw0 = Math.max(w0, 0.5) / 2, hw1 = Math.max(w1, 0.5) / 2;
  ctx.moveTo(p0.x + nx * hw0, p0.y + ny * hw0);
  ctx.lineTo(p1.x + nx * hw1, p1.y + ny * hw1);
  ctx.lineTo(p1.x - nx * hw1, p1.y - ny * hw1);
  ctx.lineTo(p0.x - nx * hw0, p0.y - ny * hw0);
  ctx.closePath();
}

export function redrawPressureTest() {
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width  = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const isDark = document.body.classList.contains('dark');
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const params = getPressureParams();
  const all = _pressureTestState.current
    ? [..._pressureTestState.strokes, _pressureTestState.current]
    : _pressureTestState.strokes;

  all.forEach(stroke => {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;

    let lastValid = 0;
    const widths = pts.map((pt, idx) => {
      const pNorm = pt.rawPressure > 0
        ? normalizePenPressure(pt.rawPressure, {
            platform: state.platform.family,
            sensitivity: params.sensitivity,
            isDrawing: idx > 0,
            lastValidPressure: lastValid
          })
        : pt.pressure;
      if (pt.rawPressure > 0) lastValid = pNorm;
      const tiltNorm  = computeTiltNorm(pt);
      const speedNorm = Math.min(1, (pt.speed || 0) / 8);
      const prevPt = pts[idx > 0 ? idx - 1 : 0];
      const nextPt = pts[idx < pts.length - 1 ? idx + 1 : pts.length - 1];
      const nibMul = computeDirectionalNibFactor(nextPt.x - prevPt.x, nextPt.y - prevPt.y, stroke.tool);
      const wRaw = computeStrokeWidth(stroke.tool, stroke.size, pNorm, tiltNorm, speedNorm, 1.0, null, params);
      return Math.max(0.25, wRaw * nibMul);
    });

    const inkColor = getEffectiveColor('#000000', isDark);
    if (stroke.tool === 'pencil') {
      renderPencilPreviewStroke(ctx, pts, widths, inkColor, 1.0);
    } else {
      ctx.save();
      ctx.fillStyle = inkColor;
      if (pts.length === 1) {
        ctx.beginPath();
        const r = Math.max(0.5, widths[0]) / 2;
        ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        for (let i = 1; i < pts.length; i++) {
          _drawTaperedSegment(ctx, pts[i - 1], pts[i], widths[i - 1], widths[i]);
        }
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const r = Math.max(0.5, widths[i]) / 2;
          ctx.moveTo(pts[i].x + r, pts[i].y);
          ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.restore();
    }
  });

  if (all.length === 0) {
    ctx.fillStyle = isDark ? '#475569' : '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Disegna qui con la penna per calibrare', cssW / 2, cssH / 2);
  }
}

export function clearPressureTest() {
  _pressureTestState.strokes = [];
  _pressureTestState.current = null;
  redrawPressureTest();
}

function _bindPreviewDom() {
  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas && _boundCanvas !== canvas) {
    _boundCanvas = canvas;
    canvas.addEventListener('pointerdown',   _onPressureTestDown);
    canvas.addEventListener('pointermove',   _onPressureTestMove);
    canvas.addEventListener('pointerup',     _onPressureTestUp);
    canvas.addEventListener('pointercancel', _onPressureTestUp);
    canvas.addEventListener('contextmenu',   (e) => e.preventDefault());
  }

  const clearBtn = document.getElementById('clearPressureBtn');
  if (clearBtn && _boundClearBtn !== clearBtn) {
    _boundClearBtn = clearBtn;
    clearBtn.addEventListener('click', clearPressureTest);
  }
}

function _refreshPreview() {
  renderPressureCurveSvg();
  redrawPressureTest();
}

export function initSettingsPressurePreview() {
  _bindPreviewDom();

  if (_initialized) return;
  _initialized = true;

  on('settings:modal-opened', () => {
    _bindPreviewDom();
    _refreshPreview();
    requestAnimationFrame(_refreshPreview);
  });

  on('settings:tab-changed', ({ tab } = {}) => {
    if (tab !== 'ink') return;
    _bindPreviewDom();
    _refreshPreview();
    requestAnimationFrame(_refreshPreview);
  });

  onSettingsChanged(({ changed }) => {
    if (!_isSettingsModalVisible()) return;
    if (Array.isArray(changed) && changed.some((k) => PRESSURE_KEYS.has(k))) {
      _refreshPreview();
    }
  });
}
