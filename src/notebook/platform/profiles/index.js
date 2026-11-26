/**
 * @module notebook/platform/profiles/index
 *
 * Registro e selettore centrale dei profili dispositivo (`desktop`, `ios`, `android`).
 * Selezionato allo startup tramite `state.platform.family` senza duplicare i motori.
 */

import { desktopProfile } from './desktop.js';
import { iosProfile } from './ios.js';
import { androidProfile } from './android.js';

const PROFILES = Object.freeze({
  desktop: desktopProfile,
  ios: iosProfile,
  android: androidProfile
});

let _activeProfile = desktopProfile;

/**
 * Normalizza un valore di piattaforma (stringa `'ios'|'android'|'desktop'`
 * oppure oggetto `state.platform`) nella chiave di profilo valida.
 */
export function resolveProfileFamily(familyOrPlatform) {
  const raw = (familyOrPlatform && typeof familyOrPlatform === 'object')
    ? familyOrPlatform.family
    : familyOrPlatform;
  if (raw === 'ios' || raw === 'android') return raw;
  return 'desktop';
}

/**
 * Restituisce il profilo associato alla famiglia richiesta (default `'desktop'`).
 */
export function getDeviceProfile(familyOrPlatform = 'desktop') {
  const key = resolveProfileFamily(familyOrPlatform);
  return PROFILES[key] || desktopProfile;
}

/**
 * Inizializza il profilo attivo allo startup (e lo restituisce).
 */
export function initDeviceProfile(platformState) {
  _activeProfile = getDeviceProfile(platformState);
  return _activeProfile;
}

/**
 * Restituisce l'ultimo profilo attivo inizializzato (o il fallback corrispondente
 * se passato `familyOrPlatform`).
 */
export function getActiveDeviceProfile(familyOrPlatform) {
  if (familyOrPlatform !== undefined && familyOrPlatform !== null) {
    return getDeviceProfile(familyOrPlatform);
  }
  return _activeProfile;
}

export { desktopProfile, iosProfile, androidProfile };
