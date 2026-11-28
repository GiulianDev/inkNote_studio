/**
 * @module features/sharing/sharing-helpers
 *
 * Logica pura e testabile per condivisione P2P su Firestore,
 * lookup privacy-safe (SHA-256 / @handle), chunking base64
 * e scadenza automatica a 24 ore.
 */

export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
export const CHUNK_BINARY_SIZE = 480 * 1024; // 480 KB -> ~640 KB base64 (< 750 KB rules limit)
export const MAX_TRANSFER_BYTES = 11 * 1024 * 1024; // ~11 MB binari -> <= 24 chunk
export const MAX_TRANSFER_CHUNKS = 25;
export const MAX_OUTGOING_TRANSFERS = 10;

const HANDLE_REGEX = /^[a-z0-9_]{3,24}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

export function isValidEmailFormat(raw) {
  const email = normalizeEmail(raw);
  return email.length > 3 && email.length <= 254 && EMAIL_REGEX.test(email);
}

export function normalizeHandle(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (s.startsWith('@')) s = s.slice(1);
  s = s.replace(/[^a-z0-9_]/g, '');
  return s.slice(0, 24);
}

export function isValidHandle(handle) {
  return typeof handle === 'string' && HANDLE_REGEX.test(handle);
}

export function suggestHandleFromUser(user) {
  const emailPart = normalizeEmail(user?.email || '').split('@')[0] || '';
  const namePart = String(user?.displayName || '').toLowerCase();
  let base = (emailPart || namePart || 'user')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (base.length < 3) base = 'inknote';
  const suffixSeed = String(user?.uid || Math.random().toString(36).slice(2))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const suffix = (suffixSeed.slice(-4) || '01').padStart(2, '0');
  const trimmedBase = base.slice(0, Math.max(3, 24 - 1 - suffix.length));
  const candidate = `${trimmedBase}_${suffix}`.slice(0, 24);
  return isValidHandle(candidate) ? candidate : `user_${suffix}`.slice(0, 24);
}

export function sanitizePhotoUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 500) return '';
  if (!trimmed.startsWith('https://')) return '';
  return trimmed;
}

export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API non disponibile');
  }
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function hashNormalizedEmail(email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmailFormat(normalized)) return '';
  return sha256Hex(normalized);
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  }
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < arr.length; i += step) {
    binary += String.fromCharCode(...arr.subarray(i, Math.min(i + step, arr.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  if (typeof base64 !== 'string') return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function splitBytesToBase64Chunks(bytes, chunkByteSize = CHUNK_BINARY_SIZE) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (arr.byteLength === 0) {
    throw new Error('Payload vuoto');
  }
  if (arr.byteLength > MAX_TRANSFER_BYTES) {
    throw new Error(`Il quaderno supera il limite massimo di ${formatTransferSize(MAX_TRANSFER_BYTES)}`);
  }
  const size = Math.max(1024, Math.min(CHUNK_BINARY_SIZE, chunkByteSize));
  const chunks = [];
  for (let offset = 0, index = 0; offset < arr.length; offset += size, index++) {
    const slice = arr.subarray(offset, Math.min(offset + size, arr.length));
    chunks.push({ index, data: bytesToBase64(slice) });
  }
  if (chunks.length > MAX_TRANSFER_CHUNKS) {
    throw new Error('Troppi frammenti per il trasferimento');
  }
  return chunks;
}

export function reassembleBase64Chunks(chunks) {
  const sorted = (Array.isArray(chunks) ? chunks.slice() : [])
    .filter(c => c && typeof c.data === 'string' && typeof c.index === 'number')
    .sort((a, b) => a.index - b.index);

  if (sorted.length === 0) {
    throw new Error('Dati del trasferimento mancanti');
  }

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].index !== i) {
      throw new Error(`Frammento ${i} mancante`);
    }
  }

  const decoded = sorted.map(c => base64ToBytes(c.data));
  const totalLen = decoded.reduce((sum, u) => sum + u.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of decoded) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function timestampToMs(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val instanceof Date) return val.getTime();
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val.seconds === 'number') return val.seconds * 1000;
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function computeTransferExpirationMs(createdAtMs = Date.now(), ttlMs = TRANSFER_TTL_MS) {
  return createdAtMs + ttlMs;
}

export function isTransferExpired(transfer, nowMs = Date.now()) {
  const exp = timestampToMs(transfer?.expiresAt);
  if (!exp) return false;
  return exp <= nowMs;
}

export function formatRemainingTime(expiresAt, nowMs = Date.now()) {
  const expMs = timestampToMs(expiresAt);
  if (!expMs) return '24h';
  const diff = expMs - nowMs;
  if (diff <= 0) return 'Scaduto';
  const totalMinutes = Math.floor(diff / 60000);
  if (totalMinutes < 1) return '< 1m';
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatTransferSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function classifyInboxTransfers(transfers, nowMs = Date.now()) {
  const activePending = [];
  const expiredIds = [];

  for (const t of (Array.isArray(transfers) ? transfers : [])) {
    if (!t || !t.id) continue;
    if (t.status === 'uploading') continue;
    if (t.status !== 'pending' || isTransferExpired(t, nowMs)) {
      expiredIds.push(t.id);
      continue;
    }
    activePending.push(t);
  }

  activePending.sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt));
  return { activePending, expiredIds };
}

export function classifyOutgoingTransfers(transfers, nowMs = Date.now()) {
  const activeSent = [];
  const cleanupIds = [];

  for (const t of (Array.isArray(transfers) ? transfers : [])) {
    if (!t || !t.id) continue;
    if (t.status === 'uploading') {
      // Aborted upload older than 10 minutes -> clean up
      const age = nowMs - timestampToMs(t.createdAt);
      if (age > 10 * 60 * 1000) {
        cleanupIds.push(t.id);
      }
      continue;
    }
    if (t.status !== 'pending' || isTransferExpired(t, nowMs)) {
      cleanupIds.push(t.id);
      continue;
    }
    activeSent.push(t);
  }

  activeSent.sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt));
  return { activeSent, cleanupIds };
}

export function checkOutgoingTransferQuota(activeTransfers, pendingToSendCount = 1, maxAllowed = MAX_OUTGOING_TRANSFERS) {
  const currentCount = Array.isArray(activeTransfers)
    ? activeTransfers.length
    : Math.max(0, Number(activeTransfers) || 0);
  const requested = Math.max(1, Number(pendingToSendCount) || 1);
  const limit = Math.max(1, Number(maxAllowed) || MAX_OUTGOING_TRANSFERS);
  const remaining = Math.max(0, limit - currentCount);
  return {
    allowed: currentCount + requested <= limit,
    currentCount,
    requested,
    remaining,
    limit
  };
}

export function extractGoogleContactCandidates(connections) {
  const byEmail = new Map();
  for (const person of (Array.isArray(connections) ? connections : [])) {
    if (!person || typeof person !== 'object') continue;
    const emails = Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
    const primaryName = person.names?.find(n => n?.displayName)?.displayName || '';
    const primaryPhoto = sanitizePhotoUrl(person.photos?.find(p => p?.url && !p.default)?.url || '');

    for (const emailObj of emails) {
      const normalized = normalizeEmail(emailObj?.value || '');
      if (!isValidEmailFormat(normalized)) continue;
      if (!byEmail.has(normalized)) {
        byEmail.set(normalized, {
          email: normalized,
          name: primaryName || normalized.split('@')[0],
          photoURL: primaryPhoto
        });
      }
    }
  }
  return Array.from(byEmail.values());
}

export function buildUniqueReceivedTitle(rawTitle, existingTitles) {
  const base = String(rawTitle || '').trim() || 'Quaderno ricevuto';
  const taken = new Set(
    Array.from(existingTitles || []).map(t => String(t || '').trim().toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;

  let n = 2;
  let candidate = `${base} (${n})`;
  while (taken.has(candidate.toLowerCase())) {
    n++;
    candidate = `${base} (${n})`;
  }
  return candidate;
}

export function parseInviteHandleFromUrl(searchStr) {
  try {
    const params = new URLSearchParams(searchStr || '');
    const raw = params.get('addFriend') || params.get('friend') || '';
    const handle = normalizeHandle(raw);
    return isValidHandle(handle) ? handle : '';
  } catch {
    return '';
  }
}

export function hasOAuthScope(scopeString, requiredScope) {
  if (typeof scopeString !== 'string' || typeof requiredScope !== 'string') return false;
  const required = requiredScope.trim();
  if (!required) return false;
  const granted = scopeString.trim().split(/\s+/).filter(Boolean);
  return granted.includes(required);
}

export function classifyPeopleApiError(status, payload, projectId = '') {
  const errObj = payload && typeof payload === 'object' ? (payload.error || payload) : null;
  const rawMessage = typeof errObj?.message === 'string' ? errObj.message.trim() : '';
  const lower = rawMessage.toLowerCase();

  const details = Array.isArray(errObj?.details) ? errObj.details : [];
  const errors = Array.isArray(errObj?.errors) ? errObj.errors : [];
  const reasonsList = [
    ...details.map(d => d?.reason).filter(Boolean),
    ...errors.map(e => e?.reason).filter(Boolean)
  ];
  const reasons = new Set(reasonsList);
  const primaryReason = reasonsList[0] || errObj?.status || '';
  const diagTag = primaryReason ? `[HTTP ${status} · ${primaryReason}]` : `[HTTP ${status}]`;

  if (
    reasons.has('SERVICE_DISABLED') ||
    reasons.has('accessNotConfigured') ||
    lower.includes('has not been used in project') ||
    (lower.includes('people api') && lower.includes('disabled'))
  ) {
    const projSuffix = projectId ? ` (${projectId})` : '';
    return {
      kind: 'api_disabled',
      retryableWithRefresh: false,
      message: `Google People API non abilitata sul progetto${projSuffix} ${diagTag}.`
    };
  }

  if (
    status === 403 && (
      reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
      reasons.has('insufficientPermissions') ||
      lower.includes('insufficient authentication scopes') ||
      lower.includes('insufficient permission')
    )
  ) {
    return {
      kind: 'scope_missing',
      retryableWithRefresh: true,
      message: `Permesso di lettura dei Contatti Google non concesso: spunta la casella dei contatti nella finestra di Google e riprova ${diagTag}.`
    };
  }

  if (status === 401 || errObj?.status === 'UNAUTHENTICATED') {
    return {
      kind: 'unauthenticated',
      retryableWithRefresh: true,
      message: `Sessione Contatti Google scaduta o non autorizzata: riprova ${diagTag}.`
    };
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      retryableWithRefresh: true,
      message: rawMessage
        ? `Accesso ai Contatti Google negato: ${rawMessage} ${diagTag}`
        : `Accesso ai Contatti Google non autorizzato ${diagTag}.`
    };
  }

  return {
    kind: 'other',
    retryableWithRefresh: false,
    message: rawMessage
      ? `Errore lettura Contatti Google (${status}): ${rawMessage}`
      : `Errore lettura Contatti Google (${status})`
  };
}

export function formatAuthErrorMessage(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Autorizzazione Google annullata.';
  }
  if (code === 'auth/popup-blocked') {
    return 'Popup bloccato dal browser: consenti i popup per questo sito e riprova.';
  }
  if (code === 'auth/user-mismatch') {
    return 'Hai selezionato un account Google diverso da quello attivo. Usa lo stesso account e riprova.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'Dominio non autorizzato in Firebase Authentication.';
  }
  if (code === 'auth/api-key-not-valid' || code === 'auth/invalid-api-key' || msg.includes('API_KEY_INVALID')) {
    return 'Configurazione Firebase API Key non valida: verifica le variabili Firebase o firebase-applet-config.json.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Errore di rete durante l’accesso Google: verifica la connessione e riprova.';
  }
  if (code === 'auth/operation-not-supported-in-this-environment') {
    return 'Accesso Google non supportato in questo contesto browser.';
  }
  return '';
}

export function sanitizeFirebaseConfigValue(raw) {
  if (typeof raw !== 'string') return '';
  let val = raw.trim();
  // Rimuove eventuali punto e virgola finali e virgolette esterne copiate da snippet JS
  for (let i = 0; i < 3; i++) {
    const prev = val;
    val = val.replace(/;+$/g, '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).trim();
    }
    if (val === prev) break;
  }
  return val;
}

export function sanitizeFirebaseConfigObject(rawConfig) {
  const src = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  return {
    apiKey: sanitizeFirebaseConfigValue(src.apiKey),
    authDomain: sanitizeFirebaseConfigValue(src.authDomain),
    projectId: sanitizeFirebaseConfigValue(src.projectId),
    storageBucket: sanitizeFirebaseConfigValue(src.storageBucket),
    messagingSenderId: sanitizeFirebaseConfigValue(src.messagingSenderId),
    appId: sanitizeFirebaseConfigValue(src.appId),
    firestoreDatabaseId: sanitizeFirebaseConfigValue(src.firestoreDatabaseId)
  };
}

export function selectActiveFirebaseConfig({
  envConfig = null,
  appletConfig = null
} = {}) {
  const cleanEnv = sanitizeFirebaseConfigObject(envConfig);
  const cleanApplet = sanitizeFirebaseConfigObject(appletConfig);

  const hasEnvConfig = Boolean(cleanEnv.apiKey && cleanEnv.projectId && cleanEnv.appId);
  const hasAppletConfig = Boolean(
    cleanApplet.apiKey &&
    cleanApplet.projectId &&
    cleanApplet.appId &&
    cleanApplet.projectId !== 'remixed-project-id'
  );

  // Usa sempre VITE_FIREBASE_* (sanitizzate) se configurate in tutti gli ambienti
  // (preview AI Studio, localhost/.env.local, build/deploy esterni), con fallback su firebase-applet-config.json.
  if (hasEnvConfig) {
    return { config: cleanEnv, source: 'env' };
  }
  if (hasAppletConfig) {
    return { config: cleanApplet, source: 'applet' };
  }
  return { config: null, source: 'none' };
}

const AI_STUDIO_NAMED_DB_REGEX = /^ai-studio-.*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveEffectiveFirestoreDatabaseId({
  projectId = '',
  firestoreDatabaseId = '',
  fromEnv = false
} = {}) {
  const rawProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  const rawDbId = typeof firestoreDatabaseId === 'string' ? firestoreDatabaseId.trim() : '';

  if (!rawDbId || rawDbId === '(default)') {
    return { databaseId: '', fallbackReason: '', ignoredDatabaseId: '' };
  }

  if (
    fromEnv &&
    rawProjectId &&
    !rawProjectId.startsWith('gen-lang-client-') &&
    AI_STUDIO_NAMED_DB_REGEX.test(rawDbId)
  ) {
    return {
      databaseId: '',
      fallbackReason: 'ai_studio_db_on_external_project',
      ignoredDatabaseId: rawDbId
    };
  }

  return { databaseId: rawDbId, fallbackReason: '', ignoredDatabaseId: '' };
}

export function formatFirestoreErrorMessage(
  err,
  { projectId = '', databaseId = '', fallback = 'Operazione non riuscita' } = {}
) {
  const raw = typeof err?.message === 'string' ? err.message.trim() : '';
  let text = raw;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.error === 'string') text = parsed.error.trim();
    } catch {
      // ignore malformed JSON
    }
  }

  const lower = text.toLowerCase();
  const dbLabel = databaseId || '(default)';
  const ctxSuffix = projectId ? ` (${projectId} · db: ${dbLabel})` : '';

  if (
    lower.includes('missing or insufficient permissions') ||
    lower.includes('permission_denied') ||
    lower.includes('permission denied')
  ) {
    return `Permessi Firestore mancanti${ctxSuffix}: pubblica firestore.rules su questo progetto Firebase.`;
  }

  if (lower.includes('client is offline') || lower.includes('unavailable')) {
    return `Impossibile raggiungere Firestore${ctxSuffix}: verifica la connessione internet oppure controlla che il database esista su Firebase (es. VITE_FIREBASE_DATABASE_ID).`;
  }

  if (lower.includes('not_found') || (lower.includes('database') && lower.includes('not found'))) {
    return `Database Firestore non trovato${ctxSuffix}: verifica che Firestore sia stato creato sul progetto.`;
  }

  return text || fallback;
}


