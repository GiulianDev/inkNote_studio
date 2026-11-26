/**
 * @module core/system-menu-guard
 *
 * Disabilita il menu contestuale di sistema (Windows, macOS/iPadOS, Android),
 * i callout di selezione su long-press e il drag nativo HTML5 su foglio e menu,
 * preservando la normale selezione del testo nei campi editabili.
 */

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden',
  'image', 'radio', 'range', 'reset', 'submit'
]);

/**
 * Riconosce elementi in cui è consentita la selezione testo (caselle di testo,
 * titolo documento, campi di ricerca e input nei modali).
 */
export function isEditableElement(target) {
  if (!target || typeof target !== 'object') return false;

  const el = typeof target.closest === 'function'
    ? target.closest('input, textarea, select, [contenteditable]')
    : target;
  if (!el || typeof el.tagName !== 'string') return false;

  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
  return ce === '' || ce === 'true' || Boolean(el.isContentEditable);
}

/**
 * Determina se un evento nativo (`contextmenu`, `selectstart`, `dragstart`)
 * debba essere bloccato per impedire l'apertura di menu di sistema / drag fantasma.
 */
export function shouldSuppressNativeEvent(eventType, target) {
  if (eventType === 'contextmenu') return true;
  if (eventType === 'selectstart' || eventType === 'dragstart') {
    return !isEditableElement(target);
  }
  return false;
}

/**
 * Registra i listener globali in fase di capture su `win`.
 * @returns {() => void} funzione di cleanup
 */
export function setupSystemMenuSuppression(win = window) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};

  const onContextMenu = (e) => {
    if (shouldSuppressNativeEvent('contextmenu', e.target)) {
      e.preventDefault();
    }
  };

  const onSelectStart = (e) => {
    if (shouldSuppressNativeEvent('selectstart', e.target)) {
      e.preventDefault();
    }
  };

  const onDragStart = (e) => {
    if (shouldSuppressNativeEvent('dragstart', e.target)) {
      e.preventDefault();
    }
  };

  win.addEventListener('contextmenu', onContextMenu, { capture: true });
  win.addEventListener('selectstart', onSelectStart, { capture: true });
  win.addEventListener('dragstart', onDragStart, { capture: true });

  return () => {
    win.removeEventListener('contextmenu', onContextMenu, { capture: true });
    win.removeEventListener('selectstart', onSelectStart, { capture: true });
    win.removeEventListener('dragstart', onDragStart, { capture: true });
  };
}
