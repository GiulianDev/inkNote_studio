import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFolderPath,
  formatFolderPathLabel,
  getDescendantFolderIds,
  computeFolderCounts,
  buildFolderPreviewMap,
  formatFolderCountLabel,
  compareNotebooks,
  compareFolders,
  filterLibraryItems,
  generateDuplicateTitle,
  deepClone,
  buildFolderAncestorPath,
  collectNotebookIdsInSelection,
  collectSubtreeSummary,
  collectFoldersForExport,
  computeLibraryControlsVisibility
} from './library-helpers.js';

test('getFolderPath & formatFolderPathLabel build hierarchy and guard against cycles', () => {
  const folders = [
    { id: 'f1', name: 'Università', parentId: null },
    { id: 'f2', name: 'Fisica', parentId: 'f1' },
    { id: 'f3', name: 'Appunti', parentId: 'f2' },
    { id: 'cycA', name: 'Ciclo A', parentId: 'cycB' },
    { id: 'cycB', name: 'Ciclo B', parentId: 'cycA' }
  ];
  const map = new Map(folders.map(f => [f.id, f]));

  assert.deepEqual(getFolderPath('f3', map).map(f => f.id), ['f1', 'f2', 'f3']);
  assert.equal(formatFolderPathLabel('f3', map), 'Università / Fisica / Appunti');
  assert.equal(formatFolderPathLabel(null, map), 'Libreria');
  assert.equal(formatFolderPathLabel('missing', map), 'Libreria');

  const cycPath = getFolderPath('cycA', map);
  assert.equal(cycPath.length, 2);
});

test('getDescendantFolderIds collects self + nested children without infinite loop', () => {
  const folders = [
    { id: 'root', parentId: null },
    { id: 'child1', parentId: 'root' },
    { id: 'child2', parentId: 'root' },
    { id: 'grandchild', parentId: 'child1' },
    { id: 'other', parentId: null }
  ];
  const descendants = getDescendantFolderIds('root', folders);
  assert.deepEqual([...descendants].sort(), ['child1', 'child2', 'grandchild', 'root']);
  assert.equal(descendants.has('other'), false);
});

test('computeFolderCounts, buildFolderPreviewMap & formatFolderCountLabel', () => {
  const folders = [
    { id: 'f1', name: 'F1', parentId: null },
    { id: 'f2', name: 'F2', parentId: 'f1' },
    { id: 'f3', name: 'Empty', parentId: null }
  ];
  const notebooks = [
    { id: 'n1', title: 'N1', folderId: 'f1' },
    { id: 'n2', title: 'N2', folderId: 'f1' },
    { id: 'n3', title: 'N3', folderId: 'orphan' }
  ];
  const map = new Map(folders.map(f => [f.id, f]));

  const counts = computeFolderCounts(folders, notebooks, map);
  assert.deepEqual(counts.get('f1'), { subfolders: 1, notebooks: 2 });
  assert.deepEqual(counts.get('f3'), { subfolders: 0, notebooks: 0 });

  assert.equal(formatFolderCountLabel(counts.get('f1')), '1 raccolta · 2 quaderni');
  assert.equal(formatFolderCountLabel(counts.get('f3')), 'Vuota');

  const previews = buildFolderPreviewMap(folders, notebooks, map);
  assert.equal(previews.get('f1').notebooks.length, 2);
  assert.equal(previews.get('f1').subfolders.length, 1);
});

test('compareNotebooks & compareFolders sort correctly', () => {
  const nbs = [
    { id: '1', title: 'Beta', pageCount: 2, updatedAt: '2026-01-01T10:00:00Z' },
    { id: '2', title: 'Alfa', pageCount: 5, updatedAt: '2026-01-03T10:00:00Z' }
  ];
  const byTitleAsc = [...nbs].sort((a, b) => compareNotebooks(a, b, 'title', 'asc'));
  assert.deepEqual(byTitleAsc.map(n => n.id), ['2', '1']);

  const byPagesDesc = [...nbs].sort((a, b) => compareNotebooks(a, b, 'pageCount', 'desc'));
  assert.deepEqual(byPagesDesc.map(n => n.id), ['2', '1']);

  const counts = new Map([['f1', { subfolders: 0, notebooks: 1 }], ['f2', { subfolders: 1, notebooks: 3 }]]);
  const fSorted = [{ id: 'f1', name: 'Z' }, { id: 'f2', name: 'A' }]
    .sort((a, b) => compareFolders(a, b, 'pageCount', 'desc', counts));
  assert.deepEqual(fSorted.map(f => f.id), ['f2', 'f1']);
});

test('filterLibraryItems handles root, folder, favorites, and search modes', () => {
  const folders = [
    { id: 'f1', name: 'Scuola', parentId: null },
    { id: 'f2', name: 'Matematica', parentId: 'f1' }
  ];
  const notebooks = [
    { id: 'n1', title: 'Analisi 1', folderId: 'f1', isFavorite: true },
    { id: 'n2', title: 'Appunti sparsi', folderId: null, isFavorite: false },
    { id: 'n3', title: 'Disegni', folderId: 'missing', isFavorite: true }
  ];
  const map = new Map(folders.map(f => [f.id, f]));

  const rootItems = filterLibraryItems({ folders, notebooks, folderMap: map, currentFolderId: null });
  assert.deepEqual(rootItems.visibleFolders.map(f => f.id), ['f1']);
  assert.deepEqual(rootItems.visibleNotebooks.map(n => n.id), ['n2', 'n3']);

  const favItems = filterLibraryItems({ folders, notebooks, folderMap: map, currentFolderId: null, onlyFavorites: true });
  assert.equal(favItems.visibleFolders.length, 0);
  assert.deepEqual(favItems.visibleNotebooks.map(n => n.id), ['n1', 'n3']);

  const searchItems = filterLibraryItems({ folders, notebooks, folderMap: map, query: 'mate' });
  assert.deepEqual(searchItems.visibleFolders.map(f => f.id), ['f2']);
  assert.equal(searchItems.visibleNotebooks.length, 0);
});

test('generateDuplicateTitle & deepClone work accurately', () => {
  const existing = new Set(['note', 'note (2)']);
  assert.equal(generateDuplicateTitle('Note', existing), 'Note (3)');
  assert.equal(generateDuplicateTitle('Note (2)', existing), 'Note (3)');
  assert.equal(generateDuplicateTitle('', new Set()), 'Senza titolo (2)');

  const src = { a: 1, arr: [1, { b: 2 }], view: new Uint8Array([3, 4]) };
  const cloned = deepClone(src);
  assert.deepEqual(cloned, src);
  assert.notEqual(cloned.arr, src.arr);
  assert.notEqual(cloned.view, src.view);
});

test('collectNotebookIdsInSelection recursively expands selected folders without duplicates', () => {
  const folders = [
    { id: 'f1', name: 'Università', parentId: null, color: '#6366f1' },
    { id: 'f2', name: 'Fisica', parentId: 'f1', color: '#2563eb' },
    { id: 'f3', name: 'Personale', parentId: null, color: '#059669' }
  ];
  const notebooks = [
    { id: 'n1', title: 'Analisi', folderId: 'f1' },
    { id: 'n2', title: 'Meccanica', folderId: 'f2' },
    { id: 'n3', title: 'Diario', folderId: 'f3' },
    { id: 'n4', title: 'Loose', folderId: null }
  ];
  const map = new Map(folders.map(f => [f.id, f]));

  const ids = collectNotebookIdsInSelection({
    selectedNotebookIds: new Set(['n2', 'n4']),
    selectedFolderIds: new Set(['f1']),
    folders,
    notebooks
  });
  assert.deepEqual(ids, ['n1', 'n2', 'n4']);

  const fullPath = buildFolderAncestorPath('f2', map);
  assert.deepEqual(fullPath.map(p => p.name), ['Università', 'Fisica']);

  const scopedPath = buildFolderAncestorPath('f2', map, new Set(['f2']));
  assert.deepEqual(scopedPath.map(p => p.name), ['Fisica']);
});

test('collectSubtreeSummary & collectFoldersForExport include empty subfolders in parent-first order', () => {
  const folders = [
    { id: 'f_empty_sub', name: 'Vuota', parentId: 'f_child' },
    { id: 'f_child', name: 'Fisica', parentId: 'f_root' },
    { id: 'f_root', name: 'Università', parentId: null },
    { id: 'f_other', name: 'Altro', parentId: null }
  ];
  const notebooks = [
    { id: 'n1', title: 'Meccanica', folderId: 'f_child' },
    { id: 'n2', title: 'AltroQuaderno', folderId: 'f_other' }
  ];

  const summary = collectSubtreeSummary({ folderIds: ['f_root'], folders, notebooks });
  assert.equal(summary.subfolderCount, 2);
  assert.deepEqual(summary.nestedNotebooks.map(n => n.id), ['n1']);

  const exported = collectFoldersForExport({
    selectedFolderIds: new Set(['f_root']),
    notebooks: [notebooks[0]],
    folders
  });
  assert.deepEqual(exported.map(f => f.id), ['f_root', 'f_child', 'f_empty_sub']);
});

test('computeLibraryControlsVisibility hides on scroll down, reveals on scroll up, and prevents clamping bounce', () => {
  const base = {
    scrollHeight: 720,
    clientHeight: 500,
    controlsHeight: 108,
    nowMs: 1000,
    ignoreScrollUntilMs: 0
  };

  // Insufficient overflow stays visible so user is never trapped
  const shallow = computeLibraryControlsVisibility({
    ...base,
    scrollHeight: 530,
    scrollTop: 25,
    prevScrollTop: 10,
    currentlyHidden: false
  });
  assert.equal(shallow.hidden, false);

  // Small scroll near top stays visible
  const tiny = computeLibraryControlsVisibility({
    ...base,
    scrollTop: 20,
    prevScrollTop: 0,
    currentlyHidden: false
  });
  assert.equal(tiny.hidden, false);

  // Downward scroll past thresholds hides bar and sets transition lock
  const hideRes = computeLibraryControlsVisibility({
    ...base,
    scrollTop: 48,
    prevScrollTop: 20,
    accumulatedDelta: 10,
    currentlyHidden: false
  });
  assert.equal(hideRes.hidden, true);
  assert.equal(hideRes.changed, true);
  assert.ok(hideRes.ignoreScrollUntilMs > 1000);

  // Brief debounce lock after toggling absorbs jitter without bounce
  const clamped = computeLibraryControlsVisibility({
    ...base,
    scrollTop: 20,
    prevScrollTop: 48,
    currentlyHidden: true,
    nowMs: 1040,
    ignoreScrollUntilMs: hideRes.ignoreScrollUntilMs
  });
  assert.equal(clamped.hidden, true);
  assert.equal(clamped.changed, false);

  // After transition lock, upward scroll beyond showDelta reveals bar
  const revealRes = computeLibraryControlsVisibility({
    ...base,
    clientHeight: 608,
    scrollTop: 55,
    prevScrollTop: 80,
    currentlyHidden: true,
    nowMs: 1500,
    ignoreScrollUntilMs: hideRes.ignoreScrollUntilMs
  });
  assert.equal(revealRes.hidden, false);
  assert.equal(revealRes.changed, true);

  // forceVisible immediately restores bar
  const forced = computeLibraryControlsVisibility({
    ...base,
    scrollTop: 120,
    prevScrollTop: 120,
    currentlyHidden: true,
    forceVisible: true,
    nowMs: 2000
  });
  assert.equal(forced.hidden, false);
  assert.equal(forced.changed, true);

  // Collapsing overflow (e.g. items deleted while hidden) reveals bar
  const noLongerOverflowing = computeLibraryControlsVisibility({
    ...base,
    scrollHeight: 500,
    clientHeight: 608,
    scrollTop: 0,
    prevScrollTop: 40,
    currentlyHidden: true,
    nowMs: 2000
  });
  assert.equal(noLongerOverflowing.hidden, false);
  assert.equal(noLongerOverflowing.changed, true);
});

