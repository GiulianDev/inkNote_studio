// ============================================================
// SETTINGS MODULE — si autogestisce (markup + binding + stato)
//
// NOTA v2: rimosso backdrop-blur dal markup per evitare il
// flicker dei canvas delle pagine durante lo scroll del modal.
// Inoltre applichiamo un "paint containment" via classe CSS
// (vedi style.css → #settingsModal) per isolare il repaint
// del modal dal resto della pagina.
//
// NOTA sidebar pagine: il select "settingPagesSidebarPosition"
// aggiorna `pagesSidebar.position` in app-settings. La sidebar
// (feature/pages-sidebar) sottoscrive `settings:changed` e si
// riposiziona automaticamente senza rebuild.
// ============================================================

import { state } from '../../core/state.js';
import { showToast, getEffectiveColor } from '../../core/utils.js';
import {
  DEFAULT_SETTINGS, getSettings, updateSettings,
  onSettingsChanged, getPressureParams
} from '../../core/app-settings.js';
import { computeStrokeWidth, renderPencilPreviewStroke } from '../render/render.js';
import {
  detectInkPlatform,
  normalizePenPressure,
  createStrokeStabilizer,
  samplePressureCurve,
  extractEventTilt,
  computeTiltNorm,
  computeDirectionalNibFactor
} from '../tools/ink-calibration.js';
import { closeAllEditorMenus } from '../toolbar/toolbar.js';

import settingsHtml from './settings-modal.html?raw';

let _mounted = false;
let _isOpen  = false;
/** @type {typeof DEFAULT_SETTINGS|null} */
let _draftSnapshot = null;

export function mountSettingsModal() {
  if (_mounted || document.getElementById('settingsModal')) {
    _mounted = true;
    return;
  }
  document.body.insertAdjacentHTML('beforeend', settingsHtml);
  _bindAll();
  _mounted = true;
}

export function openSettingsModal() {
  closeAllEditorMenus();
  mountSettingsModal();

  if (!_isOpen) {
    _draftSnapshot = { ...getSettings() };
    _isOpen = true;
  }

  const s = getSettings();
  _setValue('settingTheme',            s.theme);
  _setValue('settingPrintTheme',       s.printTheme);
  _setValue('settingHandedness',       s.handedness);
  _setValue('settingDockSize',         s.dockSize);
  _setValue('settingPagesSidebarPosition', s.pagesSidebar?.position || 'left');
  const autoHideEl = document.getElementById('settingAutoHideDock');
  if (autoHideEl) autoHideEl.checked = !!s.autoHideDock;
  const libTextEl = document.getElementById('settingLibraryShowTextBelow');
  if (libTextEl) libTextEl.checked = !!s.libraryShowTextBelow;

  _setValue('pressureSensitivitySlider', s.pressureSensitivity);
  _setValue('pressureLightSlider',       s.pressureLight);
  _setValue('pressureHeavySlider',       s.pressureHeavy);
  _setValue('pressureCurveSlider',       s.pressureCurve);
  _setValue('pressureSpeedWeightSlider', s.pressureSpeedWeight);
  _setValue('scrollSensitivitySlider',   s.scrollSensitivity);

  const platformBadge = document.getElementById('inkPlatformBadge');
  if (platformBadge) {
    const plat = _pressureTestState.platform;
    platformBadge.textContent = plat === 'ios'
      ? 'Profilo iPad / Apple Pencil'
      : (plat === 'android' ? 'Profilo Android' : 'Profilo Desktop / Surface');
  }

  _refreshLabels();
  _renderPressureCurveSvg();
  _redrawPressureTest();

  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const body = modal.querySelector('.overflow-y-auto');
  if (body) body.scrollTop = 0;
  requestAnimationFrame(() => {
    _renderPressureCurveSvg();
    _redrawPressureTest();
  });
}

export function closeSettingsModal({ cancel = true } = {}) {
  if (cancel && _draftSnapshot) {
    updateSettings(_draftSnapshot, { persist: true });
  }

  _draftSnapshot = null;
  _isOpen = false;

  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

export function confirmSettings() {
  const s = getSettings();
  const printTheme   = _getValue('settingPrintTheme') ?? s.printTheme;
  const handedness   = _getValue('settingHandedness') ?? s.handedness;
  const dockSize     = _getValue('settingDockSize')   ?? s.dockSize;
  const autoHideEl   = document.getElementById('settingAutoHideDock');
  const autoHideDock = autoHideEl ? !!autoHideEl.checked : !!s.autoHideDock;
  const libTextEl    = document.getElementById('settingLibraryShowTextBelow');
  const libraryShowTextBelow = libTextEl ? !!libTextEl.checked : !!s.libraryShowTextBelow;

  const pressureSensitivity = _getIntValue('pressureSensitivitySlider', s.pressureSensitivity);
  const pressureLight       = _getIntValue('pressureLightSlider', s.pressureLight);
  const pressureHeavy       = _getIntValue('pressureHeavySlider', s.pressureHeavy);
  const pressureCurve       = _getIntValue('pressureCurveSlider', s.pressureCurve);
  const pressureSpeedWeight = _getIntValue('pressureSpeedWeightSlider', s.pressureSpeedWeight);

  updateSettings({
    printTheme,
    handedness,
    dockSize,
    autoHideDock,
    libraryShowTextBelow,
    pressureSensitivity,
    pressureLight,
    pressureHeavy,
    pressureCurve,
    pressureSpeedWeight
  }, { persist: true });

  _draftSnapshot = null;
  _isOpen = false;
  closeSettingsModal({ cancel: false });
  showToast('Impostazioni salvate', '⚙️');
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
function _setValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function _getValue(id)    { const el = document.getElementById(id); return el ? el.value : null; }
function _getIntValue(id, fallback) {
  const raw = _getValue(id);
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function _setText(id, v)  { const el = document.getElementById(id); if (el) el.innerText = v; }

function _refreshLabels() {
  const s = getSettings();
  _setText('pressureSensitivityValue', s.pressureSensitivity);
  _setText('pressureLightValue',       s.pressureLight);
  _setText('pressureHeavyValue',       s.pressureHeavy);
  _setText('pressureCurveValue',       s.pressureCurve);
  _setText('pressureSpeedWeightValue', s.pressureSpeedWeight);
  _setText('scrollSensitivityValue',   s.scrollSensitivity);
}

function _renderPressureCurveSvg() {
  const pathEl = document.getElementById('pressureCurvePath');
  const areaEl = document.getElementById('pressureCurveArea');
  if (!pathEl || !areaEl) return;

  const params = getPressureParams();
  const pts = samplePressureCurve({ ...params, platform: _pressureTestState.platform }, 28);
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

// ------------------------------------------------------------
// BINDING
// ------------------------------------------------------------
let _bound = false;

function _bindAll() {
  if (_bound) return;
  _bound = true;

  document.getElementById('settingTheme')
    ?.addEventListener('change', (e) =>
      updateSettings({ theme: e.target.value }, { persist: false }));

  // Sidebar pagine: la posizione è global e persistita subito.
  // La sidebar (feature/pages-sidebar) sottoscrive `settings:changed`
  // e si riposiziona senza rebuild.
  document.getElementById('settingPagesSidebarPosition')
    ?.addEventListener('change', (e) => {
      const pos = e.target.value === 'right' ? 'right' : 'left';
      updateSettings(
        { pagesSidebar: { ...getSettings().pagesSidebar, position: pos } },
        { persist: true }
      );
    });

  document.getElementById('settingAutoHideDock')
    ?.addEventListener('change', (e) => {
      updateSettings({ autoHideDock: !!e.target.checked }, { persist: false });
    });

  document.getElementById('settingLibraryShowTextBelow')
    ?.addEventListener('change', (e) => {
      updateSettings({ libraryShowTextBelow: !!e.target.checked }, { persist: false });
    });

  [
    'pressureSensitivitySlider',
    'pressureLightSlider',
    'pressureHeavySlider',
    'pressureCurveSlider',
    'pressureSpeedWeightSlider'
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      const s = getSettings();
      updateSettings({
        pressureSensitivity: _getIntValue('pressureSensitivitySlider', s.pressureSensitivity),
        pressureLight:       _getIntValue('pressureLightSlider', s.pressureLight),
        pressureHeavy:       _getIntValue('pressureHeavySlider', s.pressureHeavy),
        pressureCurve:       _getIntValue('pressureCurveSlider', s.pressureCurve),
        pressureSpeedWeight: _getIntValue('pressureSpeedWeightSlider', s.pressureSpeedWeight)
      }, { persist: false });
      _refreshLabels();
      _renderPressureCurveSvg();
      _redrawPressureTest();
    });
  });

  document.getElementById('scrollSensitivitySlider')?.addEventListener('input', (e) => {
    updateSettings({ scrollSensitivity: parseInt(e.target.value, 10) }, { persist: false });
    _setText('scrollSensitivityValue', e.target.value);
  });

  document.getElementById('confirmSettingsBtn')?.addEventListener('click', confirmSettings);
  document.getElementById('cancelSettingsBtn') ?.addEventListener('click', () => closeSettingsModal());
  document.getElementById('resetPressureBtn')  ?.addEventListener('click', _resetPressureDefaults);
  document.getElementById('clearPressureBtn')  ?.addEventListener('click', _clearPressureTest);

  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) {
    canvas.addEventListener('pointerdown',   _onPressureTestDown);
    canvas.addEventListener('pointermove',   _onPressureTestMove);
    canvas.addEventListener('pointerup',     _onPressureTestUp);
    canvas.addEventListener('pointercancel', _onPressureTestUp);
    canvas.addEventListener('contextmenu',   (e) => e.preventDefault());
  }

  const modal = document.getElementById('settingsModal');
  let backdropDown = false;

  modal?.addEventListener('pointerdown', (e) => {
    backdropDown = (e.target === e.currentTarget);
  });

  modal?.addEventListener('pointerup', (e) => {
    if (backdropDown && e.target === e.currentTarget) {
      closeSettingsModal();
    }
    backdropDown = false;
  });

  modal?.addEventListener('pointercancel', () => { backdropDown = false; });

  onSettingsChanged(({ changed }) => {
    if (!_isOpen) return;
    if (changed.includes('theme') || changed.includes('theme.effective')) {
      _redrawPressureTest();
    }
  });
}

// ------------------------------------------------------------
// PRESSURE TEST CANVAS
// ------------------------------------------------------------
const _pressureTestState = {
  platform: detectInkPlatform(),
  strokes: [],
  current: null
};

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
    platform: _pressureTestState.platform,
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
    _stabilizer: createStrokeStabilizer(firstPt, { platform: _pressureTestState.platform }),
    _lastRawValidPressure: rawPressure > 0 ? normP : 0,
    _pendingInitialPressure: rawPressure <= 0,
    points: [firstPt]
  };
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  _redrawPressureTest();
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
      platform: _pressureTestState.platform,
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

  if (added) _redrawPressureTest();
}

function _onPressureTestUp(e) {
  if (_pressureTestState.current && _pressureTestState.current.points.length > 0) {
    _pressureTestState.strokes.push(_pressureTestState.current);
    if (_pressureTestState.strokes.length > 20) _pressureTestState.strokes.shift();
  }
  _pressureTestState.current = null;
  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) { try { canvas.releasePointerCapture(e.pointerId); } catch {} }
  _redrawPressureTest();
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

function _redrawPressureTest() {
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
            platform: _pressureTestState.platform,
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

function _resetPressureDefaults() {
  updateSettings({
    pressureSensitivity: DEFAULT_SETTINGS.pressureSensitivity,
    pressureLight:       DEFAULT_SETTINGS.pressureLight,
    pressureHeavy:       DEFAULT_SETTINGS.pressureHeavy,
    pressureCurve:       DEFAULT_SETTINGS.pressureCurve,
    pressureSpeedWeight: DEFAULT_SETTINGS.pressureSpeedWeight
  }, { persist: false });
  _setValue('pressureSensitivitySlider', DEFAULT_SETTINGS.pressureSensitivity);
  _setValue('pressureLightSlider',       DEFAULT_SETTINGS.pressureLight);
  _setValue('pressureHeavySlider',       DEFAULT_SETTINGS.pressureHeavy);
  _setValue('pressureCurveSlider',       DEFAULT_SETTINGS.pressureCurve);
  _setValue('pressureSpeedWeightSlider', DEFAULT_SETTINGS.pressureSpeedWeight);
  _refreshLabels();
  _renderPressureCurveSvg();
  _redrawPressureTest();
  showToast('Valori di pressione ripristinati', '↩️');
}

function _clearPressureTest() {
  _pressureTestState.strokes = [];
  _pressureTestState.current = null;
  _redrawPressureTest();
}