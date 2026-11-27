/**
 * @module notebook/platform/profiles/ios
 *
 * Profilo iPadOS / iOS + Apple Pencil (1ª/2ª gen, USB-C, Pro) per Safari, Chrome (`CriOS`) e WKWebView:
 *   - Filtro anti-hover in chiusura (`buttons === 0 && pressure === 0` dopo contatto reale) e
 *     cattura controllata di `pointerup` (previene codine/sbavature da sollevamento Apple Pencil Pro)
 *   - Stabilizzazione iniziale d'atterraggio e filtraggio pressione/spaziale a 120/240Hz
 *   - Rendering a nastro continuo singolo (zero trapezi spezzati/bordi seghettati "pixellati")
 *   - DPR Retina adattivo allo zoom, scratch canvas ampio e prediction 2x
 *   - Pre-pulizia non distruttiva testa/coda + ricampionamento uniforme per linee e forme su vetro
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

function _trimClusterHead(points, maxClusterRadius = 5.0) {
  if (!Array.isArray(points) || points.length < 6) return points;
  const head = points[0];
  let headCut = 0;
  const maxCut = points.length - 4;
  while (headCut < maxCut) {
    const next = points[headCut + 1];
    if (Math.hypot(next.x - head.x, next.y - head.y) > maxClusterRadius) break;
    headCut++;
  }
  return headCut > 0 ? points.slice(headCut) : points;
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
 * Rimuove da 1 a 3 micro-punti di scatto da sollevamento (<= maxHookPx totali)
 * quando deviano bruscamente dalla tangente di uscita del tratto.
 */
function _trimLiftOffHook(points, maxHookPx = 15, minDot = 0.58) {
  if (!Array.isArray(points) || points.length < 6) return points;
  let pts = points;
  for (let iter = 0; iter < 3 && pts.length >= 6; iter++) {
    const n = pts.length;
    const last = pts[n - 1];
    const prev = pts[n - 2];
    const slipLen = Math.hypot(last.x - prev.x, last.y - prev.y);
    if (slipLen <= 0.3 || slipLen > maxHookPx) break;

    let anchorIdx = n - 2;
    while (anchorIdx > 0 && Math.hypot(prev.x - pts[anchorIdx].x, prev.y - pts[anchorIdx].y) < 16) {
      anchorIdx--;
    }
    const bdx = prev.x - pts[anchorIdx].x;
    const bdy = prev.y - pts[anchorIdx].y;
    const bLen = Math.hypot(bdx, bdy);
    if (bLen < 8) break;
    const dot = ((last.x - prev.x) * bdx + (last.y - prev.y) * bdy) / (slipLen * bLen);
    if (dot >= minDot) break;
    pts = pts.slice(0, n - 1);
  }
  return pts;
}

/**
 * Rimuove da 1 a 3 micro-punti di atterraggio iniziale (<= maxHookPx totali)
 * quando deviano bruscamente dalla direzione d'ingresso del tratto.
 */
function _trimLandingHook(points, maxHookPx = 14, minDot = 0.55) {
  if (!Array.isArray(points) || points.length < 6) return points;
  let pts = points;
  for (let iter = 0; iter < 3 && pts.length >= 6; iter++) {
    const first = pts[0];
    const next = pts[1];
    const slipLen = Math.hypot(next.x - first.x, next.y - first.y);
    if (slipLen <= 0.3 || slipLen > maxHookPx) break;

    let anchorIdx = 1;
    while (anchorIdx < pts.length - 1 && Math.hypot(pts[anchorIdx].x - next.x, pts[anchorIdx].y - next.y) < 16) {
      anchorIdx++;
    }
    const fdx = pts[anchorIdx].x - next.x;
    const fdy = pts[anchorIdx].y - next.y;
    const fLen = Math.hypot(fdx, fdy);
    if (fLen < 8) break;
    const dot = ((next.x - first.x) * fdx + (next.y - first.y) * fdy) / (slipLen * fLen);
    if (dot >= minDot) break;
    pts = pts.slice(1);
  }
  return pts;
}

/**
 * Pulizia conservativa per tratti al rilascio (frecce, simboli matematici, lettere greche):
 * elimina solo il cluster stazionario finale e micro-uncini <= 10px dovuti al sollevamento
 * di Apple Pencil, senza troncare alette di frecce né gambi di simboli.
 */
export function cleanIosReleasePoints(rawPoints, tailTrimRadius = 6.5) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 5) return rawPoints;
  let pts = _trimLiftOffHook(rawPoints, 11, 0.58);
  pts = _trimClusterTail(pts, tailTrimRadius);
  pts = _trimLandingHook(pts, 10, 0.50);
  pts = _trimClusterHead(pts, 4.5);
  return pts;
}

/**
 * Pulizia non distruttiva delle estremità per forme chiuse iPadOS (cerchi, ellissi,
 * rettangoli, triangoli): rimuove sbavature di appoggio/stacco prima della chiusura
 * mantenendo intatti lati, archi e vertici.
 */
export function cleanIosShapePoints(rawPoints, tailTrimRadius = 10.5) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 8) return rawPoints;
  let pts = _trimLiftOffHook(rawPoints, 16, 0.58);
  pts = _trimClusterTail(pts, tailTrimRadius);
  pts = _trimLandingHook(pts, 15, 0.52);
  pts = _trimClusterHead(pts, 5.5);

  if (pts.length >= 10 && _pathLength(pts) > 55) {
    const out = new Array(pts.length);
    out[0] = pts[0];
    out[pts.length - 1] = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      out[i] = {
        ...pts[i],
        x: 0.22 * pts[i - 1].x + 0.56 * pts[i].x + 0.22 * pts[i + 1].x,
        y: 0.22 * pts[i - 1].y + 0.56 * pts[i].y + 0.22 * pts[i + 1].y
      };
    }
    return out;
  }
  return pts;
}

/**
 * Rimuove eventuali micro-ganci di atterraggio/sollevamento (1–18px ai soli estremi)
 * e cluster stazionari su copie temporanee usate SOLO per il riconoscimento linee,
 * senza alterare i tratti a mano libera né lettere curve/angoli reali ("L", "7", "c").
 */
export function cleanIosLinePoints(rawPoints, tailTrimRadius = 7.5) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 4) return rawPoints;

  // 1. Taglio di micro-scatti di sollevamento / atterraggio ai soli estremi
  let pts = _trimLiftOffHook(rawPoints, 15, 0.62);
  pts = _trimClusterTail(pts, tailTrimRadius);
  if (pts.length < 5) return pts;

  pts = _trimLandingHook(pts, 14, 0.58);
  pts = _trimClusterHead(pts, 5.5);

  if (pts.length < 8) return pts;

  const totalChord = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
  if (totalChord < 50) return pts;

  // 2. Riconosci direzione del corpo centrale (escludendo al più il primo/ultimo 15-16% e <= 20px)
  const n = pts.length;
  const maxHeadTrimDist = Math.min(18, totalChord * 0.15);
  const maxTailTrimDist = Math.min(20, totalChord * 0.16);
  const maxIdxLimit = Math.max(1, Math.floor(n * 0.20));

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
  if (coreLen >= 40) {
    const ux = cdx / coreLen;
    const uy = cdy / coreLen;
    const nx = -uy;
    const ny = ux;

    let trimStart = 0;
    for (let i = 0; i < coreStart; i++) {
      const segDx = pts[i + 1].x - pts[i].x;
      const segDy = pts[i + 1].y - pts[i].y;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen < 0.25) {
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
      if (segLen < 0.25) {
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
      if (slicedChord >= 40) {
        pts = sliced;
      }
    }
  }

  // 3. Leggero rilassamento spaziale [0.25, 0.50, 0.25] (3 passate, estremi ancorati)
  //    per attenuare il micro-jitter 120/240Hz che gonfia pathLen rispetto a chordLen
  if (pts.length >= 6 && _pathLength(pts) > 35) {
    let cur = pts;
    for (let pass = 0; pass < 3; pass++) {
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
    baseGain: 1.54,
    zeroPressureFallback: 0.28,
    minRenderWidthPx: 0.45,
    responseGamma: 0.94
  }),

  input: Object.freeze({
    dropZeroPressureUnpressedMove: false,
    capturePointerUpEndpoint: true,
    dedupCoalescedMinDistPx: 1.15,
    landingStabilizePx: 2.6,
    shouldIgnoreUnpressedPenMove(e, drawingState) {
      if (drawingState && drawingState.isDrawing && e && e.pointerId === drawingState.currentPointerId) {
        // Apple Pencil Pro / iPadOS Hover: se nello stroke corrente abbiamo già ricevuto pressione reale,
        // un evento successivo con buttons===0 e pressure<=0 indica che la punta si è staccata in hover:
        // scartarlo previene le sbavature a fine tratto.
        const hasRealPressure = Boolean(drawingState.currentStroke && drawingState.currentStroke._hasSeenRealPressure);
        if (hasRealPressure && e.pointerType === 'pen' && e.buttons === 0 && !(e.pressure > 0)) {
          return true;
        }
        return false;
      }
      return Boolean(e && e.pointerType === 'pen' && e.buttons === 0 && !(e.pressure > 0));
    },
    shouldCapturePointerUpEndpoint(e, prevPt, lastPt, upPt) {
      if (!e || !upPt) return false;
      // Non aggiungere punti finali se la penna è già in hover (buttons=0 e pressure=0)
      if (e.pointerType === 'pen' && e.buttons === 0 && !(e.pressure > 0)) {
        return false;
      }
      if (!lastPt) return true;
      const dx = upPt.x - lastPt.x;
      const dy = upPt.y - lastPt.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0.5 || dist > 4.0) return false;
      if (prevPt) {
        const pdx = lastPt.x - prevPt.x;
        const pdy = lastPt.y - prevPt.y;
        const pLen = Math.hypot(pdx, pdy);
        if (pLen >= 2.0) {
          const dot = (dx * pdx + dy * pdy) / (dist * pLen);
          if (dot < 0.45) return false;
        }
      }
      return true;
    }
  }),

  stabilizer: Object.freeze({
    defaultDtMs: 8.33,
    gaussianBlendScale: 0.92,
    gaussianShiftScale: 0.96,
    pressureTauMs: 28,
    minDeadzonePx(s) {
      const clamped = _clamp01(s);
      return clamped >= 0.08 ? 1.15 * Math.min(1, clamped / 0.35) : 0;
    },
    restDeadzoneMinPx: 1.85,
    holdToleranceMinPx: 10.5
  }),

  rendering: Object.freeze({
    alwaysJoinThinSegments: true,
    jointMinWidthThresholdPx: 0,
    useContinuousRibbon: true,
    redrawActiveStrokeOnOverlay: true,
    nibTangentMinSpanPx: 6,
    scratchMaxDim: 3600,
    maxZoomDprBoost: 1.85,
    maxRenderDpr: 3.8,
    maxOverlayDpr: 3.0,
    predictionDpr: 2,
    smoothPressurePass: true,
    adjustSegmentSteps(baseSteps, segLen, smoothness) {
      const s = smoothness == null ? 0.5 : smoothness;
      if (s <= 0.005 || segLen <= 1.2) return 1;
      if (s > 0.70 && segLen > 34) {
        return 5;
      }
      if (segLen <= 3.0) return Math.max(baseSteps, 2);
      if (segLen <= 10.0) return Math.max(baseSteps, 3);
      return Math.max(baseSteps, 4);
    }
  }),

  recognition: Object.freeze({
    cleanReleasePoints: cleanIosReleasePoints,
    cleanLinePoints: cleanIosLinePoints,
    cleanShapePoints: cleanIosShapePoints,
    shapeDetection: 'ios-istraw-rdp',
    releaseTailTrimRadius: 6.5,
    lineHold: Object.freeze({
      minChordLen: 38,
      minPathRatio: 0.89,
      maxRmsBase: 3.6,
      maxRmsFactor: 0.032,
      minTailCos: 0.54,
      signHysteresis: 3.1,
      tailTrimRadius: 10.5
    }),
    lineAuto: Object.freeze({
      minChordLen: 75,
      minPathRatio: 0.980,
      maxRmsBase: 1.45,
      maxRmsFactor: 0.009,
      maxPerpBase: 2.8,
      maxPerpFactor: 0.015,
      minEndCos: 0.90,
      axisSnapDeg: 3.0,
      maxSignChangesDivisor: 100,
      tailTrimRadius: 7.5
    })
  })
});
