/**
 * @module shared/release/bug-report-helpers
 *
 * Funzioni pure di validazione, anti-spam locale e costruzione payload Firestore
 * per le segnalazioni bug (testabili anche fuori da Vite/browser).
 */

import { RELEASE_INFO } from '../core/release-info.js';

export const BUG_DESC_MIN_LENGTH = 15;
export const BUG_DESC_MAX_LENGTH = 1500;
export const BUG_COOLDOWN_MS = 5 * 60 * 1000;
export const BUG_MAX_PER_DAY = 3;
export const BUG_MIN_DWELL_MS = 2000;
export const BUG_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BUG_GUARD_STORAGE_KEY = 'inknote_bug_report_guard_v1';

export function formatCooldownWait(waitMs) {
  const totalSec = Math.max(1, Math.ceil(waitMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) return `${secs} sec`;
  if (secs === 0) return `${mins} min`;
  return `${mins} min ${secs} sec`;
}

export function hashBugText(rawText) {
  const normalized = String(rawText || '').trim().replace(/\s+/g, ' ').toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function validateBugDescription(rawText) {
  const trimmed = String(rawText || '').trim();
  if (trimmed.length < BUG_DESC_MIN_LENGTH) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Descrivi il problema con almeno ${BUG_DESC_MIN_LENGTH} caratteri (${trimmed.length}/${BUG_DESC_MIN_LENGTH}).`
    };
  }
  if (trimmed.length > BUG_DESC_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'too_long',
      message: `Descrizione troppo lunga (massimo ${BUG_DESC_MAX_LENGTH} caratteri).`
    };
  }
  return { ok: true, text: trimmed };
}

export function readBugGuardHistory(storage = globalThis.localStorage, now = Date.now()) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { timestamps: [], lastTextHash: '' };
  }
  try {
    const raw = storage.getItem(BUG_GUARD_STORAGE_KEY);
    if (!raw) return { timestamps: [], lastTextHash: '' };
    const parsed = JSON.parse(raw);
    const cutoff = now - BUG_DAY_WINDOW_MS;
    const timestamps = Array.isArray(parsed?.timestamps)
      ? parsed.timestamps.filter((ts) => Number.isFinite(ts) && ts > cutoff && ts <= now + 60_000).sort((a, b) => a - b)
      : [];
    const lastTextHash = typeof parsed?.lastTextHash === 'string' ? parsed.lastTextHash : '';
    return { timestamps, lastTextHash };
  } catch {
    return { timestamps: [], lastTextHash: '' };
  }
}

export function writeBugGuardHistory(history, storage = globalThis.localStorage) {
  if (!storage || typeof storage.setItem !== 'function') return;
  try {
    storage.setItem(BUG_GUARD_STORAGE_KEY, JSON.stringify({
      timestamps: Array.isArray(history?.timestamps) ? history.timestamps : [],
      lastTextHash: typeof history?.lastTextHash === 'string' ? history.lastTextHash : ''
    }));
  } catch {}
}

export function evaluateClientAntiSpam({
  description = '',
  honeypotValue = '',
  panelOpenedAt = 0,
  now = Date.now(),
  storage = globalThis.localStorage
} = {}) {
  if (String(honeypotValue || '').trim() !== '') {
    return {
      ok: false,
      code: 'honeypot',
      message: 'Invio bloccato dal controllo anti-spam.'
    };
  }

  if (panelOpenedAt > 0 && (now - panelOpenedAt) < BUG_MIN_DWELL_MS) {
    return {
      ok: false,
      code: 'too_fast',
      message: 'Attendi un paio di secondi prima di inviare la segnalazione.'
    };
  }

  const descCheck = validateBugDescription(description);
  if (!descCheck.ok) {
    return {
      ok: false,
      code: descCheck.reason,
      message: descCheck.message
    };
  }

  const history = readBugGuardHistory(storage, now);
  const lastTs = history.timestamps[history.timestamps.length - 1] || 0;
  if (lastTs > 0 && (now - lastTs) < BUG_COOLDOWN_MS) {
    const waitMs = BUG_COOLDOWN_MS - (now - lastTs);
    return {
      ok: false,
      code: 'cooldown',
      waitMs,
      message: `Attendi ancora ${formatCooldownWait(waitMs)} prima di inviare un'altra segnalazione.`
    };
  }

  if (history.timestamps.length >= BUG_MAX_PER_DAY) {
    return {
      ok: false,
      code: 'daily_limit',
      message: `Hai raggiunto il limite di ${BUG_MAX_PER_DAY} segnalazioni in 24 ore. Usa "Copia report" se necessario.`
    };
  }

  const textHash = hashBugText(descCheck.text);
  if (history.lastTextHash && history.lastTextHash === textHash) {
    return {
      ok: false,
      code: 'duplicate',
      message: 'Hai già inviato questa stessa segnalazione.'
    };
  }

  return {
    ok: true,
    text: descCheck.text,
    textHash,
    history
  };
}

export function generateBugReportId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'bug_' + crypto.randomUUID().replace(/-/g, '');
  }
  return 'bug_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export function buildBugFirestorePayload({ reportId, user, description, diagnostics = {} }) {
  const rawVersion = String(diagnostics.version || RELEASE_INFO.version || '0.0.0').trim();
  const safeVersion = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(rawVersion) && rawVersion.length <= 32
    ? rawVersion
    : '0.0.0';
  const rawViewportClass = String(diagnostics.viewportClass || 'desktop');
  const viewportClass = ['phone', 'tablet', 'desktop'].includes(rawViewportClass) ? rawViewportClass : 'desktop';
  const rawViewport = String(diagnostics.viewport || '0x0').trim();
  const viewport = (rawViewport.length >= 3 ? rawViewport : '0x0').slice(0, 32);
  const rawDpr = Number(diagnostics.dpr);
  const dpr = Number.isFinite(rawDpr) ? Math.min(10, Math.max(0.5, rawDpr)) : 1;
  const rawCount = Number(diagnostics.notebooksCount);
  const notebooksCount = Number.isInteger(rawCount) && rawCount >= 0
    ? Math.min(100000, rawCount)
    : -1;

  return {
    id: String(reportId),
    reporterUid: String(user?.uid || ''),
    isAnonymous: Boolean(user?.isAnonymous),
    description: String(description || '').trim().slice(0, BUG_DESC_MAX_LENGTH),
    version: safeVersion,
    builtAt: String(diagnostics.builtAt || RELEASE_INFO.builtAt || 'n/d').slice(0, 64),
    os: String(diagnostics.os || 'sconosciuta').slice(0, 40) || 'sconosciuta',
    viewportClass,
    viewport,
    dpr,
    theme: diagnostics.theme === 'scuro' ? 'scuro' : 'chiaro',
    notebooksCount,
    userAgent: String(diagnostics.userAgent || '').slice(0, 320),
    status: 'new'
  };
}

export function classifyBugSubmitError(err, stage = 'commit') {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();

  if (code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed') {
    return 'Invio diretto non ancora attivo: abilita Anonymous Auth nella Console Firebase oppure usa "Copia report".';
  }
  if (code === 'permission-denied' || msg.includes('permission-denied') || msg.includes('insufficient permissions')) {
    if (stage === 'rules-check') {
      return 'Regole Firestore non ancora aggiornate su questo progetto per bug_reports. Aggiorna firestore.rules in Console Firebase oppure usa "Copia report".';
    }
    return 'Limite invii attivo sul server: attendi 5 minuti tra una segnalazione e l\'altra.';
  }
  if (code === 'unavailable' || code === 'auth/network-request-failed' || msg.includes('offline') || msg.includes('network')) {
    return 'Connessione assente o Firebase non raggiungibile. Usa "Copia report".';
  }
  return 'Invio non riuscito al momento. Puoi comunque usare "Copia report".';
}
