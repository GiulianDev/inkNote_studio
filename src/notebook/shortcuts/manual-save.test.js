import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createManualSaveRunner } from './manual-save.js';

describe('manual-save (Ctrl+S)', () => {
  it('waits for forceSave to resolve before showing Salvato toast', async () => {
    const events = [];
    let resolveSave;
    const run = createManualSaveRunner({
      flushHistory: () => events.push('flushHistory'),
      showStatusBadge: (msg) => events.push(`badge:${msg}`),
      forceSave: () => new Promise((resolve) => {
        events.push('forceSave:start');
        resolveSave = resolve;
      }),
      showToast: (msg, icon) => events.push(`toast:${icon}:${msg}`)
    });

    const p = run();
    // Before forceSave finishes, toast MUST NOT have been shown
    assert.deepEqual(events, ['flushHistory', 'badge:Salvataggio...', 'forceSave:start']);

    resolveSave();
    const ok = await p;
    assert.equal(ok, true);
    assert.deepEqual(events, [
      'flushHistory',
      'badge:Salvataggio...',
      'forceSave:start',
      'toast:💾:Salvato'
    ]);
  });

  it('shows error toast and never shows Salvato when forceSave rejects', async () => {
    const toasts = [];
    const run = createManualSaveRunner({
      flushHistory: () => {},
      forceSave: () => Promise.reject(new Error('QuotaExceededError')),
      showToast: (msg, icon) => toasts.push({ msg, icon })
    });

    const ok = await run();
    assert.equal(ok, false);
    assert.deepEqual(toasts, [{ msg: 'Errore durante il salvataggio', icon: '⚠️' }]);
  });

  it('coalesces overlapping Ctrl+S presses while a save is already in flight', async () => {
    let calls = 0;
    let resolveSave;
    const run = createManualSaveRunner({
      flushHistory: () => {},
      forceSave: () => {
        calls++;
        return new Promise((resolve) => { resolveSave = resolve; });
      },
      showToast: () => {}
    });

    const p1 = run();
    const p2 = run();
    assert.equal(calls, 1);
    resolveSave();
    assert.equal(await p1, true);
    assert.equal(await p2, true);
  });
});
