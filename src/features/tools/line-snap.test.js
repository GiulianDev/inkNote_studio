import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAngleSnap,
  evaluateLineHoldCandidate,
  evaluateUltraStraightLineCandidate
} from './line-snap.js';

function makeLine(x0, y0, x1, y1, count = 20, wobbleAmp = 0) {
  const pts = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const w = wobbleAmp * Math.sin(t * Math.PI * 3);
    pts.push({ x: x0 + dx * t + nx * w, y: y0 + dy * t + ny * w, pressure: 0.5 });
  }
  return pts;
}

describe('line-snap: hold-to-snap vs strict release auto-snap & H/V hysteresis', () => {
  it('snaps within 4 deg, releases past 8 deg, and NEVER re-snaps after unlock on the same line', () => {
    const start = { x: 100, y: 200 };
    // Within 4 deg of horizontal -> engages h
    const resH = applyAngleSnap(start, { x: 300, y: 210 }, null, false);
    assert.equal(resH.axis, 'h');
    assert.equal(resH.rejected, false);
    assert.equal(resH.y, 200);

    // At 6 deg (still under 8 deg release) -> holds h
    const holdH = applyAngleSnap(start, { x: 300, y: 221 }, resH.axis, resH.rejected);
    assert.equal(holdH.axis, 'h');
    assert.equal(holdH.rejected, false);
    assert.equal(holdH.y, 200);

    // At 12 deg -> releases h and marks rejected = true for this line
    const relH = applyAngleSnap(start, { x: 300, y: 243 }, holdH.axis, holdH.rejected);
    assert.equal(relH.axis, null);
    assert.equal(relH.rejected, true);
    assert.equal(relH.y, 243);

    // Moving back close to horizontal (1.7 deg) on the SAME line must NOT re-snap!
    const slightAngle = applyAngleSnap(start, { x: 300, y: 206 }, relH.axis, relH.rejected);
    assert.equal(slightAngle.axis, null);
    assert.equal(slightAngle.rejected, true);
    assert.equal(slightAngle.y, 206);

    // Moving close to vertical (2 deg) on that same unlocked line must also stay free
    const nearV = applyAngleSnap(start, { x: 105, y: 400 }, slightAngle.axis, slightAngle.rejected);
    assert.equal(nearV.axis, null);
    assert.equal(nearV.rejected, true);
    assert.equal(nearV.x, 105);

    // A NEW line (rejected = false) snaps cleanly again
    const freshV = applyAngleSnap(start, { x: 105, y: 400 }, null, false);
    assert.equal(freshV.axis, 'v');
    assert.equal(freshV.rejected, false);
    assert.equal(freshV.x, 100);
  });

  it('rejects casual handwritten lines and curved letters on release auto-snap', () => {
    // Typical slightly bowed handwritten underline (3.2px bow over 180px)
    const casualLine = makeLine(50, 200, 230, 204, 18, 3.2);
    assert.ok(evaluateLineHoldCandidate(casualLine), 'hold mode still accepts casual straight line');
    assert.equal(evaluateUltraStraightLineCandidate(casualLine), null, 'release auto-snap must NOT snap casual bowed line');

    // Short vertical stroke like digit "1" or letter "l" (55px)
    const shortStroke = makeLine(120, 100, 122, 155, 12, 0.2);
    assert.equal(evaluateUltraStraightLineCandidate(shortStroke), null, 'short stroke under 80px must not auto-snap on release');

    // Line with slight entry hook
    const hooked = makeLine(50, 100, 220, 100, 20, 0.2);
    hooked[0] = { x: 46, y: 112, pressure: 0.4 };
    assert.equal(evaluateUltraStraightLineCandidate(hooked), null, 'hooked stroke must not auto-snap');
  });

  it('accepts truly ruler-straight regular lines on release auto-snap', () => {
    const rulerStraight = makeLine(60, 300, 280, 303, 24, 0.35);
    const res = evaluateUltraStraightLineCandidate(rulerStraight);
    assert.ok(res, 'ultra-straight line should auto-snap on release');
    assert.equal(res.end.y, 300, 'near-horizontal ultra-straight line snaps cleanly to Y=300');
  });

  it('still snaps a short fast line after a long stationary iPad hold with tail jitter', () => {
    const lineWithHold = makeLine(80, 220, 240, 220, 14, 0.6);
    for (let j = 0; j < 36; j++) {
      lineWithHold.push({
        x: 240 + (j % 2 === 0 ? 1.8 : -1.8),
        y: 220 + (j % 3 === 0 ? -1.6 : 1.6),
        pressure: 0.5
      });
    }
    const res = evaluateLineHoldCandidate(lineWithHold);
    assert.ok(res, 'long iPad hold jitter cluster must not break line hold-to-snap');
  });
});
