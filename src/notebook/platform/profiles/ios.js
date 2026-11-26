/**
 * @module notebook/platform/profiles/ios
 *
 * Profilo iPadOS / iOS + Apple Pencil (1ª/2ª gen, USB-C, Pro) per Safari, Chrome (`CriOS`) e WKWebView:
 *   - Gestione sicura di `pointermove` a pressione 0 e `pointerup` finale (60Hz/120Hz/240Hz)
 *   - Giunti circolari sempre attivi sotto 1.8px per evitare micro-fessure CoreGraphics ("tratto tratteggiato")
 *   - Pre-pulizia non distruttiva di micro-ganci testa/coda e micro-jitter 120/240Hz per linee dritte
 */

function _clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function _pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

function _trimClusterTail(points, maxClusterRadius = 6.5) {
  if (!Array.isArray(points) || points.length < 6) return points;
  const n = points.length;
  const tip = points[n - 1];
  const minKeep = 4;

  let cutIdx = n - 1;
  while (cutIdx > minKeep) {
    const p = points[cutIdx - 1];
    if (Math.hypot(tip.x - p.x, tip.y - p.y) > maxClusterRadius) break;
    cutIdx--;
  }
  if (cutIdx >= n - 1) return points;
  return points.slice(0, cutIdx + 1);
}

/**
 * Rimuove eventuali micro-ganci di atterraggio/sollevamento (1–16px ai soli estremi)
 * e cluster stazionari su copie temporanee usate SOLO per il riconoscimento linee,
 * senza alterare i tratti a mano libera né lettere curve/angoli reali ("L", "7", "c").
 */
export function cleanIosLinePoints(rawPoints, tailTrimRadius = 6.5) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 4) return rawPoints;

  // 1. Taglio di eventuale singolo scatto finale da sollevamento (<= 12px che devia bruscamente)
  let pts = rawPoints;
  if (pts.length >= 6) {
    const n = pts.length;
    const last = pts[n - 1];
    const prev = pts[n - 2];
    const slipLen = Math.hypot(last.x - prev.x, last.y - prev.y);
    if (slipLen > 0.5 && slipLen <= 12) {
      let anchorIdx = n - 2;
      while (anchorIdx > 0 && Math.hypot(prev.x - pts[anchorIdx].x, prev.y - pts[anchorIdx].y) < 16) {
        anchorIdx--;
      }
      const bdx = prev.x - pts[anchorIdx].x;
      const bdy = prev.y - pts[anchorIdx].y;
      const bLen = Math.hypot(bdx, bdy);
      if (bLen >= 8) {
        const dot = ((last.x - prev.x) * bdx + (last.y - prev.y) * bdy) / (slipLen * bLen);
        if (dot < 0.65) {
          pts = pts.slice(0, n - 1);
        }
      }
    }
  }

  // 2. Pulizia cluster stazionario finale
  pts = _trimClusterTail(pts, tailTrimRadius);
  if (pts.length < 5) return pts;

  // 3. Pulizia cluster stazionario iniziale
  {
    const head = pts[0];
    let headCut = 0;
    const maxCut = pts.length - 4;
    while (headCut < maxCut) {
      const next = pts[headCut + 1];
      if (Math.hypot(next.x - head.x, next.y - head.y) > 5.0) break;
      headCut++;
    }
    if (headCut > 0) {
      pts = pts.slice(headCut);
    }
  }

  if (pts.length < 8) return pts;

  const totalChord = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
  if (totalChord < 55) return pts;

  // 4. Riconosci direzione del corpo centrale (escludendo al più il primo/ultimo 14-15% e <= 18px)
  const n = pts.length;
  const maxHeadTrimDist = Math.min(16, totalChord * 0.14);
  const maxTailTrimDist = Math.min(18, totalChord * 0.15);
  const maxIdxLimit = Math.max(1, Math.floor(n * 0.18));

  let coreStart = 0;
  let acc = 0;
  while (coreStart < maxIdxLimit && coreStart < n - 5) {
    const seg = Math.hypot(pts[coreStart + 1].x - pts[coreStart].x, pts[coreStart + 1].y - pts[coreStart].y);
    if (acc + seg > maxHeadTrimDist) break;
    acc += seg;
    coreStart++;
  }

  let coreEnd = n - 1;
  acc = 0;
  while (coreEnd > n - 1 - maxIdxLimit && coreEnd > coreStart + 4) {
    const seg = Math.hypot(pts[coreEnd].x - pts[coreEnd - 1].x, pts[coreEnd].y - pts[coreEnd - 1].y);
    if (acc + seg > maxTailTrimDist) break;
    acc += seg;
    coreEnd--;
  }

  const cdx = pts[coreEnd].x - pts[coreStart].x;
  const cdy = pts[coreEnd].y - pts[coreStart].y;
  const coreLen = Math.hypot(cdx, cdy);
  if (coreLen >= 42) {
    const ux = cdx / coreLen;
    const uy = cdy / coreLen;
    const nx = -uy;
    const ny = ux;

    let trimStart = 0;
    for (let i = 0; i < coreStart; i++) {
      const segDx = pts[i + 1].x - pts[i].x;
      const segDy = pts[i + 1].y - pts[i].y;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen < 0.2) {
        trimStart = i + 1;
        continue;
      }
      const dot = (segDx * ux + segDy * uy) / segLen;
      const perpOff = Math.abs((pts[i].x - pts[coreStart].x) * nx + (pts[i].y - pts[coreStart].y) * ny);
      if (dot < 0.72 || perpOff > 2.2) {
        trimStart = i + 1;
      }
    }

    let trimEnd = n - 1;
    for (let i = n - 1; i > coreEnd; i--) {
      const segDx = pts[i].x - pts[i - 1].x;
      const segDy = pts[i].y - pts[i - 1].y;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen < 0.2) {
        trimEnd = i - 1;
        continue;
      }
      const dot = (segDx * ux + segDy * uy) / segLen;
      const perpOff = Math.abs((pts[i].x - pts[coreEnd].x) * nx + (pts[i].y - pts[coreEnd].y) * ny);
      if (dot < 0.72 || perpOff > 2.2) {
        trimEnd = i - 1;
      }
    }

    if (trimEnd - trimStart + 1 >= 6 && (trimStart > 0 || trimEnd < n - 1)) {
      const sliced = pts.slice(trimStart, trimEnd + 1);
      const slicedChord = Math.hypot(sliced[sliced.length - 1].x - sliced[0].x, sliced[sliced.length - 1].y - sliced[0].y);
      if (slicedChord >= 42) {
        pts = sliced;
      }
    }
  }

  // 5. Leggero rilassamento spaziale [0.25, 0.50, 0.25] (2 passate, estremi ancorati)
  //    per attenuare il micro-jitter 120/240Hz che gonfia pathLen rispetto a chordLen
  if (pts.length >= 6 && _pathLength(pts) > 35) {
    let cur = pts;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Array(cur.length);
      next[0] = cur[0];
      next[cur.length - 1] = cur[cur.length - 1];
      for (let i = 1; i < cur.length - 1; i++) {
        next[i] = {
          ...cur[i],
          x: 0.25 * cur[i - 1].x + 0.5 * cur[i].x + 0.25 * cur[i + 1].x,
          y: 0.25 * cur[i - 1].y + 0.5 * cur[i].y + 0.25 * cur[i + 1].y
        };
      }
      cur = next;
    }
    return cur;
  }

  return pts;
}

export const iosProfile = Object.freeze({
  family: 'ios',

  pressure: Object.freeze({
    baseGain: 1.48,
    zeroPressureFallback: 0.28,
    minRenderWidthPx: 0.45
  }),

  input: Object.freeze({
    dropZeroPressureUnpressedMove: false,
    capturePointerUpEndpoint: true,
    dedupCoalescedMinDistPx: 0.15,
    shouldIgnoreUnpressedPenMove(e, drawingState) {
      if (drawingState && drawingState.isDrawing && e && e.pointerId === drawingState.currentPointerId) {
        return false;
      }
      return Boolean(e && e.pointerType === 'pen' && e.buttons === 0 && !(e.pressure > 0));
    }
  }),

  stabilizer: Object.freeze({
    defaultDtMs: 8.33,
    gaussianBlendScale: 0.84,
    gaussianShiftScale: 0.90,
    minDeadzonePx(s) {
      const clamped = _clamp01(s);
      return clamped >= 0.08 ? 0.38 * Math.min(1, clamped / 0.35) : 0;
    },
    restDeadzoneMinPx: 1.45
  }),

  rendering: Object.freeze({
    alwaysJoinThinSegments: true,
    jointMinWidthThresholdPx: 0,
    adjustSegmentSteps(baseSteps, segLen, smoothness) {
      if (baseSteps <= 1) return 1;
      const s = smoothness == null ? 0.5 : smoothness;
      if (s > 0.70 && segLen > 34) {
        return 5;
      }
      return baseSteps;
    }
  }),

  recognition: Object.freeze({
    cleanReleasePoints: null,
    cleanLinePoints: cleanIosLinePoints,
    releaseTailTrimRadius: 4.5,
    lineHold: Object.freeze({
      minChordLen: 42,
      minPathRatio: 0.91,
      maxRmsBase: 3.0,
      maxRmsFactor: 0.028,
      minTailCos: 0.62,
      signHysteresis: 2.8,
      tailTrimRadius: 6.5
    }),
    lineAuto: Object.freeze({
      minChordLen: 75,
      minPathRatio: 0.978,
      maxRmsBase: 1.8,
      maxRmsFactor: 0.011,
      maxPerpBase: 3.4,
      maxPerpFactor: 0.020,
      minEndCos: 0.88,
      axisSnapDeg: 3.0,
      maxSignChangesDivisor: 95,
      tailTrimRadius: 6.5
    })
  })
});
