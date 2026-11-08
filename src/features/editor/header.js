// ============================================================
// HEADER: solo page counter (il resto è delegato a editor.js)
// ============================================================

import { state } from '../../core/state.js';

export function updatePageCounterUI() {
  const el = document.getElementById('pageCounterText');
  if (el) el.innerText = `Pagina ${state.activePageIndex + 1} di ${state.pages.length}`;
}