/**
 * @module pages/notebook-page
 *
 * Pagina Quaderno — monta nel DOM il workspace del quaderno aperto
 * (`#toolbarMount`, `#viewport`, barra flottante lazo, undo/redo, zoom badge).
 */

import notebookPageHtml from './notebook-page.html?raw';

let _mounted = false;

export function mountNotebookPage() {
  if (_mounted || document.getElementById('viewport')) {
    _mounted = true;
    return;
  }

  const mountTarget = document.getElementById('notebookPageMount');
  if (mountTarget) {
    mountTarget.innerHTML = notebookPageHtml;
  } else {
    const toast = document.getElementById('toastNotification');
    if (toast && toast.parentElement) {
      toast.insertAdjacentHTML('beforebegin', notebookPageHtml);
    } else {
      document.body.insertAdjacentHTML('beforeend', notebookPageHtml);
    }
  }
  _mounted = true;
}
