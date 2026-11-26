/**
 * @module components/floating-menu
 *
 * Componente globale riutilizzabile per i menu flottanti (`<ink-menu>` / `.ui-menu`):
 *   - Applica automaticamente gli stili globali `.ui-menu` e gestisce il proprio
 *     backdrop sfocato `.ui-menu-backdrop` (senza markup duplicato).
 *   - Posiziona il pannello rispetto al trigger con clamping e flip automatico.
 *   - Garantisce mutua esclusione tra tutti i menu e i popover registrati.
 *   - Gestisce resize, Escape, backdrop click/pointerdown (bloccando tocchi
 *     accidentali sul canvas sottostante) e attributi ARIA.
 */

import { computeFloatingMenuPosition } from './floating-menu-position.js';

export class InkMenuElement extends HTMLElement {
  connectedCallback() {
    this.classList.add('ui-menu');
    if (!this.hasAttribute('role')) {
      this.setAttribute('role', 'menu');
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('ink-menu')) {
  customElements.define('ink-menu', InkMenuElement);
}

const _controllers = new Set();
const _externalClosers = new Map();
let _globalListenersBound = false;

function _ensureBackdrop(panel, backdropOpt) {
  if (backdropOpt === false) return null;
  if (backdropOpt instanceof HTMLElement) {
    backdropOpt.classList.add('ui-menu-backdrop');
    return backdropOpt;
  }

  const prev = panel.previousElementSibling;
  if (prev && prev.classList.contains('ui-menu-backdrop')) {
    return prev;
  }

  const el = document.createElement('div');
  el.className = 'ui-menu-backdrop hidden';
  el.setAttribute('aria-hidden', 'true');
  if (panel.id) el.dataset.menuBackdropFor = panel.id;
  panel.parentNode?.insertBefore(el, panel);
  return el;
}

function _bindGlobalListenersOnce() {
  if (_globalListenersBound || typeof window === 'undefined') return;
  _globalListenersBound = true;

  window.addEventListener('resize', () => {
    for (const ctrl of _controllers) {
      if (ctrl.isOpen()) ctrl.reposition();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    for (const ctrl of _controllers) {
      if (!ctrl.isOpen()) continue;
      if (ctrl.containsTarget(e.target)) continue;
      ctrl.close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    let closedAny = false;
    for (const ctrl of _controllers) {
      if (ctrl.isOpen()) {
        ctrl.close();
        closedAny = true;
      }
    }
    if (closedAny) e.stopPropagation();
  });
}

/**
 * Registra un popover esterno (es. colorPickerPopover, pagePopover) nel sistema
 * di mutua esclusione dei menu.
 *
 * @param {string} id
 * @param {() => void} closeFn
 */
export function registerExternalMenuCloser(id, closeFn) {
  if (!id || typeof closeFn !== 'function') return;
  _externalClosers.set(id, closeFn);
}

/**
 * Chiude tutti i menu flottanti (e popover esterni registrati),
 * escludendo eventualmente un controller o id specifico.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.except=null]
 * @param {string|null} [opts.exceptId=null]
 */
export function closeAllFloatingMenus({ except = null, exceptId = null } = {}) {
  for (const ctrl of _controllers) {
    if (ctrl === except || (exceptId && ctrl.id === exceptId)) continue;
    if (ctrl.isOpen()) ctrl.close();
  }
  for (const [id, closeFn] of _externalClosers.entries()) {
    if (exceptId && id === exceptId) continue;
    closeFn();
  }
}

/**
 * Chiude un singolo menu registrato per id.
 * @param {string} id
 */
export function closeFloatingMenuById(id) {
  for (const ctrl of _controllers) {
    if (ctrl.id === id) ctrl.close();
  }
}

/**
 * Verifica se almeno un menu gestito è aperto (opzionalmente filtrato per id).
 * @param {string} [id]
 * @returns {boolean}
 */
export function isFloatingMenuOpen(id) {
  for (const ctrl of _controllers) {
    if (id) {
      if (ctrl.id === id) return ctrl.isOpen();
    } else if (ctrl.isOpen()) {
      return true;
    }
  }
  return false;
}

/**
 * Collega un elemento menu flottante (es. `<ink-menu>` o `<div class="ui-menu">`)
 * al sistema centralizzato di apertura, posizionamento, backdrop e mutua esclusione.
 *
 * @param {object} config
 * @param {string} [config.id]
 * @param {HTMLElement} config.panel
 * @param {HTMLElement|(() => HTMLElement|null)|null} [config.trigger=null]
 * @param {HTMLElement|boolean} [config.backdrop=true]
 * @param {'start'|'center'|'end'} [config.align='end']
 * @param {number} [config.gap=8]
 * @param {number} [config.margin=8]
 * @param {boolean} [config.bindTriggerClick=false]
 * @param {(ctrl: object) => void} [config.onOpen]
 * @param {(ctrl: object) => void} [config.onClose]
 */
export function createFloatingMenu({
  id = '',
  panel,
  trigger = null,
  backdrop = true,
  align = 'end',
  gap = 8,
  margin = 8,
  bindTriggerClick = false,
  onOpen = null,
  onClose = null
}) {
  if (!panel) {
    return {
      id,
      open: () => {},
      close: () => {},
      toggle: () => {},
      isOpen: () => false,
      reposition: () => {},
      containsTarget: () => false,
      destroy: () => {}
    };
  }

  _bindGlobalListenersOnce();

  panel.classList.add('ui-menu');
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'menu');

  const getTrigger = () => (typeof trigger === 'function' ? trigger() : trigger);
  const backdropEl = _ensureBackdrop(panel, backdrop);
  const resolvedId = id || panel.id || '';

  const initTriggerEl = getTrigger();
  if (initTriggerEl) {
    if (!initTriggerEl.hasAttribute('aria-haspopup')) {
      initTriggerEl.setAttribute('aria-haspopup', 'menu');
    }
    initTriggerEl.setAttribute('aria-expanded', 'false');
  }

  const isOpen = () => !panel.classList.contains('hidden');

  const reposition = () => {
    const triggerEl = getTrigger();
    if (!triggerEl) return;
    const triggerRect = triggerEl.getBoundingClientRect();
    const pos = computeFloatingMenuPosition({
      triggerRect,
      menuWidth: panel.offsetWidth || 256,
      menuHeight: panel.offsetHeight || 240,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      align,
      gap,
      margin
    });
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
  };

  const close = () => {
    const wasOpen = isOpen();
    panel.classList.add('hidden');
    if (backdropEl) backdropEl.classList.add('hidden');
    const triggerEl = getTrigger();
    if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
    if (wasOpen && typeof onClose === 'function') {
      onClose(controller);
    }
  };

  const open = () => {
    closeAllFloatingMenus({ except: controller, exceptId: resolvedId || null });
    document.getElementById('eraserCursor')?.classList.remove('visible');
    if (typeof onOpen === 'function') {
      onOpen(controller);
    }
    if (backdropEl) backdropEl.classList.remove('hidden');
    panel.classList.remove('hidden');
    const triggerEl = getTrigger();
    if (triggerEl) triggerEl.setAttribute('aria-expanded', 'true');
    reposition();
  };

  const toggle = () => {
    if (isOpen()) close();
    else open();
  };

  const containsTarget = (target) => {
    if (!target) return false;
    const triggerEl = getTrigger();
    return panel.contains(target) || (triggerEl ? triggerEl.contains(target) : false);
  };

  const onBackdropPointerDown = (e) => {
    // Impedisce che il tap sullo sfondo sfocato raggiunga il canvas sotto il backdrop.
    e.stopPropagation();
  };

  const onBackdropClick = (e) => {
    e.stopPropagation();
    close();
  };

  const onTriggerClick = (e) => {
    e.stopPropagation();
    toggle();
  };

  if (backdropEl) {
    backdropEl.addEventListener('pointerdown', onBackdropPointerDown);
    backdropEl.addEventListener('click', onBackdropClick);
  }

  if (bindTriggerClick && initTriggerEl) {
    initTriggerEl.addEventListener('click', onTriggerClick);
  }

  const controller = {
    id: resolvedId,
    panel,
    backdrop: backdropEl,
    open,
    close,
    toggle,
    isOpen,
    reposition,
    containsTarget,
    destroy: () => {
      close();
      _controllers.delete(controller);
      if (backdropEl) {
        backdropEl.removeEventListener('pointerdown', onBackdropPointerDown);
        backdropEl.removeEventListener('click', onBackdropClick);
      }
      if (bindTriggerClick && initTriggerEl) {
        initTriggerEl.removeEventListener('click', onTriggerClick);
      }
    }
  };

  _controllers.add(controller);
  return controller;
}
