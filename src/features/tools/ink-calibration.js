/**
 * @module features/tools/ink-calibration
 *
 * Logica pura (zero DOM / zero store globale) per:
 *   1. Normalizzazione pressione cross-device (Apple Pencil iPadOS vs Surface/Desktop)
 *   2. Curva pressione, spessore min/max e influenza velocità (stile GoodNotes)
 *   3. Campionamento curva SVG per anteprima in Impostazioni
 *   4. Stabilizzazione tratto: One Euro Filter 2D + deadzone stazionaria zoom-aware
 *   5. Pulizia micro-tremolio finale (tail jitter) prima del riconoscimento forme/linee
 */

export const DEFAULT_PRESSURE_SENSITIVITY = 50;
export const DEFAULT_PRESSURE_SPEED_WEIGHT = 20;

export const LEGACY_PRESSURE_PARAMS = Object.freeze({
  lightMul: 0.05,
  heavyMul: 3.4,
  curve: 2.0,
  speedWeight: 0.25
});

function _clamp(val, min, max) {
  return val < min ? min : (val > max ? max : val);
}

function _clamp01(val) {
  return _clamp(val, 0, 1);
}

/**
 * Rileva la piattaforma di input penna (`'ios' | 'android' | 'desktop'`).
 */
export function detectInkPlatform(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return 'desktop';
  const ua = nav.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua) ||
      (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1)) {
    return 'ios';
  }
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Deriva i parametri di rendering/normalizzazione dalle impostazioni utente.
 */
export function derivePressureParams(settings = {}) {
  const lightRaw = typeof settings.pressureLight === 'number' ? settings.pressureLight : 10;
  const heavyRaw = typeof settings.pressureHeavy === 'number' ? settings.pressureHeavy : 340;
  const curveRaw = typeof settings.pressureCurve === 'number' ? settings.pressureCurve : 60;
  const sensRaw = typeof settings.pressureSensitivity === 'number'
    ? settings.pressureSensitivity
    : DEFAULT_PRESSURE_SENSITIVITY;
  const speedRaw = typeof settings.pressureSpeedWeight === 'number'
    ? settings.pressureSpeedWeight
    : DEFAULT_PRESSURE_SPEED_WEIGHT;

  const lightFrac = _clamp01(lightRaw / 100);
  const lightMul = 0.06 + lightFrac * 0.84;
  const heavyMul = Math.max(lightMul + 0.15, _clamp(heavyRaw, 100, 500) / 100);

  // Curva continua 0..100 -> esponente gamma 0.45 (morbida) .. 1.20 (media) .. 3.20 (progressiva)
  const curveFrac = _clamp01(curveRaw / 100);
  const curve = 0.45 * Math.pow(3.2 / 0.45, curveFrac);

  const sensitivity = _clamp(sensRaw, 0, 100);
  const speedWeight = _clamp01(speedRaw / 100) * 0.45;

  return {
    lightMul,
    heavyMul,
    curve,
    sensitivity,
    speedWeight
  };
}

/**
 * Crea uno snapshot serializzabile da salvare sullo stroke al momento della creazione,
 * così i tratti già scritti non cambiano mai quando l'utente modifica le impostazioni.
 */
export function cloneInkParams(params) {
  const src = params || LEGACY_PRESSURE_PARAMS;
  return {
    lightMul: Number.isFinite(src.lightMul) ? src.lightMul : LEGACY_PRESSURE_PARAMS.lightMul,
    heavyMul: Number.isFinite(src.heavyMul) ? src.heavyMul : LEGACY_PRESSURE_PARAMS.heavyMul,
    curve: Number.isFinite(src.curve) ? src.curve : LEGACY_PRESSURE_PARAMS.curve,
    speedWeight: Number.isFinite(src.speedWeight) ? src.speedWeight : LEGACY_PRESSURE_PARAMS.speedWeight
  };
}

/**
 * Normalizza la pressione grezza del PointerEvent in [0..1] compensando:
 *   - differenza hardware Apple Pencil (Safari/iPadOS emette tipicamente 0.06..0.58)
 *     rispetto a penne Wintab/HID Windows (Surface)
 *   - slider Sensibilità utente (0..100, 50 = calibrato)
 *   - soft-knee dolce sopra 0.80 per evitare saturazione brusca
 */
export function normalizePenPressure(rawPressure, {
  platform = 'desktop',
  sensitivity = DEFAULT_PRESSURE_SENSITIVITY,
  isDrawing = false,
  lastValidPressure = 0
} = {}) {
  const sens = _clamp(Number.isFinite(sensitivity) ? sensitivity : DEFAULT_PRESSURE_SENSITIVITY, 0, 100);
  const userGain = Math.pow(2.2, (sens - 50) / 50); // 0 -> ~0.45x, 50 -> 1.0x, 100 -> 2.2x
  const platformBaseGain = platform === 'ios' ? 1.65 : (platform === 'android' ? 1.15 : 1.0);
  const totalGain = platformBaseGain * userGain;

  const raw = Number.isFinite(rawPressure) ? rawPressure : 0;
  if (raw > 0) {
    const scaled = raw * totalGain;
    // Soft-knee sopra 0.80 per preservare dinamica anche con guadagno alto
    const shaped = scaled <= 0.80
      ? scaled
      : 0.80 + (scaled - 0.80) / (1 + (scaled - 0.80) * 1.4);
    return _clamp(shaped, 0.02, 1.0);
  }

  if (isDrawing && lastValidPressure > 0) {
    return _clamp(lastValidPressure, 0.02, 1.0);
  }
  return platform === 'ios' ? 0.16 : 0.30;
}

/**
 * Calcola lo spessore finale di un punto dello stroke dato tool, pressione, tilt e velocità.
 */
export function computeInkStrokeWidth(
  tool,
  baseSize,
  pressure,
  tiltNorm = 0,
  speedNorm = 0,
  taper = 1.0,
  inkParams = null
) {
  const p = _clamp01(pressure == null ? 0.5 : pressure);
  const tNorm = _clamp01(tiltNorm || 0);
  const sNorm = _clamp01(speedNorm || 0);
  const params = inkParams || LEGACY_PRESSURE_PARAMS;
  let w = baseSize;

  if (tool === 'pen') {
    // Stilografica: massima espressività su pressione, inclinazione e velocità
    const lightMul = Number.isFinite(params.lightMul) ? params.lightMul : LEGACY_PRESSURE_PARAMS.lightMul;
    const heavyMul = Number.isFinite(params.heavyMul) ? params.heavyMul : LEGACY_PRESSURE_PARAMS.heavyMul;
    const curve = Number.isFinite(params.curve) ? params.curve : LEGACY_PRESSURE_PARAMS.curve;
    const speedWeight = Number.isFinite(params.speedWeight) ? params.speedWeight : LEGACY_PRESSURE_PARAMS.speedWeight;

    const range = Math.max(0.05, heavyMul - lightMul);
    w = baseSize * (lightMul + Math.pow(p, curve) * range);
    w *= (1 + tNorm * 0.45);
    w *= (1 - sNorm * speedWeight);
  } else if (tool === 'pencil') {
    // Matita: pressione più dolce e fortissima sensibilità all'inclinazione (effetto pastello/grafite larga)
    const lightMul = Number.isFinite(params.lightMul) ? params.lightMul : LEGACY_PRESSURE_PARAMS.lightMul;
    const heavyMul = Number.isFinite(params.heavyMul) ? params.heavyMul : LEGACY_PRESSURE_PARAMS.heavyMul;
    const curve = Number.isFinite(params.curve) ? params.curve : LEGACY_PRESSURE_PARAMS.curve;
    const speedWeight = Number.isFinite(params.speedWeight) ? params.speedWeight : LEGACY_PRESSURE_PARAMS.speedWeight;

    const pencilLight = Math.max(0.28, lightMul * 0.85);
    const pencilHeavy = Math.max(pencilLight + 0.15, Math.min(2.6, heavyMul * 0.72));
    const pencilCurve = Math.max(0.65, curve * 0.85);
    w = baseSize * (pencilLight + Math.pow(p, pencilCurve) * (pencilHeavy - pencilLight));
    w *= (1 + tNorm * 1.45);
    w *= (1 - sNorm * Math.max(0.10, speedWeight * 0.65));
  } else if (tool === 'marker') {
    // Penna: tratto molto più uniforme, minima variazione da pressione/inclinazione/velocità
    w = baseSize * (0.90 + p * 0.30);
    w *= (1 + tNorm * 0.08);
    w *= (1 - sNorm * 0.08);
  } else if (tool === 'highlighter') {
    const base = baseSize * 4.0;
    const pressureMul = 0.85 + p * 0.30;
    const speedMul = 1 - sNorm * 0.15;
    w = base * pressureMul * speedMul;
  }

  return Math.max(0.25, w * (taper != null ? taper : 1.0));
}

/**
 * Restituisce punti normalizzati `(x: 0..1 pressione input, y: 0..1 spessore relativo)`
 * per disegnare il grafico della curva nelle Impostazioni.
 */
export function samplePressureCurve(params, steps = 28) {
  const derived = params && typeof params.curve === 'number'
    ? params
    : derivePressureParams(params);
  const n = Math.max(4, steps | 0);
  const out = [];
  const maxScale = Math.max(1e-4, derived.heavyMul);
  const range = Math.max(0.05, derived.heavyMul - derived.lightMul);
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const pNorm = x === 0
      ? 0
      : normalizePenPressure(x, {
          platform: 'desktop',
          sensitivity: derived.sensitivity != null ? derived.sensitivity : DEFAULT_PRESSURE_SENSITIVITY
        });
    const mul = derived.lightMul + Math.pow(pNorm, derived.curve) * range;
    out.push({
      x,
      y: _clamp01(mul / maxScale)
    });
  }
  return out;
}

// ============================================================
// STABILIZZATORE ONE EURO FILTER + DEADZONE ZOOM-AWARE
// ============================================================

function _lowPassAlpha(cutoffHz, dtSec) {
  const tau = 1.0 / (2.0 * Math.PI * Math.max(0.01, cutoffHz));
  return 1.0 / (1.0 + tau / Math.max(1e-4, dtSec));
}

/**
 * Crea uno stabilizzatore stateful per un singolo tratto.
 * Filtra i micro-tremolii ad alta frequenza a bassa velocità / punta ferma
 * mantenendo reattività immediata nei movimenti rapidi.
 */
export function createStrokeStabilizer(initialPoint = null) {
  let hasInit = false;
  let lastRawX = 0;
  let lastRawY = 0;
  let lastFiltX = 0;
  let lastFiltY = 0;
  let lastDx = 0;
  let lastDy = 0;
  let lastAcceptX = 0;
  let lastAcceptY = 0;
  let lastPressure = 0.5;
  let lastTs = 0;

  if (initialPoint) {
    hasInit = true;
    lastRawX = initialPoint.x;
    lastRawY = initialPoint.y;
    lastFiltX = initialPoint.x;
    lastFiltY = initialPoint.y;
    lastAcceptX = initialPoint.x;
    lastAcceptY = initialPoint.y;
    lastPressure = initialPoint.pressure != null ? initialPoint.pressure : 0.5;
    lastTs = initialPoint.timeStamp || 0;
  }

  return {
    filterPoint(rawPoint, { smoothing = 0.5, scale = 1.0 } = {}) {
      const s = _clamp01(smoothing == null ? 0.5 : smoothing);
      const vpScale = Math.max(0.25, Number.isFinite(scale) ? scale : 1.0);
      const ts = Number.isFinite(rawPoint.timeStamp) ? rawPoint.timeStamp : 0;

      if (!hasInit) {
        hasInit = true;
        lastRawX = rawPoint.x;
        lastRawY = rawPoint.y;
        lastFiltX = rawPoint.x;
        lastFiltY = rawPoint.y;
        lastAcceptX = rawPoint.x;
        lastAcceptY = rawPoint.y;
        lastPressure = rawPoint.pressure != null ? rawPoint.pressure : 0.5;
        lastTs = ts;
        return {
          accepted: true,
          x: rawPoint.x,
          y: rawPoint.y,
          pressure: lastPressure,
          distFromAccepted: 0,
          dtMs: 16.67
        };
      }

      const rawDtMs = (ts > 0 && lastTs > 0 && ts > lastTs) ? (ts - lastTs) : 8.33;
      const clampedDtMs = _clamp(rawDtMs, 2, 64);
      const dtSec = clampedDtMs / 1000;
      if (ts > 0) lastTs = ts;

      // Smoothing spenta: bypass filtro spaziale, deadzone minima
      if (s <= 0.01) {
        const dx = rawPoint.x - lastAcceptX;
        const dy = rawPoint.y - lastAcceptY;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          return { accepted: false, x: lastAcceptX, y: lastAcceptY, pressure: lastPressure, distFromAccepted: dist, dtMs: clampedDtMs };
        }
        lastAcceptX = rawPoint.x;
        lastAcceptY = rawPoint.y;
        lastFiltX = rawPoint.x;
        lastFiltY = rawPoint.y;
        lastRawX = rawPoint.x;
        lastRawY = rawPoint.y;
        const rawP = rawPoint.pressure != null ? rawPoint.pressure : lastPressure;
        lastPressure = _clamp(lastPressure * 0.25 + rawP * 0.75, 0.02, 1.0);
        return {
          accepted: true,
          x: rawPoint.x,
          y: rawPoint.y,
          pressure: lastPressure,
          distFromAccepted: dist,
          dtMs: clampedDtMs
        };
      }

      // One Euro Filter 2D
      const dxRaw = (rawPoint.x - lastRawX) / dtSec;
      const dyRaw = (rawPoint.y - lastRawY) / dtSec;
      lastRawX = rawPoint.x;
      lastRawY = rawPoint.y;

      const dAlpha = _lowPassAlpha(1.0, dtSec);
      lastDx = lastDx + (dxRaw - lastDx) * dAlpha;
      lastDy = lastDy + (dyRaw - lastDy) * dAlpha;

      const speedPerSec = Math.hypot(lastDx, lastDy);
      // s=0.5 -> minCutoff=3.9Hz (smorza jitter a riposo), s=1.0 -> minCutoff=0.65Hz (molto stabile)
      const minCutoff = Math.max(0.55, 7.2 - s * 6.55);
      // beta regola quanto velocemente si "apre" il filtro in movimento veloce
      const beta = 0.004 + (1 - s) * 0.028;
      const cutoff = minCutoff + beta * speedPerSec;
      const alpha = _lowPassAlpha(cutoff, dtSec);

      lastFiltX = lastFiltX + (rawPoint.x - lastFiltX) * alpha;
      lastFiltY = lastFiltY + (rawPoint.y - lastFiltY) * alpha;

      // Deadzone zoom-aware: ~0.6..1.6 CSS px tradotti in coordinate pagina (max 2.6 page px)
      const deadzone = Math.min(2.6, Math.max(0.45, (0.55 + s * 1.05) / vpScale));
      const dist = Math.hypot(lastFiltX - lastAcceptX, lastFiltY - lastAcceptY);
      if (dist < deadzone) {
        return {
          accepted: false,
          x: lastFiltX,
          y: lastFiltY,
          pressure: lastPressure,
          distFromAccepted: dist,
          dtMs: clampedDtMs
        };
      }

      lastAcceptX = lastFiltX;
      lastAcceptY = lastFiltY;

      // Smoothing pressione reattivo (preserva variazioni intenzionali)
      const rawP = rawPoint.pressure != null ? rawPoint.pressure : lastPressure;
      const pNewW = 0.68 - s * 0.16; // 0.68 .. 0.52
      lastPressure = _clamp(lastPressure * (1 - pNewW) + rawP * pNewW, 0.02, 1.0);

      return {
        accepted: true,
        x: lastFiltX,
        y: lastFiltY,
        pressure: lastPressure,
        distFromAccepted: dist,
        dtMs: clampedDtMs
      };
    }
  };
}

/**
 * Calcola la tolleranza di movimento (in coordinate pagina) per considerare la penna "ferma"
 * durante l'hold-to-snap, adattandola allo zoom corrente.
 */
export function getHoldMoveTolerancePx(scale = 1.0) {
  const s = Math.max(0.25, Number.isFinite(scale) ? scale : 1.0);
  return Math.max(8, 10 / s);
}

/**
 * Rimuove eventuali micro-punti stazionari accumulati sulla punta finale mentre la mano
 * era ferma o durante il sollevamento della penna (evita falsi fallimenti in cosTail / closure).
 */
export function trimStationaryTail(points, maxClusterRadius = 5.5) {
  if (!Array.isArray(points) || points.length < 6) return points;
  const n = points.length;
  const tip = points[n - 1];
  const minKeep = Math.max(4, Math.ceil(n * 0.45));

  let cutIdx = n - 1;
  while (cutIdx > minKeep) {
    const p = points[cutIdx - 1];
    const d = Math.hypot(tip.x - p.x, tip.y - p.y);
    if (d > maxClusterRadius) break;
    cutIdx--;
  }

  // Conserva l'ultimo punto utile appena fuori dal cluster (o l'ancora iniziale del cluster)
  if (cutIdx >= n - 1) return points;
  return points.slice(0, cutIdx + 1);
}
