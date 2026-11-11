// ============================================================
// SETTINGS MODULE — si autogestisce (markup + binding + stato)
// ============================================================

import { state } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import {
  DEFAULT_SETTINGS, getSettings, updateSettings,
  onSettingsChanged
} from '../../core/app-settings.js';
import { computeStrokeWidth } from '../editor/render.js';

import settingsHtml from './settings.html?raw';

// ------------------------------------------------------------
// MOUNT — inietta il markup una volta sola (idempotente)
// ------------------------------------------------------------
let _mounted = false;

export function mountSettingsModal() {
  if (_mounted || document.getElementById('settingsModal')) {
    _mounted = true;
    return;
  }
  document.body.insertAdjacentHTML('beforeend', settingsHtml);
  _bindAll();
  _mounted = true;
}

// ------------------------------------------------------------
// OPEN / CLOSE
// ------------------------------------------------------------
export function openSettingsModal() {
  mountSettingsModal();

  const s = getSettings();
  _setValue('settingTheme',            s.theme);
  _setValue('settingPrintTheme',       s.printTheme);
  _setValue('settingHandedness',       s.handedness);
  _setValue('settingDockSize',         s.dockSize);
  _setValue('pressureLightSlider',     s.pressureLight);
  _setValue('pressureHeavySlider',     s.pressureHeavy);
  _setValue('pressureCurveSlider',     s.pressureCurve);
  _setValue('scrollSensitivitySlider', s.scrollSensitivity);
  _refreshLabels();
  _redrawPressureTest();

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

/**
 * Commit dei select "non-live" (theme è live, gli altri no).
 * Gli slider pressione/scroll sono già persistiti dal loro `input`.
 */
export function confirmSettings() {
  updateSettings({
    printTheme: _getValue('settingPrintTheme') ?? getSettings().printTheme,
    handedness: _getValue('settingHandedness') ?? getSettings().handedness,
    dockSize:   _getValue('settingDockSize')   ?? getSettings().dockSize
  });
  closeSettingsModal();
  showToast('Impostazioni salvate', '⚙️');
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
function _setValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function _getValue(id)    { const el = document.getElementById(id); return el ? el.value : null; }
function _setText(id, v)  { const el = document.getElementById(id); if (el) el.innerText = v; }

function _refreshLabels() {
  const s = getSettings();
  _setText('pressureLightValue',     s.pressureLight);
  _setText('pressureHeavyValue',     s.pressureHeavy);
  _setText('pressureCurveValue',     s.pressureCurve);
  _setText('scrollSensitivityValue', s.scrollSensitivity);
}

// ------------------------------------------------------------
// BINDING — una sola volta, alla prima mount
// ------------------------------------------------------------
let _bound = false;

function _bindAll() {
  if (_bound) return;
  _bound = true;

  // Select "live" (immediato, non attende "Salva")
  document.getElementById('settingTheme')
    ?.addEventListener('change', (e) => updateSettings({ theme: e.target.value }));

  // Slider pressione: real-time + persist
  ['pressureLightSlider', 'pressureHeavySlider', 'pressureCurveSlider'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      updateSettings({
        pressureLight: parseInt(_getValue('pressureLightSlider')),
        pressureHeavy: parseInt(_getValue('pressureHeavySlider')),
        pressureCurve: parseInt(_getValue('pressureCurveSlider'))
      });
      _refreshLabels();
      _redrawPressureTest();
    });
  });

  // Scroll sensitivity: real-time + persist
  document.getElementById('scrollSensitivitySlider')?.addEventListener('input', (e) => {
    updateSettings({ scrollSensitivity: parseInt(e.target.value) });
    _setText('scrollSensitivityValue', e.target.value);
  });

  // Bottoni
  document.getElementById('confirmSettingsBtn')?.addEventListener('click', confirmSettings);
  document.getElementById('cancelSettingsBtn') ?.addEventListener('click', closeSettingsModal);
  document.getElementById('resetPressureBtn')  ?.addEventListener('click', _resetPressureDefaults);
  document.getElementById('clearPressureBtn')  ?.addEventListener('click', _clearPressureTest);

  // Canvas di test pressione
  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) {
    canvas.addEventListener('pointerdown',   _onPressureTestDown);
    canvas.addEventListener('pointermove',   _onPressureTestMove);
    canvas.addEventListener('pointerup',     _onPressureTestUp);
    canvas.addEventListener('pointercancel', _onPressureTestUp);
    canvas.addEventListener('contextmenu',   (e) => e.preventDefault());
  }

  // Ridisegna il test se il tema cambia mentre il modale è aperto
  onSettingsChanged(({ changed }) => {
    if (!_isModalOpen()) return;
    if (changed.includes('theme') || changed.includes('theme.effective')) {
      _redrawPressureTest();
    }
  });
}

function _isModalOpen() {
  const m = document.getElementById('settingsModal');
  return m && !m.classList.contains('hidden');
}

// ------------------------------------------------------------
// PRESSURE TEST CANVAS
// ------------------------------------------------------------
const _pressureTestState = { strokes: [], current: null };

function _onPressureTestDown(e) {
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const tool = (state.activeTool === 'pen' || state.activeTool === 'pencil') ? state.activeTool : 'pen';
  _pressureTestState.current = {
    tool, size: state.strokeWidth, points: [{
      x: e.clientX - rect.left, y: e.clientY - rect.top,
      pressure: Math.max(0.1, e.pressure || 0.5),
      tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, speed: 0
    }]
  };
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  _redrawPressureTest();
}

function _onPressureTestMove(e) {
  if (!_pressureTestState.current) return;
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const last = _pressureTestState.current.points[_pressureTestState.current.points.length - 1];
  _pressureTestState.current.points.push({
    x: e.clientX - rect.left, y: e.clientY - rect.top,
    pressure: Math.max(0.1, e.pressure || 0.5),
    tiltX: e.tiltX || 0, tiltY: e.tiltY || 0,
    speed: Math.hypot(e.clientX - rect.left - last.x, e.clientY - rect.top - last.y)
  });
  _redrawPressureTest();
}

function _onPressureTestUp(e) {
  if (_pressureTestState.current && _pressureTestState.current.points.length > 1) {
    _pressureTestState.strokes.push(_pressureTestState.current);
    if (_pressureTestState.strokes.length > 20) _pressureTestState.strokes.shift();
  }
  _pressureTestState.current = null;
  const canvas = document.getElementById('pressureTestCanvas');
  if (canvas) { try { canvas.releasePointerCapture(e.pointerId); } catch {} }
  _redrawPressureTest();
}

function _redrawPressureTest() {
  const canvas = document.getElementById('pressureTestCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
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

  const all = _pressureTestState.current
    ? [..._pressureTestState.strokes, _pressureTestState.current]
    : _pressureTestState.strokes;

  all.forEach(stroke => {
    const pts = stroke.points;
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = isDark ? '#f8fafc' : '#0f172a';
    for (let i = 1; i < pts.length; i++) {
      const p1 = pts[i - 1], p2 = pts[i];
      const tiltNorm  = Math.min(1, Math.hypot(p2.tiltX, p2.tiltY) / 30);
      const speedNorm = Math.min(1, p2.speed / 8);
      const w = computeStrokeWidth(stroke.tool, stroke.size, p2.pressure, tiltNorm, speedNorm, 1.0);
      ctx.lineWidth = Math.max(0.3, w);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    ctx.restore();
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
    pressureLight: DEFAULT_SETTINGS.pressureLight,
    pressureHeavy: DEFAULT_SETTINGS.pressureHeavy,
    pressureCurve: DEFAULT_SETTINGS.pressureCurve
  });
  _setValue('pressureLightSlider', DEFAULT_SETTINGS.pressureLight);
  _setValue('pressureHeavySlider', DEFAULT_SETTINGS.pressureHeavy);
  _setValue('pressureCurveSlider', DEFAULT_SETTINGS.pressureCurve);
  _refreshLabels();
  _redrawPressureTest();
  showToast('Valori di pressione ripristinati', '↩️');
}

function _clearPressureTest() {
  _pressureTestState.strokes = [];
  _pressureTestState.current = null;
  _redrawPressureTest();
}