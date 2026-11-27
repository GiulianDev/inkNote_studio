import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeToolbarSettingsForCloud,
  sanitizeCloudFolderPayload,
  sanitizeCloudNotebookPayload,
  computeFolderMetaSignature,
  computeNotebookMetaSignature,
  sortFoldersParentFirst,
  reconcileSyncSets,
  sha256Uint8Array,
  loadLocalTombstones,
  recordLocalDeletion,
  clearLocalDeletion,
  loadUserSyncState,
  saveUserSyncState,
  loadDailySyncUsage,
  recordDailySyncUsage,
  formatBytesCompact
} from './sync-helpers.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

test('sanitizeToolbarSettingsForCloud strips undefined and preserves paperColor/patternColor', () => {
  const cleaned = sanitizeToolbarSettingsForCloud({
    activeTool: 'pen',
    paperColor: '#ABC',
    patternColor: null,
    tools: {
      pen: { color: '#112233', width: 5, opacity: undefined, style: 'dashed' }
    },
    text: { fontFamily: 'mono', fontSize: 99, color: undefined },
    smoothing: 75,
    extraUnknownProp: 'should_not_leak',
    compactMode: true
  });

  assert.equal(cleaned.activeTool, 'pen');
  assert.equal(cleaned.paperColor, '#aabbcc');
  assert.equal(cleaned.patternColor, null);
  assert.equal(cleaned.tools.pen.color, '#112233');
  assert.equal(cleaned.tools.pen.opacity, 1.0);
  assert.equal(cleaned.tools.pen.style, 'dashed');
  assert.equal(cleaned.text.fontFamily, 'mono');
  assert.equal(cleaned.text.fontSize, 72);
  assert.equal(cleaned.text.color, '#000000');
  assert.equal(cleaned.compactMode, false);
  assert.equal('extraUnknownProp' in cleaned, false);

  const json = JSON.stringify(cleaned);
  assert.equal(json.includes('undefined'), false);
  assert.ok(Object.keys(cleaned).length <= 40);
});

test('sanitizeCloudNotebookPayload and sanitizeCloudFolderPayload enforce schema limits', () => {
  const folder = sanitizeCloudFolderPayload({
    folder: {
      id: 'fl_1',
      name: '  Appunti Università  ',
      parentId: 'fl_1', // self-parenting ignored
      color: '#ff00aa',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-02T10:00:00.000Z'
    },
    ownerUid: 'user_abc'
  });
  assert.equal(folder.parentId, '');
  assert.equal(folder.name, 'Appunti Università');
  assert.equal(folder.color, '#ff00aa');
  assert.equal(folder.deleted, false);

  const nb = sanitizeCloudNotebookPayload({
    notebook: {
      id: 'nb_1',
      title: '',
      coverColor: 'invalid',
      pattern: 'grid',
      folderId: null,
      isFavorite: 1,
      pageOrder: ['pg_a', 'pg_a', 'pg_b', 'bad id!'],
      lastPageIndex: 99,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-02T10:00:00.000Z'
    },
    ownerUid: 'user_abc'
  });
  assert.equal(nb.title, 'Quaderno senza titolo');
  assert.equal(nb.coverColor, '#4f46e5');
  assert.equal(nb.pattern, 'grid');
  assert.equal(nb.folderId, '');
  assert.equal(nb.isFavorite, true);
  assert.deepEqual(nb.pageOrder, ['pg_a', 'pg_b']);
  assert.equal(nb.pageCount, 2);
  assert.equal(nb.lastPageIndex, 1);

  const deletedNb = sanitizeCloudNotebookPayload({
    notebookId: 'nb_1',
    ownerUid: 'user_abc',
    deleted: true,
    deletedAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });
  assert.equal(deletedNb.deleted, true);
  assert.deepEqual(deletedNb.pageOrder, []);
  assert.equal(deletedNb.pageCount, 0);
  assert.equal(deletedNb.lastPageIndex, 0);
});

test('sortFoldersParentFirst orders ancestors before descendants', () => {
  const sorted = sortFoldersParentFirst([
    { id: 'f_grandchild', parentId: 'f_child' },
    { id: 'f_child', parentId: 'f_root' },
    { id: 'f_root', parentId: null }
  ]);
  assert.deepEqual(sorted.map(f => f.id), ['f_root', 'f_child', 'f_grandchild']);
});

test('reconcileSyncSets handles upload, download, tombstones, metadata signatures, and conflicts', () => {
  const t1 = Date.parse('2026-11-10T10:00:00.000Z');
  const t2 = Date.parse('2026-11-10T11:00:00.000Z');
  const t3 = Date.parse('2026-11-10T12:00:00.000Z');

  const localNbMetaOnly = {
    id: 'nb_meta',
    title: 'Stesso',
    isFavorite: true, // toggled locally without bumping updatedAt!
    updatedAt: new Date(t1).toISOString(),
    lastEditAt: new Date(t1).toISOString()
  };
  const cloudNbMetaOnly = {
    id: 'nb_meta',
    title: 'Stesso',
    isFavorite: false,
    deleted: false,
    clientUpdatedAt: new Date(t1).toISOString(),
    updatedAt: t1
  };

  const prevMetaSig = computeNotebookMetaSignature({ ...localNbMetaOnly, isFavorite: false });
  const prevCloudSig = computeNotebookMetaSignature(cloudNbMetaOnly);

  const actions = reconcileSyncSets({
    localItems: [
      { id: 'nb_local_only', title: 'Nuovo locale', updatedAt: new Date(t2).toISOString() },
      { id: 'nb_synced', title: 'Uguale', updatedAt: new Date(t1).toISOString() },
      localNbMetaOnly,
      { id: 'nb_conflict', title: 'Locale mod', updatedAt: new Date(t3).toISOString() },
      { id: 'nb_cloud_del', title: 'Non toccato', updatedAt: new Date(t1).toISOString() },
      { id: 'nb_cloud_del_conflict', title: 'Editato offline', updatedAt: new Date(t3).toISOString() },
      { id: 'nb_first_same', title: 'Identico', coverColor: '#123456', pattern: 'ruled', updatedAt: new Date(t1).toISOString() }
    ],
    cloudItems: [
      { id: 'nb_cloud_only', title: 'Nuovo cloud', deleted: false, clientUpdatedAt: new Date(t2).toISOString(), updatedAt: t2 },
      { id: 'nb_synced', title: 'Uguale', deleted: false, clientUpdatedAt: new Date(t1).toISOString(), updatedAt: t1 },
      cloudNbMetaOnly,
      { id: 'nb_conflict', title: 'Cloud mod', deleted: false, clientUpdatedAt: new Date(t2).toISOString(), updatedAt: t2 },
      { id: 'nb_cloud_del', title: 'Eliminato', deleted: true, clientUpdatedAt: new Date(t2).toISOString(), updatedAt: t2 },
      { id: 'nb_cloud_del_conflict', title: 'Eliminato', deleted: true, clientUpdatedAt: new Date(t2).toISOString(), updatedAt: t2 },
      { id: 'nb_del_loc', title: 'Da eliminare cloud', deleted: false, clientUpdatedAt: new Date(t1).toISOString(), updatedAt: t1 },
      { id: 'nb_del_loc_conflict', title: 'Modificato altrove', deleted: false, clientUpdatedAt: new Date(t3).toISOString(), updatedAt: t3 },
      { id: 'nb_first_same', title: 'Identico', coverColor: '#123456', pattern: 'ruled', deleted: false, clientUpdatedAt: new Date(t1).toISOString(), updatedAt: t1 }
    ],
    localTombstones: {
      nb_del_loc: t2,
      nb_del_loc_conflict: t2,
      nb_stale: t1
    },
    lastSyncMap: {
      nb_synced: { localUpdatedMs: t1, cloudServerUpdatedMs: t1, localMetaSignature: computeNotebookMetaSignature({ id: 'nb_synced', title: 'Uguale' }), cloudMetaSignature: computeNotebookMetaSignature({ id: 'nb_synced', title: 'Uguale' }) },
      nb_meta: { localUpdatedMs: t1, cloudServerUpdatedMs: t1, localMetaSignature: prevMetaSig, cloudMetaSignature: prevCloudSig },
      nb_conflict: { localUpdatedMs: t1, cloudServerUpdatedMs: t1 },
      nb_cloud_del: { localUpdatedMs: t1, cloudServerUpdatedMs: t1 },
      nb_cloud_del_conflict: { localUpdatedMs: t1, cloudServerUpdatedMs: t1 },
      nb_del_loc: { localUpdatedMs: t1, cloudServerUpdatedMs: t1 },
      nb_del_loc_conflict: { localUpdatedMs: t1, cloudServerUpdatedMs: t1 }
    },
    getLocalSignature: computeNotebookMetaSignature,
    getCloudSignature: computeNotebookMetaSignature
  });

  const byId = new Map(actions.map(a => [a.id, a]));
  assert.equal(byId.get('nb_local_only').action, 'upload');
  assert.equal(byId.get('nb_cloud_only').action, 'download');
  assert.equal(byId.get('nb_synced').action, 'noop');
  assert.equal(byId.get('nb_meta').action, 'upload');
  assert.equal(byId.get('nb_conflict').action, 'conflict');
  assert.equal(byId.get('nb_conflict').reason, 'both_modified');
  assert.equal(byId.get('nb_cloud_del').action, 'delete_local');
  assert.equal(byId.get('nb_cloud_del_conflict').action, 'conflict');
  assert.equal(byId.get('nb_cloud_del_conflict').reason, 'modified_locally_deleted_cloud');
  assert.equal(byId.get('nb_del_loc').action, 'delete_cloud');
  assert.equal(byId.get('nb_del_loc_conflict').action, 'conflict');
  assert.equal(byId.get('nb_del_loc_conflict').reason, 'deleted_locally_modified_cloud');
  assert.equal(byId.get('nb_first_same').action, 'noop');
  assert.equal(byId.get('nb_stale').action, 'noop');
  assert.equal(byId.get('nb_stale').clearTombstone, true);
});

test('local tombstones, sync state, daily usage, sha256, and formatting work deterministically', async () => {
  const storage = createMemoryStorage();

  recordLocalDeletion('notebooks', 'nb_1', 1700000000000, storage);
  recordLocalDeletion('folders', 'fl_1', 1700000005000, storage);
  let tombs = loadLocalTombstones(storage);
  assert.equal(tombs.notebooks.nb_1, 1700000000000);
  assert.equal(tombs.folders.fl_1, 1700000005000);

  clearLocalDeletion('notebooks', 'nb_1', storage);
  tombs = loadLocalTombstones(storage);
  assert.equal('nb_1' in tombs.notebooks, false);

  saveUserSyncState('uid_1', {
    lastSyncAt: '2026-11-27T12:00:00.000Z',
    folders: { fl_2: { localUpdatedMs: 100 } },
    notebooks: { nb_2: { localUpdatedMs: 200 } }
  }, storage);
  const loadedState = loadUserSyncState('uid_1', storage);
  assert.equal(loadedState.lastSyncAt, '2026-11-27T12:00:00.000Z');
  assert.equal(loadedState.notebooks.nb_2.localUpdatedMs, 200);

  recordDailySyncUsage('uid_1', { syncCount: 1, bytesUploaded: 2048, readsApprox: 5, writesApprox: 2 }, '2026-11-27', storage);
  const day1 = recordDailySyncUsage('uid_1', { syncCount: 1, bytesDownloaded: 4096, readsApprox: 3 }, '2026-11-27', storage);
  assert.equal(day1.syncCount, 2);
  assert.equal(day1.bytesUploaded, 2048);
  assert.equal(day1.bytesDownloaded, 4096);
  assert.equal(day1.readsApprox, 8);
  assert.equal(day1.writesApprox, 2);

  // Nuovo giorno azzera automaticamente i contatori giornalieri
  const day2 = loadDailySyncUsage('uid_1', '2026-11-28', storage);
  assert.equal(day2.syncCount, 0);
  assert.equal(day2.bytesUploaded, 0);

  const hash = await sha256Uint8Array(new Uint8Array([1, 2, 3, 4]));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(formatBytesCompact(512), '512 B');
  assert.equal(formatBytesCompact(1536), '1.5 KB');
  assert.equal(formatBytesCompact(2 * 1024 * 1024), '2.00 MB');

  assert.notEqual(
    computeFolderMetaSignature({ id: 'f1', name: 'A', color: '#111111' }),
    computeFolderMetaSignature({ id: 'f1', name: 'B', color: '#111111' })
  );
});
