import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSidebarHeaderTop,
  resolveSidebarViewportTop,
  evaluateSidebarSwipeStart,
  resolveSidebarSwipeDecision
} from './sidebar-layout.js';

describe('pages-sidebar layout helper', () => {
  it('returns rounded bottom when header is visible and height changed', () => {
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 61.4, bottom: 61.4 },
        isCompactMode: false,
        lastTop: null
      }),
      61
    );
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 74, bottom: 74.2 },
        isCompactMode: false,
        lastTop: 61
      }),
      74
    );
  });

  it('skips redundant writes when pixel offset is unchanged', () => {
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 61, bottom: 61.2 },
        isCompactMode: false,
        lastTop: 61
      }),
      null
    );
  });

  it('skips updates when header is hidden or in compact mode', () => {
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 0, bottom: 0 },
        isCompactMode: false,
        lastTop: 61
      }),
      null
    );
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 52, bottom: 64 },
        isCompactMode: true,
        lastTop: 61
      }),
      null
    );
    assert.equal(
      resolveSidebarHeaderTop({
        rect: null,
        isCompactMode: false,
        lastTop: 61
      }),
      null
    );
  });

  it('pushes sidebar below contextual dock on mobile when dock horizontally overlaps sidebar', () => {
    // Smartphone 390px: dock spans left 14..375, overlaps left sidebar 0..148
    const mobileTop = resolveSidebarViewportTop({
      headerRect: { height: 59, bottom: 59 },
      dockRect: { left: 14, right: 375, top: 68, bottom: 180, width: 361, height: 112 },
      dockVisible: true,
      isCompactMode: false,
      sidebarPosition: 'left',
      sidebarWidth: 148,
      viewportWidth: 390,
      dockGap: 8
    });
    assert.equal(mobileTop, 188);

    // Desktop 1440px: centered dock 468..971 does NOT overlap sidebar 0..180
    const desktopTop = resolveSidebarViewportTop({
      headerRect: { height: 63, bottom: 63 },
      dockRect: { left: 468, right: 971, top: 68, bottom: 186, width: 503, height: 118 },
      dockVisible: true,
      isCompactMode: false,
      sidebarPosition: 'left',
      sidebarWidth: 180,
      viewportWidth: 1440,
      dockGap: 8
    });
    assert.equal(desktopTop, 63);

    // Compact mode on mobile still clears overlapping dock
    const compactMobileTop = resolveSidebarViewportTop({
      headerRect: { height: 0, bottom: 0 },
      dockRect: { left: 14, right: 375, top: 76, bottom: 188, width: 361, height: 112 },
      dockVisible: true,
      isCompactMode: true,
      sidebarPosition: 'right',
      sidebarWidth: 148,
      viewportWidth: 390,
      dockGap: 8
    });
    assert.equal(compactMobileTop, 196);
  });

  it('evaluates edge and tab swipe eligibility accurately while ignoring pen input', () => {
    assert.deepEqual(
      evaluateSidebarSwipeStart({
        clientX: 14,
        clientY: 420,
        viewportWidth: 390,
        sidebarPosition: 'left',
        sidebarOpen: false,
        pointerType: 'pen',
        tabRect: { top: 385, bottom: 459 }
      }),
      { accept: false, mode: null }
    );

    assert.deepEqual(
      evaluateSidebarSwipeStart({
        clientX: 28,
        clientY: 360,
        viewportWidth: 390,
        sidebarPosition: 'left',
        sidebarOpen: false,
        pointerType: 'touch',
        tabRect: { top: 385, bottom: 459 }
      }),
      { accept: true, mode: 'open' }
    );

    // Far vertically from tab should NOT trigger edge swipe
    assert.deepEqual(
      evaluateSidebarSwipeStart({
        clientX: 20,
        clientY: 120,
        viewportWidth: 390,
        sidebarPosition: 'left',
        sidebarOpen: false,
        pointerType: 'touch',
        tabRect: { top: 385, bottom: 459 }
      }),
      { accept: false, mode: null }
    );

    // Right edge swipe near tab
    assert.deepEqual(
      evaluateSidebarSwipeStart({
        clientX: 372,
        clientY: 430,
        viewportWidth: 390,
        sidebarPosition: 'right',
        sidebarOpen: false,
        pointerType: 'touch',
        tabRect: { top: 385, bottom: 459 }
      }),
      { accept: true, mode: 'open' }
    );
  });

  it('commits open/close swipe only when inward/outward horizontal threshold is met', () => {
    assert.equal(resolveSidebarSwipeDecision({ mode: 'open', dx: 26, dy: 6, sidebarPosition: 'left' }), 'open');
    assert.equal(resolveSidebarSwipeDecision({ mode: 'open', dx: -26, dy: 6, sidebarPosition: 'left' }), null);
    assert.equal(resolveSidebarSwipeDecision({ mode: 'open', dx: 30, dy: 40, sidebarPosition: 'left' }), null);
    assert.equal(resolveSidebarSwipeDecision({ mode: 'open', dx: -28, dy: 4, sidebarPosition: 'right' }), 'open');
    assert.equal(resolveSidebarSwipeDecision({ mode: 'close', dx: -26, dy: 5, sidebarPosition: 'left' }), 'close');
    assert.equal(resolveSidebarSwipeDecision({ mode: 'close', dx: 28, dy: 4, sidebarPosition: 'right' }), 'close');
  });
});
