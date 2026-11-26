import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProfileFamily,
  getDeviceProfile,
  initDeviceProfile,
  getActiveDeviceProfile,
  desktopProfile,
  iosProfile,
  androidProfile
} from './index.js';
import { cleanIosLinePoints } from './ios.js';
import {
  evaluateLineHoldCandidate,
  evaluateUltraStraightLineCandidate
} from '../../tools/line-snap.js';
import { computePlatformSegmentSteps } from '../../render/stroke-geometry.js';

function makeLine(x0, y0, x1, y1, count = 24, wobbleAmp = 0) {
  const pts = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const w = wobbleAmp * Math.sin(t * Math.PI * 3);
    pts.push({ x: x0 + dx * t + nx * w, y: y0 + dy * t + ny * w, pressure: 0.25 });
  }
  return pts;
}

describe('platform profiles registry & Surface/iPadOS/Android separation', () => {
  it('resolves desktop, ios, android and defaults safely to desktop', () => {
    assert.equal(resolveProfileFamily('ios'), 'ios');
    assert.equal(resolveProfileFamily('android'), 'android');
    assert.equal(resolveProfileFamily('desktop'), 'desktop');
    assert.equal(resolveProfileFamily({ family: 'ios' }), 'ios');
    assert.equal(resolveProfileFamily('unknown'), 'desktop');
    assert.equal(resolveProfileFamily(null), 'desktop');

    assert.equal(getDeviceProfile('desktop'), desktopProfile);
    assert.equal(getDeviceProfile('ios'), iosProfile);
    assert.equal(getDeviceProfile('android'), androidProfile);

    initDeviceProfile({ family: 'ios' });
    assert.equal(getActiveDeviceProfile(), iosProfile);
    assert.equal(getActiveDeviceProfile('desktop'), desktopProfile);
    initDeviceProfile({ family: 'desktop' });
    assert.equal(getActiveDeviceProfile(), desktopProfile);
  });

  it('preserves 100% desktop (Surface/PC) thresholds, joint cutoff, and step caps', () => {
    assert.equal(desktopProfile.pressure.baseGain, 1.0);
    assert.equal(desktopProfile.pressure.minRenderWidthPx, 0.25);
    assert.equal(desktopProfile.rendering.alwaysJoinThinSegments, false);
    assert.equal(desktopProfile.rendering.jointMinWidthThresholdPx, 1.8);
    assert.equal(desktopProfile.input.capturePointerUpEndpoint, false);
    assert.equal(desktopProfile.input.dedupCoalescedMinDistPx, 0);

    // Desktop caps segLen <= 34 at 3 even at high smoothness; iOS/Android allow 5 above 34px
    assert.equal(computePlatformSegmentSteps(34, 0.9, 'desktop'), 3);
    assert.equal(computePlatformSegmentSteps(48, 0.9, 'ios'), 5);
    assert.equal(computePlatformSegmentSteps(48, 0.9, 'android'), 5);

    // Desktop still rejects bowed lines, short strokes, and entry hooks
    const casualLine = makeLine(50, 200, 230, 204, 18, 3.2);
    assert.equal(evaluateUltraStraightLineCandidate(casualLine, { platform: 'desktop' }), null);

    const hooked = makeLine(50, 100, 220, 100, 20, 0.2);
    hooked[0] = { x: 46, y: 112, pressure: 0.4 };
    assert.equal(evaluateUltraStraightLineCandidate(hooked, { platform: 'desktop' }), null);
  });

  it('prevents dropping valid mid-stroke pen moves at pressure=0 on iOS/iPadOS only', () => {
    const activeState = { isDrawing: true, currentPointerId: 42 };
    const zeroMoveSamePen = { pointerType: 'pen', pointerId: 42, buttons: 0, pressure: 0 };
    const zeroMoveHoverPen = { pointerType: 'pen', pointerId: 42, buttons: 0, pressure: 0 };
    const zeroMoveOtherPen = { pointerType: 'pen', pointerId: 99, buttons: 0, pressure: 0 };

    assert.equal(desktopProfile.input.shouldIgnoreUnpressedPenMove(zeroMoveSamePen, activeState), true);
    assert.equal(androidProfile.input.shouldIgnoreUnpressedPenMove(zeroMoveSamePen, activeState), true);

    assert.equal(iosProfile.input.shouldIgnoreUnpressedPenMove(zeroMoveSamePen, activeState), false);
    assert.equal(
      iosProfile.input.shouldIgnoreUnpressedPenMove(zeroMoveHoverPen, { isDrawing: false, currentPointerId: 42 }),
      true
    );
    assert.equal(iosProfile.input.shouldIgnoreUnpressedPenMove(zeroMoveOtherPen, activeState), true);
  });

  it('configures iOS thin-stroke circular joints and sub-pixel suppression cleanly', () => {
    assert.equal(iosProfile.rendering.alwaysJoinThinSegments, true);
    assert.equal(iosProfile.rendering.jointMinWidthThresholdPx, 0);
    assert.equal(iosProfile.pressure.minRenderWidthPx, 0.45);
    assert.equal(iosProfile.input.capturePointerUpEndpoint, true);
    assert.ok(iosProfile.input.dedupCoalescedMinDistPx > 0);
    assert.equal(iosProfile.stabilizer.minDeadzonePx(0.02), 0);
    assert.ok(iosProfile.stabilizer.minDeadzonePx(0.35) > 0.3);
  });

  it('recognizes 120/240Hz iPadOS straight lines with landing/lift-off micro-hooks without mutating input', () => {
    const pts = [];
    // Micro-gancio di atterraggio inclinato (6px)
    pts.push({ x: 75, y: 207, pressure: 0.08 });
    pts.push({ x: 77, y: 204, pressure: 0.12 });
    pts.push({ x: 79, y: 201.5, pressure: 0.16 });
    // Corpo centrale a ~120Hz (55 punti lungo 200px) con micro-jitter +-0.65px
    for (let i = 0; i <= 54; i++) {
      const t = i / 54;
      const jitter = (i % 2 === 0 ? 0.6 : -0.6) * Math.sin(i * 0.7);
      pts.push({
        x: 80 + 200 * t,
        y: 200 + 2 * t + jitter,
        pressure: 0.22
      });
    }
    // Micro-gancio finale da sollevamento (7px verso l'alto-destra)
    pts.push({ x: 282, y: 199, pressure: 0.09 });
    pts.push({ x: 285, y: 195, pressure: 0.03 });

    const originalCopy = JSON.parse(JSON.stringify(pts));

    // Su desktop la stessa linea con micro-ganci non deve cambiare comportamento (resta rifiutata)
    assert.equal(evaluateUltraStraightLineCandidate(pts, { platform: 'desktop' }), null);

    // Su iOS/iPadOS viene riconosciuta e snappata in orizzontale
    const res = evaluateUltraStraightLineCandidate(pts, { platform: 'ios' });
    assert.ok(res, 'iPadOS straight line with landing/lift-off micro-hooks should snap');
    assert.equal(res.end.y, res.start.y);
    assert.ok(res.end.x - res.start.x >= 180);

    // Non distruttivo: pts originali intatti
    assert.deepEqual(pts, originalCopy);
  });

  it('does NOT falsely snap casual curves, short "1"/"l", genuine "L", or "c" arcs on iPadOS', () => {
    // Linea ondulata / curva casuale (3.2px bow)
    const casualLine = makeLine(50, 200, 230, 204, 36, 3.2);
    assert.equal(evaluateUltraStraightLineCandidate(casualLine, { platform: 'ios' }), null);

    // Tratto corto come cifra "1" o lettera "l" (55px)
    const shortStroke = makeLine(120, 100, 122, 155, 16, 0.2);
    assert.equal(evaluateUltraStraightLineCandidate(shortStroke, { platform: 'ios' }), null);

    // Lettera "L" genuina (asta verticale 80px + piede orizzontale 40px)
    const letterL = [
      ...makeLine(100, 100, 100, 180, 20, 0.2),
      ...makeLine(102, 180, 140, 180, 12, 0.2)
    ];
    assert.equal(evaluateUltraStraightLineCandidate(letterL, { platform: 'ios' }), null);

    // Arco "c"
    const arcC = [];
    for (let i = 0; i <= 24; i++) {
      const a = -Math.PI * 0.35 + (i / 24) * Math.PI * 1.1;
      arcC.push({ x: 160 - Math.cos(a) * 38, y: 160 + Math.sin(a) * 48, pressure: 0.25 });
    }
    assert.equal(evaluateUltraStraightLineCandidate(arcC, { platform: 'ios' }), null);
  });

  it('snaps hold-to-snap lines on iPadOS even with tail jitter cluster and final lift-off slip', () => {
    const pts = makeLine(80, 220, 240, 220, 28, 0.8);
    for (let j = 0; j < 30; j++) {
      pts.push({
        x: 240 + (j % 2 === 0 ? 2.1 : -2.1),
        y: 220 + (j % 3 === 0 ? -1.9 : 1.9),
        pressure: 0.15
      });
    }
    // Scatto finale da sollevamento Apple Pencil
    pts.push({ x: 245, y: 213, pressure: 0.02 });

    const cleaned = cleanIosLinePoints(pts, 6.5);
    assert.ok(cleaned.length < pts.length);

    const holdRes = evaluateLineHoldCandidate(pts, { platform: 'ios' });
    assert.ok(holdRes, 'iPadOS hold-to-snap should absorb tail cluster and lift-off slip');
    assert.ok(holdRes.end.x - holdRes.start.x >= 140);
  });
});
