/**
 * @module shared/sync/sync-helpers
 *
 * Logica pura di sanitizzazione, riconciliazione bidirezionale con tombstone,
 * firme metadati e tracciamento consumi/stato locale per la sincronizzazione cloud manuale.
 */

export const SYNC_TOMBSTONES_KEY = 'inknote_sync_tombstones_v1';
export const SYNC_STATE_KEY_PREFIX = 'inknote_sync_state_v1_';
export const SYNC_USAGE_KEY_PREFIX = 'inknote_sync_usage_v1_';

export const SYNC_VALID_PATTERNS = ['ruled', 'grid', 'dots', 'blank'];
export const SYNC_VALID_TOOLS = ['pen', 'pencil', 'marker', 'highlighter', 'eraser', 'lasso', 'text'];
export const SYNC_VALID_STYLES = ['solid', 'dashed', 'dashed-large', 'dotted', 'dash-dot'];
export const SYNC_VALID_TEXT_FONTS = ['sans', 'serif', 'mono', 'hand'];
export const SYNC_VALID_TEXT_ALIGNS = ['left', 'center', 'right'];

export const SYNC_MAX_PAGES_PER_NOTEBOOK = 500;
export const SYNC_TIMESTAMP_TOLERANCE_MS = 1000;

const _ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidCloudId(id) {
  return typeof id === 'string' && _ID_RE.test(id);
}

export function normalizeHexColor(val, fallback = '#4f46e5') {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return '#' + trimmed.slice(1).split('').map(c => c + c).join('').toLowerCase();
  }
  return fallback;
}

export function normalizeHexOrNull(val) {
  if (val == null || val === '') return null;
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return '#' + trimmed.slice(1).split('').map(c => c + c).join('').toLowerCase();
  }
  return null;
}

function _clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function _clampFloat(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function _safeIsoTimestamp(val, fallbackIso = new Date().toISOString()) {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed && trimmed.length <= 40 && Number.isFinite(Date.parse(trimmed))) {
      return trimmed;
    }
  }
  const ms = parseSyncTimestampMs(val);
  if (ms > 0) {
    return new Date(ms).toISOString();
  }
  return String(fallbackIso).slice(0, 40);
}

export function parseSyncTimestampMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : 0;
  if (val instanceof Date) {
    const t = val.getTime();
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  if (typeof val === 'object') {
    if (typeof val.toMillis === 'function') {
      const t = val.toMillis();
      return Number.isFinite(t) && t > 0 ? t : 0;
    }
    if (typeof val.seconds === 'number') {
      const ns = typeof val.nanoseconds === 'number' ? val.nanoseconds : 0;
      const t = val.seconds * 1000 + Math.floor(ns / 1e6);
      return Number.isFinite(t) && t > 0 ? t : 0;
    }
  }
  if (typeof val === 'string') {
    const t = Date.parse(val);
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  return 0;
}

/**
 * Sanitizza `toolbarSettings` garantendo zero valori `undefined` e conformità con Firestore.
 * Preserva `paperColor`, `patternColor` e stili strumento/testo.
 */
export function sanitizeToolbarSettingsForCloud(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const rawTools = (src.tools && typeof src.tools === 'object') ? src.tools : {};
  const rawText = (src.text && typeof src.text === 'object') ? src.text : {};

  const sanitizeTool = (name, defaultColor, defaultOpacity) => {
    const t = (rawTools[name] && typeof rawTools[name] === 'object') ? rawTools[name] : {};
    return {
      color: normalizeHexColor(t.color, defaultColor),
      width: _clampFloat(t.width, 1, 25, 3),
      opacity: _clampFloat(t.opacity, 0.1, 1.0, defaultOpacity),
      style: SYNC_VALID_STYLES.includes(t.style) ? t.style : 'solid'
    };
  };

  const recentColors = Array.isArray(src.recentColors)
    ? src.recentColors
        .map(c => normalizeHexOrNull(c))
        .filter(Boolean)
        .slice(0, 16)
    : [];

  const snapCircles = src.snapCircles !== false;
  const snapRectangles = src.snapRectangles !== false;
  const snapTriangles = src.snapTriangles !== false;
  const snapArrows = src.snapArrows !== false;
  const snapMathSymbols = src.snapMathSymbols !== false;
  const snapGreekLetters = src.snapGreekLetters !== false;

  return {
    activeTool: SYNC_VALID_TOOLS.includes(src.activeTool) ? src.activeTool : 'marker',
    tools: {
      pen: sanitizeTool('pen', '#000000', 1.0),
      pencil: sanitizeTool('pencil', '#000000', 1.0),
      marker: sanitizeTool('marker', '#000000', 0.9),
      highlighter: sanitizeTool('highlighter', '#ffeb3b', 0.35)
    },
    text: {
      fontFamily: SYNC_VALID_TEXT_FONTS.includes(rawText.fontFamily) ? rawText.fontFamily : 'sans',
      fontSize: _clampInt(rawText.fontSize, 10, 72, 18),
      bold: !!rawText.bold,
      italic: !!rawText.italic,
      align: SYNC_VALID_TEXT_ALIGNS.includes(rawText.align) ? rawText.align : 'left',
      color: normalizeHexColor(rawText.color, '#000000')
    },
    eraserSize: _clampInt(src.eraserSize, 1, 5, 3),
    eraserMode: src.eraserMode === 'point' ? 'point' : 'stroke',
    lassoMode: src.lassoMode === 'rect' ? 'rect' : 'freehand',
    lassoSelectInk: src.lassoSelectInk !== false,
    lassoSelectText: src.lassoSelectText !== false,
    snapLines: src.snapLines !== false,
    snapShapes: !!(
      snapCircles ||
      snapRectangles ||
      snapTriangles ||
      snapArrows ||
      snapMathSymbols ||
      snapGreekLetters
    ),
    snapCircles,
    snapRectangles,
    snapTriangles,
    snapArrows,
    snapMathSymbols,
    snapGreekLetters,
    smoothing: _clampInt(src.smoothing, 0, 100, 50),
    compactMode: false,
    recentColors,
    paperColor: normalizeHexOrNull(src.paperColor),
    patternColor: normalizeHexOrNull(src.patternColor)
  };
}

export function sanitizePageOrder(rawOrder, maxPages = SYNC_MAX_PAGES_PER_NOTEBOOK) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rawOrder)) return out;
  for (const pid of rawOrder) {
    if (!isValidCloudId(pid) || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    if (out.length >= maxPages) break;
  }
  return out;
}

export function sanitizeCloudFolderPayload({
  folder = null,
  folderId = '',
  ownerUid,
  deleted = false,
  existingCloud = null,
  deletedAtMs = 0
} = {}) {
  const id = folder?.id || folderId || existingCloud?.id || '';
  if (!isValidCloudId(id)) throw new Error(`ID cartella non valido per il sync: "${id}"`);
  if (!isValidCloudId(ownerUid)) throw new Error('UID proprietario non valido');

  const nowIso = new Date().toISOString();
  const rawName = String(folder?.name || existingCloud?.name || 'Cartella').trim();
  const name = (rawName || 'Cartella').slice(0, 140);
  const rawParent = folder?.parentId ?? existingCloud?.parentId ?? '';
  const parentId = (typeof rawParent === 'string' && isValidCloudId(rawParent) && rawParent !== id)
    ? rawParent
    : '';

  const clientCreatedAt = _safeIsoTimestamp(
    folder?.createdAt || existingCloud?.clientCreatedAt || existingCloud?.createdAt,
    nowIso
  );
  const clientUpdatedAt = deleted
    ? _safeIsoTimestamp(deletedAtMs || nowIso, nowIso)
    : _safeIsoTimestamp(folder?.updatedAt || existingCloud?.clientUpdatedAt, nowIso);

  return {
    id,
    ownerUid,
    name,
    parentId,
    color: normalizeHexColor(folder?.color || existingCloud?.color, '#6366f1'),
    deleted: !!deleted,
    clientCreatedAt,
    clientUpdatedAt
  };
}

export function sanitizeCloudNotebookPayload({
  notebook = null,
  notebookId = '',
  ownerUid,
  deleted = false,
  existingCloud = null,
  deletedAtMs = 0
} = {}) {
  const id = notebook?.id || notebookId || existingCloud?.id || '';
  if (!isValidCloudId(id)) throw new Error(`ID quaderno non valido per il sync: "${id}"`);
  if (!isValidCloudId(ownerUid)) throw new Error('UID proprietario non valido');

  const nowIso = new Date().toISOString();
  const rawTitle = String(notebook?.title || existingCloud?.title || 'Quaderno senza titolo').trim();
  const title = (rawTitle || 'Quaderno senza titolo').slice(0, 160);
  const coverColor = normalizeHexColor(notebook?.coverColor || existingCloud?.coverColor, '#4f46e5');
  const rawPattern = notebook?.pattern || existingCloud?.pattern || 'ruled';
  const pattern = SYNC_VALID_PATTERNS.includes(rawPattern) ? rawPattern : 'ruled';
  const rawFolderId = notebook?.folderId ?? existingCloud?.folderId ?? '';
  const folderId = (typeof rawFolderId === 'string' && isValidCloudId(rawFolderId))
    ? rawFolderId
    : '';

  const pageOrder = deleted
    ? []
    : sanitizePageOrder(
        notebook?.pageOrder ||
          (Array.isArray(notebook?.pages) ? notebook.pages.map(p => p?.pageId) : existingCloud?.pageOrder)
      );
  const pageCount = deleted ? 0 : pageOrder.length;
  const maxPageIdx = pageCount > 0 ? Math.min(499, pageCount - 1) : 0;
  const lastPageIndex = deleted
    ? 0
    : _clampInt(notebook?.lastPageIndex ?? existingCloud?.lastPageIndex, 0, maxPageIdx, 0);

  const clientCreatedAt = _safeIsoTimestamp(
    notebook?.createdAt || existingCloud?.clientCreatedAt || existingCloud?.createdAt,
    nowIso
  );
  const clientUpdatedAt = deleted
    ? _safeIsoTimestamp(deletedAtMs || nowIso, nowIso)
    : _safeIsoTimestamp(notebook?.updatedAt || notebook?.lastEditAt || existingCloud?.clientUpdatedAt, nowIso);
  const lastEditAt = deleted
    ? clientUpdatedAt
    : _safeIsoTimestamp(notebook?.lastEditAt || notebook?.updatedAt || existingCloud?.lastEditAt, clientUpdatedAt);

  return {
    id,
    ownerUid,
    title,
    coverColor,
    pattern,
    folderId,
    isFavorite: !!(notebook?.isFavorite ?? existingCloud?.isFavorite),
    pageOrder,
    pageCount,
    lastPageIndex,
    toolbarSettings: sanitizeToolbarSettingsForCloud(
      notebook?.toolbarSettings || existingCloud?.toolbarSettings
    ),
    deleted: !!deleted,
    clientCreatedAt,
    clientUpdatedAt,
    lastEditAt
  };
}

export function computeFolderMetaSignature(folder) {
  if (!folder) return '';
  return JSON.stringify({
    name: String(folder.name || 'Cartella').trim().slice(0, 140),
    parentId: (typeof folder.parentId === 'string' && isValidCloudId(folder.parentId) && folder.parentId !== folder.id)
      ? folder.parentId
      : '',
    color: normalizeHexColor(folder.color, '#6366f1'),
    deleted: !!folder.deleted
  });
}

export function computeNotebookMetaSignature(nb) {
  if (!nb) return '';
  const ts = sanitizeToolbarSettingsForCloud(nb.toolbarSettings);
  // Escludiamo compactMode e activeTool transitorio se non significativi? Teniamo tutto tranne compactMode (già false).
  return JSON.stringify({
    title: String(nb.title || 'Quaderno senza titolo').trim().slice(0, 160),
    coverColor: normalizeHexColor(nb.coverColor, '#4f46e5'),
    pattern: SYNC_VALID_PATTERNS.includes(nb.pattern) ? nb.pattern : 'ruled',
    folderId: (typeof nb.folderId === 'string' && isValidCloudId(nb.folderId)) ? nb.folderId : '',
    isFavorite: !!nb.isFavorite,
    pageOrder: sanitizePageOrder(nb.pageOrder),
    paperColor: ts.paperColor,
    patternColor: ts.patternColor,
    toolbar: ts,
    deleted: !!nb.deleted
  });
}

/**
 * Converte una cartella cloud Firestore nel record locale IDB.
 */
export function cloudFolderToLocalRecord(cloud) {
  const updatedIso = _safeIsoTimestamp(cloud.clientUpdatedAt || cloud.updatedAt);
  const createdIso = _safeIsoTimestamp(cloud.clientCreatedAt || cloud.createdAt || updatedIso, updatedIso);
  return {
    id: cloud.id,
    name: String(cloud.name || 'Nuova Cartella').trim() || 'Nuova Cartella',
    parentId: (typeof cloud.parentId === 'string' && cloud.parentId && cloud.parentId !== cloud.id)
      ? cloud.parentId
      : null,
    color: normalizeHexColor(cloud.color, '#6366f1'),
    createdAt: createdIso,
    updatedAt: updatedIso
  };
}

/**
 * Ordina le cartelle in ordine topologico (genitori prima dei figli) così
 * il salvataggio locale o cloud non lascia riferimenti pendenti.
 */
export function sortFoldersParentFirst(folders) {
  const list = Array.isArray(folders) ? folders.filter(f => f && f.id) : [];
  const byId = new Map(list.map(f => [f.id, f]));
  const depthMemo = new Map();

  const getDepth = (id, stack = new Set()) => {
    if (depthMemo.has(id)) return depthMemo.get(id);
    if (stack.has(id)) return 0;
    const item = byId.get(id);
    if (!item || !item.parentId || !byId.has(item.parentId)) {
      depthMemo.set(id, 0);
      return 0;
    }
    stack.add(id);
    const d = 1 + getDepth(item.parentId, stack);
    stack.delete(id);
    depthMemo.set(id, d);
    return d;
  };

  return list.slice().sort((a, b) => getDepth(a.id) - getDepth(b.id));
}

/**
 * Riconcilia un insieme di record locali vs cloud rispetto a tombstone locali e stato dell'ultimo sync.
 *
 * Azioni possibili per ID:
 *   - 'upload'       : locale nuovo o modificato -> carica su cloud
 *   - 'download'     : cloud nuovo o modificato -> scarica in locale
 *   - 'delete_cloud' : eliminato localmente (tombstone) -> marca deleted=true su cloud
 *   - 'delete_local' : eliminato su cloud (deleted=true) -> rimuovi da locale
 *   - 'conflict'     : modifica concorrente o prima sincronizzazione con dati divergenti
 *   - 'noop'         : già allineato (0 scritture / 0 download pagine)
 */
export function reconcileSyncSets({
  localItems = [],
  cloudItems = [],
  localTombstones = {},
  lastSyncMap = {},
  getLocalUpdatedMs = (item) => parseSyncTimestampMs(item?.updatedAt || item?.lastEditAt || item?.createdAt),
  getCloudServerUpdatedMs = (item) => parseSyncTimestampMs(item?.updatedAt || item?.clientUpdatedAt || item?.lastEditAt),
  getCloudClientUpdatedMs = (item) => parseSyncTimestampMs(item?.clientUpdatedAt || item?.updatedAt || item?.lastEditAt),
  getLocalSignature = () => '',
  getCloudSignature = () => '',
  toleranceMs = SYNC_TIMESTAMP_TOLERANCE_MS
} = {}) {
  const localMap = new Map();
  for (const item of localItems) {
    if (item && item.id) localMap.set(item.id, item);
  }

  const cloudMap = new Map();
  for (const item of cloudItems) {
    if (item && item.id) cloudMap.set(item.id, item);
  }

  const allIds = new Set([
    ...localMap.keys(),
    ...cloudMap.keys(),
    ...Object.keys(localTombstones || {})
  ]);

  const actions = [];

  for (const id of allIds) {
    const local = localMap.get(id) || null;
    const cloud = cloudMap.get(id) || null;
    const tombMs = parseSyncTimestampMs(localTombstones?.[id]);
    const prev = lastSyncMap?.[id] || null;
    const cloudDeleted = !!cloud?.deleted;

    if (local && !cloud) {
      actions.push({ id, action: 'upload', local, cloud: null, prev, reason: 'local_only' });
      continue;
    }

    if (!local && !cloud) {
      // Tombstone locale per un oggetto mai salito in cloud (o già rimosso)
      if (tombMs > 0) {
        actions.push({ id, action: 'noop', local: null, cloud: null, prev, clearTombstone: true, reason: 'stale_tombstone' });
      }
      continue;
    }

    if (!local && cloud) {
      if (cloudDeleted) {
        actions.push({
          id,
          action: 'noop',
          local: null,
          cloud,
          prev,
          clearTombstone: tombMs > 0,
          reason: 'both_deleted'
        });
        continue;
      }

      const cloudServerMs = getCloudServerUpdatedMs(cloud);
      const cloudClientMs = getCloudClientUpdatedMs(cloud);

      if (tombMs > 0) {
        if (prev && cloudServerMs > (prev.cloudServerUpdatedMs || 0) + toleranceMs && cloudClientMs > tombMs + toleranceMs) {
          actions.push({
            id,
            action: 'conflict',
            local: null,
            cloud,
            prev,
            tombstoneMs: tombMs,
            reason: 'deleted_locally_modified_cloud'
          });
        } else {
          actions.push({
            id,
            action: 'delete_cloud',
            local: null,
            cloud,
            prev,
            tombstoneMs: tombMs,
            reason: 'local_tombstone'
          });
        }
        continue;
      }

      actions.push({ id, action: 'download', local: null, cloud, prev, reason: 'cloud_only' });
      continue;
    }

    // Entrambi presenti (local && cloud)
    const localMs = getLocalUpdatedMs(local);
    const cloudServerMs = getCloudServerUpdatedMs(cloud);
    const cloudClientMs = getCloudClientUpdatedMs(cloud);
    const localSig = getLocalSignature(local);
    const cloudSig = getCloudSignature(cloud);

    if (cloudDeleted) {
      if (prev) {
        const localTimeChanged = localMs > (prev.localUpdatedMs || 0) + toleranceMs;
        const localMetaChanged = Boolean(localSig && prev.localMetaSignature && localSig !== prev.localMetaSignature);
        if (localTimeChanged || localMetaChanged) {
          actions.push({
            id,
            action: 'conflict',
            local,
            cloud,
            prev,
            reason: 'modified_locally_deleted_cloud'
          });
        } else {
          actions.push({
            id,
            action: 'delete_local',
            local,
            cloud,
            prev,
            reason: 'cloud_tombstone'
          });
        }
      } else {
        // Esiste localmente ma in cloud è marcato eliminato e non c'era storia sync su questo device
        actions.push({
          id,
          action: 'conflict',
          local,
          cloud,
          prev: null,
          reason: 'local_exists_cloud_deleted'
        });
      }
      continue;
    }

    if (prev) {
      const localTimeChanged = localMs > (prev.localUpdatedMs || 0) + toleranceMs;
      const localMetaChanged = Boolean(localSig && prev.localMetaSignature && localSig !== prev.localMetaSignature);
      const localChanged = localTimeChanged || localMetaChanged;

      const cloudMetaChanged = Boolean(cloudSig && prev.cloudMetaSignature && cloudSig !== prev.cloudMetaSignature);
      let cloudTimeChanged;
      if (!prev.cloudServerUpdatedMs && prev.uploadedClientUpdatedAt) {
        const expectedClientMs = parseSyncTimestampMs(prev.uploadedClientUpdatedAt);
        cloudTimeChanged = Math.abs(cloudClientMs - expectedClientMs) > toleranceMs;
      } else {
        cloudTimeChanged = cloudServerMs > (prev.cloudServerUpdatedMs || 0) + toleranceMs;
      }
      const cloudChanged = cloudTimeChanged || cloudMetaChanged;

      if (!localChanged && !cloudChanged) {
        actions.push({ id, action: 'noop', local, cloud, prev, reason: 'in_sync' });
      } else if (localChanged && !cloudChanged) {
        actions.push({ id, action: 'upload', local, cloud, prev, reason: 'local_newer' });
      } else if (!localChanged && cloudChanged) {
        actions.push({ id, action: 'download', local, cloud, prev, reason: 'cloud_newer' });
      } else {
        // Entrambi modificati dopo l'ultimo sync
        const sameSig = Boolean(localSig && cloudSig && localSig === cloudSig);
        const sameTime = Math.abs(localMs - cloudClientMs) <= toleranceMs;
        if (sameSig && sameTime) {
          actions.push({ id, action: 'noop', local, cloud, prev, reason: 'converged' });
        } else {
          actions.push({ id, action: 'conflict', local, cloud, prev, reason: 'both_modified' });
        }
      }
    } else {
      // Prima sincronizzazione su questo dispositivo/account con stesso ID già in cloud
      const sameSig = Boolean(localSig && cloudSig && localSig === cloudSig);
      const sameTime = Math.abs(localMs - cloudClientMs) <= toleranceMs;
      if (sameSig && sameTime) {
        actions.push({ id, action: 'noop', local, cloud, prev: null, reason: 'first_sync_identical' });
      } else {
        actions.push({ id, action: 'conflict', local, cloud, prev: null, reason: 'both_exist_first_sync' });
      }
    }
  }

  return actions;
}

// ============================================================
// HASH SHA-256 PER DIFFERENZIALE PAGINE
// ============================================================

export async function sha256Uint8Array(bytes) {
  const view = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes || 0);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// PERSISTENZA LOCALE TOMBSTONE, STATO SYNC E CONSUMI GIORNALIERI
// ============================================================

function _getStorage(explicitStorage) {
  if (explicitStorage) return explicitStorage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadLocalTombstones(storage = null) {
  const ls = _getStorage(storage);
  if (!ls) return { folders: {}, notebooks: {} };
  try {
    const raw = ls.getItem(SYNC_TOMBSTONES_KEY);
    if (!raw) return { folders: {}, notebooks: {} };
    const parsed = JSON.parse(raw);
    return {
      folders: parsed?.folders && typeof parsed.folders === 'object' ? { ...parsed.folders } : {},
      notebooks: parsed?.notebooks && typeof parsed.notebooks === 'object' ? { ...parsed.notebooks } : {}
    };
  } catch {
    return { folders: {}, notebooks: {} };
  }
}

function _saveLocalTombstones(data, storage = null) {
  const ls = _getStorage(storage);
  if (!ls) return;
  try {
    ls.setItem(SYNC_TOMBSTONES_KEY, JSON.stringify({
      folders: data?.folders || {},
      notebooks: data?.notebooks || {}
    }));
  } catch {
    // ignore storage quota errors
  }
}

export function recordLocalDeletion(kind, id, deletedAtMs = Date.now(), storage = null) {
  if ((kind !== 'folders' && kind !== 'notebooks') || !isValidCloudId(id)) return;
  const data = loadLocalTombstones(storage);
  data[kind][id] = Number.isFinite(deletedAtMs) ? deletedAtMs : Date.now();
  _saveLocalTombstones(data, storage);
}

export function clearLocalDeletion(kind, id, storage = null) {
  if ((kind !== 'folders' && kind !== 'notebooks') || !id) return;
  const data = loadLocalTombstones(storage);
  if (id in data[kind]) {
    delete data[kind][id];
    _saveLocalTombstones(data, storage);
  }
}

export function loadUserSyncState(uid, storage = null) {
  const empty = { lastSyncAt: null, folders: {}, notebooks: {} };
  const ls = _getStorage(storage);
  if (!ls || !isValidCloudId(uid)) return empty;
  try {
    const raw = ls.getItem(`${SYNC_STATE_KEY_PREFIX}${uid}`);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      lastSyncAt: typeof parsed?.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      folders: parsed?.folders && typeof parsed.folders === 'object' ? parsed.folders : {},
      notebooks: parsed?.notebooks && typeof parsed.notebooks === 'object' ? parsed.notebooks : {}
    };
  } catch {
    return empty;
  }
}

export function saveUserSyncState(uid, syncState, storage = null) {
  const ls = _getStorage(storage);
  if (!ls || !isValidCloudId(uid)) return;
  try {
    ls.setItem(`${SYNC_STATE_KEY_PREFIX}${uid}`, JSON.stringify({
      lastSyncAt: syncState?.lastSyncAt || null,
      folders: syncState?.folders || {},
      notebooks: syncState?.notebooks || {}
    }));
  } catch {
    // ignore storage quota errors
  }
}

export function getSyncDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function loadDailySyncUsage(uid, dateKey = getSyncDateKey(), storage = null) {
  const empty = {
    dateKey,
    syncCount: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    readsApprox: 0,
    writesApprox: 0
  };
  const ls = _getStorage(storage);
  if (!ls || !isValidCloudId(uid)) return empty;
  try {
    const raw = ls.getItem(`${SYNC_USAGE_KEY_PREFIX}${uid}`);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.dateKey !== dateKey) return empty;
    return {
      dateKey,
      syncCount: Math.max(0, Number(parsed.syncCount) || 0),
      bytesUploaded: Math.max(0, Number(parsed.bytesUploaded) || 0),
      bytesDownloaded: Math.max(0, Number(parsed.bytesDownloaded) || 0),
      readsApprox: Math.max(0, Number(parsed.readsApprox) || 0),
      writesApprox: Math.max(0, Number(parsed.writesApprox) || 0)
    };
  } catch {
    return empty;
  }
}

export function recordDailySyncUsage(uid, delta = {}, dateKey = getSyncDateKey(), storage = null) {
  const cur = loadDailySyncUsage(uid, dateKey, storage);
  const next = {
    dateKey,
    syncCount: cur.syncCount + Math.max(0, Number(delta.syncCount) || 0),
    bytesUploaded: cur.bytesUploaded + Math.max(0, Number(delta.bytesUploaded) || 0),
    bytesDownloaded: cur.bytesDownloaded + Math.max(0, Number(delta.bytesDownloaded) || 0),
    readsApprox: cur.readsApprox + Math.max(0, Number(delta.readsApprox) || 0),
    writesApprox: cur.writesApprox + Math.max(0, Number(delta.writesApprox) || 0)
  };
  const ls = _getStorage(storage);
  if (ls && isValidCloudId(uid)) {
    try {
      ls.setItem(`${SYNC_USAGE_KEY_PREFIX}${uid}`, JSON.stringify(next));
    } catch {
      // ignore storage quota errors
    }
  }
  return next;
}

export function formatBytesCompact(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSyncTimestampIt(isoOrMs) {
  const ms = parseSyncTimestampMs(isoOrMs);
  if (!ms) return 'Mai sincronizzato';
  try {
    return new Intl.DateTimeFormat('it-IT', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}
