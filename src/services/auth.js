// ============================================================
// LOGIN GOOGLE (mock)
// ============================================================

import { showToast, showStatusBadge } from '../core/utils.js';

let currentUser = null;

export function handleGoogleLogin() {
  if (!currentUser) {
    setTimeout(() => {
      currentUser = { displayName: 'Utente Demo', email: 'demo@inknote.app' };
      _updateLoginUI();
      showToast('Accesso effettuato con successo!', '👤');
    }, 400);
  } else {
    currentUser = null;
    _updateLoginUI();
    showToast('Disconnesso', '👋');
  }
}

function _updateLoginUI() {
  const btnText = document.getElementById('googleLoginText');
  if (currentUser) {
    btnText.innerText = currentUser.displayName;
    showStatusBadge('Online (Cloud Sync)');
  } else {
    btnText.innerText = 'Accedi con Google';
    showStatusBadge('Locale');
  }
}