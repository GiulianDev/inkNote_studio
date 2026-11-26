import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SELECTION_STROKE_STYLES,
  isValidSelectionStrokeStyle,
  normalizeStrokeStyle,
  isStrokeStyleCapable,
  resolveSelectionStrokeStyle,
  applyStyleToStrokes,
  computeSelectionStylePopoverPosition,
  computeSelectionMenuPosition,
  resolveSelectionMenuMode,
  resolveSelectionColor,
  resolveSelectionFontSize,
  computeSteppedSelectionFontSize,
  TEXT_FONT_SIZE_MIN,
  TEXT_FONT_SIZE_MAX
} from './selection-style.js';

describe('selection-style helpers', () => {
  it('validates and normalizes stroke styles', () => {
    for (const style of SELECTION_STROKE_STYLES) {
      assert.equal(isValidSelectionStrokeStyle(style), true);
      assert.equal(normalizeStrokeStyle(style), style);
    }
    assert.equal(isValidSelectionStrokeStyle('invalid'), false);
    assert.equal(normalizeStrokeStyle(undefined), 'solid');
    assert.equal(normalizeStrokeStyle('zigzag'), 'solid');
  });

  it('excludes highlighter from style-capable strokes', () => {
    assert.equal(isStrokeStyleCapable({ tool: 'pen' }), true);
    assert.equal(isStrokeStyleCapable({ tool: 'pencil' }), true);
    assert.equal(isStrokeStyleCapable({ tool: 'marker' }), true);
    assert.equal(isStrokeStyleCapable({ tool: 'highlighter' }), false);
    assert.equal(isStrokeStyleCapable({}), true);
    assert.equal(isStrokeStyleCapable(null), false);
  });

  it('resolves uniform, mixed, and non-capable selections accurately', () => {
    const emptyRes = resolveSelectionStrokeStyle([]);
    assert.equal(emptyRes.hasStyleCapable, false);
    assert.equal(emptyRes.activeStyle, null);

    const hlOnly = resolveSelectionStrokeStyle([{ tool: 'highlighter', style: 'solid' }]);
    assert.equal(hlOnly.hasStyleCapable, false);
    assert.equal(hlOnly.capableCount, 0);

    const uniform = resolveSelectionStrokeStyle([
      { tool: 'pen', style: 'dashed' },
      { tool: 'highlighter', style: 'solid' },
      { tool: 'marker', style: 'dashed' }
    ]);
    assert.equal(uniform.hasStyleCapable, true);
    assert.equal(uniform.capableCount, 2);
    assert.equal(uniform.style, 'dashed');
    assert.equal(uniform.activeStyle, 'dashed');
    assert.equal(uniform.isMixed, false);

    const mixed = resolveSelectionStrokeStyle([
      { tool: 'pen', style: 'solid' },
      { tool: 'pencil', style: 'dotted' }
    ]);
    assert.equal(mixed.hasStyleCapable, true);
    assert.equal(mixed.style, 'solid');
    assert.equal(mixed.activeStyle, null);
    assert.equal(mixed.isMixed, true);
  });

  it('applies style only to capable strokes and invokes cache invalidation when needed', () => {
    const pen = { tool: 'pen', style: 'solid' };
    const hl = { tool: 'highlighter', style: 'solid' };
    const pencil = { tool: 'pencil', style: 'dashed' };
    const invalidated = [];

    const res = applyStyleToStrokes([pen, hl, pencil], 'dash-dot', {
      onInvalidate: (s) => invalidated.push(s)
    });

    assert.equal(res.updatedCount, 2);
    assert.equal(res.changedCount, 2);
    assert.equal(res.changed, true);
    assert.equal(pen.style, 'dash-dot');
    assert.equal(pencil.style, 'dash-dot');
    assert.equal(hl.style, 'solid');
    assert.deepEqual(invalidated, [pen, pencil]);

    // Re-applying same style should report changed: false and not invalidate again
    invalidated.length = 0;
    const sameRes = applyStyleToStrokes([pen, hl, pencil], 'dash-dot', {
      onInvalidate: (s) => invalidated.push(s)
    });
    assert.equal(sameRes.updatedCount, 2);
    assert.equal(sameRes.changedCount, 0);
    assert.equal(sameRes.changed, false);
    assert.equal(invalidated.length, 0);

    // Invalid style should be a safe no-op
    const invalidRes = applyStyleToStrokes([pen], 'unknown');
    assert.deepEqual(invalidRes, { updatedCount: 0, changedCount: 0, changed: false });
    assert.equal(pen.style, 'dash-dot');
  });

  it('positions popover above trigger by default and flips below near top edge', () => {
    const above = computeSelectionStylePopoverPosition({
      triggerRect: { left: 400, top: 220, right: 454, bottom: 250, width: 54, height: 30 },
      popoverWidth: 204,
      popoverHeight: 42,
      viewportWidth: 1280,
      viewportHeight: 800
    });
    assert.equal(above.placement, 'top');
    assert.equal(above.top, 170);
    assert.equal(above.left, 325);

    const flipped = computeSelectionStylePopoverPosition({
      triggerRect: { left: 20, top: 68, right: 74, bottom: 98, width: 54, height: 30 },
      popoverWidth: 204,
      popoverHeight: 42,
      viewportWidth: 1280,
      viewportHeight: 800
    });
    assert.equal(flipped.placement, 'bottom');
    assert.equal(flipped.top, 106);
    assert.equal(flipped.left, 8);
  });

  it('positions selection menu above bbox, flips below top toolbar, and clamps edges', () => {
    const above = computeSelectionMenuPosition({
      selectionRect: { left: 300, top: 260, right: 500, bottom: 360 },
      menuWidth: 360,
      menuHeight: 48,
      viewportWidth: 1280,
      viewportHeight: 800,
      minTop: 124
    });
    assert.equal(above.placement, 'top');
    assert.equal(above.top, 200);
    assert.equal(above.left, 220);

    const flipped = computeSelectionMenuPosition({
      selectionRect: { left: 10, top: 130, right: 120, bottom: 210 },
      menuWidth: 360,
      menuHeight: 48,
      viewportWidth: 1280,
      viewportHeight: 800,
      minTop: 124
    });
    assert.equal(flipped.placement, 'bottom');
    assert.equal(flipped.top, 228);
    assert.equal(flipped.left, 12);

    const clampedRight = computeSelectionMenuPosition({
      selectionRect: { left: 1180, top: 300, right: 1260, bottom: 380 },
      menuWidth: 360,
      menuHeight: 48,
      viewportWidth: 1280,
      viewportHeight: 800,
      minTop: 124
    });
    assert.equal(clampedRight.left, 908);

    // iPad visualViewport con tastiera aperta / zoom (offsetLeft=60, offsetTop=40, height=340)
    const vvMenu = computeSelectionMenuPosition({
      selectionRect: { left: 180, top: 350, right: 380, bottom: 420 },
      menuWidth: 320,
      menuHeight: 46,
      viewportRect: { left: 60, top: 40, width: 700, height: 340 },
      minTop: 110
    });
    assert.equal(vvMenu.left, 120);
    assert.equal(vvMenu.top, 292);
  });

  it('resolves contextual menu mode across none, ink, single/multi text, and mixed selections', () => {
    assert.deepEqual(resolveSelectionMenuMode([], []), {
      mode: 'none',
      hasStrokes: false,
      hasText: false,
      showColor: false,
      showInkControls: false,
      showTextControls: false,
      showSingleTextEdit: false
    });

    assert.deepEqual(resolveSelectionMenuMode([{ tool: 'pen' }], []), {
      mode: 'ink',
      hasStrokes: true,
      hasText: false,
      showColor: true,
      showInkControls: true,
      showTextControls: false,
      showSingleTextEdit: false
    });

    assert.deepEqual(resolveSelectionMenuMode([], [{ id: 'tb1' }]), {
      mode: 'text',
      hasStrokes: false,
      hasText: true,
      showColor: true,
      showInkControls: false,
      showTextControls: true,
      showSingleTextEdit: true
    });

    assert.deepEqual(resolveSelectionMenuMode([], [{ id: 'tb1' }, { id: 'tb2' }]), {
      mode: 'text',
      hasStrokes: false,
      hasText: true,
      showColor: true,
      showInkControls: false,
      showTextControls: true,
      showSingleTextEdit: false
    });

    assert.deepEqual(resolveSelectionMenuMode([{ tool: 'pen' }], [{ id: 'tb1' }]), {
      mode: 'mixed',
      hasStrokes: true,
      hasText: true,
      showColor: true,
      showInkControls: false,
      showTextControls: false,
      showSingleTextEdit: false
    });
  });

  it('resolves unified color and clamps/steps text font size cleanly', () => {
    assert.deepEqual(resolveSelectionColor([], [{ color: '#2563EB' }]), {
      color: '#2563eb',
      isMixed: false
    });
    assert.deepEqual(resolveSelectionColor([{ color: '#000' }], [{ color: '#e11d48' }]), {
      color: '#000000',
      isMixed: true
    });

    assert.deepEqual(resolveSelectionFontSize([{ fontSize: 24 }, { fontSize: 24 }]), {
      fontSize: 24,
      isMixed: false
    });
    assert.deepEqual(resolveSelectionFontSize([{ fontSize: 16 }, { fontSize: 32 }]), {
      fontSize: 16,
      isMixed: true
    });

    assert.equal(computeSteppedSelectionFontSize(18, 2), 20);
    assert.equal(computeSteppedSelectionFontSize(TEXT_FONT_SIZE_MIN, -4), TEXT_FONT_SIZE_MIN);
    assert.equal(computeSteppedSelectionFontSize(TEXT_FONT_SIZE_MAX, 4), TEXT_FONT_SIZE_MAX);
  });
});
