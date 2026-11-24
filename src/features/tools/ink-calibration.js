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
    // Stilografica: massima espressività su pressione, inclinazione e velocità (filetti sottili veloci)
    const lightMul = Number.isFinite(params.lightMul) ? params.lightMul : LEGACY_PRESSURE_PARAMS.lightMul;
    const heavyMul = Number.isFinite(params.heavyMul) ? params.heavyMul : LEGACY_PRESSURE_PARAMS.heavyMul;
    const curve = Number.isFinite(params.curve) ? params.curve : LEGACY_PRESSURE_PARAMS.curve;
    const speedWeight = Number.isFinite(params.speedWeight) ? params.speedWeight : LEGACY_PRESSURE_PARAMS.speedWeight;

    const range = Math.max(0.05, heavyMul - lightMul);
    w = baseSize * (lightMul + Math.pow(p, curve) * range);
    w *= (1 + tNorm * 0.45);
    const effectiveSpeedW = speedWeight > 0 ? Math.min(0.52, speedWeight * 1.55 + 0.10) : 0;
    w *= (1 - sNorm * effectiveSpeedW);
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
    // Penna: tratto uniforme da penna a sfera/gel, minima variazione da pressione/inclinazione/velocità
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
 * Modulazione direzionale del pennino della stilografica (`'pen'`):
 * aste discendenti / oblique risultano più piene e ricche, mentre filetti
 * ascendenti o traversali orizzontali si assottigliano naturalmente.
 */
export function computeDirectionalNibFactor(dx, dy, tool = 'pen') {
  if (tool !== 'pen') return 1.0;
  const len = Math.hypot(dx || 0, dy || 0);
  if (len < 0.05) return 1.0;
  const ux = dx / len;
  const uy = dy / len;
  // Asse naturale del pennino (~28° rispetto alla verticale) + leggero afflusso in discesa
  const nibAxis = Math.abs(uy * 0.88 - ux * 0.47);
  const downBias = Math.max(-0.15, uy) * 0.14;
  return _clamp(0.76 + nibAxis * 0.36 + downBias, 0.74, 1.24);
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
// STABILIZZATORE MULTI-LIVELLO (Bypass / Zero-Lag / One Euro)
// ============================================================

function _lowPassAlpha(cutoffHz, dtSec) {
  const tau = 1.0 / (2.0 * Math.PI * Math.max(0.01, cutoffHz));
  return 1.0 / (1.0 + tau / Math.max(1e-4, dtSec));
}

/**
 * Restituisce i parametri continui dello stabilizzatore calibrati per piattaforma
 * (`'ios' | 'android' | 'desktop'`), grado `smoothing` (0..1) e zoom corrente:
 *   - 0          (`bypass`):      0 lag, nessun filtro spaziale
 *   - 0.01..0.30 (`geometric`):   iPad quasi trasparente; Surface con lookahead Holt anti-zig-zag
 *   - 0.31..0.70 (`balanced`):    One Euro adattivo tarato per 120-240Hz (iPadOS), 60Hz N-Trig (Surface) o USI/S-Pen (Android)
 *   - 0.71..1.00 (`calligraphy`): stabilizzazione fluida per curve ampie
 */
export function getStabilizerParams(smoothing = 0.5, scale = 1.0, platform = 'desktop') {
  const s = _clamp01(smoothing == null ? 0.5 : smoothing);
  const vpScale = Math.max(0.25, Number.isFinite(scale) ? scale : 1.0);
  const plat = platform === 'ios' || platform === 'android' ? platform : 'desktop';

  if (s < 0.005) {
    return {
      mode: 'bypass',
      platform: plat,
      s: 0,
      minCutoff: Infinity,
      beta: 0,
      dCutoff: Infinity,
      deadzone: 0.01,
      restDeadzone: 0.01,
      restCutoff: Infinity,
      trendGain: 0,
      pressureNewWeight: 0.80
    };
  }

  let mode;
  let minCutoff;
  let beta;
  let dCutoff;
  let baseDeadzone;
  let trendGain = 0;

  if (s <= 0.30) {
    mode = 'geometric';
  } else if (s <= 0.70) {
    mode = 'balanced';
  } else {
    mode = 'calligraphy';
  }

  if (plat === 'ios') {
    // iPadOS Apple Pencil (120–240Hz): trasparente/ultra-reattivo fino a smoothing medio, restDeadzone attiva solo a punta ferma
    if (s <= 0.30) {
      const u = s / 0.30;
      minCutoff = 180.0 * Math.pow(72.0 / 180.0, u);
      beta = 0.220 - u * 0.050;
      dCutoff = 26.0 - u * 6.0;
      baseDeadzone = 0.14 * u;
    } else if (s <= 0.70) {
      const v = (s - 0.30) / 0.40;
      minCutoff = 72.0 * Math.pow(14.0 / 72.0, v);
      beta = 0.170 - v * 0.080;
      dCutoff = 20.0 - v * 11.0;
      baseDeadzone = 0.14 + v * 0.56;
    } else {
      const w = (s - 0.70) / 0.30;
      minCutoff = 14.0 * Math.pow(2.0 / 14.0, w);
      beta = 0.090 - w * 0.060;
      dCutoff = 9.0 - w * 5.5;
      baseDeadzone = 0.70 + w * 0.48;
    }
  } else if (plat === 'android') {
    // Android (60–120Hz USI/S-Pen): attenuazione progressiva normalizzata su dt reali irregolari
    if (s <= 0.30) {
      const u = s / 0.30;
      minCutoff = 95.0 * Math.pow(24.0 / 95.0, u);
      beta = 0.110 - u * 0.035;
      dCutoff = 11.0 - u * 4.5;
      baseDeadzone = 0.26 * u;
    } else if (s <= 0.70) {
      const v = (s - 0.30) / 0.40;
      minCutoff = 24.0 * Math.pow(4.2 / 24.0, v);
      beta = 0.075 - v * 0.035;
      dCutoff = 6.5 - v * 3.0;
      baseDeadzone = 0.26 + v * 0.58;
    } else {
      const w = (s - 0.70) / 0.30;
      minCutoff = 4.2 * Math.pow(1.15 / 4.2, w);
      beta = 0.040 - w * 0.025;
      dCutoff = 3.5 - w * 1.8;
      baseDeadzone = 0.84 + w * 0.50;
    }
  } else {
    // Surface Go 1 / Windows N-Trig (~60Hz): riduce scalettatura diagonale con leggero lookahead di trend su tratti rettilinei
    if (s <= 0.30) {
      const u = s / 0.30;
      minCutoff = 80.0 * Math.pow(18.0 / 80.0, u);
      beta = 0.095 - u * 0.035;
      dCutoff = 10.0 - u * 4.5;
      baseDeadzone = 0.34 * u;
      trendGain = 0.24 * u;
    } else if (s <= 0.70) {
      const v = (s - 0.30) / 0.40;
      minCutoff = 18.0 * Math.pow(3.6 / 18.0, v);
      beta = 0.060 - v * 0.028;
      dCutoff = 5.5 - v * 2.5;
      baseDeadzone = 0.34 + v * 0.62;
      trendGain = 0.24 - v * 0.14;
    } else {
      const w = (s - 0.70) / 0.30;
      minCutoff = 3.6 * Math.pow(1.05 / 3.6, w);
      beta = 0.032 - w * 0.020;
      dCutoff = 3.0 - w * 1.4;
      baseDeadzone = 0.96 + w * 0.52;
      trendGain = 0.10 * (1 - w);
    }
  }

  const deadzone = Math.min(2.6, baseDeadzone / vpScale);
  // Durante una pausa/hold con punta ferma (es. Apple Pencil su iPad per snap forme),
  // attiva una soglia minima anti-tremolio senza penalizzare i movimenti di scrittura.
  const restDeadzone = Math.min(2.6, Math.max(deadzone, 1.38 / vpScale));
  const restCutoff = Math.min(minCutoff, 3.8);

  return {
    mode,
    platform: plat,
    s,
    minCutoff,
    beta,
    dCutoff,
    deadzone,
    restDeadzone,
    restCutoff,
    trendGain,
    pressureNewWeight: 0.78 - s * 0.24
  };
}

/**
 * Crea uno stabilizzatore stateful per un singolo tratto adattato alla piattaforma.
 */
export function createStrokeStabilizer(initialPoint = null, { platform = 'desktop' } = {}) {
  const defaultPlatform = platform === 'ios' || platform === 'android' ? platform : 'desktop';
  let hasInit = false;
  let lastRawX = 0;
  let lastRawY = 0;
  let lastFiltX = 0;
  let lastFiltY = 0;
  let lastDx = 0;
  let lastDy = 0;
  let lastAcceptX = 0;
  let lastAcceptY = 0;
  let lastStepX = 0;
  let lastStepY = 0;
  let lastPressure = 0.5;
  let lastTs = 0;
  let observedDtMs = defaultPlatform === 'ios' ? 8.33 : 16.67;

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
        lastRawX = rawPoint.x;
        lastRawY = rawPoint.y;
        lastFiltX = rawPoint.x;
        lastFiltY = rawPoint.y;
        lastAcceptX = rawPoint.x;
        lastAcceptY = rawPoint.y;
        lastStepX = 0;
        lastStepY = 0;
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
          // Eventi coalesced nello stesso frame condividono talvolta il timestamp
          rawDtMs = cfg.platform === 'ios' ? 4.5 : 6.0;
        }
      } else {
        rawDtMs = observedDtMs;
      }
      const effectiveDtMs = cfg.platform === 'android'
        ? _clamp(rawDtMs * 0.65 + observedDtMs * 0.35, 3, 48)
        : _clamp(rawDtMs, 2, 64);
      const dtSec = effectiveDtMs / 1000;
      if (ts > 0) lastTs = ts;

      // Fascia 0 (smoothing=0): bypass filtro spaziale, zero lag
      if (cfg.mode === 'bypass') {
        _blendPressure(rawPoint, cfg);
        const dx = rawPoint.x - lastAcceptX;
        const dy = rawPoint.y - lastAcceptY;
        const dist = Math.hypot(dx, dy);
        if (dist < cfg.deadzone) {
          return { accepted: false, x: lastAcceptX, y: lastAcceptY, pressure: lastPressure, distFromAccepted: dist, dtMs: effectiveDtMs };
        }
        lastStepX = dx;
        lastStepY = dy;
        lastAcceptX = rawPoint.x;
        lastAcceptY = rawPoint.y;
        lastFiltX = rawPoint.x;
        lastFiltY = rawPoint.y;
        lastRawX = rawPoint.x;
        lastRawY = rawPoint.y;
        return {
          accepted: true,
          x: rawPoint.x,
          y: rawPoint.y,
          pressure: lastPressure,
          distFromAccepted: dist,
          dtMs: effectiveDtMs
        };
      }

      const stepInX = rawPoint.x - lastRawX;
      const stepInY = rawPoint.y - lastRawY;
      const dxRaw = stepInX / dtSec;
      const dyRaw = stepInY / dtSec;
      lastRawX = rawPoint.x;
      lastRawY = rawPoint.y;

      const dAlpha = _lowPassAlpha(cfg.dCutoff, dtSec);
      lastDx = lastDx + (dxRaw - lastDx) * dAlpha;
      lastDy = lastDy + (dyRaw - lastDy) * dAlpha;

      const speedPerSec = Math.hypot(lastDx, lastDy);
      const distRaw = Math.hypot(rawPoint.x - lastAcceptX, rawPoint.y - lastAcceptY);
      const isResting = distRaw < cfg.restDeadzone;
      const baseCutoff = cfg.minCutoff + cfg.beta * speedPerSec;
      const cutoff = isResting ? Math.min(baseCutoff, cfg.restCutoff) : baseCutoff;
      const alpha = _lowPassAlpha(cutoff, dtSec);

      lastFiltX = lastFiltX + (rawPoint.x - lastFiltX) * alpha;
      lastFiltY = lastFiltY + (rawPoint.y - lastFiltY) * alpha;

      // Desktop (Surface Go 1): leggero anticipo lungo la tangente corrente su segmenti continui
      // (preserva gli spigoli netti e taglia il lag percepito su linee diagonali 60Hz)
      let outX = lastFiltX;
      let outY = lastFiltY;
      if (cfg.trendGain > 0 && !isResting) {
        const prevLen = Math.hypot(lastStepX, lastStepY);
        const currLen = Math.hypot(stepInX, stepInY);
        if (prevLen > 0.5 && currLen > 0.5) {
          const cosAng = (lastStepX * stepInX + lastStepY * stepInY) / (prevLen * currLen);
          if (cosAng > 0.65) {
            const lead = cfg.trendGain * Math.min(1, (cosAng - 0.65) / 0.35);
            outX += (rawPoint.x - lastFiltX) * lead;
            outY += (rawPoint.y - lastFiltY) * lead;
          }
        }
      }
      lastStepX = stepInX;
      lastStepY = stepInY;

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
