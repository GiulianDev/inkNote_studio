/**
 * @module features/tools/arrow-recognition
 *
 * Logica geometrica pura (zero DOM/state) per il riconoscimento di frecce:
 *   1. Freccia in 2 tratti: linea dritta esistente + punta `>` all'estremità
 *      (allineata all'asse della linea, con alette sui due lati opposti).
 *   2. Freccia in 1 tratto continuo: asta dritta + doppia aletta finale.
 */

export function distSqPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

export function perpendicularRmsDeviationSampled(points, A, B, step = 2) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const px = p.x - A.x;
    const py = p.y - A.y;
    const along = px * ux + py * uy;
    const perpX = px - along * ux;
    const perpY = py - along * uy;
    sumSq += perpX * perpX + perpY * perpY;
    count++;
  }
  if ((points.length - 1) % step !== 0) {
    const p = points[points.length - 1];
    const px = p.x - A.x;
    const py = p.y - A.y;
    const along = px * ux + py * uy;
    const perpX = px - along * ux;
    const perpY = py - along * uy;
    sumSq += perpX * perpX + perpY * perpY;
    count++;
  }
  if (count === 0) return null;
  return Math.sqrt(sumSq / count);
}

/**
 * Verifica che uno stroke esistente sia una linea dritta valida come asta freccia.
 * Esclude lettere curve ("d", "u", "o", "c") e tratti troppo corti.
 */
export function analyzeStraightShaftCandidate(points, { minLength = 45, maxRmsFactor = 0.03, minPathRatio = 0.92 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < minLength) return null;

  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (chordLen / Math.max(pathLen, 1) < minPathRatio) return null;

  if (points.length >= 3) {
    const rms = perpendicularRmsDeviationSampled(points, first, last, 2);
    if (rms === null || rms > Math.max(3.5, chordLen * maxRmsFactor)) return null;
  }

  const ux = dx / chordLen;
  const uy = dy / chordLen;
  return {
    chordLen,
    first,
    last,
    endpoints: [
      { end: last, tail: first, dirX: ux, dirY: uy },
      { end: first, tail: last, dirX: -ux, dirY: -uy }
    ]
  };
}

/**
 * Analizza se `tipPoints` ha la geometria di una punta a V (`>`).
 * Ritorna `{ pStart, pEnd, tip, w1, w2, avgWing, bisX, bisY }` o `null`.
 */
export function parseChevronTip(tipPoints) {
  if (!Array.isArray(tipPoints) || tipPoints.length < 5) return null;

  const n = tipPoints.length;
  let pathLen = 0;
  for (let i = 1; i < n; i++) {
    pathLen += Math.hypot(tipPoints[i].x - tipPoints[i - 1].x, tipPoints[i].y - tipPoints[i - 1].y);
  }
  if (pathLen < 16 || pathLen > 145) return null;

  const pStart = tipPoints[0];
  const pEnd = tipPoints[n - 1];
  const chordLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
  const chordRatio = chordLen / Math.max(pathLen, 1);
  if (chordRatio < 0.22 || chordRatio > 0.88) return null;

  // Vertice della V: punto più distante dalla corda pStart -> pEnd
  let tipIdx = -1;
  let maxPerpSq = -1;
  for (let i = 1; i < n - 1; i++) {
    const dSq = distSqPointToSegment(
      tipPoints[i].x, tipPoints[i].y,
      pStart.x, pStart.y, pEnd.x, pEnd.y
    );
    if (dSq > maxPerpSq) {
      maxPerpSq = dSq;
      tipIdx = i;
    }
  }
  if (tipIdx <= 0 || tipIdx >= n - 1) return null;

  const tip = tipPoints[tipIdx];
  const w1 = Math.hypot(tip.x - pStart.x, tip.y - pStart.y);
  const w2 = Math.hypot(pEnd.x - tip.x, pEnd.y - tip.y);
  if (w1 < 7.5 || w2 < 7.5 || Math.max(w1, w2) > 68) return null;
  if (Math.min(w1, w2) / Math.max(w1, w2) < 0.45) return null;
  if (pathLen / (w1 + w2) > 1.22) return null;

  // Entrambe le alette devono essere ragionevolmente dritte
  for (let i = 1; i < tipIdx; i++) {
    const dSq = distSqPointToSegment(
      tipPoints[i].x, tipPoints[i].y,
      pStart.x, pStart.y, tip.x, tip.y
    );
    if (dSq > Math.max(32, (w1 * 0.20) ** 2)) return null;
  }
  for (let i = tipIdx + 1; i < n - 1; i++) {
    const dSq = distSqPointToSegment(
      tipPoints[i].x, tipPoints[i].y,
      tip.x, tip.y, pEnd.x, pEnd.y
    );
    if (dSq > Math.max(32, (w2 * 0.20) ** 2)) return null;
  }

  // Angolo di apertura della V (~25° .. 120°)
  const vAx = (pStart.x - tip.x) / w1;
  const vAy = (pStart.y - tip.y) / w1;
  const vBx = (pEnd.x - tip.x) / w2;
  const vBy = (pEnd.y - tip.y) / w2;
  const cosOpen = vAx * vBx + vAy * vBy;
  if (cosOpen < -0.50 || cosOpen > 0.90) return null;

  // Bisettrice dalla punta verso il centro delle alette
  const midX = (pStart.x + pEnd.x) * 0.5 - tip.x;
  const midY = (pStart.y + pEnd.y) * 0.5 - tip.y;
  const midLen = Math.hypot(midX, midY);
  if (midLen < 4) return null;

  return {
    pStart,
    pEnd,
    tip,
    w1,
    w2,
    avgWing: (w1 + w2) * 0.5,
    bisX: midX / midLen,
    bisY: midY / midLen
  };
}

/**
 * Analizza se `tipPoints` è una punta `>` allineata all'estremità di una linea dritta
 * in `existingStrokes`. Ritorna `{ target, wingLen }` o `null`.
 */
export function findArrowTipTarget(tipPoints, existingStrokes) {
  if (!Array.isArray(existingStrokes) || existingStrokes.length === 0) return null;
  const chevron = parseChevronTip(tipPoints);
  if (!chevron) return null;

  const { pStart, pEnd, tip, avgWing, bisX, bisY } = chevron;
  const maxLateralOffset = Math.min(9.5, Math.max(5.5, avgWing * 0.34));
  const minAlongOffset = -14;
  const maxAlongOffset = 12;

  let bestTarget = null;
  let bestScore = Infinity;

  const maxAlongAbs = Math.max(Math.abs(minAlongOffset), maxAlongOffset);
  const maxTipDistSq = maxAlongAbs * maxAlongAbs + maxLateralOffset * maxLateralOffset + 1;
  const minShaftChord = Math.max(45, avgWing * 1.6);
  const minShaftChordSq = minShaftChord * minShaftChord;

  for (let i = existingStrokes.length - 1; i >= 0; i--) {
    const s = existingStrokes[i];
    const pts = s && s.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;

    // Filtro O(1) senza scansione punti: corda minima e distanza punta dagli estremi
    const first = pts[0];
    const last = pts[pts.length - 1];
    const cdx = last.x - first.x;
    const cdy = last.y - first.y;
    if (cdx * cdx + cdy * cdy < minShaftChordSq) continue;

    const dfx = tip.x - first.x;
    const dfy = tip.y - first.y;
    const dlx = tip.x - last.x;
    const dly = tip.y - last.y;
    if (dfx * dfx + dfy * dfy > maxTipDistSq && dlx * dlx + dly * dly > maxTipDistSq) {
      continue;
    }

    const shaft = analyzeStraightShaftCandidate(pts);
    if (!shaft) continue;
    if (shaft.chordLen < avgWing * 1.6) continue;

    for (const info of shaft.endpoints) {
      const vx = tip.x - info.end.x;
      const vy = tip.y - info.end.y;

      // Scomposizione lungo l'asse della linea e perpendicolarmente ad essa
      const along = vx * info.dirX + vy * info.dirY;
      const lateral = Math.abs(-vx * info.dirY + vy * info.dirX);

      if (lateral > maxLateralOffset) continue;
      if (along < minAlongOffset || along > maxAlongOffset) continue;

      // La bisettrice della V deve puntare all'indietro rispetto alla direzione della linea (~ <= 35°)
      const dotBack = bisX * info.dirX + bisY * info.dirY;
      if (dotBack > -0.82) continue;

      // Le due alette devono trovarsi sui due lati opposti dell'asse della linea
      const sideStart = (pStart.x - info.end.x) * (-info.dirY) + (pStart.y - info.end.y) * info.dirX;
      const sideEnd = (pEnd.x - info.end.x) * (-info.dirY) + (pEnd.y - info.end.y) * info.dirX;
      if (sideStart * sideEnd >= 0) continue;
      if (Math.min(Math.abs(sideStart), Math.abs(sideEnd)) < 4) continue;

      const score = lateral * 1.5 + Math.abs(along);
      if (score < bestScore) {
        bestScore = score;
        bestTarget = info;
      }
    }
  }

  if (!bestTarget) return null;

  const wingLen = Math.max(10, Math.min(48, avgWing));
  return { target: bestTarget, wingLen };
}

/**
 * Riconosce il simbolo "di conseguenza" (`=>` / `⇒`) formato da
 * due linee parallele esistenti + punta `>` all'estremità.
 * Ritorna `{ barAIndex, barBIndex, barA, barB, chevron }` o `null`.
 */
export function findImplicationArrowTarget(tipPoints, existingStrokes) {
  if (!Array.isArray(existingStrokes) || existingStrokes.length < 2) return null;
  const chevron = parseChevronTip(tipPoints);
  if (!chevron) return null;

  const { pStart, pEnd, tip, avgWing, bisX, bisY } = chevron;

  // Raccogli le aste dritte recenti orientate concordemente con -bis
  const candidates = [];
  const startScan = Math.max(0, existingStrokes.length - 30);
  for (let i = existingStrokes.length - 1; i >= startScan; i--) {
    const s = existingStrokes[i];
    const pts = s && s.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const cdx = pts[pts.length - 1].x - pts[0].x;
    const cdy = pts[pts.length - 1].y - pts[0].y;
    if (cdx * cdx + cdy * cdy < 22 * 22) continue;
    const shaft = analyzeStraightShaftCandidate(pts, {
      minLength: 22,
      maxRmsFactor: 0.035,
      minPathRatio: 0.90
    });
    if (!shaft) continue;

    // Scegli l'orientamento dell'asta opposto alla bisettrice della V
    let chosen = null;
    let bestDot = -Infinity;
    for (const ep of shaft.endpoints) {
      const dotFwd = ep.dirX * (-bisX) + ep.dirY * (-bisY);
      if (dotFwd > bestDot) {
        bestDot = dotFwd;
        chosen = ep;
      }
    }
    if (!chosen || bestDot < 0.85) continue;

    // Filtro rapido di vicinanza della punta rispetto all'estremità anteriore dell'asta
    const roughDist = Math.hypot(tip.x - chosen.end.x, tip.y - chosen.end.y);
    if (roughDist > Math.max(48, shaft.chordLen * 0.9)) continue;

    candidates.push({
      strokeIndex: i,
      chordLen: shaft.chordLen,
      tail: chosen.tail,
      end: chosen.end,
      dirX: chosen.dirX,
      dirY: chosen.dirY
    });
  }

  if (candidates.length < 2) return null;

  let bestMatch = null;
  let bestScore = Infinity;

  for (let a = 0; a < candidates.length - 1; a++) {
    const barA = candidates[a];
    for (let b = a + 1; b < candidates.length; b++) {
      const barB = candidates[b];

      // 1. Lunghezze comparabili e parallelismo stretto
      const lenRatio = Math.min(barA.chordLen, barB.chordLen) / Math.max(barA.chordLen, barB.chordLen);
      if (lenRatio < 0.50) continue;

      const dotAB = barA.dirX * barB.dirX + barA.dirY * barB.dirY;
      if (dotAB < 0.94) continue;

      const sumDx = barA.dirX + barB.dirX;
      const sumDy = barA.dirY + barB.dirY;
      const sumLen = Math.hypot(sumDx, sumDy);
      if (sumLen < 0.1) continue;
      const ux = sumDx / sumLen;
      const uy = sumDy / sumLen;
      const nx = -uy;
      const ny = ux;

      // 2. Separazione perpendicolare compatibile con `=`
      const midAx = (barA.tail.x + barA.end.x) * 0.5;
      const midAy = (barA.tail.y + barA.end.y) * 0.5;
      const midBx = (barB.tail.x + barB.end.x) * 0.5;
      const midBy = (barB.tail.y + barB.end.y) * 0.5;
      const sep = Math.abs((midBx - midAx) * nx + (midBy - midAy) * ny);
      if (sep < 5 || sep > Math.min(34, Math.max(24, avgWing * 1.45))) continue;

      // 3. Sovrapposizione longitudinale e terminazione allineata
      const a0 = barA.tail.x * ux + barA.tail.y * uy;
      const a1 = barA.end.x * ux + barA.end.y * uy;
      const b0 = barB.tail.x * ux + barB.tail.y * uy;
      const b1 = barB.end.x * ux + barB.end.y * uy;
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap / Math.min(barA.chordLen, barB.chordLen) < 0.55) continue;

      const avgLen = (barA.chordLen + barB.chordLen) * 0.5;
      if (Math.abs(a1 - b1) > Math.max(16, avgLen * 0.38)) continue;

      // 4. Posizione della punta `>` centrata sul punto medio finale di `=`
      const midEndX = (barA.end.x + barB.end.x) * 0.5;
      const midEndY = (barA.end.y + barB.end.y) * 0.5;
      const vx = tip.x - midEndX;
      const vy = tip.y - midEndY;
      const along = vx * ux + vy * uy;
      const lateral = Math.abs(vx * nx + vy * ny);

      if (along < -12 || along > 22) continue;
      if (lateral > Math.max(9, sep * 0.65)) continue;

      // 5. Le due alette di `>` devono stare sui lati opposti della linea mediana
      //    e coprire gran parte della separazione tra le due barre.
      const sideStart = (pStart.x - midEndX) * nx + (pStart.y - midEndY) * ny;
      const sideEnd = (pEnd.x - midEndX) * nx + (pEnd.y - midEndY) * ny;
      if (sideStart * sideEnd >= 0) continue;
      if (Math.min(Math.abs(sideStart), Math.abs(sideEnd)) < 4) continue;
      if (Math.abs(sideStart - sideEnd) < sep * 0.70) continue;

      // Preferisci barre più vicine e recenti
      const recencyPenalty = (existingStrokes.length - 1 - barB.strokeIndex) * 0.8;
      const score = lateral * 1.6 + Math.abs(along - 4) + recencyPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestMatch = {
          barAIndex: barA.strokeIndex,
          barBIndex: barB.strokeIndex,
          barA,
          barB,
          chevron
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Costruisce la geometria pulita di `⇒` (2 barre parallele che terminano
 * esattamente sulle alette della punta `>`).
 */
export function buildImplicationArrowGeometry(match, { snapAxis = true } = {}) {
  const { barA, barB, chevron } = match;

  const sumDx = barA.dirX + barB.dirX;
  const sumDy = barA.dirY + barB.dirY;
  const sumLen = Math.hypot(sumDx, sumDy) || 1;
  let ux = sumDx / sumLen;
  let uy = sumDy / sumLen;

  if (snapAxis) {
    const angleDeg = Math.atan2(Math.abs(uy), Math.abs(ux)) * 180 / Math.PI;
    if (angleDeg <= 7) {
      ux = ux >= 0 ? 1 : -1;
      uy = 0;
    } else if (90 - angleDeg <= 7) {
      ux = 0;
      uy = uy >= 0 ? 1 : -1;
    }
  }

  const nx = -uy;
  const ny = ux;

  const projAlong = (p) => p.x * ux + p.y * uy;
  const projNormal = (p) => p.x * nx + p.y * ny;

  const nA = (projNormal(barA.tail) + projNormal(barA.end)) * 0.5;
  const nB = (projNormal(barB.tail) + projNormal(barB.end)) * 0.5;
  const midN = (nA + nB) * 0.5;
  const rawSep = Math.abs(nB - nA);
  const cleanSep = Math.max(7, Math.min(24, rawSep));
  const halfSep = cleanSep * 0.5;

  const halfAngle = 36 * Math.PI / 180;
  const tanHalf = Math.tan(halfAngle);
  const sinHalf = Math.sin(halfAngle);

  const tailAlong = (projAlong(barA.tail) + projAlong(barB.tail)) * 0.5;
  const avgEndAlong = (projAlong(barA.end) + projAlong(barB.end)) * 0.5;
  const rawTipAlong = Math.max(projAlong(chevron.tip), avgEndAlong + 3);
  const minTipAlong = tailAlong + 16 + halfSep / tanHalf;
  const tipAlong = Math.max(rawTipAlong, minTipAlong);
  const barEndAlong = tipAlong - halfSep / tanHalf;

  const toPoint = (along, normal) => ({
    x: ux * along + nx * normal,
    y: uy * along + ny * normal
  });

  const bar1Sign = nA >= nB ? 1 : -1;
  const bar2Sign = -bar1Sign;

  const tip = toPoint(tipAlong, midN);
  const wingLen = Math.max(12, Math.min(48, Math.max(chevron.avgWing, halfSep / sinHalf + 6)));

  return {
    barAEndpoints: [toPoint(tailAlong, midN + bar1Sign * halfSep), toPoint(barEndAlong, midN + bar1Sign * halfSep)],
    barBEndpoints: [toPoint(tailAlong, midN + bar2Sign * halfSep), toPoint(barEndAlong, midN + bar2Sign * halfSep)],
    tip,
    dirX: ux,
    dirY: uy,
    wingLen,
    halfAngleDeg: 36
  };
}

/**
 * Analizza uno stroke continuo a 1 tratto per riconoscere una freccia (asta dritta + 2 alette finali).
 * Ritorna `{ tail, rawTip, minAlong, avgSide }` o `null`.
 */
export function analyzeSingleStrokeArrow(pts) {
  if (!Array.isArray(pts) || pts.length < 10) return null;
  const n = pts.length;

  const tail = pts[0];
  let maxDist = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - tail.x, pts[i].y - tail.y);
    if (d > maxDist) maxDist = d;
  }
  if (maxDist < 52) return null;

  const threshold = maxDist * 0.94;
  let tipIdx = -1;
  let peakDist = -1;
  const maxSearchIdx = n - 4;
  for (let i = 3; i <= maxSearchIdx; i++) {
    const d = Math.hypot(pts[i].x - tail.x, pts[i].y - tail.y);
    if (d >= threshold) {
      if (d >= peakDist) {
        peakDist = d;
        tipIdx = i;
      } else {
        break;
      }
    }
  }
  if (tipIdx < 3 || tipIdx > n - 4) return null;

  const rawTip = pts[tipIdx];
  const shaftLen = Math.hypot(rawTip.x - tail.x, rawTip.y - tail.y);
  if (shaftLen < 52) return null;

  let shaftPathLen = 0;
  for (let i = 1; i <= tipIdx; i++) {
    shaftPathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (shaftLen / Math.max(shaftPathLen, 1) < 0.91) return null;

  const shaftCheckEnd = Math.max(2, tipIdx - 1);
  const shaftSlice = pts.slice(0, shaftCheckEnd + 1);
  const rmsShaft = perpendicularRmsDeviationSampled(shaftSlice, tail, rawTip, 2);
  if (rmsShaft === null || rmsShaft > Math.max(3.5, shaftLen * 0.030)) return null;

  const ux = (rawTip.x - tail.x) / shaftLen;
  const uy = (rawTip.y - tail.y) / shaftLen;
  const px = -uy;
  const py = ux;

  let minPerp = 0;
  let maxPerp = 0;
  let minAlong = 0;
  let maxAlong = 0;
  let maxWingDist = 0;
  let headPathLen = 0;

  for (let i = tipIdx + 1; i < n; i++) {
    headPathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const dx = pts[i].x - rawTip.x;
    const dy = pts[i].y - rawTip.y;
    const along = dx * ux + dy * uy;
    const perp = dx * px + dy * py;
    const d = Math.hypot(dx, dy);
    if (perp < minPerp) minPerp = perp;
    if (perp > maxPerp) maxPerp = perp;
    if (along < minAlong) minAlong = along;
    if (along > maxAlong) maxAlong = along;
    if (d > maxWingDist) maxWingDist = d;
  }

  if (maxAlong > Math.max(10, shaftLen * 0.08)) return null;
  if (minAlong > -6) return null;
  if (maxPerp < 6 || minPerp > -6) return null;
  const wingSymmetry = Math.min(maxPerp, -minPerp) / Math.max(maxPerp, -minPerp);
  if (wingSymmetry < 0.40) return null;
  if (maxWingDist < 9 || maxWingDist > Math.min(60, shaftLen * 0.45)) return null;
  if (shaftLen < maxWingDist * 2.0) return null;
  if (headPathLen > maxWingDist * 5.0) return null;

  return {
    tail: { x: tail.x, y: tail.y },
    rawTip: { x: rawTip.x, y: rawTip.y },
    minAlong,
    avgSide: (maxPerp - minPerp) * 0.5
  };
}
