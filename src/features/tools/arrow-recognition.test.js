import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findArrowTipTarget,
  findImplicationArrowTarget,
  buildImplicationArrowGeometry,
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

test('recognizes "=>" implication symbol (horizontal & compact) and builds crisp parallel geometry', () => {
  // Due linee leggermente imperfette + ">" finale
  const topBar = { points: sampleLine(100, 200, 144, 202, 8) };
  const botBar = { points: sampleLine(140, 214, 102, 213, 8) }; // disegnata anche da destra a sinistra!
  const chevron = sampleVShape(
    { x: 134, y: 194 },
    { x: 152, y: 208 },
    { x: 134, y: 222 }
  );

  const match = findImplicationArrowTarget(chevron, [topBar, botBar]);
  assert.ok(match, 'Expected => implication symbol to match');

  const geom = buildImplicationArrowGeometry(match, { snapAxis: true });
  assert.equal(geom.dirX, 1);
  assert.equal(geom.dirY, 0);
  // Entrambe le barre hanno uguale X iniziale/finale e terminano prima della punta
  assert.ok(Math.abs(geom.barAEndpoints[1].x - geom.barBEndpoints[1].x) < 0.01);
  assert.ok(geom.barAEndpoints[1].x < geom.tip.x);
  assert.ok(Math.abs(geom.barAEndpoints[0].y - geom.barBEndpoints[0].y) >= 7);
});

test('recognizes vertical "⇓" implication symbol drawn downward', () => {
  const leftBar = { points: sampleLine(200, 120, 200, 165, 8) };
  const rightBar = { points: sampleLine(212, 122, 212, 166, 8) };
  const chevron = sampleVShape(
    { x: 194, y: 156 },
    { x: 206, y: 173 },
    { x: 218, y: 156 }
  );

  const match = findImplicationArrowTarget(chevron, [leftBar, rightBar]);
  assert.ok(match, 'Expected vertical implication symbol to match');
  const geom = buildImplicationArrowGeometry(match, { snapAxis: true });
  assert.equal(geom.dirX, 0);
  assert.equal(geom.dirY, 1);
});

test('rejects "= v", "= <", and "11 v" so math expressions do not falsely snap to =>', () => {
  const eqTop = { points: sampleLine(100, 200, 132, 200, 6) };
  const eqBot = { points: sampleLine(100, 212, 132, 212, 6) };

  // "= v" (la v apre verso l'alto, ortogonale a "=")
  const letterV = sampleVShape(
    { x: 142, y: 196 },
    { x: 152, y: 216 },
    { x: 162, y: 196 }
  );
  assert.equal(findImplicationArrowTarget(letterV, [eqTop, eqBot]), null);

  // "= <" (la punta apre in avanti, non indietro su "=")
  const lessThan = sampleVShape(
    { x: 160, y: 194 },
    { x: 144, y: 206 },
    { x: 160, y: 218 }
  );
  assert.equal(findImplicationArrowTarget(lessThan, [eqTop, eqBot]), null);

  // "11 v" (due aste verticali con "v" scritta di fianco a destra)
  const one1 = { points: sampleLine(100, 120, 100, 165, 6) };
  const one2 = { points: sampleLine(112, 120, 112, 165, 6) };
  const sideV = sampleVShape(
    { x: 124, y: 145 },
    { x: 134, y: 165 },
    { x: 144, y: 145 }
  );
  assert.equal(findImplicationArrowTarget(sideV, [one1, one2]), null);
});
