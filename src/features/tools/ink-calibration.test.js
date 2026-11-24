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
  getStabilizerParams,
  createStrokeStabilizer,
  getHoldMoveTolerancePx,
  trimStationaryTail,
  extractEventTilt,
  computeTiltNorm
} from './ink-calibration.js';
import {
  computeSegmentSteps,
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
    const tEdge1A = getStabilizerParams(0.30, 1.0);
    const tEdge1B = getStabilizerParams(0.3001, 1.0);
    const tEdge2A = getStabilizerParams(0.70, 1.0);
    const tEdge2B = getStabilizerParams(0.7001, 1.0);

    assert.equal(tBypass.mode, 'bypass');
    assert.equal(tLow1.mode, 'geometric');
    assert.equal(tEdge1B.mode, 'balanced');
    assert.equal(tEdge2B.mode, 'calligraphy');

    assert.ok(tLow1.deadzone < 0.05, 'slider=1 deadzone must start near zero instead of jumping');
    assert.ok(Math.abs(tEdge1A.minCutoff - tEdge1B.minCutoff) < 0.1, 'tier 1->2 minCutoff must be continuous');
    assert.ok(Math.abs(tEdge2A.minCutoff - tEdge2B.minCutoff) < 0.1, 'tier 2->3 minCutoff must be continuous');
    assert.ok(Math.abs(tEdge1A.deadzone - tEdge1B.deadzone) < 0.02);
    assert.ok(Math.abs(tEdge2A.deadzone - tEdge2B.deadzone) < 0.02);
  });

  it('provides Surface Go 1 step budgeting and loop-free clamped Hermite rounding', () => {
    // Low smoothing / tiny segments use 1 step to minimize CPU/GPU arc+polygon work
    assert.equal(computeSegmentSteps(12, 0), 1);
    assert.equal(computeSegmentSteps(2.0, 0.85), 1);
    assert.equal(computeSegmentSteps(5.0, 0.20), 1);
    assert.ok(computeSegmentSteps(18, 0.25) >= 2);
    assert.ok(computeSegmentSteps(25, 0.80) === 4);

    assert.equal(computeCurveWeight(0), 0);
    assert.ok(computeCurveWeight(0.01) > 0.1 && computeCurveWeight(0.30) > 0.65);
    assert.equal(computeCurveWeight(0.85), 1);

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


