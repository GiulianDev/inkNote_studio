import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findArrowTipTarget,
  analyzeSingleStrokeArrow
} from './arrow-recognition.js';

function sampleLine(x0, y0, x1, y1, count = 12) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return pts;
}

function sampleVShape(pStart, tip, pEnd, perWing = 4) {
  const w1 = sampleLine(pStart.x, pStart.y, tip.x, tip.y, perWing);
  const w2 = sampleLine(tip.x, tip.y, pEnd.x, pEnd.y, perWing).slice(1);
  return [...w1, ...w2];
}

test('recognizes > arrowhead at the end of a horizontal axis line', () => {
  const axis = { points: sampleLine(100, 300, 320, 300, 20) };
  const arrowTip = sampleVShape(
    { x: 302, y: 288 },
    { x: 321, y: 300 },
    { x: 302, y: 312 }
  );

  const match = findArrowTipTarget(arrowTip, [axis]);
  assert.ok(match, 'Expected horizontal axis arrowhead to match');
  assert.ok(Math.hypot(match.target.end.x - 320, match.target.end.y - 300) < 1);
  assert.ok(match.target.dirX > 0.99);
});

test('recognizes ^ arrowhead at the top of a vertical axis line drawn bottom-to-top', () => {
  const axis = { points: sampleLine(200, 420, 200, 120, 20) };
  const arrowTip = sampleVShape(
    { x: 188, y: 138 },
    { x: 200, y: 119 },
    { x: 212, y: 138 }
  );

  const match = findArrowTipTarget(arrowTip, [axis]);
  assert.ok(match, 'Expected vertical axis arrowhead to match');
  assert.ok(Math.hypot(match.target.end.x - 200, match.target.end.y - 120) < 1);
  assert.ok(match.target.dirY < -0.99);
});

test('rejects "l v" handwriting where "v" is beside "l" rather than on its axis', () => {
  // Lettera "l" verticale alta 55px a x=100
  const letterL = { points: sampleLine(100, 100, 100, 155, 10) };
  // Lettera "v" scritta subito a destra (x=114..134, punta a x=124) — vicina a (100, 155) ma fuori asse!
  const letterV = sampleVShape(
    { x: 114, y: 132 },
    { x: 124, y: 154 },
    { x: 134, y: 132 }
  );

  assert.equal(findArrowTipTarget(letterV, [letterL]), null);

  // Anche con "v" vicinissima lateralmente (punta a soli 11px a destra di "l")
  const closeV = sampleVShape(
    { x: 103, y: 135 },
    { x: 111, y: 155 },
    { x: 121, y: 135 }
  );
  assert.equal(findArrowTipTarget(closeV, [letterL]), null);
});

test('rejects "d v" handwriting where "d" is a curved letter with stem, not a straight line', () => {
  // Lettera "d": anello curvo seguito da asta verticale che termina in basso a (120, 160)
  const letterD = [
    { x: 120, y: 138 },
    { x: 106, y: 136 },
    { x: 96, y: 146 },
    { x: 98, y: 158 },
    { x: 112, y: 160 },
    { x: 120, y: 150 },
    { x: 120, y: 102 },
    { x: 120, y: 122 },
    { x: 120, y: 142 },
    { x: 120, y: 160 }
  ];
  // Lettera "v" subito vicino alla base di "d"
  const letterV = sampleVShape(
    { x: 108, y: 142 },
    { x: 120, y: 160 },
    { x: 132, y: 142 }
  );

  assert.equal(findArrowTipTarget(letterV, [{ points: letterD }]), null);
});

test('detects valid single-stroke continuous arrow and ignores short non-arrow strokes', () => {
  const shaft = sampleLine(100, 200, 220, 200, 12);
  const wing1 = sampleLine(220, 200, 202, 186, 4).slice(1);
  const backToTip = sampleLine(202, 186, 220, 200, 3).slice(1);
  const wing2 = sampleLine(220, 200, 202, 214, 4).slice(1);
  const arrowPts = [...shaft, ...wing1, ...backToTip, ...wing2];

  const single = analyzeSingleStrokeArrow(arrowPts);
  assert.ok(single, 'Expected single-stroke continuous arrow to match');
  assert.ok(Math.hypot(single.rawTip.x - 220, single.rawTip.y - 200) < 10);

  // Short "7" stroke (only one backward wing, no opposite wing)
  const sevenPts = [
    ...sampleLine(100, 100, 150, 100, 8),
    ...sampleLine(150, 100, 120, 145, 8).slice(1)
  ];
  assert.equal(analyzeSingleStrokeArrow(sevenPts), null);
});
