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

function _maxPerpFromChord(points, A, B) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return Infinity;
  const nx = -dy / len;
  const ny = dx / len;
  let maxAbs = 0;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs((points[i].x - A.x) * nx + (points[i].y - A.y) * ny);
    if (d > maxAbs) maxAbs = d;
  }
  return maxAbs;
}

function _resampleShaftUniform(points, targetCount) {
  const n = points.length;
  if (n <= 1 || targetCount <= 1) {
    const p = points[0];
    return [{
      x: p.x,
      y: p.y,
      pressure: Number.isFinite(p.pressure) ? p.pressure : 0.5,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      pointerType: p.pointerType
    }];
  }

  const cum = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    cum.push(total);
  }
  if (total < 1e-4) {
    return points.map(p => ({
      x: p.x,
      y: p.y,
      pressure: Number.isFinite(p.pressure) ? p.pressure : 0.5,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      pointerType: p.pointerType
    }));
  }

  const out = [{
    x: points[0].x,
    y: points[0].y,
    pressure: Number.isFinite(points[0].pressure) ? points[0].pressure : 0.5,
    tiltX: points[0].tiltX,
    tiltY: points[0].tiltY,
    pointerType: points[0].pointerType
  }];

  let seg = 1;
  for (let k = 1; k < targetCount - 1; k++) {
    const target = (k / (targetCount - 1)) * total;
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const prevD = cum[seg - 1];
    const nextD = cum[seg];
    const span = Math.max(1e-6, nextD - prevD);
    const t = Math.max(0, Math.min(1, (target - prevD) / span));
    const a = points[seg - 1];
    const b = points[seg];
    const pa = Number.isFinite(a.pressure) ? a.pressure : 0.5;
    const pb = Number.isFinite(b.pressure) ? b.pressure : 0.5;
    const ref = t < 0.5 ? a : b;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      pressure: pa + (pb - pa) * t,
      tiltX: ref.tiltX,
      tiltY: ref.tiltY,
      pointerType: ref.pointerType
    });
  }

  const last = points[n - 1];
  out.push({
    x: last.x,
    y: last.y,
    pressure: Number.isFinite(last.pressure) ? last.pressure : 0.5,
    tiltX: last.tiltX,
    tiltY: last.tiltY,
    pointerType: last.pointerType
  });
  return out;
}

/**
 * Rende uniforme una coda curva di freccia tramite ricampionamento a passo costante
 * + 4 passate gaussiane [0.25, 0.50, 0.25] con estremi ancorati.
 */
export function smoothArrowShaftPoints(points, passes = 4) {
  if (!Array.isArray(points) || points.length < 2) return points ? [...points] : [];
  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const count = Math.max(10, Math.min(72, Math.round(pathLen / 6) + 1));
  let src = _resampleShaftUniform(points, count);
  const n = src.length;
  if (n < 4 || passes <= 0) return src;

  for (let pass = 0; pass < passes; pass++) {
    const out = new Array(n);
    out[0] = { ...src[0] };
    out[n - 1] = { ...src[n - 1] };
    for (let i = 1; i < n - 1; i++) {
      const prev = src[i - 1];
      const curr = src[i];
      const next = src[i + 1];
      out[i] = {
        x: 0.25 * prev.x + 0.50 * curr.x + 0.25 * next.x,
        y: 0.25 * prev.y + 0.50 * curr.y + 0.25 * next.y,
        pressure: 0.25 * prev.pressure + 0.50 * curr.pressure + 0.25 * next.pressure,
        tiltX: curr.tiltX,
        tiltY: curr.tiltY,
        pointerType: curr.pointerType
      };
    }
    src = out;
  }
  return src;
}

/**
 * Calcola la tangente di uscita normalizzata `(dirX, dirY)` all'estremità finale (`!atStart`)
 * o iniziale (`atStart`) di un'asta curva già regolarizzata.
 */
export function computeShaftEndpointTangent(points, atStart = false) {
  if (!Array.isArray(points) || points.length < 2) return { dirX: 1, dirY: 0 };
  const n = points.length;
  let totalLen = 0;
  for (let i = 1; i < n; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const lookback = Math.min(28, Math.max(12, totalLen * 0.22));
  const end = atStart ? points[0] : points[n - 1];

  let acc = 0;
  let anchor = atStart ? points[n - 1] : points[0];
  if (!atStart) {
    for (let i = n - 1; i > 0; i--) {
      const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      if (acc + seg >= lookback && seg > 1e-6) {
        const remain = lookback - acc;
        const t = remain / seg;
        anchor = {
          x: points[i].x + (points[i - 1].x - points[i].x) * t,
          y: points[i].y + (points[i - 1].y - points[i].y) * t
        };
        break;
      }
      acc += seg;
      anchor = points[i - 1];
    }
  } else {
    for (let i = 0; i < n - 1; i++) {
      const seg = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
      if (acc + seg >= lookback && seg > 1e-6) {
        const remain = lookback - acc;
        const t = remain / seg;
        anchor = {
          x: points[i].x + (points[i + 1].x - points[i].x) * t,
          y: points[i].y + (points[i + 1].y - points[i].y) * t
        };
        break;
      }
      acc += seg;
      anchor = points[i + 1];
    }
  }

  const dx = end.x - anchor.x;
  const dy = end.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-4) return { dirX: dx / len, dirY: dy / len };

  const fallbackDx = points[n - 1].x - points[0].x;
  const fallbackDy = points[n - 1].y - points[0].y;
  const fallbackLen = Math.hypot(fallbackDx, fallbackDy) || 1;
  const sign = atStart ? -1 : 1;
  return { dirX: (fallbackDx / fallbackLen) * sign, dirY: (fallbackDy / fallbackLen) * sign };
}

function _isSmoothCurvedShaft(points) {
  const res = _resampleShaftUniform(points, 13);
  if (res.length < 4) return false;
  let totalTurn = 0;
  let prevUx = 0;
  let prevUy = 0;
  let hasPrev = false;

  for (let i = 1; i < res.length; i++) {
    const dx = res[i].x - res[i - 1].x;
    const dy = res[i].y - res[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const ux = dx / len;
    const uy = dy / len;
    if (hasPrev) {
      const dot = Math.max(-1, Math.min(1, prevUx * ux + prevUy * uy));
      if (dot < 0.20) return false; // spigolo netto (> ~78°), es. "L", "7", "Z"
      totalTurn += Math.acos(dot);
    }
    prevUx = ux;
    prevUy = uy;
    hasPrev = true;
  }
  return totalTurn <= 3.9; // ~223°, accetta archi fino a ~semicerchio / curve a S morbide
}

/**
 * Verifica che uno stroke esistente sia una linea dritta valida (o, se `allowCurved`,
 * una curva continua senza spigoli/occhielli) da usare come asta freccia.
 */
export function analyzeArrowShaftCandidate(points, {
  minLength = 42,
  maxRmsBase = 4.5,
  maxRmsFactor = 0.038,
  minPathRatio = 0.92,
  allowCurved = false
} = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const chordLen = Math.hypot(dx, dy);

  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (pathLen < Math.max(10, minLength)) return null;

  const rms = points.length >= 3 ? perpendicularRmsDeviationSampled(points, first, last, 2) : 0;
  const maxPerp = points.length >= 3 ? _maxPerpFromChord(points, first, last) : 0;
  const chordRatio = chordLen / Math.max(pathLen, 1);

  const straightEnough =
    chordLen >= minLength &&
    chordRatio >= minPathRatio &&
    rms !== null &&
    rms <= Math.max(maxRmsBase, chordLen * maxRmsFactor) &&
    maxPerp <= Math.max(maxRmsBase * 1.9, chordLen * Math.max(0.065, maxRmsFactor * 1.7));

  if (straightEnough) {
    const ux = dx / chordLen;
    const uy = dy / chordLen;
    return {
      isStraight: true,
      chordLen,
      pathLen,
      first,
      last,
      endpoints: [
        { end: last, tail: first, dirX: ux, dirY: uy },
        { end: first, tail: last, dirX: -ux, dirY: -uy }
      ]
    };
  }

  if (!allowCurved) return null;
  if (chordLen < 26 || chordRatio < 0.55) return null;
  if (!_isSmoothCurvedShaft(points)) return null;

  const smoothed = smoothArrowShaftPoints(points, 4);
  const sFirst = smoothed[0];
  const sLast = smoothed[smoothed.length - 1];
  const endTan = computeShaftEndpointTangent(smoothed, false);
  const startTan = computeShaftEndpointTangent(smoothed, true);

  return {
    isStraight: false,
    chordLen,
    pathLen,
    first: sFirst,
    last: sLast,
    endpoints: [
      {
        end: sLast,
        tail: sFirst,
        dirX: endTan.dirX,
        dirY: endTan.dirY,
        smoothedPoints: smoothed
      },
      {
        end: sFirst,
        tail: sLast,
        dirX: startTan.dirX,
        dirY: startTan.dirY,
        smoothedPoints: [...smoothed].reverse()
      }
    ]
  };
}

/**
 * Verifica che uno stroke esistente sia una linea dritta valida come asta freccia.
 * Esclude lettere curve ("d", "u", "o", "c") e tratti troppo corti.
 */
export function analyzeStraightShaftCandidate(points, {
  minLength = 42,
  maxRmsBase = 3.5,
  maxRmsFactor = 0.032,
  minPathRatio = 0.92
} = {}) {
  return analyzeArrowShaftCandidate(points, {
    minLength,
    maxRmsBase,
    maxRmsFactor,
    minPathRatio,
    allowCurved: false
  });
}

/**
 * Analizza se `tipPoints` ha la geometria di una punta a V (`>`).
 * Ritorna `{ pStart, pEnd, tip, w1, w2, avgWing, bisX, bisY }` o `null`.
 */
export function parseChevronTip(tipPoints) {
  if (!Array.isArray(tipPoints) || tipPoints.length < 3) return null;

  const n = tipPoints.length;
  let pathLen = 0;
  for (let i = 1; i < n; i++) {
    pathLen += Math.hypot(tipPoints[i].x - tipPoints[i - 1].x, tipPoints[i].y - tipPoints[i - 1].y);
  }
  if (pathLen < 10 || pathLen > 155) return null;

  const pStart = tipPoints[0];
  const pEnd = tipPoints[n - 1];
  const chordLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
  const chordRatio = chordLen / Math.max(pathLen, 1);
  if (chordRatio < 0.20 || chordRatio > 0.94) return null;

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
  if (w1 < 4.5 || w2 < 4.5 || Math.max(w1, w2) > 68) return null;
  if (Math.min(w1, w2) / Math.max(w1, w2) < 0.40) return null;
  if (pathLen / (w1 + w2) > 1.26) return null;

  // Entrambe le alette devono essere ragionevolmente dritte
  for (let i = 1; i < tipIdx; i++) {
    const dSq = distSqPointToSegment(
      tipPoints[i].x, tipPoints[i].y,
      pStart.x, pStart.y, tip.x, tip.y
    );
    if (dSq > Math.max(36, (w1 * 0.24) ** 2)) return null;
  }
  for (let i = tipIdx + 1; i < n - 1; i++) {
    const dSq = distSqPointToSegment(
      tipPoints[i].x, tipPoints[i].y,
      tip.x, tip.y, pEnd.x, pEnd.y
    );
    if (dSq > Math.max(36, (w2 * 0.24) ** 2)) return null;
  }

  // Angolo di apertura della V (~24° .. 136°)
  const vAx = (pStart.x - tip.x) / w1;
  const vAy = (pStart.y - tip.y) / w1;
  const vBx = (pEnd.x - tip.x) / w2;
  const vBy = (pEnd.y - tip.y) / w2;
  const cosOpen = vAx * vBx + vAy * vBy;
  if (cosOpen < -0.72 || cosOpen > 0.91) return null;

  // Bisettrice dalla punta verso il centro delle alette
  const midX = (pStart.x + pEnd.x) * 0.5 - tip.x;
  const midY = (pStart.y + pEnd.y) * 0.5 - tip.y;
  const midLen = Math.hypot(midX, midY);
  if (midLen < 2.5) return null;

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
 * Analizza se `tipPoints` è una punta `>` allineata all'estremità di un'asta (dritta o curva)
 * in `existingStrokes`. Ritorna `{ shaftIndex, isStraight, target, wingLen }` o `null`.
 */
export function findArrowTipTarget(tipPoints, existingStrokes) {
  if (!Array.isArray(existingStrokes) || existingStrokes.length === 0) return null;
  const chevron = parseChevronTip(tipPoints);
  if (!chevron) return null;

  const { pStart, pEnd, tip, avgWing, bisX, bisY } = chevron;
  const maxLateralOffset = Math.min(11, Math.max(6, avgWing * 0.40));
  const minAlongOffset = -15;
  const maxAlongOffset = 14;

  let bestMatch = null;
  let bestScore = Infinity;

  const maxAlongAbs = Math.max(Math.abs(minAlongOffset), maxAlongOffset);
  const maxTipDistSq = maxAlongAbs * maxAlongAbs + maxLateralOffset * maxLateralOffset + 4;
  const minPreChord = Math.max(24, avgWing * 1.1);
  const minPreChordSq = minPreChord * minPreChord;

  for (let i = existingStrokes.length - 1; i >= 0; i--) {
    const s = existingStrokes[i];
    const pts = s && s.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;

    // Filtro O(1) senza scansione punti: distanza punta dagli estremi e corda minima
    const first = pts[0];
    const last = pts[pts.length - 1];
    const cdx = last.x - first.x;
    const cdy = last.y - first.y;
    if (cdx * cdx + cdy * cdy < minPreChordSq) continue;

    const dfx = tip.x - first.x;
    const dfy = tip.y - first.y;
    const dlx = tip.x - last.x;
    const dly = tip.y - last.y;
    if (dfx * dfx + dfy * dfy > maxTipDistSq && dlx * dlx + dly * dly > maxTipDistSq) {
      continue;
    }

    const shaft = analyzeArrowShaftCandidate(pts, {
      minLength: 42,
      maxRmsBase: 4.5,
      maxRmsFactor: 0.038,
      minPathRatio: 0.94,
      allowCurved: true
    });
    if (!shaft) continue;
    if (shaft.pathLen < avgWing * 1.5 || shaft.chordLen < avgWing * 1.1) continue;

    const minDotBack = shaft.isStraight ? -0.82 : -0.74;

    for (const info of shaft.endpoints) {
      const vx = tip.x - info.end.x;
      const vy = tip.y - info.end.y;

      // Scomposizione lungo la tangente d'uscita e perpendicolarmente ad essa
      const along = vx * info.dirX + vy * info.dirY;
      const lateral = Math.abs(-vx * info.dirY + vy * info.dirX);

      if (lateral > maxLateralOffset) continue;
      if (along < minAlongOffset || along > maxAlongOffset) continue;

      // La bisettrice della V deve puntare all'indietro rispetto alla direzione di uscita
      const dotBack = bisX * info.dirX + bisY * info.dirY;
      if (dotBack > minDotBack) continue;

      // Le due alette devono trovarsi sui due lati opposti dell'asse alla punta
      const sideStart = (pStart.x - info.end.x) * (-info.dirY) + (pStart.y - info.end.y) * info.dirX;
      const sideEnd = (pEnd.x - info.end.x) * (-info.dirY) + (pEnd.y - info.end.y) * info.dirX;
      if (sideStart * sideEnd >= 0) continue;
      if (Math.min(Math.abs(sideStart), Math.abs(sideEnd)) < 3) continue;

      const score = lateral * 1.5 + Math.abs(along);
      if (score < bestScore) {
        bestScore = score;
        bestMatch = {
          shaftIndex: i,
          isStraight: shaft.isStraight,
          target: info
        };
      }
    }
  }

  if (!bestMatch) return null;

  const wingLen = Math.max(9, Math.min(48, avgWing));
  return {
    shaftIndex: bestMatch.shaftIndex,
    isStraight: bestMatch.isStraight,
    target: bestMatch.target,
    wingLen
  };
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
    if (cdx * cdx + cdy * cdy < 12 * 12) continue;
    const shaft = analyzeStraightShaftCandidate(pts, {
      minLength: 12,
      maxRmsBase: 4.5,
      maxRmsFactor: 0.06,
      minPathRatio: 0.86
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
    if (!chosen || bestDot < 0.78) continue;

    // Filtro rapido di vicinanza della punta rispetto all'estremità anteriore dell'asta
    const roughDist = Math.hypot(tip.x - chosen.end.x, tip.y - chosen.end.y);
    if (roughDist > Math.max(48, shaft.chordLen * 1.15)) continue;

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

      // 1. Lunghezze comparabili e parallelismo
      const lenRatio = Math.min(barA.chordLen, barB.chordLen) / Math.max(barA.chordLen, barB.chordLen);
      if (lenRatio < 0.45) continue;

      const dotAB = barA.dirX * barB.dirX + barA.dirY * barB.dirY;
      if (dotAB < 0.90) continue;

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
      if (sep < 3.2 || sep > Math.min(36, Math.max(24, avgWing * 1.65))) continue;

      // 3. Sovrapposizione longitudinale e terminazione allineata
      const a0 = barA.tail.x * ux + barA.tail.y * uy;
      const a1 = barA.end.x * ux + barA.end.y * uy;
      const b0 = barB.tail.x * ux + barB.tail.y * uy;
      const b1 = barB.end.x * ux + barB.end.y * uy;
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap / Math.min(barA.chordLen, barB.chordLen) < 0.45) continue;

      const avgLen = (barA.chordLen + barB.chordLen) * 0.5;
      if (Math.abs(a1 - b1) > Math.max(18, avgLen * 0.45)) continue;

      // 4. Posizione della punta `>` centrata sul punto medio finale di `=`
      const midEndX = (barA.end.x + barB.end.x) * 0.5;
      const midEndY = (barA.end.y + barB.end.y) * 0.5;
      const vx = tip.x - midEndX;
      const vy = tip.y - midEndY;
      const along = vx * ux + vy * uy;
      const lateral = Math.abs(vx * nx + vy * ny);

      if (along < -Math.max(14, avgLen * 0.45) || along > Math.max(26, avgWing * 1.6)) continue;
      if (lateral > Math.max(10, sep * 0.75)) continue;

      // 5. Le due alette di `>` devono stare sui lati opposti della linea mediana
      //    e coprire gran parte della separazione tra le due barre.
      const sideStart = (pStart.x - midEndX) * nx + (pStart.y - midEndY) * ny;
      const sideEnd = (pEnd.x - midEndX) * nx + (pEnd.y - midEndY) * ny;
      if (sideStart * sideEnd >= 0) continue;
      if (Math.min(Math.abs(sideStart), Math.abs(sideEnd)) < 2.5) continue;
      if (Math.abs(sideStart - sideEnd) < Math.max(6, sep * 0.62)) continue;

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
  const cleanSep = Math.max(5.5, Math.min(24, rawSep));
  const halfSep = cleanSep * 0.5;

  const halfAngle = 36 * Math.PI / 180;
  const tanHalf = Math.tan(halfAngle);
  const sinHalf = Math.sin(halfAngle);

  const tailAlong = (projAlong(barA.tail) + projAlong(barB.tail)) * 0.5;
  const avgEndAlong = (projAlong(barA.end) + projAlong(barB.end)) * 0.5;
  const rawTipAlong = Math.max(projAlong(chevron.tip), avgEndAlong + 3);
  const minTipAlong = tailAlong + 12 + halfSep / tanHalf;
  const tipAlong = Math.max(rawTipAlong, minTipAlong);
  const barEndAlong = tipAlong - halfSep / tanHalf;

  const toPoint = (along, normal) => ({
    x: ux * along + nx * normal,
    y: uy * along + ny * normal
  });

  const bar1Sign = nA >= nB ? 1 : -1;
  const bar2Sign = -bar1Sign;

  const tip = toPoint(tipAlong, midN);
  const wingLen = Math.max(10, Math.min(48, Math.max(chevron.avgWing, halfSep / sinHalf + 4)));

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
 * Analizza uno stroke continuo a 1 tratto per riconoscere una freccia
 * (asta dritta da raddrizzare OPPURE coda curva da regolarizzare + 2 alette finali).
 * Ritorna `{ tail, rawTip, isStraight, dirX, dirY, smoothedShaft, minAlong, avgSide }` o `null`.
 */
export function analyzeSingleStrokeArrow(pts) {
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const n = pts.length;

  const tail = pts[0];
  let maxDist = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - tail.x, pts[i].y - tail.y);
    if (d > maxDist) maxDist = d;
  }
  if (maxDist < 42) return null;

  const threshold = maxDist * 0.92;
  const dropCutoff = Math.max(5, maxDist * 0.04);
  let tipIdx = -1;
  let peakDist = -1;
  const maxSearchIdx = n - 4;
  for (let i = 3; i <= maxSearchIdx; i++) {
    const d = Math.hypot(pts[i].x - tail.x, pts[i].y - tail.y);
    if (d >= threshold) {
      if (d >= peakDist) {
        peakDist = d;
        tipIdx = i;
      } else if (d < peakDist - dropCutoff) {
        break;
      }
    } else if (peakDist >= 0 && d < peakDist - dropCutoff) {
      break;
    }
  }
  if (tipIdx < 3 || tipIdx > n - 4) return null;

  const rawTip = pts[tipIdx];
  const shaftSlice = pts.slice(0, tipIdx + 1);
  const shaftAnalysis = analyzeArrowShaftCandidate(shaftSlice, {
    minLength: 42,
    maxRmsBase: 4.5,
    maxRmsFactor: 0.038,
    minPathRatio: 0.94,
    allowCurved: true
  });
  if (!shaftAnalysis) return null;

  const shaftChordLen = shaftAnalysis.chordLen;
  const shaftPathLen = shaftAnalysis.pathLen;
  const isStraight = shaftAnalysis.isStraight;
  const endInfo = shaftAnalysis.endpoints[0];
  const ux = endInfo.dirX;
  const uy = endInfo.dirY;
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

  if (maxAlong > Math.max(11, shaftPathLen * 0.09)) return null;
  if (minAlong > -5) return null;
  if (maxPerp < 5.5 || minPerp > -5.5) return null;
  const wingSymmetry = Math.min(maxPerp, -minPerp) / Math.max(maxPerp, -minPerp);
  if (wingSymmetry < 0.38) return null;
  if (maxWingDist < 8 || maxWingDist > Math.min(60, shaftPathLen * 0.48)) return null;
  if (shaftPathLen < maxWingDist * 1.9 && shaftChordLen < maxWingDist * 1.9) return null;
  if (headPathLen > maxWingDist * 5.2) return null;

  return {
    tail: { x: tail.x, y: tail.y },
    rawTip: { x: rawTip.x, y: rawTip.y },
    isStraight,
    dirX: ux,
    dirY: uy,
    smoothedShaft: isStraight ? null : endInfo.smoothedPoints,
    minAlong,
    avgSide: (maxPerp - minPerp) * 0.5
  };
}
