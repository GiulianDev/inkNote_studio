import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUG_COOLDOWN_MS,
  BUG_DESC_MAX_LENGTH,
  BUG_DESC_MIN_LENGTH,
  BUG_MAX_PER_DAY,
  buildBugFirestorePayload,
  classifyBugSubmitError,
  evaluateClientAntiSpam,
  formatCooldownWait,
  hashBugText,
  validateBugDescription,
  writeBugGuardHistory
} from './bug-report-helpers.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    }
  };
}

describe('bug-report-service anti-spam & payload builder', () => {
  it('enforces min and max description length', () => {
    const shortRes = validateBugDescription('troppocorto');
    assert.equal(shortRes.ok, false);
    assert.equal(shortRes.reason, 'too_short');

    const okRes = validateBugDescription('Il lazo perde la selezione dopo un doppio tap.');
    assert.equal(okRes.ok, true);

    const longRes = validateBugDescription('a'.repeat(BUG_DESC_MAX_LENGTH + 1));
    assert.equal(longRes.ok, false);
    assert.equal(longRes.reason, 'too_long');
  });

  it('blocks honeypot, too-fast submissions, cooldown, duplicates, and 24h cap', () => {
    const storage = createMemoryStorage();
    const t0 = 1_700_000_000_000;
    const validText = 'Segnalazione dettagliata su errore esportazione PDF.';

    const hp = evaluateClientAntiSpam({
      description: validText,
      honeypotValue: 'http://spam.example',
      panelOpenedAt: t0 - 5000,
      now: t0,
      storage
    });
    assert.equal(hp.ok, false);
    assert.equal(hp.code, 'honeypot');

    const fast = evaluateClientAntiSpam({
      description: validText,
      honeypotValue: '',
      panelOpenedAt: t0 - 500,
      now: t0,
      storage
    });
    assert.equal(fast.ok, false);
    assert.equal(fast.code, 'too_fast');

    const allowed = evaluateClientAntiSpam({
      description: validText,
      honeypotValue: '',
      panelOpenedAt: t0 - 4000,
      now: t0,
      storage
    });
    assert.equal(allowed.ok, true);

    writeBugGuardHistory({
      timestamps: [t0],
      lastTextHash: hashBugText(validText)
    }, storage);

    const cooldown = evaluateClientAntiSpam({
      description: 'Altro problema diverso rispetto al precedente report.',
      panelOpenedAt: t0,
      now: t0 + 60_000,
      storage
    });
    assert.equal(cooldown.ok, false);
    assert.equal(cooldown.code, 'cooldown');
    assert.ok(cooldown.waitMs > 0);

    const dup = evaluateClientAntiSpam({
      description: '   segnalazione   dettagliata su errore esportazione pdf.  ',
      panelOpenedAt: t0,
      now: t0 + BUG_COOLDOWN_MS + 1000,
      storage
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'duplicate');

    writeBugGuardHistory({
      timestamps: [
        t0,
        t0 + BUG_COOLDOWN_MS + 1000,
        t0 + (BUG_COOLDOWN_MS * 2) + 2000
      ],
      lastTextHash: hashBugText('altri report')
    }, storage);

    const daily = evaluateClientAntiSpam({
      description: 'Quarta segnalazione diversa nella stessa giornata.',
      panelOpenedAt: t0,
      now: t0 + (BUG_COOLDOWN_MS * 4),
      storage
    });
    assert.equal(daily.ok, false);
    assert.equal(daily.code, 'daily_limit');
    assert.equal(BUG_MAX_PER_DAY, 3);
  });

  it('builds a schema-compliant Firestore payload without PII', () => {
    const payload = buildBugFirestorePayload({
      reportId: 'bug_123456',
      user: { uid: 'anon_abc', isAnonymous: true },
      description: 'Il tratto della penna trema quando si zooma oltre il 200%.',
      diagnostics: {
        version: '0.1.2',
        builtAt: '2026-11-26',
        os: 'iPadOS',
        viewportClass: 'tablet',
        viewport: '1024x768',
        dpr: 2,
        theme: 'scuro',
        notebooksCount: 'n/d',
        userAgent: 'Mozilla/5.0'
      }
    });

    assert.equal(payload.id, 'bug_123456');
    assert.equal(payload.reporterUid, 'anon_abc');
    assert.equal(payload.isAnonymous, true);
    assert.equal(payload.notebooksCount, -1);
    assert.equal(payload.status, 'new');
    assert.equal('email' in payload, false);
    assert.ok(payload.description.length >= BUG_DESC_MIN_LENGTH);
  });

  it('formats cooldown times and classifies Firebase error codes cleanly', () => {
    assert.equal(formatCooldownWait(45_000), '45 sec');
    assert.equal(formatCooldownWait(125_000), '2 min 5 sec');
    assert.match(classifyBugSubmitError({ code: 'auth/admin-restricted-operation' }), /Anonymous Auth/i);
    assert.match(classifyBugSubmitError({ code: 'permission-denied' }, 'rules-check'), /firestore\.rules/i);
    assert.match(classifyBugSubmitError({ code: 'permission-denied' }, 'commit'), /5 minuti/i);
  });
});
