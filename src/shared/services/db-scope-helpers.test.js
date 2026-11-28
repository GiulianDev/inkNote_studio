import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOwnerUid,
  getRecordOwnerUid,
  belongsToOwner,
  filterRecordsByOwner,
  resolveStampedOwnerUid,
  summarizeGuestLibraryRecords,
  computeGuestClaimSignature,
  shouldPromptGuestClaim,
  resolveCollisionSafeId
} from './db-scope-helpers.js';

test('normalizeOwnerUid, getRecordOwnerUid, belongsToOwner and filterRecordsByOwner isolate owners cleanly', () => {
  assert.equal(normalizeOwnerUid(null), null);
  assert.equal(normalizeOwnerUid(undefined), null);
  assert.equal(normalizeOwnerUid('   '), null);
  assert.equal(normalizeOwnerUid(' uid_a '), 'uid_a');

  const records = [
    { id: 'nb_legacy' },
    { id: 'nb_guest', ownerUid: null },
    { id: 'nb_a1', ownerUid: 'uid_a' },
    { id: 'nb_b1', ownerUid: 'uid_b' }
  ];

  assert.equal(getRecordOwnerUid(records[0]), null);
  assert.equal(belongsToOwner(records[0], null), true);
  assert.equal(belongsToOwner(records[2], 'uid_a'), true);
  assert.equal(belongsToOwner(records[2], null), false);

  assert.deepEqual(
    filterRecordsByOwner(records, null).map(r => r.id),
    ['nb_legacy', 'nb_guest']
  );
  assert.deepEqual(
    filterRecordsByOwner(records, 'uid_a').map(r => r.id),
    ['nb_a1']
  );
  assert.deepEqual(
    filterRecordsByOwner(records, 'uid_b').map(r => r.id),
    ['nb_b1']
  );
  assert.deepEqual(
    filterRecordsByOwner(records, 'uid_c').map(r => r.id),
    []
  );
});

test('resolveStampedOwnerUid preserves existing ownerUid across writes and stamps active owner on creation', () => {
  assert.equal(
    resolveStampedOwnerUid({
      existingRecord: { id: 'nb_1', ownerUid: 'uid_a' },
      incomingRecord: { id: 'nb_1', ownerUid: 'uid_b' },
      activeOwnerUid: 'uid_b'
    }),
    'uid_a'
  );

  assert.equal(
    resolveStampedOwnerUid({
      existingRecord: { id: 'nb_legacy' },
      incomingRecord: { id: 'nb_legacy' },
      activeOwnerUid: 'uid_a'
    }),
    null
  );

  assert.equal(
    resolveStampedOwnerUid({
      existingRecord: null,
      incomingRecord: { id: 'nb_new' },
      activeOwnerUid: 'uid_a'
    }),
    'uid_a'
  );

  assert.equal(
    resolveStampedOwnerUid({
      existingRecord: null,
      incomingRecord: { id: 'nb_guest_explicit', ownerUid: null },
      activeOwnerUid: 'uid_a'
    }),
    null
  );
});

test('summarizeGuestLibraryRecords, computeGuestClaimSignature and shouldPromptGuestClaim handle login guest prompt flow', () => {
  const notebooks = [
    { id: 'nb_g1', ownerUid: null },
    { id: 'nb_g2' },
    { id: 'nb_a1', ownerUid: 'uid_a' }
  ];
  const folders = [
    { id: 'fl_g1', ownerUid: null },
    { id: 'fl_b1', ownerUid: 'uid_b' }
  ];

  const summary = summarizeGuestLibraryRecords({ notebooks, folders });
  assert.equal(summary.notebooksCount, 2);
  assert.equal(summary.foldersCount, 1);
  assert.equal(summary.hasGuestItems, true);

  const sig1 = computeGuestClaimSignature({ notebooks, folders });
  assert.equal(sig1, 'nb:nb_g1,nb_g2|fld:fl_g1');

  // Reordering does not alter signature
  const sigReordered = computeGuestClaimSignature({
    notebooks: [notebooks[1], notebooks[2], notebooks[0]],
    folders: [folders[1], folders[0]]
  });
  assert.equal(sigReordered, sig1);

  assert.equal(shouldPromptGuestClaim({
    uid: null,
    guestSummary: summary,
    signature: sig1,
    dismissedSignature: ''
  }), false);

  assert.equal(shouldPromptGuestClaim({
    uid: 'uid_a',
    guestSummary: summary,
    signature: sig1,
    dismissedSignature: ''
  }), true);

  assert.equal(shouldPromptGuestClaim({
    uid: 'uid_a',
    guestSummary: summary,
    signature: sig1,
    dismissedSignature: sig1
  }), false);

  // Adding a new guest notebook later changes signature -> re-prompts on login
  const sigNewGuest = computeGuestClaimSignature({
    notebooks: [...notebooks, { id: 'nb_g3', ownerUid: null }],
    folders
  });
  assert.notEqual(sigNewGuest, sig1);
  assert.equal(shouldPromptGuestClaim({
    uid: 'uid_a',
    guestSummary: summary,
    signature: sigNewGuest,
    dismissedSignature: sig1
  }), true);
});

test('resolveCollisionSafeId avoids overwriting IDs owned by another user', () => {
  const used = new Set(['nb_shared', 'fld_1']);
  assert.equal(resolveCollisionSafeId('nb_free', used, 'nb_'), 'nb_free');
  const remapped = resolveCollisionSafeId('nb_shared', used, 'nb_');
  assert.notEqual(remapped, 'nb_shared');
  assert.ok(remapped.startsWith('nb_'));
});
