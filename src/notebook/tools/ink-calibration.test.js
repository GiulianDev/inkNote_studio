import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRESSURE_SENSITIVITY,
  LEGACY_PRESSURE_PARAMS,
  detectInkPlatform,
  derivePressureParams,
  getPressureParams,
  cloneInkParams,
  normalizePenPressure,
  computeInkStrokeWidth,
  samplePressureCurve,
  getStabilizerParams,
  createStrokeStabilizer,
  getHoldMoveTolerancePx,
  trimStationaryTail,
  extractEventTilt,
  computeTiltNorm,
  computePredictionWidth,
  computeDirectionalNibFactor
} from './ink-calibration.js';
import { state } from '../../shared/core/state.js';
import {
  computeSegmentSteps,
  computePlatformSegmentSteps,
  computeCurveWeight,
  prepareSegmentCurve,
  evalSegmentCurveInto,
  computeRelaxWeight,
  buildRelaxedPoints
} from '../render/stroke-geometry.js';

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

describe('ink-calibration: multi-tier stabilizer & stationary tail trimming', () => {
  it('suppresses stationary micro-tremor jitter when smoothing > 0 across low, medium and high levels (iPad 120Hz hold)', () => {
    for (const smoothing of [0.01, 0.15, 0.50, 0.65, 0.85]) {
      const stab = createStrokeStabilizer({ x: 100, y: 100, pressure: 0.4, timeStamp: 1000 });
      let acceptedCount = 0;
      for (let i = 1; i <= 40; i++) {
        // ±1.1px iPad 120Hz stationary tremor around (100, 100)
        const jx = (i % 2 === 0 ? 1.05 : -1.05);
        const jy = (i % 3 === 0 ? 0.75 : -0.75);
        const res = stab.filterPoint(
          { x: 100 + jx, y: 100 + jy, pressure: 0.4, timeStamp: 1000 + i * 8.33 },
          { smoothing, scale: 1.0 }
        );
        if (res.accepted) acceptedCount++;
      }
      assert.equal(acceptedCount, 0, `stationary iPad hold tremor must not draw jitter lines at smoothing=${smoothing}`);
    }
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

  it('keeps near-zero spatial lag at low smoothing (0 -> 1 -> 15) on 60Hz Surface Go 1 strokes', () => {
    const measureTrackingLag = (smoothing) => {
      const stab = createStrokeStabilizer({ x: 100, y: 100, pressure: 0.5, timeStamp: 1000 });
      let maxLag = 0;
      for (let i = 1; i <= 20; i++) {
        // Handwriting arc ~300 px/s at 60Hz (16.67ms per sample)
        const rawX = 100 + i * 5;
        const rawY = 100 + Math.sin(i * 0.35) * 8;
        const res = stab.filterPoint(
          { x: rawX, y: rawY, pressure: 0.5, timeStamp: 1000 + i * 16.67 },
          { smoothing, scale: 1.0 }
        );
        const lag = Math.hypot(rawX - res.x, rawY - res.y);
        if (lag > maxLag) maxLag = lag;
      }
      return maxLag;
    };

    const lag0 = measureTrackingLag(0);
    const lag1 = measureTrackingLag(0.01);
    const lag2 = measureTrackingLag(0.02);
    const lag15 = measureTrackingLag(0.15);
    const lag50 = measureTrackingLag(0.50);
    const lag90 = measureTrackingLag(0.90);

    assert.equal(lag0, 0, 'smoothing=0 must have exact zero spatial lag');
    assert.ok(lag1 < 0.75, `smoothing=1 must not jump into heavy lag (got ${lag1}px)`);
    assert.ok(lag2 < 0.85, `smoothing=2 must stay ultra-responsive (got ${lag2}px)`);
    assert.ok(lag15 < 1.5, `smoothing=15 must stay under 1.5px lag (got ${lag15}px)`);
    assert.ok(lag1 <= lag15 && lag15 <= lag50 && lag50 <= lag90, 'lag/damping progression must be monotonic across tiers');
  });

  it('transitions continuously across tier boundaries without sudden parameter cliffs', () => {
    const tBypass = getStabilizerParams(0, 1.0);
    const tLow1 = getStabilizerParams(0.01, 1.0);
    const tLow30 = getStabilizerParams(0.30, 1.0);
    const tMidA = getStabilizerParams(0.65, 1.0);
    const tMidB = getStabilizerParams(0.6501, 1.0);

    assert.equal(tBypass.mode, 'bypass');
    assert.equal(tLow1.mode, 'gaussian');
    assert.equal(tLow30.mode, 'gaussian');
    assert.equal(tMidA.mode, 'gaussian');
    assert.equal(tMidB.mode, 'strong');

    assert.ok(tLow1.deadzone < 0.05, 'slider=1 deadzone must start near zero instead of jumping');
    assert.ok(Math.abs(tMidA.minCutoff - tMidB.minCutoff) < 0.1, 'gaussian->strong minCutoff must be continuous');
    assert.ok(Math.abs(tMidA.beta - tMidB.beta) < 0.01, 'gaussian->strong beta must be continuous');
    assert.ok(Math.abs(tMidA.liveBlend - tMidB.liveBlend) < 0.01, 'gaussian->strong liveBlend must be continuous');
    assert.ok(Math.abs(tMidA.deadzone - tMidB.deadzone) < 0.02);
  });

  it('provides Surface Go 1 step budgeting and loop-free clamped Hermite rounding', () => {
    // Low smoothing / tiny segments use 1 step to minimize CPU/GPU arc+polygon work
    assert.equal(computeSegmentSteps(12, 0), 1);
    assert.equal(computeSegmentSteps(2.0, 0.85), 1);
    assert.equal(computeSegmentSteps(4.0, 0.20), 1);
    assert.ok(computeSegmentSteps(6.0, 0.20) >= 2, 'low smoothing unlocks gentle rounding on 5-14px handwriting segments');
    assert.ok(computeSegmentSteps(18, 0.25) >= 2);
    assert.ok(computeSegmentSteps(25, 0.80) === 4);

    assert.equal(computeCurveWeight(0), 0);
    assert.ok(computeCurveWeight(0.01) > 0.02 && computeCurveWeight(0.30) >= 0.18 && computeCurveWeight(0.30) < 0.30);
    assert.ok(computeCurveWeight(0.85) > 0.75 && computeCurveWeight(0.85) < 1);

    // Uneven segment lengths (20px followed by 2px) must not loop/overshoot wildly
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 20, y: 0 };
    const p2 = { x: 22, y: 2 };
    const p3 = { x: 40, y: 20 };
    const curve = {};
    const out = {};
    prepareSegmentCurve(curve, p0, p1, p2, p3, Math.hypot(2, 2), 0.85);
    for (let i = 1; i < 4; i++) {
      evalSegmentCurveInto(out, p1, p2, curve, i / 4);
      assert.ok(out.x >= 19.5 && out.x <= 22.5, `clamped curve x stayed bounded (got ${out.x})`);
      assert.ok(out.y >= -0.5 && out.y <= 2.5, `clamped curve y stayed bounded (got ${out.y})`);
    }
  });

  it('relaxes zigzag micro-wobble progressively without mutating stroke points or blunting big corners', () => {
    assert.equal(computeRelaxWeight(0), 0);
    assert.ok(computeRelaxWeight(0.50) > computeRelaxWeight(0.15));
    assert.ok(computeRelaxWeight(0.85) > computeRelaxWeight(0.50));

    const zigzag = [];
    for (let i = 0; i <= 16; i++) {
      zigzag.push({ x: i * 10, y: 100 + (i % 2 === 0 ? 3.5 : -3.5), pressure: 0.5 });
    }
    const rawPts = buildRelaxedPoints(zigzag, 0);
    const midPts = buildRelaxedPoints(zigzag, 0.50);
    const highPts = buildRelaxedPoints(zigzag, 0.85);

    assert.equal(rawPts, zigzag, 'smoothing=0 must return original points array without allocation');
    assert.equal(highPts[0], zigzag[0], 'endpoints must remain anchored');
    assert.equal(highPts[highPts.length - 1], zigzag[zigzag.length - 1]);

    const avgDev = (arr) => arr.slice(1, -1).reduce((s, p) => s + Math.abs(p.y - 100), 0) / (arr.length - 2);
    assert.ok(avgDev(midPts) < avgDev(zigzag) * 0.7, 'medium smoothing must attenuate micro-wobble');
    assert.ok(avgDev(highPts) < avgDev(midPts) * 0.5, 'high smoothing must strongly flatten micro-wobble');

    // Low smoothing (20%) rounds short micro-tremor (3px steps) while keeping real 90deg corners sharp
    const fineTremor = [];
    for (let i = 0; i <= 14; i++) {
      fineTremor.push({ x: i * 3, y: 100 + (i % 2 === 0 ? 1.5 : -1.5), pressure: 0.5 });
    }
    const lowTremorSmoothed = buildRelaxedPoints(fineTremor, 0.20);
    assert.ok(avgDev(lowTremorSmoothed) < avgDev(fineTremor) * 0.65, 'low smoothing must visibly round short-step hand tremor');

    const sharpL = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 20, pressure: 0.5 },
      { x: 0, y: 40, pressure: 0.5 },
      { x: 20, y: 40, pressure: 0.5 },
      { x: 40, y: 40, pressure: 0.5 }
    ];
    const sharpSmoothed = buildRelaxedPoints(sharpL, 0.20);
    assert.ok(Math.hypot(sharpSmoothed[2].x - 0, sharpSmoothed[2].y - 40) < 0.6, 'authentic L corner with 20px legs must stay sharp at low smoothing');
  });

  it('scales hold tolerance inversely with zoom & trims long stationary hold jitter completely', () => {
    assert.ok(getHoldMoveTolerancePx(0.5) > getHoldMoveTolerancePx(1.5));

    const pts = [];
    for (let i = 0; i < 12; i++) pts.push({ x: 10 + i * 12, y: 100, pressure: 0.5 });
    // Simulate long 320ms+ iPad 120Hz hold (36 jitter samples clustered around (142, 100))
    for (let j = 0; j < 36; j++) {
      pts.push({ x: 142 + (j % 2 === 0 ? 1.5 : -1.5), y: 100 + (j % 3 === 0 ? 1.8 : -1.8), pressure: 0.5 });
    }

    const trimmed = trimStationaryTail(pts, 5.5);
    assert.ok(trimmed.length <= 13, `entire stationary hold cluster should be trimmed (got len ${trimmed.length})`);
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

  it('computes dynamic pressure-matched prediction width and reseeds synthetic entry pressure cleanly', () => {
    const params = derivePressureParams({ pressureLight: 10, pressureHeavy: 360, pressureCurve: 60, pressureSpeedWeight: 20 });

    const lightPredW = computePredictionWidth({
      tool: 'pen',
      baseSize: 3,
      lastPoint: { pressure: 0.08, tiltX: 0, tiltY: 0, speed: 0 },
      predictedEvents: [{ pressure: 0.05, tiltX: 0, tiltY: 0 }],
      inkParams: params,
      platform: 'ios',
      sensitivity: 50
    });
    const heavyPredW = computePredictionWidth({
      tool: 'pen',
      baseSize: 3,
      lastPoint: { pressure: 0.72, tiltX: 0, tiltY: 0, speed: 0 },
      predictedEvents: [{ pressure: 0.55, tiltX: 0, tiltY: 0 }],
      inkParams: params,
      platform: 'ios',
      sensitivity: 50
    });
    const zeroPredW = computePredictionWidth({
      tool: 'pen',
      baseSize: 3,
      lastPoint: { pressure: 0.72, tiltX: 0, tiltY: 0, speed: 0 },
      predictedEvents: [{ pressure: 0, tiltX: 0, tiltY: 0 }],
      inkParams: params,
      platform: 'ios',
      sensitivity: 50
    });
    const hlPredW = computePredictionWidth({
      tool: 'highlighter',
      baseSize: 3,
      lastPoint: { pressure: 0.9, tiltX: 0, tiltY: 0, speed: 0 },
      predictedEvents: [{ pressure: 0.9 }]
    });

    assert.ok(heavyPredW > lightPredW * 3.5, `prediction width must scale with pen pressure (${heavyPredW} vs ${lightPredW})`);
    assert.ok(zeroPredW > lightPredW * 3.5, 'zero-pressure predicted event must fall back to lastPoint pressure');
    assert.equal(hlPredW, 12);

    // Sub-deadzone pressure progression and synthetic initial reseeding
    const stab = createStrokeStabilizer({ x: 50, y: 50, pressure: 0.28, timeStamp: 100 });
    stab.seedInitialPressure(0.07);
    // Move slightly within deadzone while ramping up pressure (fallback=false)
    const sub1 = stab.filterPoint({ x: 50.2, y: 50, pressure: 0.45, _pressureFallback: false, timeStamp: 108 }, { smoothing: 0.5, scale: 1 });
    assert.equal(sub1.accepted, false);
    // Fallback sample (pressure=0 -> 0.28) must NOT overwrite tracked real pressure
    const subFallback = stab.filterPoint({ x: 50.3, y: 50, pressure: 0.28, _pressureFallback: true, timeStamp: 116 }, { smoothing: 0.5, scale: 1 });
    assert.equal(subFallback.accepted, false);
    assert.ok(Math.abs(subFallback.pressure - sub1.pressure) < 1e-6);
    // Next accepted move continues cleanly from updated pressure
    const acc = stab.filterPoint({ x: 62, y: 50, pressure: 0.65, _pressureFallback: false, timeStamp: 124 }, { smoothing: 0.5, scale: 1 });
    assert.equal(acc.accepted, true);
    assert.ok(acc.pressure > 0.40, `expected continuous sub-deadzone + move pressure ramp > 0.40, got ${acc.pressure}`);
  });

  it('optimizes stabilizer behavior per platform (ios near-zero lag, desktop sharp corner, android irregular dt, zero hold tremor on all)', () => {
    // 1. Stationary hold tremor = 0 accepted across ios, android, desktop
    for (const platform of ['ios', 'android', 'desktop']) {
      for (const smoothing of [0.05, 0.35, 0.75]) {
        const stab = createStrokeStabilizer({ x: 200, y: 200, pressure: 0.4, timeStamp: 1000 }, { platform });
        let accepted = 0;
        for (let i = 1; i <= 30; i++) {
          const r = stab.filterPoint(
            { x: 200 + (i % 2 ? 0.95 : -0.95), y: 200 + (i % 3 ? 0.7 : -0.7), pressure: 0.4, timeStamp: 1000 + i * 8.33 },
            { smoothing, scale: 1.0 }
          );
          if (r.accepted) accepted++;
        }
        assert.equal(accepted, 0, `${platform} hold tremor must stay 0 at smoothing=${smoothing}`);
      }
    }

    // 2. iOS (Apple Pencil) stays faster/lower-lag than desktop at 40% smoothing
    const measureLag = (platform, dtMs) => {
      const stab = createStrokeStabilizer({ x: 100, y: 100, pressure: 0.5, timeStamp: 1000 }, { platform });
      let maxLag = 0;
      for (let i = 1; i <= 15; i++) {
        const rx = 100 + i * 7;
        const ry = 100 + Math.sin(i * 0.4) * 10;
        const res = stab.filterPoint({ x: rx, y: ry, pressure: 0.5, timeStamp: 1000 + i * dtMs }, { smoothing: 0.40, scale: 1.0 });
        maxLag = Math.max(maxLag, Math.hypot(rx - res.x, ry - res.y));
      }
      return maxLag;
    };
    const iosLag40 = measureLag('ios', 8.33);
    const deskLag40 = measureLag('desktop', 16.67);
    assert.ok(iosLag40 < deskLag40, `iOS should track with lower lag than desktop at 40% (${iosLag40} vs ${deskLag40})`);
    assert.ok(iosLag40 < 1.2, `iOS lag at 40% should be minimal (< 1.2px, got ${iosLag40})`);

    // 3. Desktop sharp 90deg V-corner stays crisp (trendGain disengages around sharp turn)
    const deskStab = createStrokeStabilizer({ x: 50, y: 50, pressure: 0.5, timeStamp: 1000 }, { platform: 'desktop' });
    let lastOut = { x: 50, y: 50 };
    for (let i = 1; i <= 6; i++) {
      lastOut = deskStab.filterPoint({ x: 50 + i * 8, y: 50 + i * 8, pressure: 0.5, timeStamp: 1000 + i * 16.67 }, { smoothing: 0.30, scale: 1.0 });
    }
    const cornerApex = lastOut;
    for (let i = 1; i <= 6; i++) {
      lastOut = deskStab.filterPoint({ x: 98 + i * 8, y: 98 - i * 8, pressure: 0.5, timeStamp: 1100 + i * 16.67 }, { smoothing: 0.30, scale: 1.0 });
    }
    assert.ok(cornerApex.x > 90 && cornerApex.y > 90, 'corner apex should track near vertex (98, 98)');
    assert.ok(lastOut.y < 60, `ascending leg of sharp V-corner must climb back cleanly (got y=${lastOut.y})`);

    // 4. Android handles irregular coalesced dtMs gracefully
    const andStab = createStrokeStabilizer({ x: 100, y: 100, pressure: 0.5, timeStamp: 1000 }, { platform: 'android' });
    const dts = [4, 24, 5, 22, 6, 18];
    let ts = 1000;
    let outAnd = null;
    for (let i = 0; i < dts.length; i++) {
      ts += dts[i];
      outAnd = andStab.filterPoint({ x: 100 + (i + 1) * 10, y: 100, pressure: 0.5, timeStamp: ts }, { smoothing: 0.45, scale: 1.0 });
    }
    assert.ok(outAnd && outAnd.accepted && outAnd.x > 145, 'Android stabilizer progresses cleanly under irregular timestamps');
  });

  it('keeps Centripetal Catmull-Rom loop-free under extreme spacing jumps and caps desktop steps', () => {
    // Extreme uneven segment ratio: 35px -> 3px -> 38px must never create cusps or loops
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 35, y: 0 };
    const p2 = { x: 38, y: 2 };
    const p3 = { x: 76, y: 38 };
    const curve = {};
    const out = {};
    prepareSegmentCurve(curve, p0, p1, p2, p3, Math.hypot(3, 2), 0.95);
    let prevX = p1.x;
    for (let i = 1; i <= 8; i++) {
      evalSegmentCurveInto(out, p1, p2, curve, i / 8);
      assert.ok(out.x >= prevX - 0.05 && out.x <= p2.x + 0.3, `monotonic non-looping x (got ${out.x} vs prev ${prevX})`);
      assert.ok(out.y >= -0.4 && out.y <= 2.4, `bounded centripetal y (got ${out.y})`);
      prevX = out.x;
    }

    // Platform step budgets: desktop saves polygon vertices on Surface Go 1
    assert.equal(computePlatformSegmentSteps(28, 0.85, 'desktop'), 3);
    assert.equal(computePlatformSegmentSteps(40, 0.85, 'ios'), 5);
  });

  it('gives Stilografica (pen) authentic speed tapering and directional fountain-nib contrast vs uniform marker', () => {
    const params = derivePressureParams({ pressureLight: 10, pressureHeavy: 360, pressureCurve: 60, pressureSpeedWeight: 20 });
    const baseSize = 3;

    // Velocity thinning on Stilografica: fast flick is clearly thinner than slow pool
    const slowW = computeInkStrokeWidth('pen', baseSize, 0.5, 0, 0.05, 1.0, params);
    const fastW = computeInkStrokeWidth('pen', baseSize, 0.5, 0, 0.90, 1.0, params);
    assert.ok(fastW < slowW * 0.80, `fast Stilografica flick must slim noticeably (${fastW} vs ${slowW})`);

    // Directional nib factor: downward strokes thicker than horizontal/upward hairlines for pen, neutral for marker/pencil
    const downNib = computeDirectionalNibFactor(2, 12, 'pen');
    const crossNib = computeDirectionalNibFactor(12, 1, 'pen');
    const upNib = computeDirectionalNibFactor(8, -10, 'pen');
    assert.ok(downNib > 1.05 && crossNib < 0.95 && downNib > crossNib * 1.18, `expected fountain downstroke > crossbar (${downNib} vs ${crossNib}, up=${upNib})`);
    assert.equal(computeDirectionalNibFactor(2, 12, 'marker'), 1.0);
    assert.equal(computeDirectionalNibFactor(12, 1, 'pencil'), 1.0);
  });

  it('reads and updates cached getPressureParams dynamically from state.settings', () => {
    const prev = state.settings;
    try {
      state.settings = {
        pressureSensitivity: 25,
        pressureLight: 20,
        pressureHeavy: 280,
        pressureCurve: 40,
        pressureSpeedWeight: 10
      };
      const first = getPressureParams();
      assert.equal(first.sensitivity, 25);
      assert.equal(getPressureParams(), first, 'should return memoized instance for identical settings');

      state.settings = {
        ...state.settings,
        pressureSensitivity: 80,
        pressureHeavy: 420
      };
      const updated = getPressureParams();
      assert.notEqual(updated, first);
      assert.equal(updated.sensitivity, 80);
      assert.equal(updated.heavyMul, 4.2);
    } finally {
      state.settings = prev;
    }
  });
});



