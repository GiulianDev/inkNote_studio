// ============================================================
// MODALE IMPOSTAZIONI + CALIBRAZIONE PRESSIONE
// ============================================================

import { state } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import {
  loadSettings, saveSettings, applySettings, DEFAULT_SETTINGS
} from '../../services/settings.js';
import { computeStrokeWidth } from '../editor/render.js';

export function openSettingsModal() {
  const s = loadSettings();
  const elTheme = document.getElementById('settingTheme');
  const elPrint = document.getElementById('settingPrintTheme');
  const elHand = document.getElementById('settingHandedness');
  if (elTheme) elTheme.value = s.theme;
  if (elPrint) elPrint.value = s.printTheme;
  if (elHand) elHand.value = s.handedness;

  const lightSlider = document.getElementById('pressureLightSlider');
  const heavySlider = document.getElementById('pressureHeavySlider');
  const curveSlider = document.getElementById('pressureCurveSlider');
  if (lightSlider) lightSlider.value = s.pressureLight;
  if (heavySlider) heavySlider.value = s.pressureHeavy;
  if (curveSlider) curveSlider.value = s.pressureCurve;
  _updatePressureLabels();
  _bindPressureSliders();

  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const body = modal.querySelector('.overflow-y-auto');
  if (body) body.scrollTop = 0;
  requestAnimationFrame(() => _redrawPressureTest());
}

export function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

export function confirmSettings() {
  const current = loadSettings();
  const elTheme = document.getElementById('settingTheme');
  const elPrint = document.getElementById('settingPrintTheme');
  const elHand = document.getElementById('settingHandedness');
  const lightSlider = document.getElementById('pressureLightSlider');
  const heavySlider = document.getElementById('pressureHeavySlider');
  const curveSlider = document.getElementById('pressureCurveSlider');

  const settings = {
    theme: elTheme ? elTheme.value : current.theme,
    printTheme: elPrint ? elPrint.value : current.printTheme,
    handedness: elHand ? elHand.value : current.handedness,
    smoothing: current.smoothing,
    subbarVisible: current.subbarVisible,
    compactMode: current.compactMode,
    pressureLight: lightSlider ? parseInt(lightSlider.value) : current.pressureLight,
    pressureHeavy: heavySlider ? parseInt(heavySlider.value) : current.pressureHeavy,
    pressureCurve: curveSlider ? parseInt(curveSlider.value) : current.pressureCurve
  };
  saveSettings(settings);
  applySettings(settings);
  closeSettingsModal();
  showToast('Impostazioni salvate', '⚙️');
}

// --- calibrazione pressione ---

const _pressureTestState = { strokes: [], current: null, bound: false };

function _updatePressureLabels() {
  const light = document.getElementById('pressureLightSlider');
  const heavy = document.getElementById('pressureHeavySlider');
  const curve = document.getElementById('pressureCurveSlider');
  const lightV = document.getElementById('pressureLightValue');
  const heavyV = document.getElementById('pressureHeavyValue');
  const curveV = document.getElementById('pressureCurveValue');
  if (light && lightV) lightV.innerText = light.value;
  if (heavy && heavyV) heavyV.innerText = heavy.value;
  if (curve && curveV) curveV.innerText = curve.value;
}

function _bindPressureSliders() {
  if (_pressureTestState.bound) return;
  _pressureTestState.bound = true;

  ['pressureLightSlider', 'pressureHeavySlider', 'pressureCurveSlider'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const s = loadSettings();
      s.pressureLight = parseInt(document.getElementById('pressureLightSlider').value);
      s.pressureHeavy = parseInt(document.getElementById('pressureHeavySlider').value);
      s.pressureCurve = parseInt(document.getElementById('pressureCurveSlider').value);
      saveSettings(s);
      _updatePressureLabels();
      _redrawPressureTest();
    });
  });

  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) {
    canvas.addEventListener('pointerdown', _onPressureTestDown);
    canvas.addEventListener('pointermove', _onPressureTestMove);
    canvas.addEventListener('pointerup', _onPressureTestUp);
    canvas.addEventListener('pointercancel', _onPressureTestUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

function _onPressureTestDown(e) {
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const tool = (state.activeTool === 'pen' || state.activeTool === 'pencil') ? state.activeTool : 'pen';
  const pt = {
    x: e.clientX - rect.left, y: e.clientY - rect.top,
    pressure: Math.max(0.1, e.pressure || 0.5),
    tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, speed: 0
  };
  _pressureTestState.current = { tool, size: state.strokeWidth, points: [pt] };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  _redrawPressureTest();
}

function _onPressureTestMove(e) {
  if (!_pressureTestState.current) return;
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const last = _pressureTestState.current.points[_pressureTestState.current.points.length - 1];
  const pt = {
    x: e.clientX - rect.left, y: e.clientY - rect.top,
    pressure: Math.max(0.1, e.pressure || 0.5),
    tiltX: e.tiltX || 0, tiltY: e.tiltY || 0,
    speed: Math.hypot(e.clientX - rect.left - last.x, e.clientY - rect.top - last.y)
  };
  _pressureTestState.current.points.push(pt);
  _redrawPressureTest();
}

function _onPressureTestUp(e) {
  if (_pressureTestState.current && _pressureTestState.current.points.length > 1) {
    _pressureTestState.strokes.push(_pressureTestState.current);
    // Limita a 20 stroke di test: oltre, scarta il più vecchio.
    if (_pressureTestState.strokes.length > 20) _pressureTestState.strokes.shift();
  }
  _pressureTestState.current = null;
  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
  _redrawPressureTest();
}

function _redrawPressureTest() {
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr); canvas.height = Math.floor(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const isDark = document.body.classList.contains('dark');
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const allStrokes = _pressureTestState.current
    ? [..._pressureTestState.strokes, _pressureTestState.current]
    : _pressureTestState.strokes;

  allStrokes.forEach(stroke => {
    const pts = stroke.points;
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = isDark ? '#f8fafc' : '#0f172a';
    for (let i = 1; i < pts.length; i++) {
      const p1 = pts[i - 1], p2 = pts[i];
      const tiltNorm = Math.min(1, Math.hypot(p2.tiltX, p2.tiltY) / 30);
      const speedNorm = Math.min(1, p2.speed / 8);
      const w = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, tiltNorm, speedNorm, 1.0);
      ctx.lineWidth = Math.max(0.3, w);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    ctx.restore();
  });

  if (allStrokes.length === 0) {
    ctx.fillStyle = isDark ? '#475569' : '#94a3b8';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Disegna qui con la penna per calibrare', cssW / 2, cssH / 2);
  }
}

export function resetPressureDefaults() {
  const s = loadSettings();
  s.pressureLight = DEFAULT_SETTINGS.pressureLight;
  s.pressureHeavy = DEFAULT_SETTINGS.pressureHeavy;
  s.pressureCurve = DEFAULT_SETTINGS.pressureCurve;
  saveSettings(s);
  const light = document.getElementById('pressureLightSlider');
  const heavy = document.getElementById('pressureHeavySlider');
  const curve = document.getElementById('pressureCurveSlider');
  if (light) light.value = s.pressureLight;
  if (heavy) heavy.value = s.pressureHeavy;
  if (curve) curve.value = s.pressureCurve;
  _updatePressureLabels();
  _redrawPressureTest();
  showToast('Valori di pressione ripristinati', '↩️');
}

export function clearPressureTest() {
  _pressureTestState.strokes = [];
  _pressureTestState.current = null;
  _redrawPressureTest();
}

// Bind iniziale alla load
export function initSettingsModal() {
  _bindPressureSliders();
}