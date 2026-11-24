import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recognizeMathSymbolSingleStroke,
  recognizeGreekSingleStroke,
  recognizeGreekMultiStroke
} from './math-greek-recognition.js';

function sampleLine(x0, y0, x1, y1, steps = 12) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return out;
}

function samplePolyline(verts, stepsPerSeg = 8) {
  const out = [];
  for (let i = 0; i < verts.length - 1; i++) {
    const seg = sampleLine(verts[i].x, verts[i].y, verts[i + 1].x, verts[i + 1].y, stepsPerSeg);
    if (i > 0) seg.shift();
    out.push(...seg);
  }
  return out;
}

function addJitter(pts, amp = 1.2) {
  return pts.map((p, idx) => ({
    x: p.x + Math.sin(idx * 1.7) * amp,
    y: p.y + Math.cos(idx * 2.3) * amp
  }));
}

function cubicPts(p0, p1, p2, p3, count = 16) {
  const out = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const mt = 1 - t;
    out.push({
      x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y
    });
  }
  return out;
}

test('recognizeMathSymbolSingleStroke detects round brackets ( and )', () => {
  const leftParen = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    leftParen.push({ x: 140 - Math.sin(Math.PI * t) * 28, y: 100 + t * 90 });
  }
  const resL = recognizeMathSymbolSingleStroke(addJitter(leftParen, 1.0));
  assert.equal(resL?.symbol, '(');

  const rightParen = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    rightParen.push({ x: 200 + Math.sin(Math.PI * t) * 28, y: 100 + t * 90 });
  }
  const resR = recognizeMathSymbolSingleStroke(addJitter(rightParen, 1.0));
  assert.equal(resR?.symbol, ')');
});

test('recognizeMathSymbolSingleStroke detects square brackets [ and ]', () => {
  const leftSq = samplePolyline([
    { x: 140, y: 100 },
    { x: 112, y: 100 },
    { x: 112, y: 190 },
    { x: 140, y: 190 }
  ], 10);
  const resL = recognizeMathSymbolSingleStroke(addJitter(leftSq, 1.0));
  assert.equal(resL?.symbol, '[');

  const rightSq = samplePolyline([
    { x: 200, y: 100 },
    { x: 228, y: 100 },
    { x: 228, y: 190 },
    { x: 200, y: 190 }
  ], 10);
  const resR = recognizeMathSymbolSingleStroke(addJitter(rightSq, 1.0));
  assert.equal(resR?.symbol, ']');
});

test('recognizeMathSymbolSingleStroke detects curly braces { and }', () => {
  const leftCurly = [
    ...cubicPts({ x: 150, y: 100 }, { x: 126, y: 102 }, { x: 132, y: 146 }, { x: 110, y: 155 }, 16),
    ...cubicPts({ x: 110, y: 155 }, { x: 132, y: 164 }, { x: 126, y: 208 }, { x: 150, y: 210 }, 16).slice(1)
  ];
  const resL = recognizeMathSymbolSingleStroke(addJitter(leftCurly, 0.8));
  assert.equal(resL?.symbol, '{');

  const rightCurly = [
    ...cubicPts({ x: 210, y: 100 }, { x: 234, y: 102 }, { x: 228, y: 146 }, { x: 250, y: 155 }, 16),
    ...cubicPts({ x: 250, y: 155 }, { x: 228, y: 164 }, { x: 234, y: 208 }, { x: 210, y: 210 }, 16).slice(1)
  ];
  const resR = recognizeMathSymbolSingleStroke(addJitter(rightCurly, 0.8));
  assert.equal(resR?.symbol, '}');
});

test('recognizeMathSymbolSingleStroke detects summation ∑', () => {
  const sumPts = samplePolyline([
    { x: 180, y: 100 },
    { x: 120, y: 100 },
    { x: 154, y: 140 },
    { x: 120, y: 180 },
    { x: 180, y: 180 }
  ], 10);
  const res = recognizeMathSymbolSingleStroke(addJitter(sumPts, 1.2));
  assert.equal(res?.symbol, '∑');
});

test('recognizeMathSymbolSingleStroke rejects Z and straight lines', () => {
  const zPts = samplePolyline([
    { x: 100, y: 100 },
    { x: 160, y: 100 },
    { x: 100, y: 160 },
    { x: 160, y: 160 }
  ], 10);
  assert.equal(recognizeMathSymbolSingleStroke(zPts), null);

  const vert = sampleLine(150, 100, 150, 220, 20);
  assert.equal(recognizeMathSymbolSingleStroke(vert), null);
});

test('recognizeGreekSingleStroke detects α, β, γ, Δ, Ω, ω, ε, σ', () => {
  const ox = 100, oy = 100, S = 70;
  const scale = (pts) => pts.map(p => ({ x: ox + p.x * S, y: oy + p.y * S }));

  const alpha = scale([
    ...cubicPts({ x: 0.94, y: 0.16 }, { x: 0.72, y: 0.55 }, { x: 0.46, y: 0.98 }, { x: 0.18, y: 0.96 }, 14),
    ...cubicPts({ x: 0.18, y: 0.96 }, { x: -0.02, y: 0.92 }, { x: -0.02, y: 0.12 }, { x: 0.24, y: 0.04 }, 14).slice(1),
    ...cubicPts({ x: 0.24, y: 0.04 }, { x: 0.52, y: -0.04 }, { x: 0.72, y: 0.88 }, { x: 0.96, y: 0.94 }, 14).slice(1)
  ]);
  assert.equal(recognizeGreekSingleStroke(addJitter(alpha, 1.0))?.symbol, 'α');

  const beta = [
    ...sampleLine(110, 195, 118, 120, 10),
    ...cubicPts({ x: 118, y: 120 }, { x: 122, y: 100 }, { x: 162, y: 100 }, { x: 158, y: 124 }, 12).slice(1),
    ...cubicPts({ x: 158, y: 124 }, { x: 154, y: 140 }, { x: 128, y: 143 }, { x: 126, y: 144 }, 8).slice(1),
    ...cubicPts({ x: 126, y: 144 }, { x: 168, y: 146 }, { x: 168, y: 186 }, { x: 116, y: 178 }, 14).slice(1)
  ];
  assert.equal(recognizeGreekSingleStroke(addJitter(beta, 1.0))?.symbol, 'β');

  const gamma = scale([
    ...cubicPts({ x: 0.04, y: 0.14 }, { x: 0.26, y: -0.04 }, { x: 0.58, y: 0.56 }, { x: 0.48, y: 0.96 }, 14),
    ...cubicPts({ x: 0.48, y: 0.96 }, { x: 0.40, y: 1.04 }, { x: 0.36, y: 0.66 }, { x: 0.96, y: 0.04 }, 16).slice(1)
  ]);
  assert.equal(recognizeGreekSingleStroke(addJitter(gamma, 1.0))?.symbol, 'γ');

  const upperDelta = samplePolyline([
    { x: 150, y: 100 },
    { x: 185, y: 160 },
    { x: 115, y: 160 },
    { x: 150, y: 100 }
  ], 10);
  assert.equal(recognizeGreekSingleStroke(addJitter(upperDelta, 1.0))?.symbol, 'Δ');

  const omegaUpperPts = [];
  omegaUpperPts.push(...sampleLine(100, 175, 122, 175, 6));
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI * 0.74 + (Math.PI * 2.26 - Math.PI * 0.74) * (i / 24);
    omegaUpperPts.push({ x: 138 + Math.cos(a) * 32, y: 138 + Math.sin(a) * 34 });
  }
  omegaUpperPts.push(...sampleLine(154, 175, 176, 175, 6));
  assert.equal(recognizeGreekSingleStroke(addJitter(omegaUpperPts, 0.9))?.symbol, 'Ω');

  const omegaLowerPts = [
    ...cubicPts({ x: 108, y: 112 }, { x: 96, y: 152 }, { x: 120, y: 175 }, { x: 138, y: 138 }, 16),
    ...cubicPts({ x: 138, y: 138 }, { x: 152, y: 175 }, { x: 180, y: 154 }, { x: 166, y: 112 }, 16).slice(1)
  ];
  assert.equal(recognizeGreekSingleStroke(addJitter(omegaLowerPts, 0.9))?.symbol, 'ω');

  const epsilonPts = [
    ...cubicPts({ x: 155, y: 105 }, { x: 115, y: 98 }, { x: 100, y: 130 }, { x: 138, y: 135 }, 14),
    ...cubicPts({ x: 138, y: 135 }, { x: 98, y: 142 }, { x: 110, y: 174 }, { x: 158, y: 165 }, 14).slice(1)
  ];
  assert.equal(recognizeGreekSingleStroke(addJitter(epsilonPts, 0.9))?.symbol, 'ε');

  const sigmaPts = [];
  for (let i = 0; i <= 28; i++) {
    const a = -0.35 + (-Math.PI * 2 + 0.6) * (i / 28);
    sigmaPts.push({ x: 130 + Math.cos(a) * 24, y: 140 + Math.sin(a) * 24 });
  }
  sigmaPts.push(...sampleLine(142, 118, 172, 118, 8));
  assert.equal(recognizeGreekSingleStroke(addJitter(sigmaPts, 0.8))?.symbol, 'σ');
});

test('recognizeGreekMultiStroke detects 2-stroke θ, φ, ψ, λ and 3-stroke π', () => {
  const oval = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    oval.push({ x: 200 + Math.cos(a) * 22, y: 200 + Math.sin(a) * 28 });
  }

  // θ = oval + horizontal bar
  const thetaBar = sampleLine(176, 200, 224, 200, 10);
  const resTheta = recognizeGreekMultiStroke(thetaBar, [{ points: oval }]);
  assert.equal(resTheta?.symbol, 'θ');
  assert.equal(resTheta?.updates?.length, 1);

  // φ = oval + vertical slash
  const phiBar = sampleLine(200, 160, 200, 240, 10);
  const resPhi = recognizeGreekMultiStroke(phiBar, [{ points: oval }]);
  assert.equal(resPhi?.symbol, 'φ');
  assert.equal(resPhi?.updates?.length, 1);

  // ψ = U cup + vertical stem
  const uCup = cubicPts({ x: 280, y: 180 }, { x: 282, y: 230 }, { x: 328, y: 230 }, { x: 330, y: 180 }, 20);
  const psiStem = sampleLine(305, 165, 305, 248, 12);
  const resPsi = recognizeGreekMultiStroke(psiStem, [{ points: uCup }]);
  assert.equal(resPsi?.symbol, 'ψ');

  // π = 2 legs + roof bar
  const leg1 = sampleLine(410, 190, 410, 245, 10);
  const leg2 = sampleLine(445, 190, 445, 245, 10);
  const roof = sampleLine(400, 190, 456, 190, 12);
  const resPi = recognizeGreekMultiStroke(roof, [{ points: leg1 }, { points: leg2 }]);
  assert.equal(resPi?.symbol, 'π');
  assert.equal(resPi?.updates?.length, 2);

  // λ = diagonal `\` + leg `/` from middle down-left
  const mainDiag = sampleLine(510, 170, 550, 235, 12);
  const legSlash = sampleLine(528, 200, 505, 235, 10);
  const resLambda = recognizeGreekMultiStroke(legSlash, [{ points: mainDiag }]);
  assert.equal(resLambda?.symbol, 'λ');

  // X crossing should NOT match λ
  const fullCross = sampleLine(550, 170, 505, 235, 12);
  assert.equal(recognizeGreekMultiStroke(fullCross, [{ points: mainDiag }]), null);
});

test('recognizeGreekSingleStroke rejects plain circle and straight lines', () => {
  const circle = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    circle.push({ x: 200 + Math.cos(a) * 30, y: 200 + Math.sin(a) * 30 });
  }
  assert.equal(recognizeGreekSingleStroke(circle), null);
  assert.equal(recognizeGreekSingleStroke(sampleLine(100, 100, 180, 100, 15)), null);
});

test('curly braces render with sleek Word/LaTeX proportions and vertical stems, parens stay subtly curved', () => {
  // Hand-drawn brace rather wide (w=46, h=110)
  const wideCurly = [
    ...cubicPts({ x: 156, y: 100 }, { x: 128, y: 102 }, { x: 132, y: 146 }, { x: 110, y: 155 }, 16),
    ...cubicPts({ x: 110, y: 155 }, { x: 132, y: 164 }, { x: 128, y: 208 }, { x: 156, y: 210 }, 16).slice(1)
  ];
  const braceRes = recognizeMathSymbolSingleStroke(wideCurly);
  assert.equal(braceRes?.symbol, '{');
  const xs = braceRes.points.map(p => p.x);
  const ys = braceRes.points.map(p => p.y);
  const bw = Math.max(...xs) - Math.min(...xs);
  const bh = Math.max(...ys) - Math.min(...ys);
  // Larghezza proporzionata stile LaTeX (~<= 0.28 * altezza) e cima ancorata esattamente a minY (100)
  assert.ok(bw <= bh * 0.28, `Expected sleek brace width <= 0.28*h, got ${bw / bh}`);
  assert.ok(Math.abs(Math.min(...ys) - 100) < 0.5);
  // Verifica che esista la cuspide centrale ben distinta verso sinistra
  const minX = Math.min(...xs);
  const cuspPts = braceRes.points.filter(p => Math.abs(p.x - minX) < 1.0);
  assert.ok(cuspPts.length >= 1 && Math.abs(cuspPts[0].y - 155) < 2);

  // Hand-drawn paren rather wide (w=34, h=100) -> output paren is much more slender & gentle
  const wideParen = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    wideParen.push({ x: 140 - Math.sin(Math.PI * t) * 34, y: 100 + t * 100 });
  }
  const parenRes = recognizeMathSymbolSingleStroke(wideParen);
  assert.equal(parenRes?.symbol, '(');
  const pXs = parenRes.points.map(p => p.x);
  const pw = Math.max(...pXs) - Math.min(...pXs);
  assert.ok(pw <= 18.5, `Expected restrained paren width <= 18.5px, got ${pw}`);
});

