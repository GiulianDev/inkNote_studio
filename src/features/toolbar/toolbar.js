// ============================================================
// TOOLBAR FEATURE — componente grafica (dock + subbar)
// Per ora espone solo `mountToolbar()`. La logica applicativa
// resta in features/editor/toolbar.js e verrà migrata qui
// gradualmente, insieme a tool-state.js.
// ============================================================

import './toolbar.css';
import toolbarHtml from './toolbar.html?raw';

let _mounted = false;

/**
 * Inietta il markup della toolbar nel DOM. Idempotente.
 * Va chiamato PRIMA di initSettings() e dei bind degli editor handler,
 * perché initSettings applica tema/subbar/compact al DOM e i bind
 * cercano gli id della toolbar (#themeToggleBtn, #subbar, ecc.).
 */
export function mountToolbar() {
  if (_mounted || document.getElementById('mainHeader')) {
    _mounted = true;
    return;
  }

  const mount = document.getElementById('toolbarMount');
  if (!mount) return;

  // insertAdjacentHTML('beforebegin') mantiene l'header/subbar come
  // figli diretti del <body>: i selettori body.compact-mode #mainHeader,
  // body.handed-left header, @media print header continuano a funzionare
  // senza modifiche.
  mount.insertAdjacentHTML('beforebegin', toolbarHtml);
  mount.remove();

  _mounted = true;
}