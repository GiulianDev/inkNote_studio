/**
 * @module notebook/platform/profiles/desktop
 *
 * Profilo Desktop / Surface / Ibrido Windows-macOS-Linux.
 * Mantiene al 100% parametri, tolleranze e rendering attuali (zero regressioni su Surface/PC).
 */

export const desktopProfile = Object.freeze({
  family: 'desktop',

  pressure: Object.freeze({
    baseGain: 1.0,
    zeroPressureFallback: 0.28,
    minRenderWidthPx: 0.25
  }),

  input: Object.freeze({
    dropZeroPressureUnpressedMove: true,
    capturePointerUpEndpoint: false,
    dedupCoalescedMinDistPx: 0,
    shouldIgnoreUnpressedPenMove(e) {
      return Boolean(e && e.pointerType === 'pen' && e.buttons === 0 && !(e.pressure > 0));
    }
  }),

  stabilizer: Object.freeze({
    defaultDtMs: 16.67,
    gaussianBlendScale: 1.0,
    gaussianShiftScale: 1.0,
    minDeadzonePx: 0,
    restDeadzoneMinPx: 1.38
  }),

  rendering: Object.freeze({
    alwaysJoinThinSegments: false,
    jointMinWidthThresholdPx: 1.8,
    adjustSegmentSteps(baseSteps, segLen, _smoothness) {
      if (baseSteps <= 1) return 1;
      return segLen <= 34 ? Math.min(baseSteps, 3) : baseSteps;
    }
  }),

  recognition: Object.freeze({
    cleanReleasePoints: null,
    cleanLinePoints: null,
    releaseTailTrimRadius: 5.5,
    lineHold: Object.freeze({
      minChordLen: 45,
      minPathRatio: 0.93,
      maxRmsBase: 2.5,
      maxRmsFactor: 0.024,
      minTailCos: 0.72,
      signHysteresis: 2.5,
      tailTrimRadius: 5.5
    }),
    lineAuto: Object.freeze({
      minChordLen: 80,
      minPathRatio: 0.988,
      maxRmsBase: 1.1,
      maxRmsFactor: 0.007,
      maxPerpBase: 2.2,
      maxPerpFactor: 0.014,
      minEndCos: 0.94,
      axisSnapDeg: 2.5,
      maxSignChangesDivisor: 110,
      tailTrimRadius: 4.5
    })
  })
});
