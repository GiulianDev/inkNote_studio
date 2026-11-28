import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInstallPlatform } from './pwa.js';

test('classifyInstallPlatform hides button when already standalone', () => {
  assert.deepEqual(
    classifyInstallPlatform({
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      isStandalone: true,
      hasDeferredPrompt: true
    }),
    { isInstalled: true, isIOS: false, mode: 'installed' }
  );
});

test('classifyInstallPlatform prefers native prompt when beforeinstallprompt is available', () => {
  assert.deepEqual(
    classifyInstallPlatform({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0',
      isStandalone: false,
      hasDeferredPrompt: true
    }),
    { isInstalled: false, isIOS: false, mode: 'prompt' }
  );
});

test('classifyInstallPlatform detects iPadOS desktop UA and classic iOS Safari for install guide', () => {
  assert.deepEqual(
    classifyInstallPlatform({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      maxTouchPoints: 5,
      isStandalone: false,
      hasDeferredPrompt: false
    }),
    { isInstalled: false, isIOS: true, mode: 'ios-guide' }
  );
  assert.deepEqual(
    classifyInstallPlatform({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
      maxTouchPoints: 5,
      isStandalone: false,
      hasDeferredPrompt: false
    }),
    { isInstalled: false, isIOS: true, mode: 'ios-guide' }
  );
});

test('classifyInstallPlatform returns none on unsupported desktop without prompt', () => {
  assert.deepEqual(
    classifyInstallPlatform({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      maxTouchPoints: 0,
      isStandalone: false,
      hasDeferredPrompt: false
    }),
    { isInstalled: false, isIOS: false, mode: 'none' }
  );
});
