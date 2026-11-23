import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFullscreenState,
  reduceNativeFullscreenChange
} from './fullscreen.js';

test('resolveFullscreenState returns true if native or fallback is active', () => {
  assert.equal(resolveFullscreenState({ nativeFullscreen: false, fallbackActive: false }), false);
  assert.equal(resolveFullscreenState({ nativeFullscreen: true, fallbackActive: false }), true);
  assert.equal(resolveFullscreenState({ nativeFullscreen: false, fallbackActive: true }), true);
  assert.equal(resolveFullscreenState({ nativeFullscreen: true, fallbackActive: true }), true);
});

test('reduceNativeFullscreenChange enters native fullscreen cleanly', () => {
  const next = reduceNativeFullscreenChange({
    wasNativeActive: false,
    isNativeNow: true,
    fallbackActive: true
  });
  assert.deepEqual(next, {
    nativeActive: true,
    fallbackActive: false,
    isFullscreen: true
  });
});

test('reduceNativeFullscreenChange exits both native and fallback when user presses Esc from native fullscreen', () => {
  const next = reduceNativeFullscreenChange({
    wasNativeActive: true,
    isNativeNow: false,
    fallbackActive: false
  });
  assert.deepEqual(next, {
    nativeActive: false,
    fallbackActive: false,
    isFullscreen: false
  });
});

test('reduceNativeFullscreenChange keeps CSS fallback active when browser blocks native fullscreen', () => {
  const next = reduceNativeFullscreenChange({
    wasNativeActive: false,
    isNativeNow: false,
    fallbackActive: true
  });
  assert.deepEqual(next, {
    nativeActive: false,
    fallbackActive: true,
    isFullscreen: true
  });
});
