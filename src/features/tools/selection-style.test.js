import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SELECTION_STROKE_STYLES,
  isValidSelectionStrokeStyle,
  normalizeStrokeStyle,
  isStrokeStyleCapable,
  resolveSelectionStrokeStyle,
  applyStyleToStrokes,
  computeSelectionStylePopoverPosition
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
});
