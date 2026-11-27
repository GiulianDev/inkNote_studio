// ============================================================
// LIBRERIA — HELPER PURI (Gerarchia cartelle, filtri, ordinamento, nomi)
// Nessuna dipendenza dal DOM per consentire test unitari rapidi.
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
 * Formatta il percorso di una cartella come "Padre / Figlia" o "Libreria".
 */
export function formatFolderPathLabel(folderId, folderMap) {
  if (!folderId || !folderMap.has(folderId)) return 'Libreria';
  const path = getFolderPath(folderId, folderMap);
  return path.map(f => f.name).join(' / ') || 'Libreria';
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
 * Calcola per ogni cartella il numero di sottocartelle e quaderni diretti.
 */
export function computeFolderCounts(folders, notebooks, folderMap) {
  const counts = new Map();
  for (const f of folders) {
    counts.set(f.id, { subfolders: 0, notebooks: 0 });
  }
  for (const f of folders) {
    if (f.parentId && folderMap.has(f.parentId)) {
      counts.get(f.parentId).subfolders++;
    }
  }
  for (const nb of notebooks) {
    if (nb.folderId && folderMap.has(nb.folderId)) {
      counts.get(nb.folderId).notebooks++;
    }
  }
  return counts;
}

/**
 * Costruisce una mappa degli elementi (quaderni e sottoraccolte) contenuti in ogni cartella
 * per la generazione dell'anteprima visiva sulle cover.
 */
export function buildFolderPreviewMap(folders, notebooks, folderMap) {
  const map = new Map();
  for (const f of folders) {
    map.set(f.id, { notebooks: [], subfolders: [] });
  }
  for (const nb of notebooks) {
    if (nb.folderId && folderMap.has(nb.folderId)) {
      map.get(nb.folderId).notebooks.push(nb);
    }
  }
  for (const f of folders) {
    if (f.parentId && folderMap.has(f.parentId)) {
      map.get(f.parentId).subfolders.push(f);
    }
  }
  return map;
}

/**
 * Formatta il contatore sintetico di una raccolta (es. "1 raccolta · 2 quaderni" o "Vuota").
 */
export function formatFolderCountLabel(stat) {
  const { subfolders = 0, notebooks = 0 } = stat || {};
  const parts = [];
  if (subfolders > 0) parts.push(`${subfolders} raccolt${subfolders === 1 ? 'a' : 'e'}`);
  if (notebooks > 0) parts.push(`${notebooks} quadern${notebooks === 1 ? 'o' : 'i'}`);
  return parts.length > 0 ? parts.join(' · ') : 'Vuota';
}

export function compareNotebooks(a, b, sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  let cmp = 0;

  if (sortBy === 'title') {
    cmp = (a.title || '').localeCompare(b.title || '', 'it', { sensitivity: 'base' });
  } else if (sortBy === 'createdAt') {
    cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  } else if (sortBy === 'pageCount') {
    cmp = (a.pageCount || 1) - (b.pageCount || 1);
  } else {
    cmp = new Date(a.lastEditAt || a.updatedAt || 0).getTime() -
          new Date(b.lastEditAt || b.updatedAt || 0).getTime();
  }

  if (cmp !== 0) return cmp * dir;
  return (a.title || '').localeCompare(b.title || '', 'it', { sensitivity: 'base' });
}

export function compareFolders(a, b, sortBy, sortDir, folderCounts) {
  const dir = sortDir === 'asc' ? 1 : -1;
  let cmp = 0;

  if (sortBy === 'createdAt') {
    cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  } else if (sortBy === 'updatedAt') {
    cmp = new Date(a.updatedAt || a.createdAt || 0).getTime() -
          new Date(b.updatedAt || b.createdAt || 0).getTime();
  } else if (sortBy === 'pageCount') {
    const ca = folderCounts.get(a.id) || { subfolders: 0, notebooks: 0 };
    const cb = folderCounts.get(b.id) || { subfolders: 0, notebooks: 0 };
    cmp = (ca.notebooks + ca.subfolders) - (cb.notebooks + cb.subfolders);
  } else {
    cmp = (a.name || '').localeCompare(b.name || '', 'it', { sensitivity: 'base' });
  }

  if (cmp !== 0) return cmp * dir;
  return (a.name || '').localeCompare(b.name || '', 'it', { sensitivity: 'base' });
}

/**
 * Filtra cartelle e quaderni visibili nella vista corrente (ricerca, preferiti o cartella).
 */
export function filterLibraryItems({
  folders,
  notebooks,
  folderMap,
  currentFolderId = null,
  query = '',
  onlyFavorites = false
}) {
  const queryLower = query.trim().toLowerCase();
  const isSearching = queryLower.length > 0;

  if (isSearching) {
    return {
      visibleFolders: folders.filter(f =>
        !onlyFavorites && (f.name || '').toLowerCase().includes(queryLower)
      ),
      visibleNotebooks: notebooks.filter(nb => {
        if (onlyFavorites && !nb.isFavorite) return false;
        return (nb.title || '').toLowerCase().includes(queryLower);
      })
    };
  }

  if (onlyFavorites && currentFolderId === null) {
    return {
      visibleFolders: [],
      visibleNotebooks: notebooks.filter(nb => !!nb.isFavorite)
    };
  }

  return {
    visibleFolders: folders.filter(f => {
      const pid = (f.parentId && folderMap.has(f.parentId)) ? f.parentId : null;
      return pid === currentFolderId;
    }),
    visibleNotebooks: notebooks.filter(nb => {
      if (onlyFavorites && !nb.isFavorite) return false;
      const fid = (nb.folderId && folderMap.has(nb.folderId)) ? nb.folderId : null;
      return fid === currentFolderId;
    })
  };
}

export function deepClone(val) {
  if (typeof structuredClone === 'function') {
    return structuredClone(val);
  }
  if (val === null || typeof val !== 'object') return val;
  if (ArrayBuffer.isView(val)) {
    return new val.constructor(val);
  }
  if (Array.isArray(val)) {
    return val.map(deepClone);
  }
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = deepClone(val[k]);
  }
  return copy;
}

/**
 * Genera un titolo univoco incrementale (es. "Note (2)", "Note (3)") per i duplicati.
 */
export function generateDuplicateTitle(rawTitle, existingTitles) {
  const trimmed = (rawTitle || 'Senza titolo').trim() || 'Senza titolo';
  const match = trimmed.match(/^(.*?)\s*\(([2-9]\d*)\)$/);

  let baseTitle = trimmed;
  let nextNum = 2;
  if (match && match[1].trim()) {
    baseTitle = match[1].trim();
    nextNum = parseInt(match[2], 10) + 1;
  }

  let candidate = `${baseTitle} (${nextNum})`;
  while (existingTitles.has(candidate.toLowerCase())) {
    nextNum++;
    candidate = `${baseTitle} (${nextNum})`;
  }
  return candidate;
}

/**
 * Restituisce i nodi antenna/antenati dalla radice fino a `folderId` per export backup.
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
 * Raccoglie gli ID di tutti i quaderni selezionati direttamente o contenuti
 * ricorsivamente nelle raccolte selezionate (senza duplicati).
 */
export function collectNotebookIdsInSelection({
  selectedNotebookIds,
  selectedFolderIds,
  folders = [],
  notebooks = []
}) {
  const nbSet = new Set(selectedNotebookIds || []);
  const folderSet = new Set();

  for (const fid of (selectedFolderIds || [])) {
    for (const descId of getDescendantFolderIds(fid, folders)) {
      folderSet.add(descId);
    }
  }

  const out = [];
  const seen = new Set();

  for (const nb of notebooks) {
    if (!nb || !nb.id || seen.has(nb.id)) continue;
    if (nbSet.has(nb.id) || (nb.folderId && folderSet.has(nb.folderId))) {
      seen.add(nb.id);
      out.push(nb.id);
    }
  }

  for (const id of nbSet) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }

  return out;
}

/**
 * Calcola tutte le sottoraccolte e tutti i quaderni contenuti ricorsivamente in `folderIds`.
 */
export function collectSubtreeSummary({ folderIds = [], folders = [], notebooks = [] }) {
  const rootSet = new Set((folderIds || []).filter(Boolean));
  const allFolderIds = new Set();

  for (const fid of rootSet) {
    for (const descId of getDescendantFolderIds(fid, folders)) {
      allFolderIds.add(descId);
    }
  }

  const nestedFolderIds = [];
  for (const fid of allFolderIds) {
    if (!rootSet.has(fid)) nestedFolderIds.push(fid);
  }

  const nestedNotebooks = (notebooks || []).filter(
    nb => nb && nb.folderId && allFolderIds.has(nb.folderId)
  );

  return {
    allFolderIds,
    nestedFolderIds,
    subfolderCount: nestedFolderIds.length,
    nestedNotebooks
  };
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

/**
 * Calcola la visibilità della barra controlli/ricerca della libreria allo scroll.
 * Gestisce soglie direzionali, isteresi, protezione da feedback-loop durante
 * il cambio altezza e blocco visibile in ricerca/focus/D&D o con poco overflow.
 */
export function computeLibraryControlsVisibility({
  scrollTop = 0,
  prevScrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  controlsHeight = 0,
  currentlyHidden = false,
  forceVisible = false,
  accumulatedDelta = 0,
  nowMs = 0,
  ignoreScrollUntilMs = 0,
  hideScrollTop = 32,
  hideDelta = 24,
  showScrollTop = 10,
  showDelta = 18,
  minOverflowToHide = 48,
  transitionLockMs = 80
} = {}) {
  const safeScrollTop = Math.max(0, Number(scrollTop) || 0);
  const safePrevScrollTop = Math.max(0, Number(prevScrollTop) || 0);
  const safeScrollHeight = Math.max(0, Number(scrollHeight) || 0);
  const safeClientHeight = Math.max(0, Number(clientHeight) || 0);
  const safeControlsHeight = Math.max(0, Number(controlsHeight) || 0);
  const overflow = safeScrollHeight - safeClientHeight;

  if (forceVisible) {
    return {
      hidden: false,
      changed: currentlyHidden,
      accumulatedDelta: 0,
      prevScrollTop: safeScrollTop,
      ignoreScrollUntilMs: currentlyHidden ? nowMs + transitionLockMs : ignoreScrollUntilMs
    };
  }

  // Se non c'è contenuto scrollabile a sufficienza, mantieni/ripristina la barra visibile
  if (!currentlyHidden) {
    if (safeControlsHeight <= 0 || overflow < Math.max(minOverflowToHide, hideScrollTop + 12)) {
      return {
        hidden: false,
        changed: false,
        accumulatedDelta: 0,
        prevScrollTop: safeScrollTop,
        ignoreScrollUntilMs
      };
    }
  } else if (overflow <= 4) {
    return {
      hidden: false,
      changed: true,
      accumulatedDelta: 0,
      prevScrollTop: safeScrollTop,
      ignoreScrollUntilMs: nowMs + transitionLockMs
    };
  }

  // Assorbe eventuali clamp automatici di scrollTop durante la transizione CSS
  if (nowMs < ignoreScrollUntilMs) {
    return {
      hidden: currentlyHidden,
      changed: false,
      accumulatedDelta: 0,
      prevScrollTop: safeScrollTop,
      ignoreScrollUntilMs
    };
  }

  const delta = safeScrollTop - safePrevScrollTop;

  if (safeScrollTop <= showScrollTop) {
    if (currentlyHidden) {
      return {
        hidden: false,
        changed: true,
        accumulatedDelta: 0,
        prevScrollTop: safeScrollTop,
        ignoreScrollUntilMs: nowMs + transitionLockMs
      };
    }
    return {
      hidden: false,
      changed: false,
      accumulatedDelta: 0,
      prevScrollTop: safeScrollTop,
      ignoreScrollUntilMs
    };
  }

  if (!currentlyHidden) {
    const nextDelta = delta > 0
      ? (accumulatedDelta > 0 ? accumulatedDelta + delta : delta)
      : (delta < 0 ? 0 : accumulatedDelta);

    if (safeScrollTop >= hideScrollTop && nextDelta >= hideDelta) {
      return {
        hidden: true,
        changed: true,
        accumulatedDelta: 0,
        prevScrollTop: safeScrollTop,
        ignoreScrollUntilMs: nowMs + transitionLockMs
      };
    }

    return {
      hidden: false,
      changed: false,
      accumulatedDelta: nextDelta,
      prevScrollTop: safeScrollTop,
      ignoreScrollUntilMs
    };
  }

  // Attualmente nascosta: riappare scrollando verso l'alto oltre soglia
  const nextDelta = delta < 0
    ? (accumulatedDelta < 0 ? accumulatedDelta + delta : delta)
    : (delta > 0 ? 0 : accumulatedDelta);

  if (nextDelta <= -showDelta) {
    return {
      hidden: false,
      changed: true,
      accumulatedDelta: 0,
      prevScrollTop: safeScrollTop,
      ignoreScrollUntilMs: nowMs + transitionLockMs
    };
  }

  return {
    hidden: true,
    changed: false,
    accumulatedDelta: nextDelta,
    prevScrollTop: safeScrollTop,
    ignoreScrollUntilMs
  };
}
