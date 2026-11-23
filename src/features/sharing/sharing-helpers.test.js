import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_TTL_MS,
  normalizeEmail,
  isValidEmailFormat,
  normalizeHandle,
  isValidHandle,
  suggestHandleFromUser,
  sanitizePhotoUrl,
  hashNormalizedEmail,
  splitBytesToBase64Chunks,
  reassembleBase64Chunks,
  computeTransferExpirationMs,
  isTransferExpired,
  formatRemainingTime,
  classifyInboxTransfers,
  classifyOutgoingTransfers,
  MAX_OUTGOING_TRANSFERS,
  checkOutgoingTransferQuota,
  extractGoogleContactCandidates,
  buildUniqueReceivedTitle,
  parseInviteHandleFromUrl,
  classifyPeopleApiError,
  formatAuthErrorMessage
} from './sharing-helpers.js';

test('normalizeEmail & isValidEmailFormat normalize and validate emails cleanly', () => {
  assert.equal(normalizeEmail('  Mario.Rossi@Example.COM '), 'mario.rossi@example.com');
  assert.equal(isValidEmailFormat('mario@example.com'), true);
  assert.equal(isValidEmailFormat('not-an-email'), false);
  assert.equal(isValidEmailFormat(''), false);
});

test('normalizeHandle, isValidHandle & suggestHandleFromUser enforce strict rules', () => {
  assert.equal(normalizeHandle(' @Mario_Rossi! '), 'mario_rossi');
  assert.equal(isValidHandle('mario_99'), true);
  assert.equal(isValidHandle('ab'), false);
  assert.equal(isValidHandle('Bad-Handle'), false);

  const suggested = suggestHandleFromUser({
    uid: 'abcDEF1234',
    email: 'Giulia.Verdi@gmail.com',
    displayName: 'Giulia Verdi'
  });
  assert.equal(isValidHandle(suggested), true);
  assert.ok(suggested.startsWith('giulia_verdi_'));
});

test('sanitizePhotoUrl permits only safe https URLs up to 500 chars', () => {
  assert.equal(sanitizePhotoUrl('https://lh3.googleusercontent.com/a/avatar'), 'https://lh3.googleusercontent.com/a/avatar');
  assert.equal(sanitizePhotoUrl('http://insecure.example.com/a.png'), '');
  assert.equal(sanitizePhotoUrl('javascript:alert(1)'), '');
  assert.equal(sanitizePhotoUrl('https://example.com/' + 'a'.repeat(500)), '');
});

test('hashNormalizedEmail generates deterministic 64-char SHA-256 hex regardless of case/spaces', async () => {
  const h1 = await hashNormalizedEmail('  Alice@Example.com ');
  const h2 = await hashNormalizedEmail('alice@example.com');
  assert.equal(h1.length, 64);
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
  assert.equal(await hashNormalizedEmail('invalid'), '');
});

test('splitBytesToBase64Chunks & reassembleBase64Chunks round-trip arbitrary binary payloads', () => {
  const payload = new Uint8Array(5000);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (i * 37) & 0xff;
  }

  const chunks = splitBytesToBase64Chunks(payload, 1024);
  assert.equal(chunks.length, 5);
  assert.deepEqual(chunks.map(c => c.index), [0, 1, 2, 3, 4]);

  // Deliberately shuffle before reassembling
  const shuffled = [chunks[3], chunks[0], chunks[4], chunks[1], chunks[2]];
  const restored = reassembleBase64Chunks(shuffled);
  assert.deepEqual(restored, payload);
});

test('reassembleBase64Chunks throws on missing chunk', () => {
  const payload = new Uint8Array(2500);
  const chunks = splitBytesToBase64Chunks(payload, 1024);
  assert.throws(() => reassembleBase64Chunks([chunks[0], chunks[2]]), /Frammento 1 mancante/);
});

test('24h expiration helpers compute and format remaining TTL accurately', () => {
  const now = 1_700_000_000_000;
  const exp = computeTransferExpirationMs(now);
  assert.equal(exp - now, TRANSFER_TTL_MS);

  assert.equal(isTransferExpired({ expiresAt: exp }, now + TRANSFER_TTL_MS - 1), false);
  assert.equal(isTransferExpired({ expiresAt: exp }, now + TRANSFER_TTL_MS), true);
  assert.equal(isTransferExpired({ expiresAt: { toMillis: () => exp } }, now + TRANSFER_TTL_MS + 5000), true);

  assert.equal(formatRemainingTime(exp, now + 65 * 60 * 1000), '22h 55m');
  assert.equal(formatRemainingTime(exp, now + TRANSFER_TTL_MS - 15 * 60 * 1000), '15m');
  assert.equal(formatRemainingTime(exp, now + TRANSFER_TTL_MS + 1), 'Scaduto');
});

test('classifyInboxTransfers & classifyOutgoingTransfers isolate active vs expired/completed', () => {
  const now = 1_700_000_000_000;
  const inbox = [
    { id: 't1', status: 'pending', createdAt: now - 1000, expiresAt: now + 3600_000 },
    { id: 't2', status: 'pending', createdAt: now - 90000_000, expiresAt: now - 1000 },
    { id: 't3', status: 'uploading', createdAt: now - 500, expiresAt: now + 3600_000 },
    { id: 't4', status: 'imported', createdAt: now - 2000, expiresAt: now + 3600_000 },
    { id: 't5', status: 'pending', createdAt: now - 500, expiresAt: now + 7200_000 }
  ];

  const classifiedInbox = classifyInboxTransfers(inbox, now);
  assert.deepEqual(classifiedInbox.activePending.map(t => t.id), ['t5', 't1']);
  assert.deepEqual(classifiedInbox.expiredIds, ['t2', 't4']);

  const outgoing = [
    { id: 'o1', status: 'pending', createdAt: now - 1000, expiresAt: now + 10000 },
    { id: 'o2', status: 'pending', createdAt: now - 90000_000, expiresAt: now - 50 },
    { id: 'o3', status: 'uploading', createdAt: now - 20 * 60 * 1000, expiresAt: now + 10000 },
    { id: 'o4', status: 'uploading', createdAt: now - 30_000, expiresAt: now + 10000 }
  ];
  const classifiedOut = classifyOutgoingTransfers(outgoing, now);
  assert.deepEqual(classifiedOut.activeSent.map(t => t.id), ['o1']);
  assert.deepEqual(classifiedOut.cleanupIds, ['o2', 'o3']);
});

test('extractGoogleContactCandidates deduplicates emails and filters invalid/default photos', () => {
  const candidates = extractGoogleContactCandidates([
    {
      names: [{ displayName: 'Marco Bianchi' }],
      emailAddresses: [{ value: 'Marco@Example.com' }, { value: 'marco@example.com' }],
      photos: [{ url: 'https://lh3.googleusercontent.com/photo', default: false }]
    },
    {
      names: [{ displayName: 'Senza Email' }],
      emailAddresses: []
    },
    {
      names: [{ displayName: 'Foto Default' }],
      emailAddresses: [{ value: 'luca@example.com' }],
      photos: [{ url: 'https://lh3.googleusercontent.com/default', default: true }]
    }
  ]);

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].email, 'marco@example.com');
  assert.equal(candidates[0].photoURL, 'https://lh3.googleusercontent.com/photo');
  assert.equal(candidates[1].email, 'luca@example.com');
  assert.equal(candidates[1].photoURL, '');
});

test('buildUniqueReceivedTitle & parseInviteHandleFromUrl behave predictably', () => {
  assert.equal(buildUniqueReceivedTitle('Analisi 1', ['Storia', 'Analisi 1']), 'Analisi 1 (2)');
  assert.equal(buildUniqueReceivedTitle('Analisi 1', ['Analisi 1', 'analisi 1 (2)']), 'Analisi 1 (3)');
  assert.equal(buildUniqueReceivedTitle('Fisica', ['Chimica']), 'Fisica');

  assert.equal(parseInviteHandleFromUrl('?addFriend=@Mario_99'), 'mario_99');
  assert.equal(parseInviteHandleFromUrl('?addFriend=x'), '');
});

test('checkOutgoingTransferQuota enforces simultaneous outgoing transfer limit of 10', () => {
  assert.equal(MAX_OUTGOING_TRANSFERS, 10);

  const empty = checkOutgoingTransferQuota([], 1);
  assert.deepEqual(empty, { allowed: true, currentCount: 0, requested: 1, remaining: 10, limit: 10 });

  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}` }));
  assert.deepEqual(checkOutgoingTransferQuota(eight, 2), {
    allowed: true,
    currentCount: 8,
    requested: 2,
    remaining: 2,
    limit: 10
  });
  assert.deepEqual(checkOutgoingTransferQuota(eight, 3), {
    allowed: false,
    currentCount: 8,
    requested: 3,
    remaining: 2,
    limit: 10
  });

  const full = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` }));
  assert.deepEqual(checkOutgoingTransferQuota(full, 1), {
    allowed: false,
    currentCount: 10,
    requested: 1,
    remaining: 0,
    limit: 10
  });
});

test('classifyPeopleApiError distinguishes disabled API, missing scope, 401 expiry, and other errors', () => {
  const disabled = classifyPeopleApiError(403, {
    error: {
      code: 403,
      message: 'People API has not been used in project 123 before or it is disabled.',
      details: [{ reason: 'SERVICE_DISABLED' }]
    }
  }, 'my-proj');
  assert.equal(disabled.kind, 'api_disabled');
  assert.equal(disabled.retryableWithRefresh, false);
  assert.match(disabled.message, /People API non abilitata.*my-proj/);

  const scopeMissing = classifyPeopleApiError(403, {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }]
    }
  });
  assert.equal(scopeMissing.kind, 'scope_missing');
  assert.equal(scopeMissing.retryableWithRefresh, true);
  assert.match(scopeMissing.message, /spunta la casella dei contatti/);

  const unauth = classifyPeopleApiError(401, {
    error: { code: 401, status: 'UNAUTHENTICATED', message: 'Invalid Credentials' }
  });
  assert.equal(unauth.kind, 'unauthenticated');
  assert.equal(unauth.retryableWithRefresh, true);

  const serverErr = classifyPeopleApiError(500, { error: { message: 'Backend down' } });
  assert.equal(serverErr.kind, 'other');
  assert.equal(serverErr.retryableWithRefresh, false);
  assert.match(serverErr.message, /500.*Backend down/);
});

test('formatAuthErrorMessage converts Firebase Auth popup/account codes cleanly', () => {
  assert.match(formatAuthErrorMessage({ code: 'auth/popup-closed-by-user' }), /annullata/);
  assert.match(formatAuthErrorMessage({ code: 'auth/user-mismatch' }), /account Google diverso/);
  assert.match(formatAuthErrorMessage({ code: 'auth/popup-blocked' }), /Popup bloccato/);
  assert.equal(formatAuthErrorMessage(new Error('Generic error')), '');
});

