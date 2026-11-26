/**
 * @module features/tools/line-snap
 *
 * Logica pura (zero DOM / zero store globale) per:
 *   1. Snap angolare orizzontale/verticale con isteresi (per hold interattivo)
 *   2. Riconoscimento linea durante hold (~320ms pausa)
 *   3. Raddrizzamento automatico al rilascio SOLO per tratti estremamente dritti e regolari
 */

import { perpendicularRmsDeviationSampled } from './arrow-recognition.js';
import { trimStationaryTail } from './ink-calibration.js';
import { getDeviceProfile } from '../platform/profiles/index.js';

export const LINE_ANGLE_ENGAGE_DEG  = 4;
export const LINE_ANGLE_RELEASE_DEG = 8;

const HOLD_MAX_RMS_BASE        = 2.5;
const HOLD_MAX_RMS_FACTOR      = 0.024;
const HOLD_MAX_COS_CONSISTENCY = 0.72;
const SIGN_HYSTERESIS          = 2.5;

const AUTO_AXIS_SNAP_DEG       = 2.5;

/**
 * Snap angolare orizzontale / verticale con isteresi (aggancia entro 4°, rilascia oltre 8°).
 * Una volta che lo snap si è agganciato e l'utente si è sganciato volontariamente (> 8°),
 * `rejected` diventa `true` e quella stessa linea NON si riaggancia più tornando vicino
 * a 0°/90° (permette angoli minimi vicino all'asse). Una nuova linea riparte con `rejected=false`.
 */
export function applyAngleSnap(start, rawEnd, currentAxis = null, rejected = false) {
  if (rejected) {
    return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
  }

  const dx = rawEnd.x - start.x;
  const dy = rawEnd.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) {
    return { x: rawEnd.x, y: rawEnd.y, axis: currentAxis, rejected: false };
  }

  const thetaDeg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
  const distH = thetaDeg;
  const distV = 90 - thetaDeg;

  if (currentAxis === 'h') {
    if (distH > LINE_ANGLE_RELEASE_DEG) {
      return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
    }
    return { x: rawEnd.x, y: start.y, axis: 'h', rejected: false };
  }
  if (currentAxis === 'v') {
    if (distV > LINE_ANGLE_RELEASE_DEG) {
      return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: true };
    }
    return { x: start.x, y: rawEnd.y, axis: 'v', rejected: false };
  }

  if (distH <= LINE_ANGLE_ENGAGE_DEG) {
    return { x: rawEnd.x, y: start.y, axis: 'h', rejected: false };
  }
  if (distV <= LINE_ANGLE_ENGAGE_DEG) {
    return { x: start.x, y: rawEnd.y, axis: 'v', rejected: false };
  }

  return { x: rawEnd.x, y: rawEnd.y, axis: null, rejected: false };
}

function _countPerpSignChanges(points, A, B, hysteresis) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return 0;
  const nx = -dy / len;
  const ny = dx / len;
  let lastSign = 0;
  let changes = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const perp = (p.x - A.x) * nx + (p.y - A.y) * ny;
    if (perp > hysteresis) {
      if (lastSign === -1) changes++;
      lastSign = 1;
    } else if (perp < -hysteresis) {
      if (lastSign === 1) changes++;
      lastSign = -1;
    }
  }
  return changes;
}

function _maxPerpDeviation(points, A, B) {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return Infinity;
  const nx = -dy / len;
  const ny = dx / len;
  let maxAbs = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const absPerp = Math.abs((p.x - A.x) * nx + (p.y - A.y) * ny);
    if (absPerp > maxAbs) maxAbs = absPerp;
  }
  return maxAbs;
}

function _tailCos(pts, startPt, endPt, chordLen) {
  if (pts.length < 3) return 1;
  const tip = pts[pts.length - 1];
  const tailWindow = Math.min(18, chordLen * 0.25);
  let tailIdx = pts.length - 2;
  while (tailIdx > 0 && Math.hypot(tip.x - pts[tailIdx].x, tip.y - pts[tailIdx].y) < tailWindow) {
    tailIdx--;
  }
  const base = pts[tailIdx];
  const tdx = tip.x - base.x;
  const tdy = tip.y - base.y;
  const tLen = Math.hypot(tdx, tdy);
  if (tLen < 8 || chordLen <= 0) return 1;
  return (tdx * (endPt.x - startPt.x) + tdy * (endPt.y - startPt.y)) / (tLen * chordLen);
}

function _headCos(pts, startPt, endPt, chordLen) {
  if (pts.length < 3) return 1;
  const head = pts[0];
  const headWindow = Math.min(18, chordLen * 0.25);
  let headIdx = 1;
  while (headIdx < pts.length - 1 && Math.hypot(pts[headIdx].x - head.x, pts[headIdx].y - head.y) < headWindow) {
    headIdx++;
  }
  const next = pts[headIdx];
  const hdx = next.x - head.x;
  const hdy = next.y - head.y;
  const hLen = Math.hypot(hdx, hdy);
  if (hLen < 8 || chordLen <= 0) return 1;
  return (hdx * (endPt.x - startPt.x) + hdy * (endPt.y - startPt.y)) / (hLen * chordLen);
}

/**
 * Valutazione linea dritta durante l'hold (punta tenuta ferma ~320ms).
 * Attiva la modalità interattiva con maniglie e snap orizzontale/verticale.
 */
export function evaluateLineHoldCandidate(rawPoints, { platform = 'desktop' } = {}) {
  const rec = getDeviceProfile(platform).recognition;
  const cfg = rec.lineHold;
  const tailTrimRadius = cfg.tailTrimRadius != null ? cfg.tailTrimRadius : 5.5;
  const pts = typeof rec.cleanLinePoints === 'function'
    ? rec.cleanLinePoints(rawPoints, tailTrimRadius)
    : trimStationaryTail(rawPoints, tailTrimRadius);
  if (!pts || pts.length < 4) return null;

  const startPt = pts[0];
  const endPt = pts[pts.length - 1];
  const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (chordLen < cfg.minChordLen) return null;

  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (chordLen / Math.max(pathLen, 1) < cfg.minPathRatio) return null;

  const rmsDev = perpendicularRmsDeviationSampled(pts, startPt, endPt, 3);
  if (rmsDev === null) return null;
  const maxRmsBase = cfg.maxRmsBase != null ? cfg.maxRmsBase : HOLD_MAX_RMS_BASE;
  const maxRmsFactor = cfg.maxRmsFactor != null ? cfg.maxRmsFactor : HOLD_MAX_RMS_FACTOR;
  if (rmsDev > Math.max(maxRmsBase, chordLen * maxRmsFactor)) return null;

  const signHyst = cfg.signHysteresis != null ? cfg.signHysteresis : SIGN_HYSTERESIS;
  const signChanges = _countPerpSignChanges(pts, startPt, endPt, signHyst);
  if (signChanges > Math.max(3, Math.floor(chordLen / 80))) return null;

  const minTailCos = cfg.minTailCos != null ? cfg.minTailCos : HOLD_MAX_COS_CONSISTENCY;
  if (_tailCos(pts, startPt, endPt, chordLen) < minTailCos) return null;

  return {
    start: { x: startPt.x, y: startPt.y },
    end: { x: endPt.x, y: endPt.y },
    chordLen
  };
}

/**
 * Valutazione MOLTO restrittiva per raddrizzamento automatico al rilascio
 * (solo se l'utente ha già disegnato una linea quasi da righello).
 */
export function evaluateUltraStraightLineCandidate(rawPoints, { platform = 'desktop' } = {}) {
  const rec = getDeviceProfile(platform).recognition;
  const cfg = rec.lineAuto;
  const tailTrimRadius = cfg.tailTrimRadius != null ? cfg.tailTrimRadius : 4.5;
  const pts = typeof rec.cleanLinePoints === 'function'
    ? rec.cleanLinePoints(rawPoints, tailTrimRadius)
    : trimStationaryTail(rawPoints, tailTrimRadius);
  if (!pts || pts.length < 6) return null;

  const startPt = pts[0];
  const endPt = pts[pts.length - 1];
  const chordLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
  if (chordLen < cfg.minChordLen) return null;

  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (chordLen / Math.max(pathLen, 1) < cfg.minPathRatio) return null;

  const rmsDev = perpendicularRmsDeviationSampled(pts, startPt, endPt, 2);
  if (rmsDev === null) return null;
  if (rmsDev > Math.max(cfg.maxRmsBase, chordLen * cfg.maxRmsFactor)) return null;

  const maxPerp = _maxPerpDeviation(pts, startPt, endPt);
  if (maxPerp > Math.max(cfg.maxPerpBase, chordLen * cfg.maxPerpFactor)) return null;

  const signDivisor = cfg.maxSignChangesDivisor || 110;
  const signChanges = _countPerpSignChanges(pts, startPt, endPt, 1.5);
  if (signChanges > Math.max(2, Math.floor(chordLen / signDivisor))) return null;

  if (_headCos(pts, startPt, endPt, chordLen) < cfg.minEndCos) return null;
  if (_tailCos(pts, startPt, endPt, chordLen) < cfg.minEndCos) return null;

  // Snap H/V opzionale al rilascio solo se già quasi allineata (<= axisSnapDeg)
  const dx = endPt.x - startPt.x;
  const dy = endPt.y - startPt.y;
  const thetaDeg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
  const axisSnapDeg = cfg.axisSnapDeg != null ? cfg.axisSnapDeg : AUTO_AXIS_SNAP_DEG;
  let fx = endPt.x;
  let fy = endPt.y;
  if (thetaDeg <= axisSnapDeg) fy = startPt.y;
  else if (90 - thetaDeg <= axisSnapDeg) fx = startPt.x;

  return {
    start: { x: startPt.x, y: startPt.y },
    end: { x: fx, y: fy },
    chordLen: Math.hypot(fx - startPt.x, fy - startPt.y)
  };
}

export function buildStraightLinePoints(startPt, endPt) {
  const dx = endPt.x - startPt.x;
  const dy = endPt.y - startPt.y;
  const finalLen = Math.hypot(dx, dy);
  const steps = Math.max(8, Math.floor(finalLen / 4));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({
      x: startPt.x + dx * t,
      y: startPt.y + dy * t,
      pressure: 0.5
    });
  }
  return out;
}
