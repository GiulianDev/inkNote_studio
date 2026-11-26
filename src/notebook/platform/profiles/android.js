/**
 * @module notebook/platform/profiles/android
 *
 * Profilo Android / Chrome / WebView.
 * Isolato dal profilo Desktop e iOS per future tarature stilo (S Pen, USI, MPP)
 * senza alterare i parametri validati su Android oggi.
 */

export const androidProfile = Object.freeze({
  family: 'android',

  pressure: Object.freeze({
    baseGain: 1.12,
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
    gaussianBlendScale: 0.90,
    gaussianShiftScale: 1.0,
    minDeadzonePx: 0,
    restDeadzoneMinPx: 1.38
  }),

  rendering: Object.freeze({
    alwaysJoinThinSegments: false,
    jointMinWidthThresholdPx: 1.8,
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
