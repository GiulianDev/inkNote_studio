import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSafeHudViewportRect,
  computeDockTopClearance,
  shouldStartUndoRedoDrag,
  resolveDefaultUndoRedoPosition
} from './hud-layout.js';

describe('hud-layout pure helpers', () => {
  it('excludes left sidebar width when left pages sidebar is open', () => {
    const res = computeSafeHudViewportRect({
      viewportRect: { left: 0, top: 0, width: 1440, height: 900 },
      sidebarOpen: true,
      sidebarPosition: 'left',
      sidebarWidth: 180,
      headerBottom: 61,
      margin: 8
    });

    assert.equal(res.viewportRect.left, 180);
    assert.equal(res.viewportRect.right, 1440);
    assert.equal(res.viewportRect.width, 1260);
    assert.equal(res.minTop, 69);
  });

  it('excludes right sidebar width when right pages sidebar is open', () => {
    const res = computeSafeHudViewportRect({
      viewportRect: { left: 0, top: 0, width: 1200, height: 800 },
      sidebarOpen: true,
      sidebarPosition: 'right',
      sidebarWidth: 180,
      headerBottom: 58,
      margin: 8
    });

    assert.equal(res.viewportRect.left, 0);
    assert.equal(res.viewportRect.right, 1020);
    assert.equal(res.viewportRect.width, 1020);
    assert.equal(res.minTop, 66);
  });

  it('ignores header bottom when compact mode is active or sidebar is closed', () => {
    const res = computeSafeHudViewportRect({
      viewportRect: { left: 0, top: 0, width: 1024, height: 768 },
      sidebarOpen: false,
      sidebarPosition: 'left',
      sidebarWidth: 180,
      headerBottom: 64,
      isCompactMode: true,
      margin: 8
    });

    assert.equal(res.viewportRect.left, 0);
    assert.equal(res.viewportRect.width, 1024);
    assert.equal(res.minTop, 8);
  });

  it('computes safe top clearance below visible contextual dock', () => {
    assert.equal(
      computeDockTopClearance({
        viewportTop: 61,
        dockBottom: 173,
        dockVisible: true,
        minMargin: 20,
        dockGap: 16
      }),
      128
    );

    assert.equal(
      computeDockTopClearance({
        viewportTop: 61,
        dockBottom: 173,
        dockVisible: false,
        minMargin: 20
      }),
      20
    );

    assert.equal(
      computeDockTopClearance({
        viewportTop: 61,
        dockBottom: 64,
        dockVisible: true,
        minMargin: 20,
        dockGap: 16
      }),
      20
    );
  });

  it('starts Undo/Redo drag on panel movement beyond threshold or hold fallback', () => {
    assert.equal(shouldStartUndoRedoDrag({ distancePx: 6 }), false);
    assert.equal(shouldStartUndoRedoDrag({ distancePx: 8 }), true);
    assert.equal(shouldStartUndoRedoDrag({ distancePx: 0, holdElapsed: true }), true);
  });

  it('places default Undo/Redo beside dock on desktop and below dock on narrow mobile screens', () => {
    const desktopPos = resolveDefaultUndoRedoPosition({
      viewportRect: { left: 0 },
      dockRect: { left: 468, top: 68, right: 971, bottom: 186, width: 503, height: 118 },
      dockVisible: true,
      minTop: 72
    });
    assert.deepEqual(desktopPos, { x: 16, y: 140 });

    const mobilePos = resolveDefaultUndoRedoPosition({
      viewportRect: { left: 0 },
      dockRect: { left: 14, top: 68, right: 375, bottom: 180, width: 361, height: 112 },
      dockVisible: true,
      minTop: 72
    });
    assert.deepEqual(mobilePos, { x: 12, y: 192 });
  });
});
