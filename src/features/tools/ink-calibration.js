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

import { detectPlatformInfo } from '../../core/platform.js';

export const DEFAULT_PRESSURE_SENSITIVITY = 50;
export const DEFAULT_PRESSURE_SPEED_WEIGHT = 20;
export const TILT_DEADZONE_DEG = 24;
export const TILT_MAX_DEG = 64;

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
 * Wrapper retrocompatibile sopra `core/platform.js::detectPlatformInfo`.
 */
export function detectInkPlatform(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return detectPlatformInfo({ navigatorObj: nav, windowObj: null, documentObj: null }).family;
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

  // Curva continua 0..100 -> esponente gamma 0.65 (morbida) .. 1.65 (media) .. 1.99 (default 60) .. 4.20 (progressiva)
  const curveFrac = _clamp01(curveRaw / 100);
  const curve = 0.65 * Math.pow(4.2 / 0.65, curveFrac);

  const sensitivity = _clamp(sensRaw, 0, 100);
  const speedWeight = _clamp01(speedRaw / 100) * 0.55;

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
  const platformBaseGain = platform === 'ios' ? 1.48 : (platform === 'android' ? 1.12 : 1.0);
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
  return 0.28;
}

/**
 * Estrae tiltX/tiltY in gradi da un PointerEvent, con fallback a
 * `altitudeAngle`/`azimuthAngle` (iPadOS WebKit / alcuni stili Android).
 */
export function extractEventTilt(e) {
  if (!e) return { tiltX: 0, tiltY: 0 };
  const rawX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
  const rawY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
  if (rawX !== 0 || rawY !== 0) {
    return { tiltX: rawX, tiltY: rawY };
  }
  if (Number.isFinite(e.altitudeAngle) && e.altitudeAngle >= 0 && e.altitudeAngle < Math.PI / 2) {
    const deg = Math.max(0, Math.min(90, 90 - (e.altitudeAngle * 180) / Math.PI));
    if (deg > 0.5) {
      const az = Number.isFinite(e.azimuthAngle) ? e.azimuthAngle : 0;
      return {
        tiltX: Math.round(deg * Math.cos(az) * 100) / 100,
        tiltY: Math.round(deg * Math.sin(az) * 100) / 100
      };
    }
  }
  return { tiltX: 0, tiltY: 0 };
}

/**
 * Normalizza l'inclinazione della penna in [0..1] con una deadzone
 * per la postura naturale di scrittura (<= 24° -> 0) e ramp fluido
 * fino allo shading intenzionale (64° -> 1).
 */
export function computeTiltNorm(pt) {
  if (!pt || (!pt.tiltX && !pt.tiltY)) return 0;
  const deg = Math.hypot(pt.tiltX || 0, pt.tiltY || 0);
  if (deg <= TILT_DEADZONE_DEG) return 0;
  return _clamp01((deg - TILT_DEADZONE_DEG) / (TILT_MAX_DEG - TILT_DEADZONE_DEG));
}

/**
 * Calcola lo spessore finale di un punto dello stroke dato tool, pressione, tilt e velocità.
 *   - `'marker'` (Penna): spessore uniforme e pulito (~1.0x baseSize)
 *   - `'pen'` (Stilografica): spessore normale allineato alla Penna a pressione media (~0.95x),
 *     ma con ampia escursione dinamica su pressione leggera/forte, inclinazione e velocità
 *   - `'pencil'` (Matita): effetto grafite/pastello molto sensibile all'inclinazione
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
    const lightMul = Number.isFinite(params.lightMul) ? params.lightMul : LEGACY_PRESSURE_PARAMS.lightMul;
    const heavyMul = Number.isFinite(params.heavyMul) ? params.heavyMul : LEGACY_PRESSURE_PARAMS.heavyMul;
    const curve = Number.isFinite(params.curve) ? params.curve : LEGACY_PRESSURE_PARAMS.curve;
    const speedWeight = Number.isFinite(params.speedWeight) ? params.speedWeight : LEGACY_PRESSURE_PARAMS.speedWeight;

    const range = Math.max(0.05, heavyMul - lightMul);
    w = baseSize * (lightMul + Math.pow(p, curve) * range);
    w *= (1 + tNorm * 0.82);
    const effectiveSpeedW = speedWeight > 0 ? Math.min(0.48, speedWeight * 1.45 + 0.08) : 0;
    w *= (1 - sNorm * effectiveSpeedW);
  } else if (tool === 'pencil') {
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
    w = baseSize * (0.93 + p * 0.18);
    w *= (1 + tNorm * 0.04);
    w *= (1 - sNorm * 0.04);
  } else if (tool === 'highlighter') {
    const base = baseSize * 4.0;
    const pressureMul = 0.85 + p * 0.30;
    const speedMul = 1 - sNorm * 0.15;
    w = base * pressureMul * speedMul;
  }

  return Math.max(0.25, w * (taper != null ? taper : 1.0));
}

/**
 * Modulazione direzionale bilanciata del pennino della stilografica (`'pen'`):
 * centrata attorno a ~1.0x per non ingrossare costantemente il tratto rispetto alla Penna,
 * snellendo leggermente i traversali e arricchendo le aste discendenti.
 */
export function computeDirectionalNibFactor(dx, dy, tool = 'pen') {
  if (tool !== 'pen') return 1.0;
  const len = Math.hypot(dx || 0, dy || 0);
  if (len < 0.05) return 1.0;
  const ux = dx / len;
  const uy = dy / len;
  const nibAxis = Math.abs(uy * 0.88 - ux * 0.47);
  const downBias = Math.max(-0.15, uy);
  return _clamp(0.82 + nibAxis * 0.28 + downBias * 0.10, 0.80, 1.14);
}

/**
 * Calcola la larghezza dinamica della preview predittiva (`getPredictedEvents`)
 * coerente con lo strumento, la pressione dell'ultimo punto e gli eventi predetti.
 */
export function computePredictionWidth({
  tool = 'pen',
  baseSize = 3,
  lastPoint = null,
  predictedEvents = null,
  inkParams = null,
  platform = 'desktop',
  sensitivity = DEFAULT_PRESSURE_SENSITIVITY
} = {}) {
  const bSize = Math.max(0.5, Number.isFinite(baseSize) ? baseSize : 3);
  if (tool === 'highlighter') {
    return Math.max(1, bSize * 4.0);
  }

  const lastP = lastPoint && Number.isFinite(lastPoint.pressure) ? lastPoint.pressure : 0.28;
  const lastTilt = computeTiltNorm(lastPoint);
  const lastSpeed = Math.min(1, ((lastPoint && Number.isFinite(lastPoint.speed)) ? lastPoint.speed : 0) / 8);
  const lastW = computeInkStrokeWidth(tool, bSize, lastP, lastTilt, lastSpeed, 1.0, inkParams);

  let latestPred = null;
  if (Array.isArray(predictedEvents)) {
    for (let i = predictedEvents.length - 1; i >= 0; i--) {
      const ev = predictedEvents[i];
      if (ev && Number.isFinite(ev.pressure) && ev.pressure > 0) {
        latestPred = ev;
        break;
      }
    }
  }

  if (latestPred) {
    const normPredP = normalizePenPressure(latestPred.pressure, {
      platform,
      sensitivity,
      isDrawing: true,
      lastValidPressure: lastP
    });
    const evTilt = extractEventTilt(latestPred);
    const predTilt = (evTilt.tiltX !== 0 || evTilt.tiltY !== 0) ? computeTiltNorm(evTilt) : lastTilt;
    const predW = computeInkStrokeWidth(tool, bSize, normPredP, predTilt, lastSpeed, 1.0, inkParams);
    return Math.max(0.4, lastW * 0.45 + predW * 0.55);
  }

  return Math.max(0.4, lastW);
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
          platform: (params && params.platform) || 'desktop',
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
// STABILIZZATORE INDIPENDENTE DALLO STRUMENTO
//   - 0          (`bypass`):   zero filtri, 0 lag
//   - 0.01..0.65 (`gaussian`): filtro gaussiano leggero a lag quasi nullo
//                              (elimina solo i micro-tremori seguendo 1:1 la punta)
//   - 0.66..1.00 (`strong`):   stabilizzazione progressiva per tratti calligrafici
// ============================================================

function _lowPassAlpha(cutoffHz, dtSec) {
  const tau = 1.0 / (2.0 * Math.PI * Math.max(0.01, cutoffHz));
  return 1.0 / (1.0 + tau / Math.max(1e-4, dtSec));
}

export function getStabilizerParams(smoothing = 0.5, scale = 1.0, platform = 'desktop') {
  const s = _clamp01(smoothing == null ? 0.5 : smoothing);
  const vpScale = Math.max(0.25, Number.isFinite(scale) ? scale : 1.0);
  const plat = platform === 'ios' || platform === 'android' ? platform : 'desktop';

  if (s < 0.005) {
    return {
      mode: 'bypass',
      platform: plat,
      s: 0,
      liveBlend: 0,
      maxLiveShift: 0,
      minCutoff: Infinity,
      beta: 0,
      dCutoff: Infinity,
      deadzone: 0.01,
      restDeadzone: 0.01,
      pressureNewWeight: 0.80
    };
  }

  let mode;
  let liveBlend;
  let maxLiveShift;
  let minCutoff;
  let beta;
  let dCutoff;
  let baseDeadzone;

  if (s <= 0.65) {
    mode = 'gaussian';
    const u = s / 0.65;
    const platBlendScale = plat === 'ios' ? 0.72 : (plat === 'android' ? 0.90 : 1.0);
    const platShiftScale = plat === 'ios' ? 0.82 : 1.0;
    liveBlend = (0.05 + u * 0.27) * platBlendScale;
    maxLiveShift = ((0.30 + u * 1.15) * platShiftScale) / vpScale;
    minCutoff = 120.0 * Math.pow(14.0 / 120.0, u);
    beta = 0.18 - u * 0.148;
    dCutoff = 20.0 - u * 12.0;
    baseDeadzone = 0.03 + u * 0.31;
  } else {
    mode = 'strong';
    const w = (s - 0.65) / 0.35;
    liveBlend = 0.32 + w * 0.34;
    maxLiveShift = (1.45 + w * 7.5) / vpScale;
    minCutoff = 14.0 * Math.pow(1.6 / 14.0, w);
    beta = 0.032 - w * 0.024;
    dCutoff = 8.0 - w * 5.0;
    baseDeadzone = 0.34 + w * 0.72;
  }

  const deadzone = Math.min(2.4, baseDeadzone / vpScale);
  // Anti-tremolio stazionario attivo solo a punta ferma (es. hold-to-snap su iPad)
  const restDeadzone = Math.min(2.4, Math.max(deadzone, 1.38 / vpScale));

  return {
    mode,
    platform: plat,
    s,
    liveBlend,
    maxLiveShift,
    minCutoff,
    beta,
    dCutoff,
    deadzone,
    restDeadzone,
    pressureNewWeight: 0.78 - s * 0.24
  };
}

/**
 * Crea uno stabilizzatore stateful per un singolo tratto, indipendente dallo strumento.
 */
export function createStrokeStabilizer(initialPoint = null, { platform = 'desktop' } = {}) {
  const defaultPlatform = platform === 'ios' || platform === 'android' ? platform : 'desktop';
  let hasInit = false;
  let rawCount = 0;
  let r0x = 0, r0y = 0; // più recente
  let r1x = 0, r1y = 0; // precedente
  let r2x = 0, r2y = 0; // terzultimo
  let lastFiltX = 0;
  let lastFiltY = 0;
  let lastDx = 0;
  let lastDy = 0;
  let lastAcceptX = 0;
  let lastAcceptY = 0;
  let lastPressure = 0.5;
  let lastTs = 0;
  let observedDtMs = defaultPlatform === 'ios' ? 8.33 : 16.67;

  if (initialPoint) {
    hasInit = true;
    rawCount = 1;
    r0x = r1x = r2x = initialPoint.x;
    r0y = r1y = r2y = initialPoint.y;
    lastFiltX = initialPoint.x;
    lastFiltY = initialPoint.y;
    lastAcceptX = initialPoint.x;
    lastAcceptY = initialPoint.y;
    lastPressure = initialPoint.pressure != null ? initialPoint.pressure : 0.5;
    lastTs = initialPoint.timeStamp || 0;
  }

  const _blendPressure = (rawPoint, cfg) => {
    if (!rawPoint || rawPoint._pressureFallback) return;
    if (Number.isFinite(rawPoint.pressure)) {
      lastPressure = _clamp(
        lastPressure * (1 - cfg.pressureNewWeight) + rawPoint.pressure * cfg.pressureNewWeight,
        0.02,
        1.0
      );
    }
  };

  return {
    seedInitialPressure(p) {
      if (Number.isFinite(p)) {
        lastPressure = _clamp(p, 0.02, 1.0);
      }
    },

    filterPoint(rawPoint, { smoothing = 0.5, scale = 1.0, platform: overridePlat = null } = {}) {
      const cfg = getStabilizerParams(smoothing, scale, overridePlat || defaultPlatform);
      const ts = Number.isFinite(rawPoint.timeStamp) ? rawPoint.timeStamp : 0;

      if (!hasInit) {
        hasInit = true;
        rawCount = 1;
        r0x = r1x = r2x = rawPoint.x;
        r0y = r1y = r2y = rawPoint.y;
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
          dtMs: observedDtMs
        };
      }

      let rawDtMs;
      if (ts > 0 && lastTs > 0) {
        if (ts > lastTs) {
          rawDtMs = ts - lastTs;
          observedDtMs = observedDtMs * 0.7 + _clamp(rawDtMs, 4, 33.34) * 0.3;
        } else {
          rawDtMs = 5.0;
        }
      } else {
        rawDtMs = observedDtMs;
      }
      const effectiveDtMs = _clamp(rawDtMs * 0.75 + observedDtMs * 0.25, 2, 48);
      const dtSec = effectiveDtMs / 1000;
      if (ts > 0) lastTs = ts;

      // Fascia 0 (smoothing=0): bypass totale, zero lag
      if (cfg.mode === 'bypass') {
        _blendPressure(rawPoint, cfg);
        const dx = rawPoint.x - lastAcceptX;
        const dy = rawPoint.y - lastAcceptY;
        const dist = Math.hypot(dx, dy);
        if (dist < cfg.deadzone) {
          return { accepted: false, x: lastAcceptX, y: lastAcceptY, pressure: lastPressure, distFromAccepted: dist, dtMs: effectiveDtMs };
        }
        r2x = r1x; r2y = r1y;
        r1x = r0x; r1y = r0y;
        r0x = rawPoint.x; r0y = rawPoint.y;
        rawCount++;
        lastAcceptX = rawPoint.x;
        lastAcceptY = rawPoint.y;
        lastFiltX = rawPoint.x;
        lastFiltY = rawPoint.y;
        return {
          accepted: true,
          x: rawPoint.x,
          y: rawPoint.y,
          pressure: lastPressure,
          distFromAccepted: dist,
          dtMs: effectiveDtMs
        };
      }

      const prevRawX = r0x;
      const prevRawY = r0y;
      r2x = r1x; r2y = r1y;
      r1x = r0x; r1y = r0y;
      r0x = rawPoint.x; r0y = rawPoint.y;
      rawCount++;

      const distRaw = Math.hypot(rawPoint.x - lastAcceptX, rawPoint.y - lastAcceptY);
      const isResting = distRaw < cfg.restDeadzone;

      let outX = rawPoint.x;
      let outY = rawPoint.y;

      if (cfg.mode === 'gaussian') {
        // Filtro spaziale gaussiano leggero (kernel causale pesato + clamp maxLiveShift):
        // smorza i micro-tremori senza introdurre trascinamento dietro la punta.
        if (!isResting && rawCount >= 3) {
          const gCausalX = 0.50 * r0x + 0.35 * r1x + 0.15 * r2x;
          const gCausalY = 0.50 * r0y + 0.35 * r1y + 0.15 * r2y;
          const shiftX = (gCausalX - rawPoint.x) * cfg.liveBlend;
          const shiftY = (gCausalY - rawPoint.y) * cfg.liveBlend;
          const shiftMag = Math.hypot(shiftX, shiftY);
          if (shiftMag > cfg.maxLiveShift && shiftMag > 1e-6) {
            const sc = cfg.maxLiveShift / shiftMag;
            outX = rawPoint.x + shiftX * sc;
            outY = rawPoint.y + shiftY * sc;
          } else {
            outX = rawPoint.x + shiftX;
            outY = rawPoint.y + shiftY;
          }
        }
        lastFiltX = outX;
        lastFiltY = outY;
      } else {
        // Modalità 'strong' (solo smoothing alto > 65%): stabilizzazione fluida progressiva
        const dxRaw = (rawPoint.x - prevRawX) / dtSec;
        const dyRaw = (rawPoint.y - prevRawY) / dtSec;
        const dAlpha = _lowPassAlpha(cfg.dCutoff, dtSec);
        lastDx = lastDx + (dxRaw - lastDx) * dAlpha;
        lastDy = lastDy + (dyRaw - lastDy) * dAlpha;
        const speedPerSec = Math.hypot(lastDx, lastDy);
        const cutoff = isResting ? Math.min(cfg.minCutoff, 3.8) : (cfg.minCutoff + cfg.beta * speedPerSec);
        const alpha = _lowPassAlpha(cutoff, dtSec);
        lastFiltX = lastFiltX + (rawPoint.x - lastFiltX) * alpha;
        lastFiltY = lastFiltY + (rawPoint.y - lastFiltY) * alpha;
        const shiftX = lastFiltX - rawPoint.x;
        const shiftY = lastFiltY - rawPoint.y;
        const shiftMag = Math.hypot(shiftX, shiftY);
        if (shiftMag > cfg.maxLiveShift && shiftMag > 1e-6) {
          const sc = cfg.maxLiveShift / shiftMag;
          outX = rawPoint.x + shiftX * sc;
          outY = rawPoint.y + shiftY * sc;
          lastFiltX = outX;
          lastFiltY = outY;
        } else {
          outX = lastFiltX;
          outY = lastFiltY;
        }
      }

      _blendPressure(rawPoint, cfg);

      const effectiveDeadzone = isResting ? cfg.restDeadzone : cfg.deadzone;
      const dist = Math.hypot(outX - lastAcceptX, outY - lastAcceptY);
      if (dist < effectiveDeadzone) {
        return {
          accepted: false,
          x: outX,
          y: outY,
          pressure: lastPressure,
          distFromAccepted: dist,
          dtMs: effectiveDtMs
        };
      }

      lastAcceptX = outX;
      lastAcceptY = outY;

      return {
        accepted: true,
        x: outX,
        y: outY,
        pressure: lastPressure,
        distFromAccepted: dist,
        dtMs: effectiveDtMs
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
  const minKeep = 4;

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
