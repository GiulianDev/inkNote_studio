/**
 * @module services/db-scope-helpers
 *
 * Logica pura per l'isolamento multi-account della libreria locale (`ownerUid`),
 * riepilogo/migrazione dei quaderni creati senza account (guest) e risoluzione
 * sicura di collisioni ID tra proprietari diversi in IndexedDB.
 */

export function normalizeOwnerUid(uid) {
  if (typeof uid !== 'string') return null;
  const trimmed = uid.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getRecordOwnerUid(record) {
  return normalizeOwnerUid(record?.ownerUid);
}

export function belongsToOwner(record, ownerUid) {
  return getRecordOwnerUid(record) === normalizeOwnerUid(ownerUid);
}

export function filterRecordsByOwner(records, ownerUid) {
  const targetUid = normalizeOwnerUid(ownerUid);
  if (!Array.isArray(records)) return [];
  return records.filter((item) => item && getRecordOwnerUid(item) === targetUid);
}

export function resolveStampedOwnerUid({ existingRecord = null, incomingRecord = null, activeOwnerUid = null } = {}) {
  if (existingRecord) {
    return getRecordOwnerUid(existingRecord);
  }
  if (incomingRecord && Object.prototype.hasOwnProperty.call(incomingRecord, 'ownerUid')) {
    return normalizeOwnerUid(incomingRecord.ownerUid);
  }
  return normalizeOwnerUid(activeOwnerUid);
}

export function summarizeGuestLibraryRecords({ notebooks = [], folders = [] } = {}) {
  const guestNotebooks = filterRecordsByOwner(notebooks, null);
  const guestFolders = filterRecordsByOwner(folders, null);
  return {
    notebooksCount: guestNotebooks.length,
    foldersCount: guestFolders.length,
    notebookIds: guestNotebooks.map((n) => n.id).filter(Boolean),
    folderIds: guestFolders.map((f) => f.id).filter(Boolean),
    hasGuestItems: guestNotebooks.length > 0 || guestFolders.length > 0
  };
}

export function computeGuestClaimSignature({ notebooks = [], folders = [] } = {}) {
  const nbIds = filterRecordsByOwner(notebooks, null)
    .map((n) => String(n.id || ''))
    .filter(Boolean)
    .sort();
  const fldIds = filterRecordsByOwner(folders, null)
    .map((f) => String(f.id || ''))
    .filter(Boolean)
    .sort();
  if (nbIds.length === 0 && fldIds.length === 0) return '';
  return `nb:${nbIds.join(',')}|fld:${fldIds.join(',')}`;
}

export function shouldPromptGuestClaim({
  uid = null,
  guestSummary = null,
  signature = '',
  dismissedSignature = ''
} = {}) {
  if (!normalizeOwnerUid(uid)) return false;
  if (!guestSummary?.hasGuestItems) return false;
  if (!signature) return false;
  return signature !== String(dismissedSignature || '');
}

export function resolveCollisionSafeId(preferredId, usedIdsSet, prefix = 'id_') {
  const candidate = typeof preferredId === 'string' ? preferredId.trim() : '';
  if (candidate && (!usedIdsSet || !usedIdsSet.has(candidate))) {
    return candidate;
  }
  let generated = '';
  do {
    generated = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  } while (usedIdsSet && usedIdsSet.has(generated));
  return generated;
}
