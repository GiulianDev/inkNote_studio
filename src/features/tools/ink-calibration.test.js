import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRESSURE_SENSITIVITY,
  LEGACY_PRESSURE_PARAMS,
  detectInkPlatform,
  derivePressureParams,
  cloneInkParams,
  normalizePenPressure,
  computeInkStrokeWidth,
  samplePressureCurve,
  createStrokeStabilizer,
  getHoldMoveTolerancePx,
  trimStationaryTail,
  extractEventTilt,
  computeTiltNorm
} from './ink-calibration.js';

describe('ink-calibration: cross-device pressure normalization & curve', () => {
  it('detects iPadOS MacIntel+touch vs desktop', () => {
    assert.equal(detectInkPlatform({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)', platform: 'iPad', maxTouchPoints: 5 }), 'ios');
    assert.equal(detectInkPlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
    assert.equal(detectInkPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 10 }), 'desktop');
  });

  it('expands iPad Apple Pencil raw range naturally instead of compressing flat', () => {
    const light = normalizePenPressure(0.08, { platform: 'ios', sensitivity: 50 });
    const mid   = normalizePenPressure(0.28, { platform: 'ios', sensitivity: 50 });
    const heavy = normalizePenPressure(0.55, { platform: 'ios', sensitivity: 50 });

    assert.ok(light < 0.20, `expected light Apple Pencil pressure < 0.20, got ${light}`);
    assert.ok(mid > light + 0.25 && mid < 0.65, `expected mid ~0.46, got ${mid}`);
    assert.ok(heavy > 0.80 && heavy <= 1.0, `expected heavy > 0.80, got ${heavy}`);

    const highSens = normalizePenPressure(0.28, { platform: 'ios', sensitivity: 90 });
    const lowSens  = normalizePenPressure(0.28, { platform: 'ios', sensitivity: 10 });
    assert.ok(highSens > mid && lowSens < mid);
  });

  it('produces clear width progression from curve & keeps frozen stroke inkParams immutable', () => {
    const baseSize = 3;
    const softCurve = derivePressureParams({ pressureLight: 10, pressureHeavy: 400, pressureCurve: 10, pressureSpeedWeight: 0 });
    const steepCurve = derivePressureParams({ pressureLight: 10, pressureHeavy: 400, pressureCurve: 90, pressureSpeedWeight: 0 });

    const wSoftMid = computeInkStrokeWidth('pen', baseSize, 0.45, 0, 0, 1.0, softCurve);
    const wSteepMid = computeInkStrokeWidth('pen', baseSize, 0.45, 0, 0, 1.0, steepCurve);
    const wSteepHigh = computeInkStrokeWidth('pen', baseSize, 0.95, 0, 0, 1.0, steepCurve);

    assert.ok(wSoftMid > wSteepMid * 1.4, 'soft curve must produce noticeably thicker mid-pressure stroke');
    assert.ok(wSteepHigh > wSteepMid * 2.2, 'steep curve must swell dramatically on heavy pressure');

    // Legacy stroke without inkParams uses LEGACY_PRESSURE_PARAMS regardless of global settings
    const wLegacy = computeInkStrokeWidth('pen', baseSize, 0.5, 0, 0, 1.0, null);
    const expectedLegacy = baseSize * (LEGACY_PRESSURE_PARAMS.lightMul + Math.pow(0.5, LEGACY_PRESSURE_PARAMS.curve) * (LEGACY_PRESSURE_PARAMS.heavyMul - LEGACY_PRESSURE_PARAMS.lightMul));
    assert.ok(Math.abs(wLegacy - expectedLegacy) < 1e-6);

    const frozen = cloneInkParams(softCurve);
    assert.deepEqual(Object.keys(frozen).sort(), ['curve', 'heavyMul', 'lightMul', 'speedWeight']);
  });

  it('samples monotonic curve points for SVG graph preview', () => {
    const pts = samplePressureCurve({
      pressureLight: 15,
      pressureHeavy: 350,
      pressureCurve: 60,
      pressureSensitivity: DEFAULT_PRESSURE_SENSITIVITY
    }, 20);
    assert.equal(pts.length, 21);
    assert.equal(pts[0].x, 0);
    assert.equal(pts[20].x, 1);
    for (let i = 1; i < pts.length; i++) {
      assert.ok(pts[i].y >= pts[i - 1].y, 'curve must be monotonically non-decreasing');
    }
  });
});

describe('ink-calibration: One Euro stabilizer & stationary tail trimming', () => {
  it('suppresses stationary micro-tremor jitter when smoothing > 0', () => {
    const stab = createStrokeStabilizer({ x: 100, y: 100, pressure: 0.4, timeStamp: 1000 });
    let acceptedCount = 0;
    for (let i = 1; i <= 15; i++) {
      // ±0.9px iPad jitter around (100, 100)
      const jx = (i % 2 === 0 ? 0.9 : -0.9);
      const jy = (i % 3 === 0 ? 0.7 : -0.7);
      const res = stab.filterPoint(
        { x: 100 + jx, y: 100 + jy, pressure: 0.4, timeStamp: 1000 + i * 8 },
        { smoothing: 0.65, scale: 1.0 }
      );
      if (res.accepted) acceptedCount++;
    }
    assert.equal(acceptedCount, 0, 'stationary micro-tremors should be absorbed by deadzone/One Euro');
  });

  it('tracks fast strokes closely and reduces high-frequency wobble compared to smoothing=0', () => {
    const rawTrace = [];
    for (let i = 0; i <= 30; i++) {
      const x = 50 + i * 10;
      const y = 200 + (i % 2 === 0 ? 4 : -4);
      rawTrace.push({ x, y, pressure: 0.5, timeStamp: 1000 + i * 12 });
    }

    const stabRaw = createStrokeStabilizer(rawTrace[0]);
    const stabSmooth = createStrokeStabilizer(rawTrace[0]);
    const ysRaw = [rawTrace[0].y];
    const ysSmooth = [rawTrace[0].y];

    for (let i = 1; i < rawTrace.length; i++) {
      const r0 = stabRaw.filterPoint(rawTrace[i], { smoothing: 0, scale: 1.0 });
      if (r0.accepted) ysRaw.push(r0.y);
      const r1 = stabSmooth.filterPoint(rawTrace[i], { smoothing: 0.85, scale: 1.0 });
      if (r1.accepted) ysSmooth.push(r1.y);
    }

    const wobble = (arr) => arr.reduce((acc, v) => acc + Math.abs(v - 200), 0) / arr.length;
    assert.ok(wobble(ysSmooth) < wobble(ysRaw) * 0.6, 'high smoothing must substantially dampen zigzag wobble');
  });

  it('scales hold tolerance inversely with zoom & trims trailing stationary jitter', () => {
    assert.ok(getHoldMoveTolerancePx(0.5) > getHoldMoveTolerancePx(1.5));

    const pts = [];
    for (let i = 0; i < 12; i++) pts.push({ x: 10 + i * 12, y: 100, pressure: 0.5 });
    // Add stationary jitter hook at the end around (142, 100)
    pts.push({ x: 141, y: 98, pressure: 0.5 });
    pts.push({ x: 143, y: 102, pressure: 0.5 });
    pts.push({ x: 140, y: 99, pressure: 0.5 });
    pts.push({ x: 142, y: 101, pressure: 0.5 });

    const trimmed = trimStationaryTail(pts, 5.5);
    assert.ok(trimmed.length < pts.length, 'trailing stationary jitter cluster should be trimmed');
    assert.ok(trimmed[trimmed.length - 1].x >= 130);
  });

  it('differentiates marker (Penna uniform), pen (Stilografica pressure+tilt), and pencil (Matita strong tilt)', () => {
    const baseSize = 3;
    const params = derivePressureParams({ pressureLight: 10, pressureHeavy: 380, pressureCurve: 55, pressureSpeedWeight: 20 });

    // Penna (marker): più uniforme tra pressione bassa e alta
    const mLow  = computeInkStrokeWidth('marker', baseSize, 0.1, 0, 0, 1.0, params);
    const mHigh = computeInkStrokeWidth('marker', baseSize, 0.9, 0, 0, 1.0, params);
    const mRatio = mHigh / mLow;

    // Stilografica (pen): forte variazione sia per pressione che per inclinazione
    const fLow  = computeInkStrokeWidth('pen', baseSize, 0.1, 0, 0, 1.0, params);
    const fHigh = computeInkStrokeWidth('pen', baseSize, 0.9, 0, 0, 1.0, params);
    const fTilt = computeInkStrokeWidth('pen', baseSize, 0.5, 0.8, 0, 1.0, params);
    const fNoTilt = computeInkStrokeWidth('pen', baseSize, 0.5, 0, 0, 1.0, params);
    const fRatio = fHigh / fLow;

    // Matita (pencil): massima sensibilità relativa all'inclinazione
    const pNoTilt = computeInkStrokeWidth('pencil', baseSize, 0.5, 0, 0, 1.0, params);
    const pTilt   = computeInkStrokeWidth('pencil', baseSize, 0.5, 0.85, 0, 1.0, params);

    assert.ok(mRatio < 1.45, `marker/Penna should stay uniform, got ratio ${mRatio}`);
    assert.ok(fRatio > mRatio * 3.0, `pen/Stilografica should be much more pressure-sensitive than Penna (${fRatio} vs ${mRatio})`);
    assert.ok(fTilt / fNoTilt >= 1.30, 'pen/Stilografica must respond clearly to tilt');
    assert.ok(pTilt / pNoTilt >= 2.1, 'pencil/Matita must widen strongly on tilt');
    assert.ok(pTilt / pNoTilt > fTilt / fNoTilt, 'pencil/Matita tilt ratio must exceed Stilografica');
  });

  it('keeps initial zero-pressure fallback identical across iOS, Android and desktop', () => {
    const pIos = normalizePenPressure(0, { platform: 'ios', isDrawing: false, lastValidPressure: 0 });
    const pAnd = normalizePenPressure(0, { platform: 'android', isDrawing: false, lastValidPressure: 0 });
    const pDesk = normalizePenPressure(0, { platform: 'desktop', isDrawing: false, lastValidPressure: 0 });
    assert.equal(pIos, pAnd);
    assert.equal(pAnd, pDesk);
    assert.ok(Math.abs(pIos - 0.28) < 1e-6);

    const carried = normalizePenPressure(0, { platform: 'ios', isDrawing: true, lastValidPressure: 0.62 });
    assert.ok(Math.abs(carried - 0.62) < 1e-6);
  });

  it('applies natural writing deadzone to tilt and supports altitudeAngle fallback', () => {
    // Natural 22° grip should not inflate stroke width
    assert.equal(computeTiltNorm({ tiltX: 16, tiltY: 15 }), 0);
    // ~44° slant maps to ~0.5
    const mid = computeTiltNorm({ tiltX: 44, tiltY: 0 });
    assert.ok(Math.abs(mid - 0.5) < 0.02, `expected ~0.5 tilt at 44deg, got ${mid}`);
    // >=64° flat shading saturates cleanly to 1.0
    assert.equal(computeTiltNorm({ tiltX: 65, tiltY: 0 }), 1);

    // Safari / WebKit altitudeAngle fallback when tiltX/Y are 0
    const altRad = ((90 - 45) * Math.PI) / 180; // 45° from vertical
    const extracted = extractEventTilt({ tiltX: 0, tiltY: 0, altitudeAngle: altRad, azimuthAngle: 0 });
    assert.ok(Math.hypot(extracted.tiltX, extracted.tiltY) > 44 && Math.hypot(extracted.tiltX, extracted.tiltY) < 46);
    assert.ok(computeTiltNorm(extracted) > 0.45 && computeTiltNorm(extracted) < 0.6);
  });
});


