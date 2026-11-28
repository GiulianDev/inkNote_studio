import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaExceededError, getDBStatus } from './db.js';

test('isQuotaExceededError recognizes standard DOM and Firefox/Safari quota errors', () => {
  assert.equal(isQuotaExceededError({ name: 'QuotaExceededError', message: 'Quota exceeded' }), true);
  assert.equal(isQuotaExceededError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true);
  assert.equal(isQuotaExceededError({ code: 22 }), true);
  assert.equal(isQuotaExceededError({ code: 1014 }), true);
  assert.equal(isQuotaExceededError(new Error('Storage quota exceeded while writing')), true);
  assert.equal(
    isQuotaExceededError(new Error('outer error', { cause: { name: 'QuotaExceededError' } })),
    true
  );
});

test('isQuotaExceededError ignores unrelated errors and nullish values', () => {
  assert.equal(isQuotaExceededError(null), false);
  assert.equal(isQuotaExceededError(undefined), false);
  assert.equal(isQuotaExceededError(new Error('Network timeout')), false);
  assert.equal(isQuotaExceededError({ name: 'NotFoundError', code: 8 }), false);
});

test('getDBStatus returns a snapshot copy of database readiness', () => {
  const status = getDBStatus();
  assert.equal(typeof status.ready, 'boolean');
  assert.equal(typeof status.blocked, 'boolean');
  assert.equal(typeof status.versionChanged, 'boolean');
  status.ready = !status.ready;
  assert.notEqual(getDBStatus().ready, status.ready);
});
