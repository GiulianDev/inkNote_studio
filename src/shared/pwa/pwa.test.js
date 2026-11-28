import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInstallPlatform, resolveSettingsInstallPresentation } from './pwa.js';

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

test('resolveSettingsInstallPresentation maps installed, prompt, ios-guide and fallback states cleanly', () => {
  assert.equal(resolveSettingsInstallPresentation({ mode: 'installed' }).disabled, true);
  assert.equal(resolveSettingsInstallPresentation({ mode: 'installed' }).tone, 'installed');

  const promptUI = resolveSettingsInstallPresentation({ mode: 'prompt' });
  assert.equal(promptUI.disabled, false);
  assert.equal(promptUI.tone, 'primary');
  assert.equal(promptUI.label, 'Installa app');

  const iosUI = resolveSettingsInstallPresentation({ mode: 'ios-guide', isIOS: true });
  assert.equal(iosUI.disabled, false);
  assert.equal(iosUI.tone, 'secondary');
  assert.match(iosUI.label, /iPhone \/ iPad/);

  const fallbackUI = resolveSettingsInstallPresentation({ mode: 'none', isIOS: false });
  assert.equal(fallbackUI.disabled, false);
  assert.equal(fallbackUI.label, 'Come installare');
});
