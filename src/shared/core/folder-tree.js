// ============================================================
// GERARCHIA CARTELLE — HELPER PURI (zero DOM, zero state)
// Condivisi tra backup export/import e libreria.
// ============================================================

/**
 * Restituisce il percorso dalla radice fino a `folderId` (sicuro contro cicli).
 */
export function getFolderPath(folderId, folderMap) {
  const path = [];
  const visited = new Set();
  let curId = folderId;
  while (curId && !visited.has(curId)) {
    const f = folderMap.get(curId);
    if (!f) break;
    visited.add(curId);
    path.unshift(f);
    curId = f.parentId || null;
  }
  return path;
}

/**
 * Restituisce l'insieme degli ID di una cartella e di tutte le sue discendenti.
 */
export function getDescendantFolderIds(rootFolderId, folders) {
  const excluded = new Set([rootFolderId]);
  const queue = [rootFolderId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const f of folders) {
      if (f && (f.parentId || null) === cur && !excluded.has(f.id)) {
        excluded.add(f.id);
        queue.push(f.id);
      }
    }
  }
  return excluded;
}

/**
 * Restituisce i nodi antenati dalla radice fino a `folderId` per export backup.
 */
export function buildFolderAncestorPath(folderId, folderMap, stopAtAncestorIds = null) {
  const fullPath = getFolderPath(folderId, folderMap);
  if (fullPath.length === 0) return [];

  let startIndex = 0;
  if (stopAtAncestorIds && stopAtAncestorIds.size > 0) {
    const idx = fullPath.findIndex(f => stopAtAncestorIds.has(f.id));
    if (idx !== -1) startIndex = idx;
  }

  return fullPath.slice(startIndex).map(f => ({
    id: f.id,
    name: f.name || 'Raccolta',
    color: f.color || '#6366f1'
  }));
}

/**
 * Raccoglie tutte le raccolte da includere in un backup `.inknote` in ordine topologico (padre prima dei figli).
 * Include ricorsivamente tutte le sottoraccolte delle raccolte selezionate (anche vuote)
 * e gli antenati necessari per gli eventuali quaderni selezionati fuori da esse.
 */
export function collectFoldersForExport({
  selectedFolderIds = [],
  notebooks = [],
  folders = []
}) {
  const folderMap = new Map((folders || []).filter(f => f && f.id).map(f => [f.id, f]));
  const selectedSet = new Set(Array.from(selectedFolderIds || []).filter(id => folderMap.has(id)));
  const includedIds = new Set();

  for (const fid of selectedSet) {
    for (const descId of getDescendantFolderIds(fid, folders)) {
      if (folderMap.has(descId)) includedIds.add(descId);
    }
  }

  for (const nb of (notebooks || [])) {
    if (!nb || !nb.folderId || !folderMap.has(nb.folderId)) continue;
    if (includedIds.has(nb.folderId)) continue;
    const path = buildFolderAncestorPath(nb.folderId, folderMap, selectedSet);
    for (const node of path) {
      if (folderMap.has(node.id)) includedIds.add(node.id);
    }
  }

  if (includedIds.size === 0) return [];

  // Ordinamento topologico sicuro contro cicli: padri sempre prima dei figli
  const ordered = [];
  const emitted = new Set();

  const visit = (fid, trail) => {
    if (emitted.has(fid) || trail.has(fid)) return;
    const f = folderMap.get(fid);
    if (!f) return;
    if (f.parentId && includedIds.has(f.parentId)) {
      trail.add(fid);
      visit(f.parentId, trail);
      trail.delete(fid);
    }
    emitted.add(fid);
    ordered.push({
      id: f.id,
      name: f.name || 'Raccolta',
      parentId: f.parentId || null,
      color: f.color || '#6366f1',
      createdAt: f.createdAt || null,
      updatedAt: f.updatedAt || null
    });
  };

  for (const fid of includedIds) {
    visit(fid, new Set());
  }

  return ordered;
}
