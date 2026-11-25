import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePointerKind,
  detectPlatformInfo,
  createInitialPlatformState,
  applyPlatformToDOM,
  recordPlatformPointer,
  initPlatform
} from './platform.js';

function makeMockWindow({
  innerWidth = 1440,
  innerHeight = 900,
  devicePixelRatio = 1,
  ontouchstart = false,
  matches = {}
} = {}) {
  const listeners = new Map();
  const win = {
    innerWidth,
    innerHeight,
    devicePixelRatio,
    matchMedia(query) {
      return {
        matches: Boolean(matches[query]),
        addEventListener() {},
        removeEventListener() {}
      };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    _dispatch(type, event) {
      for (const fn of (listeners.get(type) || []).slice()) {
        fn(event);
      }
    }
  };
  if (ontouchstart) win.ontouchstart = null;
  return win;
}

function makeMockDocument({ supportsFullscreen = true } = {}) {
  const classes = new Set();
  const body = {
    dataset: {},
    classList: {
      toggle(cls, force) {
        const next = force !== undefined ? Boolean(force) : !classes.has(cls);
        if (next) classes.add(cls);
        else classes.delete(cls);
        return next;
      },
      contains(cls) {
        return classes.has(cls);
      }
    }
  };
  return {
    body,
    documentElement: supportsFullscreen ? { requestFullscreen: () => {} } : {}
  };
}

describe('core/platform: centralized platform detection & runtime state', () => {
  it('identifies iPadOS (MacIntel + maxTouchPoints > 1) as ios, mobile, tablet and Safari', () => {
    const info = detectPlatformInfo({
      navigatorObj: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5
      },
      windowObj: makeMockWindow({
        innerWidth: 1024,
        innerHeight: 1366,
        devicePixelRatio: 2,
        ontouchstart: true,
        matches: { '(pointer: coarse)': true, '(any-pointer: coarse)': true }
      }),
      documentObj: makeMockDocument({ supportsFullscreen: false })
    });

    assert.equal(info.os, 'ipados');
    assert.equal(info.family, 'ios');
    assert.equal(info.isIOS, true);
    assert.equal(info.isIPadOS, true);
    assert.equal(info.isAndroid, false);
    assert.equal(info.isMobile, true);
    assert.equal(info.isDesktop, false);
    assert.equal(info.isHybrid, false);
    assert.equal(info.isSafari, true);
    assert.equal(info.hasTouch, true);
    assert.equal(info.dpr, 2);
    assert.equal(info.viewportClass, 'desktop');
    assert.equal(info.isPortrait, true);
    assert.equal(info.supportsFullscreen, false);
  });

  it('identifies Android phone properly as mobile & phone viewportClass', () => {
    const info = detectPlatformInfo({
      navigatorObj: {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
        platform: 'Linux armv81',
        maxTouchPoints: 5
      },
      windowObj: makeMockWindow({
        innerWidth: 412,
        innerHeight: 915,
        devicePixelRatio: 3,
        ontouchstart: true,
        matches: { '(pointer: coarse)': true }
      }),
      documentObj: makeMockDocument()
    });

    assert.equal(info.os, 'android');
    assert.equal(info.family, 'android');
    assert.equal(info.isAndroid, true);
    assert.equal(info.isIOS, false);
    assert.equal(info.isMobile, true);
    assert.equal(info.isHybrid, false);
    assert.equal(info.isSafari, false);
    assert.equal(info.viewportClass, 'phone');
    assert.equal(info.isPortrait, true);
  });

  it('identifies Windows Surface as desktop hybrid device without treating it as mobile', () => {
    const info = detectPlatformInfo({
      navigatorObj: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
        platform: 'Win32',
        maxTouchPoints: 10
      },
      windowObj: makeMockWindow({
        innerWidth: 1280,
        innerHeight: 800,
        devicePixelRatio: 2,
        ontouchstart: true,
        matches: { '(pointer: fine)': true, '(hover: hover)': true }
      }),
      documentObj: makeMockDocument()
    });

    assert.equal(info.os, 'windows');
    assert.equal(info.family, 'desktop');
    assert.equal(info.isDesktop, true);
    assert.equal(info.isMobile, false);
    assert.equal(info.hasTouch, true);
    assert.equal(info.isHybrid, true);
    assert.equal(info.canHover, true);
    assert.equal(info.viewportClass, 'desktop');
    assert.equal(info.isPortrait, false);
  });

  it('tracks lastPointerType dynamically (including eraser -> pen) and syncs body classes/attributes', () => {
    const win = makeMockWindow({
      innerWidth: 1280,
      innerHeight: 800,
      ontouchstart: true,
      matches: { '(pointer: fine)': true, '(hover: hover)': true }
    });
    const doc = makeMockDocument();
    const nav = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0',
      platform: 'Win32',
      maxTouchPoints: 10
    };

    const appState = {
      platform: createInitialPlatformState({ navigatorObj: nav, windowObj: win, documentObj: doc })
    };
    const { destroy } = initPlatform({ targetState: appState, windowObj: win, documentObj: doc, navigatorObj: nav });

    assert.equal(appState.platform.lastPointerType, 'mouse');
    assert.equal(doc.body.dataset.lastPointer, 'mouse');
    assert.equal(doc.body.classList.contains('plat-hybrid'), true);
    assert.equal(doc.body.classList.contains('plat-pen-seen'), false);

    win._dispatch('pointerdown', { pointerType: 'touch' });
    assert.equal(appState.platform.lastPointerType, 'touch');
    assert.equal(doc.body.dataset.lastPointer, 'touch');

    win._dispatch('pointerdown', { pointerType: 'eraser' });
    assert.equal(appState.platform.lastPointerType, 'pen');
    assert.equal(appState.platform.hasSeenPen, true);
    assert.equal(doc.body.dataset.lastPointer, 'pen');
    assert.equal(doc.body.classList.contains('plat-pen-seen'), true);

    assert.equal(normalizePointerKind('eraser'), 'pen');
    assert.equal(normalizePointerKind('pen'), 'pen');
    assert.equal(normalizePointerKind('touch'), 'touch');
    assert.equal(normalizePointerKind('mouse'), 'mouse');
    assert.equal(normalizePointerKind('other'), null);

    // Direct call works cleanly too
    recordPlatformPointer(appState.platform, 'mouse', doc);
    assert.equal(doc.body.dataset.lastPointer, 'mouse');
    applyPlatformToDOM(appState.platform, doc);
    assert.equal(doc.body.dataset.platformFamily, 'desktop');

    destroy();
  });
});
