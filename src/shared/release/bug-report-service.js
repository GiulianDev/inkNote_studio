/**
 * @module shared/release/bug-report-service
 *
 * Gestisce l'invio atomico delle segnalazioni bug verso Firestore (/bug_reports +
 * /bug_rate_limits) con Firebase Anonymous Auth trasparente dietro le quinte.
 */

import {
  doc,
  getDoc,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';
import {
  db,
  ensureBugReportAuth,
  isFirestoreReady
} from '../services/firebase.js';
import {
  BUG_COOLDOWN_MS,
  BUG_DESC_MAX_LENGTH,
  BUG_DESC_MIN_LENGTH,
  BUG_MAX_PER_DAY,
  buildBugFirestorePayload,
  classifyBugSubmitError,
  evaluateClientAntiSpam,
  formatCooldownWait,
  generateBugReportId,
  writeBugGuardHistory
} from './bug-report-helpers.js';

export {
  BUG_DESC_MAX_LENGTH,
  BUG_DESC_MIN_LENGTH,
  evaluateClientAntiSpam
};

export async function submitBugReport({
  description,
  diagnostics,
  honeypotValue = '',
  panelOpenedAt = 0,
  now = Date.now(),
  storage = globalThis.localStorage
} = {}) {
  const guard = evaluateClientAntiSpam({
    description,
    honeypotValue,
    panelOpenedAt,
    now,
    storage
  });
  if (!guard.ok) {
    const err = new Error(guard.message);
    err.code = guard.code;
    err.isUserValidation = true;
    throw err;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const err = new Error('Sei offline: impossibile inviare ora. Usa "Copia report".');
    err.code = 'offline';
    err.isUserValidation = true;
    throw err;
  }

  if (!isFirestoreReady()) {
    const err = new Error('Servizio cloud non configurato. Usa "Copia report".');
    err.code = 'not-configured';
    err.isUserValidation = true;
    throw err;
  }

  let user;
  try {
    user = await ensureBugReportAuth();
  } catch (err) {
    const friendly = new Error(classifyBugSubmitError(err));
    friendly.cause = err;
    friendly.code = err?.code || 'auth-failed';
    throw friendly;
  }

  const reportId = generateBugReportId();
  const rateRef = doc(db, 'bug_rate_limits', user.uid);
  const reportRef = doc(db, 'bug_reports', reportId);

  let rateSnap;
  try {
    rateSnap = await getDoc(rateRef);
  } catch (err) {
    const friendly = new Error(classifyBugSubmitError(err, 'rules-check'));
    friendly.cause = err;
    friendly.code = err?.code || 'rules-check-failed';
    throw friendly;
  }

  try {
    if (rateSnap.exists()) {
      const serverLastMs = rateSnap.data()?.lastReportAt?.toMillis?.() || 0;
      if (serverLastMs > 0 && (now - serverLastMs) < BUG_COOLDOWN_MS) {
        const waitMs = BUG_COOLDOWN_MS - (now - serverLastMs);
        const mergedTimestamps = [...guard.history.timestamps.filter((t) => t !== serverLastMs), serverLastMs]
          .sort((a, b) => a - b)
          .slice(-BUG_MAX_PER_DAY);
        writeBugGuardHistory({
          timestamps: mergedTimestamps,
          lastTextHash: guard.history.lastTextHash
        }, storage);
        const cooldownErr = new Error(`Attendi ancora ${formatCooldownWait(waitMs)} prima di inviare un'altra segnalazione.`);
        cooldownErr.code = 'server-cooldown';
        cooldownErr.isUserValidation = true;
        throw cooldownErr;
      }
    }

    const payload = buildBugFirestorePayload({
      reportId,
      user,
      description: guard.text,
      diagnostics
    });

    const batch = writeBatch(db);
    batch.set(reportRef, {
      ...payload,
      createdAt: serverTimestamp()
    });
    if (rateSnap.exists()) {
      batch.update(rateRef, {
        lastReportAt: serverTimestamp(),
        lastReportId: reportId
      });
    } else {
      batch.set(rateRef, {
        uid: user.uid,
        lastReportAt: serverTimestamp(),
        lastReportId: reportId
      });
    }

    await batch.commit();
  } catch (err) {
    if (err?.isUserValidation) throw err;
    const friendly = new Error(classifyBugSubmitError(err, 'commit'));
    friendly.cause = err;
    friendly.code = err?.code || 'submit-failed';
    throw friendly;
  }

  writeBugGuardHistory({
    timestamps: [...guard.history.timestamps, now].slice(-BUG_MAX_PER_DAY),
    lastTextHash: guard.textHash
  }, storage);

  return { reportId };
}
