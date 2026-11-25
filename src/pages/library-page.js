/**
 * @module pages/library-page
 *
 * Pagina Libreria — monta nel DOM il markup principale della libreria
 * (`#libraryView`) e il relativo modale di creazione quaderno (`#newNotebookModal`).
 */

import libraryPageHtml from './library-page.html?raw';

let _mounted = false;

export function mountLibraryPage() {
  if (_mounted || document.getElementById('libraryView')) {
    _mounted = true;
    return;
  }

  const mountTarget = document.getElementById('libraryPageMount');
  if (mountTarget) {
    mountTarget.innerHTML = libraryPageHtml;
  } else {
    document.body.insertAdjacentHTML('afterbegin', libraryPageHtml);
  }
  _mounted = true;
}
