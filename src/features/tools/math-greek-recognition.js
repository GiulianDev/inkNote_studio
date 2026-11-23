/**
 * @module features/tools/math-greek-recognition
 *
 * Logica geometrica pura (zero DOM/state) per riconoscimento di:
 *   1. Simboli matematici: `( )`, `[ ]`, `{ }`, `∑` (e `=> / ⇒` in arrow-recognition.js)
 *   2. Lettere greche: `α β γ δ ε ζ θ λ μ π σ φ ψ ω Δ Σ Ω`
 *      (1 tratto + varianti naturali a 2/3 tratti per `θ`, `φ`, `ψ`, `π`, `λ`).
 */

import { distSqPointToSegment } from './arrow-recognition.js';

const TEMPLATE_SAMPLES = 48;

// ------------------------------------------------------------
// Helpers geometrici base
// ------------------------------------------------------------

export function buildCornerPolyline(vertices, step = 6) {
  if (!Array.isArray(vertices) || vertices.length === 0) return [];
  const out = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    out.push({ x: a.x, y: a.y, pressure: 0.5 });
    if (len > 5) {
      const guardT = Math.min(0.15, 2 / len);
      const midSteps = Math.max(1, Math.floor((len - 4) / step));
      out.push({ x: a.x + dx * guardT, y: a.y + dy * guardT, pressure: 0.5 });
      for (let k = 1; k < midSteps; k++) {
        const t = guardT + (1 - 2 * guardT) * (k / midSteps);
        out.push({ x: a.x + dx * t, y: a.y + dy * t, pressure: 0.5 });
      }
      out.push({ x: a.x + dx * (1 - guardT), y: a.y + dy * (1 - guardT), pressure: 0.5 });
    }
  }
  const last = vertices[vertices.length - 1];
  out.push({ x: last.x, y: last.y, pressure: 0.5 });
  return out;
}

export function computeMetrics(pts) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let pathLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return {
    minX,
    maxX,
    minY,
    maxY,
    w,
    h,
    cx: minX + w * 0.5,
    cy: minY + h * 0.5,
    diag: Math.hypot(w, h),
    pathLen
  };
}

export function resamplePath(pts, n = TEMPLATE_SAMPLES) {
  if (!Array.isArray(pts) || pts.length === 0) return [];
  if (pts.length === 1 || n <= 1) return [{ x: pts[0].x, y: pts[0].y, pressure: 0.5 }];

  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(total);
  }
  if (total < 1e-6) {
    return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y, pressure: 0.5 }));
  }

  const out = [{ x: pts[0].x, y: pts[0].y, pressure: 0.5 }];
  let seg = 1;
  for (let k = 1; k < n - 1; k++) {
    const target = (k / (n - 1)) * total;
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const prev = cum[seg - 1];
    const next = cum[seg];
    const span = Math.max(1e-6, next - prev);
    const t = Math.max(0, Math.min(1, (target - prev) / span));
    out.push({
      x: pts[seg - 1].x + (pts[seg].x - pts[seg - 1].x) * t,
      y: pts[seg - 1].y + (pts[seg].y - pts[seg - 1].y) * t,
      pressure: 0.5
    });
  }
  const last = pts[pts.length - 1];
  out.push({ x: last.x, y: last.y, pressure: 0.5 });
  return out;
}

function normalizeUnitBox(pts, n = TEMPLATE_SAMPLES) {
  const res = resamplePath(pts, n);
  const m = computeMetrics(res);
  const w = Math.max(1e-6, m.w);
  const h = Math.max(1e-6, m.h);
  return res.map(p => ({
    x: (p.x - m.minX) / w,
    y: (p.y - m.minY) / h
  }));
}

function normalizedRmsDistance(aNorm, bNorm) {
  const n = Math.min(aNorm.length, bNorm.length);
  if (n === 0) return Infinity;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = aNorm[i].x - bNorm[i].x;
    const dy = aNorm[i].y - bNorm[i].y;
    sumSq += dx * dx + dy * dy;
  }
  return Math.sqrt(sumSq / n);
}

function evalUnitCurve(unitPts, x0, y0, w, h) {
  return unitPts.map(p => ({
    x: x0 + p.x * w,
    y: y0 + p.y * h,
    pressure: 0.5
  }));
}

function segmentsIntersect(a, b, c, d) {
  const ccw = (p1, p2, p3) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
  return (ccw(a, c, d) !== ccw(b, c, d)) && (ccw(a, b, c) !== ccw(a, b, d));
}

function hasSelfIntersection(resPts) {
  const n = resPts.length;
  if (n < 8) return false;
  for (let i = 0; i < n - 4; i++) {
    for (let j = i + 3; j < n - 1; j++) {
      if (i === 0 && j >= n - 2) continue;
      if (segmentsIntersect(resPts[i], resPts[i + 1], resPts[j], resPts[j + 1])) {
        return true;
      }
    }
  }
  return false;
}

function sampleCubicBezier(p0, p1, p2, p3, count) {
  const out = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const mt = 1 - t;
    out.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
    });
  }
  return out;
}

function sampleEllipse(cx, cy, rx, ry, steps = 40, startAngle = 0, endAngle = Math.PI * 2) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = startAngle + (endAngle - startAngle) * (i / steps);
    out.push({
      x: cx + Math.cos(a) * rx,
      y: cy + Math.sin(a) * ry,
      pressure: 0.5
    });
  }
  return out;
}

// ------------------------------------------------------------
// Generatori canonici (coordinate normalizzate [0..1] x [0..1])
// ------------------------------------------------------------

function buildRoundParenUnit(side) {
  const pts = [];
  const steps = 36;
  const xEnd = side === '(' ? 1.0 : 0.0;
  const xMid = side === '(' ? 0.0 : 1.0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = Math.sin(Math.PI * t);
    pts.push({
      x: xEnd + (xMid - xEnd) * s,
      y: t
    });
  }
  return pts;
}

function buildCurlyBraceUnit(side) {
  // `{` ha cuspide centrale a sinistra (x=0) ed estremità aperte a destra (x=1)
  const isLeft = side === '{';
  const xOpen = isLeft ? 1.0 : 0.0;
  const xMid = isLeft ? 0.45 : 0.55;
  const xCusp = isLeft ? 0.0 : 1.0;

  const upper = sampleCubicBezier(
    { x: xOpen, y: 0.0 },
    { x: xMid, y: 0.02 },
    { x: xMid + (xOpen - xMid) * 0.15, y: 0.44 },
    { x: xCusp, y: 0.5 },
    20
  );
  const lower = sampleCubicBezier(
    { x: xCusp, y: 0.5 },
    { x: xMid + (xOpen - xMid) * 0.15, y: 0.56 },
    { x: xMid, y: 0.98 },
    { x: xOpen, y: 1.0 },
    20
  );
  return upper.concat(lower.slice(1));
}

function buildSquareBracketUnit(side) {
  const xOpen = side === '[' ? 1.0 : 0.0;
  const xSpine = side === '[' ? 0.0 : 1.0;
  return [
    { x: xOpen, y: 0.0 },
    { x: xSpine, y: 0.0 },
    { x: xSpine, y: 1.0 },
    { x: xOpen, y: 1.0 }
  ];
}

function buildSummationUnit() {
  return [
    { x: 1.0, y: 0.0 },
    { x: 0.0, y: 0.0 },
    { x: 0.56, y: 0.5 },
    { x: 0.0, y: 1.0 },
    { x: 1.0, y: 1.0 }
  ];
}

function buildAlphaUnit() {
  // α: parte alto-destra, scende girando a sinistra, torna in basso a destra
  const pts = [];
  const p1 = sampleCubicBezier(
    { x: 0.94, y: 0.16 },
    { x: 0.72, y: 0.55 },
    { x: 0.46, y: 0.98 },
    { x: 0.18, y: 0.96 },
    16
  );
  const p2 = sampleCubicBezier(
    { x: 0.18, y: 0.96 },
    { x: -0.02, y: 0.92 },
    { x: -0.02, y: 0.12 },
    { x: 0.24, y: 0.04 },
    16
  );
  const p3 = sampleCubicBezier(
    { x: 0.24, y: 0.04 },
    { x: 0.52, y: -0.04 },
    { x: 0.72, y: 0.88 },
    { x: 0.96, y: 0.94 },
    16
  );
  pts.push(...p1, ...p2.slice(1), ...p3.slice(1));
  return normalizeUnitBox(pts, TEMPLATE_SAMPLES);
}

function buildBetaUnit() {
  // β: asta su da basso-sinistra + doppio occhiello a destra
  const s1 = [
    { x: 0.08, y: 0.98 },
    { x: 0.20, y: 0.22 }
  ];
  const s2 = sampleCubicBezier(
    { x: 0.20, y: 0.22 },
    { x: 0.24, y: 0.02 },
    { x: 0.86, y: 0.00 },
    { x: 0.82, y: 0.24 },
    14
  );
  const s3 = sampleCubicBezier(
    { x: 0.82, y: 0.24 },
    { x: 0.78, y: 0.40 },
    { x: 0.38, y: 0.43 },
    { x: 0.34, y: 0.44 },
    10
  );
  const s4 = sampleCubicBezier(
    { x: 0.34, y: 0.44 },
    { x: 0.96, y: 0.46 },
    { x: 0.96, y: 0.86 },
    { x: 0.18, y: 0.78 },
    16
  );
  return normalizeUnitBox([...s1, ...s2.slice(1), ...s3.slice(1), ...s4.slice(1)], TEMPLATE_SAMPLES);
}

function buildGammaUnit() {
  // γ: alto-sinistra -> occhiello stretto in basso -> esce alto-destra
  const c1 = sampleCubicBezier(
    { x: 0.04, y: 0.14 },
    { x: 0.26, y: -0.04 },
    { x: 0.58, y: 0.56 },
    { x: 0.48, y: 0.96 },
    18
  );
  const c2 = sampleCubicBezier(
    { x: 0.48, y: 0.96 },
    { x: 0.40, y: 1.04 },
    { x: 0.36, y: 0.66 },
    { x: 0.96, y: 0.04 },
    20
  );
  return normalizeUnitBox([...c1, ...c2.slice(1)], TEMPLATE_SAMPLES);
}

function buildDeltaLowerUnit() {
  // δ: occhiello inferiore antiorario che risale ad S con uncino in alto a destra
  const c1 = sampleCubicBezier(
    { x: 0.74, y: 0.48 },
    { x: 0.22, y: 0.34 },
    { x: 0.02, y: 0.88 },
    { x: 0.48, y: 0.98 },
    18
  );
  const c2 = sampleCubicBezier(
    { x: 0.48, y: 0.98 },
    { x: 0.94, y: 0.98 },
    { x: 0.88, y: 0.48 },
    { x: 0.34, y: 0.22 },
    18
  );
  const c3 = sampleCubicBezier(
    { x: 0.34, y: 0.22 },
    { x: 0.18, y: 0.06 },
    { x: 0.48, y: -0.04 },
    { x: 0.82, y: 0.08 },
    12
  );
  return normalizeUnitBox([...c1, ...c2.slice(1), ...c3.slice(1)], TEMPLATE_SAMPLES);
}

function buildEpsilonUnit() {
  // ε: doppio arco aperto a destra
  const top = sampleCubicBezier(
    { x: 0.92, y: 0.08 },
    { x: 0.26, y: -0.04 },
    { x: 0.02, y: 0.40 },
    { x: 0.62, y: 0.48 },
    18
  );
  const bot = sampleCubicBezier(
    { x: 0.62, y: 0.48 },
    { x: -0.02, y: 0.56 },
    { x: 0.18, y: 1.02 },
    { x: 0.96, y: 0.90 },
    18
  );
  return normalizeUnitBox([...top, ...bot.slice(1)], TEMPLATE_SAMPLES);
}

function buildZetaUnit() {
  // ζ: ricciolo superiore + curva diagonale + ansa inferiore con coda
  const top = sampleCubicBezier(
    { x: 0.24, y: 0.04 },
    { x: 0.44, y: 0.18 },
    { x: 0.86, y: 0.02 },
    { x: 0.88, y: 0.08 },
    14
  );
  const mid = sampleCubicBezier(
    { x: 0.88, y: 0.08 },
    { x: 0.36, y: 0.34 },
    { x: 0.02, y: 0.64 },
    { x: 0.42, y: 0.78 },
    18
  );
  const tail = sampleCubicBezier(
    { x: 0.42, y: 0.78 },
    { x: 0.82, y: 0.82 },
    { x: 0.86, y: 0.96 },
    { x: 0.56, y: 0.98 },
    12
  );
  return normalizeUnitBox([...top, ...mid.slice(1), ...tail.slice(1)], TEMPLATE_SAMPLES);
}

function buildThetaSingleUnit() {
  // θ a 1 tratto: ovale antiorario + traversa orizzontale centrale
  const oval = sampleEllipse(0.5, 0.5, 0.46, 0.48, 32, Math.PI, Math.PI * 3);
  const bar = [
    { x: 0.04, y: 0.5 },
    { x: 0.96, y: 0.5 }
  ];
  return normalizeUnitBox([...oval, ...bar], TEMPLATE_SAMPLES);
}

function buildLambdaSingleUnit() {
  // λ a 1 tratto continuo: spalla sinistra -> giù a destra + risale a metà -> gamba bassa a sinistra
  return normalizeUnitBox([
    { x: 0.18, y: 0.02 },
    { x: 0.52, y: 0.46 },
    { x: 0.92, y: 0.98 },
    { x: 0.50, y: 0.48 },
    { x: 0.08, y: 0.98 }
  ], TEMPLATE_SAMPLES);
}

function buildMuUnit() {
  // μ: gambetta lunga sinistra giù-su -> U -> gamba destra + flick
  const stem = [
    { x: 0.08, y: 0.98 },
    { x: 0.22, y: 0.08 }
  ];
  const cup = sampleCubicBezier(
    { x: 0.22, y: 0.08 },
    { x: 0.16, y: 0.72 },
    { x: 0.56, y: 0.82 },
    { x: 0.76, y: 0.08 },
    20
  );
  const leg = sampleCubicBezier(
    { x: 0.76, y: 0.08 },
    { x: 0.70, y: 0.62 },
    { x: 0.78, y: 0.78 },
    { x: 0.98, y: 0.66 },
    12
  );
  return normalizeUnitBox([...stem, ...cup.slice(1), ...leg.slice(1)], TEMPLATE_SAMPLES);
}

function buildPiSingleUnit() {
  // π a 1 tratto continuo: gamba sx su-giù, barra orizzontale alta, gamba dx giù
  return normalizeUnitBox([
    { x: 0.26, y: 0.98 },
    { x: 0.28, y: 0.12 },
    { x: 0.04, y: 0.12 },
    { x: 0.96, y: 0.10 },
    { x: 0.72, y: 0.12 },
    { x: 0.74, y: 0.88 },
    { x: 0.88, y: 0.96 }
  ], TEMPLATE_SAMPLES);
}

function buildSigmaLowerUnit() {
  // σ: parte da destra in alto, chiude il cerchio a sinistra/basso ed esce dritto a destra in alto
  const arc = sampleEllipse(0.42, 0.56, 0.40, 0.42, 34, -0.35, -Math.PI * 2 + 0.25);
  const tail = [
    { x: 0.58, y: 0.14 },
    { x: 0.98, y: 0.14 }
  ];
  return normalizeUnitBox([...arc, ...tail], TEMPLATE_SAMPLES);
}

function buildPhiSingleUnit() {
  // φ a 1 tratto: taglio centrale alto->basso poi ovale attorno
  const slash = [
    { x: 0.50, y: 0.02 },
    { x: 0.50, y: 0.98 },
    { x: 0.50, y: 0.78 }
  ];
  const oval = sampleEllipse(0.50, 0.50, 0.48, 0.28, 32, Math.PI * 0.5, Math.PI * 2.5);
  return normalizeUnitBox([...slash, ...oval], TEMPLATE_SAMPLES);
}

function buildPsiSingleUnit() {
  // ψ a 1 tratto: U larga + risalita sull'asta verticale centrale dall'alto al basso
  const cup = sampleCubicBezier(
    { x: 0.04, y: 0.16 },
    { x: 0.06, y: 0.76 },
    { x: 0.94, y: 0.76 },
    { x: 0.96, y: 0.16 },
    24
  );
  const spine = [
    { x: 0.50, y: 0.02 },
    { x: 0.50, y: 0.98 }
  ];
  return normalizeUnitBox([...cup, ...spine], TEMPLATE_SAMPLES);
}

function buildOmegaLowerUnit() {
  // ω: doppia pancia morbida (sinistra-basso -> picco centrale -> destra-basso -> ricciolo)
  const left = sampleCubicBezier(
    { x: 0.12, y: 0.12 },
    { x: -0.06, y: 0.68 },
    { x: 0.22, y: 1.02 },
    { x: 0.50, y: 0.46 },
    20
  );
  const right = sampleCubicBezier(
    { x: 0.50, y: 0.46 },
    { x: 0.68, y: 1.02 },
    { x: 1.04, y: 0.72 },
    { x: 0.86, y: 0.12 },
    20
  );
  return normalizeUnitBox([...left, ...right.slice(1)], TEMPLATE_SAMPLES);
}

function buildOmegaUpperUnit() {
  // Ω: piedino sx -> arco ferro di cavallo grande -> piedino dx
  const footL = [
    { x: 0.04, y: 0.96 },
    { x: 0.34, y: 0.96 }
  ];
  const arch = sampleEllipse(0.50, 0.45, 0.42, 0.43, 30, Math.PI * 0.74, Math.PI * 2.26);
  const footR = [
    { x: 0.66, y: 0.96 },
    { x: 0.96, y: 0.96 }
  ];
  return normalizeUnitBox([...footL, ...arch, ...footR], TEMPLATE_SAMPLES);
}

const GREEK_UNIT_TEMPLATES = {
  alpha: buildAlphaUnit(),
  beta: buildBetaUnit(),
  gamma: buildGammaUnit(),
  deltaLower: buildDeltaLowerUnit(),
  epsilon: buildEpsilonUnit(),
  zeta: buildZetaUnit(),
  theta: buildThetaSingleUnit(),
  lambda: buildLambdaSingleUnit(),
  mu: buildMuUnit(),
  pi: buildPiSingleUnit(),
  sigmaLower: buildSigmaLowerUnit(),
  phi: buildPhiSingleUnit(),
  psi: buildPsiSingleUnit(),
  omegaLower: buildOmegaLowerUnit(),
  omegaUpper: buildOmegaUpperUnit()
};

// ------------------------------------------------------------
// Riconoscitori simboli matematici a 1 tratto: (), [], {}, ∑
// ------------------------------------------------------------

function fitParenScore(pts, metrics, side) {
  const { minX, minY, w, h } = metrics;
  const tpl = evalUnitCurve(buildRoundParenUnit(side), minX, minY, w, h);
  let sumSq = 0;
  for (let i = 0; i < pts.length; i++) {
    let minD2 = Infinity;
    for (let j = 0; j < tpl.length - 1; j++) {
      const d2 = distSqPointToSegment(pts[i].x, pts[i].y, tpl[j].x, tpl[j].y, tpl[j + 1].x, tpl[j + 1].y);
      if (d2 < minD2) minD2 = d2;
    }
    sumSq += minD2;
  }
  return Math.sqrt(sumSq / pts.length) / Math.max(metrics.diag, 1);
}

function fitCurlyBraceScore(pts, metrics, side) {
  const { minX, minY, w, h } = metrics;
  const tpl = evalUnitCurve(buildCurlyBraceUnit(side), minX, minY, w, h);
  let sumSq = 0;
  for (let i = 0; i < pts.length; i++) {
    let minD2 = Infinity;
    for (let j = 0; j < tpl.length - 1; j++) {
      const d2 = distSqPointToSegment(pts[i].x, pts[i].y, tpl[j].x, tpl[j].y, tpl[j + 1].x, tpl[j + 1].y);
      if (d2 < minD2) minD2 = d2;
    }
    sumSq += minD2;
  }
  return Math.sqrt(sumSq / pts.length) / Math.max(metrics.diag, 1);
}

function fitSquareBracketScore(pts, metrics, side) {
  const { minX, minY, w, h } = metrics;
  const unitVerts = buildSquareBracketUnit(side);
  const verts = evalUnitCurve(unitVerts, minX, minY, w, h);
  const idealLen = h + 2 * w;
  const ratio = metrics.pathLen / Math.max(idealLen, 1);
  if (ratio < 0.82 || ratio > 1.24) return Infinity;

  let sumSq = 0;
  for (let i = 0; i < pts.length; i++) {
    let minD2 = Infinity;
    for (let j = 0; j < verts.length - 1; j++) {
      const d2 = distSqPointToSegment(pts[i].x, pts[i].y, verts[j].x, verts[j].y, verts[j + 1].x, verts[j + 1].y);
      if (d2 < minD2) minD2 = d2;
    }
    sumSq += minD2;
  }
  const start = pts[0];
  const end = pts[pts.length - 1];
  const expectedOpenX = side === '[' ? metrics.maxX : metrics.minX;
  const endNearOpen =
    (Math.abs(start.x - expectedOpenX) <= Math.max(10, w * 0.35)) &&
    (Math.abs(end.x - expectedOpenX) <= Math.max(10, w * 0.35));
  if (!endNearOpen) return Infinity;

  return Math.sqrt(sumSq / pts.length) / Math.max(metrics.diag, 1);
}

export function matchSummationOrUpperSigma(pts) {
  const m = computeMetrics(pts);
  if (m.h < 22 || m.w < 12) return null;
  const aspect = m.w / Math.max(m.h, 1);
  if (aspect < 0.42 || aspect > 1.75) return null;

  // Trova il vertice centrale (punta della V centrale della ∑)
  let midBest = null;
  let maxMidX = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const relY = (p.y - m.minY) / m.h;
    if (relY >= 0.30 && relY <= 0.70 && p.x > maxMidX) {
      maxMidX = p.x;
      midBest = p;
    }
  }
  if (!midBest) return null;
  const notchFrac = (midBest.x - m.minX) / m.w;
  if (notchFrac < 0.30 || notchFrac > 0.92) return null;

  const verts = [
    { x: m.maxX, y: m.minY },
    { x: m.minX, y: m.minY },
    { x: m.minX + Math.max(0.45, Math.min(0.68, notchFrac)) * m.w, y: m.cy },
    { x: m.minX, y: m.maxY },
    { x: m.maxX, y: m.maxY }
  ];

  let idealLen = 0;
  for (let i = 1; i < verts.length; i++) {
    idealLen += Math.hypot(verts[i].x - verts[i - 1].x, verts[i].y - verts[i - 1].y);
  }
  const pathRatio = m.pathLen / Math.max(idealLen, 1);
  if (pathRatio < 0.82 || pathRatio > 1.26) return null;

  // Verifica che tutti e 5 i vertici chiave siano toccati in ordine (V0->V1->V2->V3->V4 oppure inverso)
  const tol = Math.max(14, m.diag * 0.22);
  const findFirstWithin = (v, fromIdx) => {
    let bestIdx = -1;
    let bestD = tol;
    for (let i = fromIdx; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - v.x, pts[i].y - v.y);
      if (d <= bestD) {
        bestD = d;
        bestIdx = i;
      } else if (bestIdx !== -1 && d > tol * 1.35) {
        break;
      }
    }
    return bestIdx;
  };
  const checkOrder = (orderedVerts) => {
    let cursor = 0;
    for (const v of orderedVerts) {
      const idx = findFirstWithin(v, cursor);
      if (idx === -1) return false;
      cursor = idx;
    }
    return true;
  };
  if (!checkOrder(verts) && !checkOrder([...verts].reverse())) {
    return null;
  }

  let sumSq = 0;
  let maxD2 = 0;
  for (let i = 0; i < pts.length; i++) {
    let minD2 = Infinity;
    for (let j = 0; j < verts.length - 1; j++) {
      const d2 = distSqPointToSegment(pts[i].x, pts[i].y, verts[j].x, verts[j].y, verts[j + 1].x, verts[j + 1].y);
      if (d2 < minD2) minD2 = d2;
    }
    sumSq += minD2;
    if (minD2 > maxD2) maxD2 = minD2;
  }

  const rmsRel = Math.sqrt(sumSq / pts.length) / Math.max(m.diag, 1);
  const maxRel = Math.sqrt(maxD2) / Math.max(m.diag, 1);
  if (rmsRel > 0.085 || maxRel > 0.18) return null;

  return {
    id: 'summation',
    symbol: '∑',
    label: 'Sommatoria (∑)',
    icon: '∑',
    points: buildCornerPolyline(verts, 5)
  };
}

export function recognizeMathSymbolSingleStroke(pts) {
  if (!Array.isArray(pts) || pts.length < 6) return null;
  const m = computeMetrics(pts);

  // 1. Sommatoria ∑ (controlla prima delle parentesi)
  const sumMatch = matchSummationOrUpperSigma(pts);
  if (sumMatch) return sumMatch;

  // 2. Parentesi (), [], {} — alte e sottili, verticali, aperte tra cima e fondo
  if (m.h < 24 || m.h > 460 || m.w < 6) return null;
  const aspectHW = m.h / Math.max(m.w, 1);
  if (aspectHW < 1.32 || aspectHW > 12) return null;

  const p0 = pts[0];
  const pLast = pts[pts.length - 1];
  const ySpan = Math.abs(pLast.y - p0.y);
  if (ySpan < m.h * 0.70) return null;
  if (Math.hypot(pLast.x - p0.x, pLast.y - p0.y) / Math.max(m.pathLen, 1) < 0.38) return null;

  // Assicuriamoci che non abbia backtracking verticale pesante
  const goingDown = pLast.y >= p0.y;
  let wrongDirLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const dy = pts[i].y - pts[i - 1].y;
    if (goingDown ? dy < -3 : dy > 3) wrongDirLen += Math.abs(dy);
  }
  if (wrongDirLen > m.h * 0.14) return null;

  // Confronta i 6 candidati: [, ], {, }, (, )
  const candidates = [];

  for (const side of ['[', ']']) {
    const err = fitSquareBracketScore(pts, m, side);
    if (err <= 0.075) {
      const verts = evalUnitCurve(buildSquareBracketUnit(side), m.minX, m.minY, m.w, m.h);
      candidates.push({
        id: side === '[' ? 'bracket_left' : 'bracket_right',
        symbol: side,
        label: `Parentesi quadra ${side}`,
        icon: side,
        score: err,
        points: buildCornerPolyline(verts, 5)
      });
    }
  }

  // Per distinguere `{}` da `()` calcoliamo anche la curvatura ai quarti vs centro
  const res = resamplePath(pts, 32);
  const topY = Math.min(p0.y, pLast.y);
  const ordered = goingDown ? res : [...res].reverse();
  const q1 = ordered[Math.floor(ordered.length * 0.20)];
  const mid = ordered[Math.floor(ordered.length * 0.50)];
  const q3 = ordered[Math.floor(ordered.length * 0.80)];
  const openX = (ordered[0].x + ordered[ordered.length - 1].x) * 0.5;

  for (const side of ['{', '}']) {
    const isLeft = side === '{';
    const err = fitCurlyBraceScore(pts, m, side);
    // Verifica la cuspide centrale verso spine e i quarti più vicini al centro/lato aperto
    const cuspOk = isLeft
      ? (mid.x <= m.minX + m.w * 0.28 && openX >= m.maxX - m.w * 0.35 && q1.x > mid.x + m.w * 0.18 && q3.x > mid.x + m.w * 0.18)
      : (mid.x >= m.maxX - m.w * 0.28 && openX <= m.minX + m.w * 0.35 && q1.x < mid.x - m.w * 0.18 && q3.x < mid.x - m.w * 0.18);
    if (cuspOk && err <= 0.082) {
      candidates.push({
        id: isLeft ? 'brace_left' : 'brace_right',
        symbol: side,
        label: `Parentesi graffa ${side}`,
        icon: side,
        score: err * 0.92,
        points: evalUnitCurve(buildCurlyBraceUnit(side), m.minX, topY, m.w, m.h)
      });
    }
  }

  for (const side of ['(', ')']) {
    const isLeft = side === '(';
    const err = fitParenScore(pts, m, side);
    const arcOk = isLeft
      ? (mid.x <= m.minX + m.w * 0.25 && openX >= m.maxX - m.w * 0.30 && q1.x <= openX - m.w * 0.42 && q3.x <= openX - m.w * 0.42)
      : (mid.x >= m.maxX - m.w * 0.25 && openX <= m.minX + m.w * 0.30 && q1.x >= openX + m.w * 0.42 && q3.x >= openX + m.w * 0.42);
    if (arcOk && err <= 0.078) {
      candidates.push({
        id: isLeft ? 'paren_left' : 'paren_right',
        symbol: side,
        label: `Parentesi tonda ${side}`,
        icon: side,
        score: err,
        points: evalUnitCurve(buildRoundParenUnit(side), m.minX, m.minY, m.w, m.h)
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

// ------------------------------------------------------------
// Riconoscitori lettere greche a 1 tratto
// ------------------------------------------------------------

export function recognizeGreekSingleStroke(pts) {
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const m = computeMetrics(pts);
  if (m.diag < 22 || m.diag > 260) return null;
  if (m.w < 10 || m.h < 10) return null;

  const aspectWH = m.w / Math.max(m.h, 1);
  const res = resamplePath(pts, TEMPLATE_SAMPLES);
  const normUser = normalizeUnitBox(res, TEMPLATE_SAMPLES);
  const normRev = [...normUser].reverse();
  const selfCross = hasSelfIntersection(res);

  const p0 = pts[0];
  const pEnd = pts[pts.length - 1];
  const rel0 = { x: (p0.x - m.minX) / m.w, y: (p0.y - m.minY) / m.h };
  const relEnd = { x: (pEnd.x - m.minX) / m.w, y: (pEnd.y - m.minY) / m.h };
  const closureRatio = Math.hypot(pEnd.x - p0.x, pEnd.y - p0.y) / Math.max(m.pathLen, 1);

  const candidates = [];

  // 1. Δ (Delta maiuscola a base orizzontale, anche se piccolo)
  if (aspectWH >= 0.55 && aspectWH <= 1.85 && closureRatio <= 0.18) {
    const basePts = pts.filter(p => p.y >= m.maxY - m.h * 0.16);
    const apexPts = pts.filter(p => p.y <= m.minY + m.h * 0.18);
    if (basePts.length >= 2 && apexPts.length >= 1) {
      let minBx = Infinity, maxBx = -Infinity;
      for (const p of basePts) {
        if (p.x < minBx) minBx = p.x;
        if (p.x > maxBx) maxBx = p.x;
      }
      const apexMidX = apexPts.reduce((acc, p) => acc + p.x, 0) / apexPts.length;
      if ((maxBx - minBx) >= m.w * 0.65 && Math.abs(apexMidX - m.cx) <= m.w * 0.25) {
        const triVerts = [
          { x: m.cx, y: m.minY },
          { x: m.maxX, y: m.maxY },
          { x: m.minX, y: m.maxY },
          { x: m.cx, y: m.minY }
        ];
        let sumSq = 0;
        for (const p of pts) {
          const d0 = distSqPointToSegment(p.x, p.y, triVerts[0].x, triVerts[0].y, triVerts[1].x, triVerts[1].y);
          const d1 = distSqPointToSegment(p.x, p.y, triVerts[1].x, triVerts[1].y, triVerts[2].x, triVerts[2].y);
          const d2 = distSqPointToSegment(p.x, p.y, triVerts[2].x, triVerts[2].y, triVerts[0].x, triVerts[0].y);
          sumSq += Math.min(d0, d1, d2);
        }
        const rmsRel = Math.sqrt(sumSq / pts.length) / m.diag;
        if (rmsRel <= 0.08) {
          candidates.push({
            id: 'delta_upper',
            symbol: 'Δ',
            label: 'Lettera greca: Δ',
            icon: 'Δ',
            score: rmsRel,
            points: buildCornerPolyline(triVerts, 5)
          });
        }
      }
    }
  }

  // Helper per template matching orientato + vincolo strutturale
  const tryTemplate = (key, maxDist, cfg) => {
    if (aspectWH < cfg.minAspect || aspectWH > cfg.maxAspect) return;
    if (cfg.check && !cfg.check()) return;
    const tpl = GREEK_UNIT_TEMPLATES[key];
    const dFwd = normalizedRmsDistance(normUser, tpl);
    const dRev = cfg.allowReverse ? normalizedRmsDistance(normRev, tpl) : Infinity;
    const dist = Math.min(dFwd, dRev);
    if (dist <= maxDist) {
      candidates.push({
        id: key,
        symbol: cfg.symbol,
        label: `Lettera greca: ${cfg.symbol}`,
        icon: cfg.symbol,
        score: dist,
        points: cfg.build ? cfg.build() : evalUnitCurve(tpl, m.minX, m.minY, m.w, m.h)
      });
    }
  };

  // α: ansa aperta a destra con incrocio
  tryTemplate('alpha', 0.165, {
    symbol: 'α',
    minAspect: 0.55,
    maxAspect: 1.9,
    allowReverse: true,
    check: () => selfCross && closureRatio >= 0.14 && rel0.x >= 0.50 && relEnd.x >= 0.50
  });

  // β: alta, parte da basso-sinistra e sale facendo 2 gobbe a destra
  tryTemplate('beta', 0.17, {
    symbol: 'β',
    minAspect: 0.30,
    maxAspect: 1.05,
    allowReverse: false,
    check: () => rel0.x <= 0.45 && rel0.y >= 0.65 && m.h >= m.w * 0.95
  });

  // γ: occhiello in basso che si incrocia
  tryTemplate('gamma', 0.165, {
    symbol: 'γ',
    minAspect: 0.45,
    maxAspect: 1.65,
    allowReverse: true,
    check: () => selfCross && rel0.y <= 0.45 && relEnd.y <= 0.45 && Math.abs(relEnd.x - rel0.x) >= 0.35
  });

  // δ: pancia tondeggiante sotto + ricciolo S in alto a destra
  tryTemplate('deltaLower', 0.175, {
    symbol: 'δ',
    minAspect: 0.38,
    maxAspect: 1.35,
    allowReverse: false,
    check: () => relEnd.y <= 0.35 && rel0.y >= 0.25 && closureRatio >= 0.16
  });

  // ε: doppia C aperta a destra (non confondere con `(` grazie a rientranza centrale)
  tryTemplate('epsilon', 0.155, {
    symbol: 'ε',
    minAspect: 0.38,
    maxAspect: 1.30,
    allowReverse: true,
    check: () => {
      if (closureRatio < 0.26 || rel0.x < 0.45 || relEnd.x < 0.45) return false;
      const midPts = res.slice(Math.floor(TEMPLATE_SAMPLES * 0.35), Math.floor(TEMPLATE_SAMPLES * 0.65));
      const maxMidX = Math.max(...midPts.map(p => (p.x - m.minX) / m.w));
      return maxMidX >= 0.45;
    }
  });

  // ζ: zeta corsiva
  tryTemplate('zeta', 0.175, {
    symbol: 'ζ',
    minAspect: 0.35,
    maxAspect: 1.25,
    allowReverse: false,
    check: () => rel0.y <= 0.30 && relEnd.y >= 0.70
  });

  // θ a 1 tratto: ovale + barra orizzontale interna
  tryTemplate('theta', 0.18, {
    symbol: 'θ',
    minAspect: 0.45,
    maxAspect: 1.45,
    allowReverse: true,
    check: () => {
      const centerRow = res.filter(p => Math.abs((p.y - m.minY) / m.h - 0.5) <= 0.18);
      if (centerRow.length < 4) return false;
      const xs = centerRow.map(p => (p.x - m.minX) / m.w);
      return (Math.max(...xs) - Math.min(...xs)) >= 0.55;
    },
    build: () => {
      const rx = m.w * 0.48;
      const ry = m.h * 0.48;
      const oval = sampleEllipse(m.cx, m.cy, rx, ry, 36, Math.PI, Math.PI * 3);
      return [...oval, ...buildCornerPolyline([{ x: m.cx - rx, y: m.cy }, { x: m.cx + rx, y: m.cy }], 5)];
    }
  });

  // λ a 1 tratto: stelo diagonale + gamba sinistra
  tryTemplate('lambda', 0.165, {
    symbol: 'λ',
    minAspect: 0.42,
    maxAspect: 1.55,
    allowReverse: true,
    check: () => rel0.y <= 0.28 && relEnd.y >= 0.68 && relEnd.x <= 0.45
  });

  // μ a 1 tratto: coda sinistra + coppa + gambetta destra
  tryTemplate('mu', 0.175, {
    symbol: 'μ',
    minAspect: 0.50,
    maxAspect: 1.85,
    allowReverse: false,
    check: () => rel0.x <= 0.38 && rel0.y >= 0.62 && relEnd.x >= 0.60
  });

  // π a 1 tratto: barra alta + 2 gambe
  tryTemplate('pi', 0.175, {
    symbol: 'π',
    minAspect: 0.55,
    maxAspect: 2.0,
    allowReverse: false,
    check: () => {
      const topPts = res.filter(p => (p.y - m.minY) / m.h <= 0.30);
      if (topPts.length < 5) return false;
      const minTopX = Math.min(...topPts.map(p => (p.x - m.minX) / m.w));
      const maxTopX = Math.max(...topPts.map(p => (p.x - m.minX) / m.w));
      return (maxTopX - minTopX) >= 0.65 && rel0.y >= 0.65 && relEnd.y >= 0.65;
    }
  });

  // σ: cerchio/ovale + coda orizzontale in alto a destra
  tryTemplate('sigmaLower', 0.165, {
    symbol: 'σ',
    minAspect: 0.55,
    maxAspect: 1.75,
    allowReverse: false,
    check: () => {
      const topRight = res.filter(p => (p.y - m.minY) / m.h <= 0.35 && (p.x - m.minX) / m.w >= 0.75);
      return relEnd.y <= 0.38 && relEnd.x >= 0.72 && topRight.length >= 2;
    }
  });

  // φ a 1 tratto: barra verticale + ovale centrale
  tryTemplate('phi', 0.18, {
    symbol: 'φ',
    minAspect: 0.45,
    maxAspect: 1.55,
    allowReverse: true,
    check: () => {
      const centerCol = res.filter(p => Math.abs((p.x - m.minX) / m.w - 0.5) <= 0.18);
      if (centerCol.length < 4) return false;
      const ys = centerCol.map(p => (p.y - m.minY) / m.h);
      return (Math.max(...ys) - Math.min(...ys)) >= 0.65;
    }
  });

  // ψ a 1 tratto: coppa U + asta verticale centrale
  tryTemplate('psi', 0.18, {
    symbol: 'ψ',
    minAspect: 0.55,
    maxAspect: 1.85,
    allowReverse: false,
    check: () => rel0.x <= 0.32 && rel0.y <= 0.40 && relEnd.y >= 0.72 && relEnd.x >= 0.30 && relEnd.x <= 0.72
  });

  // ω: doppio U con picco centrale
  tryTemplate('omegaLower', 0.165, {
    symbol: 'ω',
    minAspect: 0.70,
    maxAspect: 2.5,
    allowReverse: true,
    check: () => {
      if (closureRatio < 0.25) return false;
      const midPts = res.slice(Math.floor(TEMPLATE_SAMPLES * 0.35), Math.floor(TEMPLATE_SAMPLES * 0.65));
      const minMidY = Math.min(...midPts.map(p => (p.y - m.minY) / m.h));
      return rel0.y <= 0.45 && relEnd.y <= 0.45 && minMidY <= 0.62;
    }
  });

  // Ω: ferro di cavallo + 2 piedini orizzontali in basso
  tryTemplate('omegaUpper', 0.165, {
    symbol: 'Ω',
    minAspect: 0.60,
    maxAspect: 1.85,
    allowReverse: true,
    check: () => rel0.x <= 0.32 && rel0.y >= 0.68 && relEnd.x >= 0.68 && relEnd.y >= 0.68
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

// ------------------------------------------------------------
// Riconoscimento lettere greche multi-tratto (θ, φ, ψ, π, λ)
// ------------------------------------------------------------

function isStraightBar(pts, { minLen = 14, maxRmsFactor = 0.09, minPathRatio = 0.88 } = {}) {
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < minLen) return null;
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (len / Math.max(pathLen, 1) < minPathRatio) return null;
  if (pts.length >= 3) {
    let sumSq = 0;
    for (let i = 0; i < pts.length; i++) {
      sumSq += distSqPointToSegment(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
    }
    const rms = Math.sqrt(sumSq / pts.length);
    if (rms > Math.max(3.5, len * maxRmsFactor)) return null;
  }
  const m = computeMetrics(pts);
  const angleDeg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
  return { a, b, len, angleDeg, ...m };
}

function isClosedOvalStroke(pts) {
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const m = computeMetrics(pts);
  if (m.diag < 18 || m.diag > 230 || m.w < 10 || m.h < 10) return null;
  const aspect = m.w / m.h;
  if (aspect < 0.42 || aspect > 2.2) return null;
  const closure = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
  if (closure / Math.max(m.pathLen, 1) > 0.24) return null;

  const rx = m.w * 0.5;
  const ry = m.h * 0.5;
  let errSum = 0;
  for (const p of pts) {
    const r = Math.hypot((p.x - m.cx) / rx, (p.y - m.cy) / ry);
    errSum += (r - 1) ** 2;
  }
  const rmsEll = Math.sqrt(errSum / pts.length);
  if (rmsEll > 0.28) return null;
  return { ...m, rx, ry };
}

function isUCupStroke(pts) {
  if (!Array.isArray(pts) || pts.length < 6) return null;
  const m = computeMetrics(pts);
  if (m.diag < 18 || m.diag > 240 || m.w < 12 || m.h < 10) return null;
  const p0 = pts[0];
  const p1 = pts[pts.length - 1];
  const topThresh = m.minY + m.h * 0.38;
  if (p0.y > topThresh || p1.y > topThresh) return null;
  if (Math.abs(p1.x - p0.x) < m.w * 0.55) return null;
  // Il punto più basso deve trovarsi nella zona centrale
  let lowest = pts[0];
  for (const p of pts) if (p.y > lowest.y) lowest = p;
  if (Math.abs(lowest.x - m.cx) > m.w * 0.30) return null;
  return m;
}

export function recognizeGreekMultiStroke(newPts, existingStrokes) {
  if (!Array.isArray(newPts) || !Array.isArray(existingStrokes) || existingStrokes.length === 0) {
    return null;
  }

  const bar = isStraightBar(newPts, { minLen: 14 });
  const lookbackStart = Math.max(0, existingStrokes.length - 6);

  // 1. θ (ovale + barra orizzontale attraverso)
  if (bar && bar.angleDeg <= 24) {
    for (let i = existingStrokes.length - 1; i >= lookbackStart; i--) {
      const oval = isClosedOvalStroke(existingStrokes[i]?.points);
      if (!oval) continue;
      if (Math.abs(bar.cy - oval.cy) > oval.h * 0.28) continue;
      if (bar.minX > oval.cx - oval.w * 0.15 || bar.maxX < oval.cx + oval.w * 0.15) continue;
      if (bar.w < oval.w * 0.50 || bar.w > oval.w * 1.50) continue;

      return {
        id: 'theta_2stroke',
        symbol: 'θ',
        label: 'Lettera greca: θ',
        icon: 'θ',
        updates: [
          {
            strokeIndex: i,
            points: sampleEllipse(oval.cx, oval.cy, oval.rx, oval.ry, 40, 0, Math.PI * 2)
          }
        ],
        points: buildCornerPolyline([
          { x: oval.minX, y: oval.cy },
          { x: oval.maxX, y: oval.cy }
        ], 5)
      };
    }
  }

  // 2. φ (ovale + barra verticale attraverso)
  if (bar && bar.angleDeg >= 66) {
    for (let i = existingStrokes.length - 1; i >= lookbackStart; i--) {
      const oval = isClosedOvalStroke(existingStrokes[i]?.points);
      if (!oval) continue;
      if (Math.abs(bar.cx - oval.cx) > oval.w * 0.28) continue;
      if (bar.minY > oval.cy - oval.h * 0.15 || bar.maxY < oval.cy + oval.h * 0.15) continue;
      if (bar.h < oval.h * 0.65 || bar.h > oval.h * 2.2) continue;

      const padY = Math.max(oval.h * 0.22, 6);
      const topY = Math.min(bar.minY, oval.minY - padY);
      const botY = Math.max(bar.maxY, oval.maxY + padY);
      return {
        id: 'phi_2stroke',
        symbol: 'φ',
        label: 'Lettera greca: φ',
        icon: 'φ',
        updates: [
          {
            strokeIndex: i,
            points: sampleEllipse(oval.cx, oval.cy, oval.rx, oval.ry, 40, 0, Math.PI * 2)
          }
        ],
        points: buildCornerPolyline([
          { x: oval.cx, y: topY },
          { x: oval.cx, y: botY }
        ], 5)
      };
    }

    // 3. ψ (coppa U + barra verticale centrale)
    for (let i = existingStrokes.length - 1; i >= lookbackStart; i--) {
      const ucup = isUCupStroke(existingStrokes[i]?.points);
      if (!ucup) continue;
      if (Math.abs(bar.cx - ucup.cx) > ucup.w * 0.26) continue;
      if (bar.maxY < ucup.maxY - 2) continue;
      if (bar.minY > ucup.minY + ucup.h * 0.35) continue;

      const cleanCup = sampleCubicBezier(
        { x: ucup.minX, y: ucup.minY },
        { x: ucup.minX, y: ucup.maxY + ucup.h * 0.18 },
        { x: ucup.maxX, y: ucup.maxY + ucup.h * 0.18 },
        { x: ucup.maxX, y: ucup.minY },
        28
      ).map(p => ({ x: p.x, y: p.y, pressure: 0.5 }));

      const topY = Math.min(bar.minY, ucup.minY - Math.max(4, ucup.h * 0.18));
      const botY = Math.max(bar.maxY, ucup.maxY + Math.max(6, ucup.h * 0.32));
      return {
        id: 'psi_2stroke',
        symbol: 'ψ',
        label: 'Lettera greca: ψ',
        icon: 'ψ',
        updates: [{ strokeIndex: i, points: cleanCup }],
        points: buildCornerPolyline([
          { x: ucup.cx, y: topY },
          { x: ucup.cx, y: botY }
        ], 5)
      };
    }
  }

  // 4. π (2 gambe verticali + barra orizzontale sopra)
  if (bar && bar.angleDeg <= 18 && bar.w >= 16) {
    const legCands = [];
    for (let i = existingStrokes.length - 1; i >= lookbackStart; i--) {
      const leg = isStraightBar(existingStrokes[i]?.points, { minLen: 12 });
      if (!leg || leg.angleDeg < 62) continue;
      if (leg.cx < bar.minX - 6 || leg.cx > bar.maxX + 6) continue;
      if (Math.abs(leg.minY - bar.cy) > Math.max(14, bar.w * 0.45)) continue;
      if (leg.maxY <= bar.cy + 8) continue;
      legCands.push({ idx: i, leg });
    }
    if (legCands.length >= 2) {
      let bestPair = null;
      let bestSepScore = Infinity;
      for (let a = 0; a < legCands.length - 1; a++) {
        for (let b = a + 1; b < legCands.length; b++) {
          const l1 = legCands[a];
          const l2 = legCands[b];
          const sep = Math.abs(l1.leg.cx - l2.leg.cx);
          if (sep < bar.w * 0.25 || sep > bar.w * 0.96) continue;
          const hRatio = Math.min(l1.leg.h, l2.leg.h) / Math.max(l1.leg.h, l2.leg.h);
          if (hRatio < 0.55) continue;
          const score = Math.abs(l1.leg.minY - l2.leg.minY);
          if (score < bestSepScore) {
            bestSepScore = score;
            bestPair = l1.leg.cx < l2.leg.cx ? [l1, l2] : [l2, l1];
          }
        }
      }
      if (bestPair) {
        const [leftLeg, rightLeg] = bestPair;
        const roofY = bar.cy;
        const footY = Math.max(leftLeg.leg.maxY, rightLeg.leg.maxY);
        const legSpread = rightLeg.leg.cx - leftLeg.leg.cx;
        const overhang = Math.max(5, Math.min(14, legSpread * 0.28));
        const roofX0 = Math.min(bar.minX, leftLeg.leg.cx - overhang);
        const roofX1 = Math.max(bar.maxX, rightLeg.leg.cx + overhang);

        return {
          id: 'pi_3stroke',
          symbol: 'π',
          label: 'Lettera greca: π',
          icon: 'π',
          updates: [
            {
              strokeIndex: leftLeg.idx,
              points: buildCornerPolyline([
                { x: leftLeg.leg.cx, y: roofY },
                { x: leftLeg.leg.cx, y: footY }
              ], 5)
            },
            {
              strokeIndex: rightLeg.idx,
              points: buildCornerPolyline([
                { x: rightLeg.leg.cx, y: roofY },
                { x: rightLeg.leg.cx, y: footY }
              ], 5)
            }
          ],
          points: buildCornerPolyline([
            { x: roofX0, y: roofY },
            { x: roofX1, y: roofY }
          ], 5)
        };
      }
    }
  }

  // 5. λ a 2 tratti: diagonale principale `\` + gamba `/` da metà verso basso-sinistra
  if (bar && bar.angleDeg >= 30 && bar.angleDeg <= 78) {
    const newDx = bar.b.x - bar.a.x;
    const newDy = bar.b.y - bar.a.y;
    const newTop = newDy >= 0 ? bar.a : bar.b;
    const newBot = newDy >= 0 ? bar.b : bar.a;
    if (newBot.x < newTop.x - 4) {
      for (let i = existingStrokes.length - 1; i >= lookbackStart; i--) {
        const main = isStraightBar(existingStrokes[i]?.points, { minLen: 22 });
        if (!main || main.angleDeg < 30 || main.angleDeg > 78) continue;
        const mainTop = (main.b.y - main.a.y) >= 0 ? main.a : main.b;
        const mainBot = (main.b.y - main.a.y) >= 0 ? main.b : main.a;
        if (mainBot.x <= mainTop.x + 6) continue;

        const dMidSq = distSqPointToSegment(newTop.x, newTop.y, mainTop.x, mainTop.y, mainBot.x, mainBot.y);
        const tol = Math.max(10, main.len * 0.18);
        if (dMidSq > tol * tol) continue;

        const vx = mainBot.x - mainTop.x;
        const vy = mainBot.y - mainTop.y;
        const tProj = ((newTop.x - mainTop.x) * vx + (newTop.y - mainTop.y) * vy) / (vx * vx + vy * vy);
        if (tProj < 0.25 || tProj > 0.70) continue;

        const junction = {
          x: mainTop.x + vx * tProj,
          y: mainTop.y + vy * tProj
        };
        if (newBot.y < junction.y + main.h * 0.28) continue;

        return {
          id: 'lambda_2stroke',
          symbol: 'λ',
          label: 'Lettera greca: λ',
          icon: 'λ',
          updates: [
            {
              strokeIndex: i,
              points: buildCornerPolyline([mainTop, mainBot], 5)
            }
          ],
          points: buildCornerPolyline([junction, newBot], 5)
        };
      }
    }
  }

  return null;
}
