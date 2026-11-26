/**
 * @module components/modal
 *
 * Controller unificato per tutte le modali dell'app:
 *   - Stack LIFO delle modali aperte (Escape, backdrop e tasto Indietro agiscono solo sulla cima).
 *   - Gestione sicura del backdrop (ignora drag partiti dentro il contenuto e rilasciati fuori).
 *   - Supporto Escape garantito anche quando il focus è dentro input, select o textarea.
 *   - Attributi ARIA standard (`role="dialog"`, `aria-modal="true"`).
 *   - Ripristino automatico del focus al elemento attivo precedente alla chiusura.
 *   - Supporto per modali bloccanti non chiudibili (es. progress dialog o export PDF attivo).
 */

export function createModalManager({
  documentObj = typeof document !== 'undefined' ? document : null
} = {}) {
  const _openStack = [];
  const _registered = new Set();
  let _keyListenerBound = false;

  const _removeFromStack = (entry) => {
    const idx = _openStack.indexOf(entry);
    if (idx !== -1) _openStack.splice(idx, 1);
  };

  const _handleKeyDown = (e) => {
    if (e.key !== 'Escape' || _openStack.length === 0) return;

    const top = _openStack[_openStack.length - 1];
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    if (top.options.closeOnEscape && top.canClose('escape')) {
      top.close('escape');
    }
  };

  const _ensureGlobalKeyListener = () => {
    if (_keyListenerBound || !documentObj || typeof documentObj.addEventListener !== 'function') return;
    documentObj.addEventListener('keydown', _handleKeyDown, true);
    _keyListenerBound = true;
  };

  const _resolveFocusTarget = (initialFocus, element) => {
    if (!initialFocus) return null;
    if (typeof initialFocus === 'function') return initialFocus(element);
    if (typeof initialFocus === 'string') {
      return element?.querySelector?.(initialFocus) || documentObj?.querySelector?.(initialFocus) || null;
    }
    return initialFocus;
  };

  function registerModal(element, options = {}) {
    if (!element) {
      return {
        id: options.id || '',
        element: null,
        open: () => false,
        close: () => false,
        isOpen: () => false,
        updateOptions: () => {},
        destroy: () => {}
      };
    }

    const resolvedOptions = {
      id: options.id || element.id || `modal_${_registered.size + 1}`,
      removeOnClose: Boolean(options.removeOnClose),
      displayClass: options.displayClass !== undefined ? options.displayClass : 'flex',
      closeOnEscape: options.closeOnEscape !== false,
      closeOnBackdrop: options.closeOnBackdrop !== false,
      closeOnBack: options.closeOnBack !== false,
      canClose: typeof options.canClose === 'function' ? options.canClose : () => true,
      initialFocus: options.initialFocus ?? null,
      restoreFocus: options.restoreFocus !== false,
      ariaLabel: options.ariaLabel ?? null,
      ariaBusy: Boolean(options.ariaBusy),
      onOpen: typeof options.onOpen === 'function' ? options.onOpen : null,
      onClose: typeof options.onClose === 'function' ? options.onClose : null
    };

    if (typeof element.hasAttribute === 'function' && typeof element.setAttribute === 'function') {
      if (!element.hasAttribute('role')) element.setAttribute('role', 'dialog');
      if (!element.hasAttribute('aria-modal')) element.setAttribute('aria-modal', 'true');
      if (resolvedOptions.ariaLabel && !element.hasAttribute('aria-label')) {
        element.setAttribute('aria-label', resolvedOptions.ariaLabel);
      }
      if (resolvedOptions.ariaBusy) {
        element.setAttribute('aria-busy', 'true');
      }
    }

    let _isOpen = false;
    let _destroyed = false;
    let _previousActiveElement = null;
    let _pointerDownInside = false;
    let _resetPointerTimer = null;

    const entry = {
      id: resolvedOptions.id,
      element,
      options: resolvedOptions,
      canClose: (reason) => {
        try {
          return entry.options.canClose(reason) !== false;
        } catch {
          return true;
        }
      },
      close: null
    };

    const _clearResetTimer = () => {
      if (_resetPointerTimer !== null) {
        clearTimeout(_resetPointerTimer);
        _resetPointerTimer = null;
      }
    };

    const onPointerDown = (e) => {
      _clearResetTimer();
      _pointerDownInside = e.target !== element;
    };

    const onPointerEnd = () => {
      _clearResetTimer();
      _resetPointerTimer = setTimeout(() => {
        _pointerDownInside = false;
        _resetPointerTimer = null;
      }, 0);
    };

    const onClick = (e) => {
      if (!_isOpen || e.target !== element) return;
      if (_pointerDownInside) {
        _pointerDownInside = false;
        return;
      }
      if (entry.options.closeOnBackdrop && entry.canClose('backdrop')) {
        close('backdrop');
      }
    };

    if (typeof element.addEventListener === 'function') {
      element.addEventListener('pointerdown', onPointerDown);
      element.addEventListener('pointerup', onPointerEnd);
      element.addEventListener('pointercancel', onPointerEnd);
      element.addEventListener('click', onClick);
    }

    const open = () => {
      if (_destroyed) return false;
      _ensureGlobalKeyListener();

      if (_isOpen) {
        // Porta comunque in cima allo stack se riaperta
        _removeFromStack(entry);
        _openStack.push(entry);
        return false;
      }

      _previousActiveElement = documentObj?.activeElement || null;

      if (entry.options.removeOnClose && documentObj?.body && !element.parentNode && typeof documentObj.body.appendChild === 'function') {
        documentObj.body.appendChild(element);
      } else if (!entry.options.removeOnClose && element.classList) {
        element.classList.remove('hidden');
        if (entry.options.displayClass) {
          element.classList.add(entry.options.displayClass);
        }
      }

      _isOpen = true;
      _removeFromStack(entry);
      _openStack.push(entry);

      if (entry.options.onOpen) {
        entry.options.onOpen(controller);
      }

      const focusTarget = _resolveFocusTarget(entry.options.initialFocus, element);
      if (focusTarget && typeof focusTarget.focus === 'function') {
        try {
          focusTarget.focus();
        } catch {}
      }

      return true;
    };

    const close = (reason = 'programmatic', result = undefined) => {
      if (!_isOpen) return false;
      _isOpen = false;
      _pointerDownInside = false;
      _clearResetTimer();
      _removeFromStack(entry);

      if (entry.options.removeOnClose) {
        if (typeof element.remove === 'function') {
          element.remove();
        } else if (element.parentNode && typeof element.parentNode.removeChild === 'function') {
          element.parentNode.removeChild(element);
        }
      } else if (element.classList) {
        element.classList.add('hidden');
        if (entry.options.displayClass) {
          element.classList.remove(entry.options.displayClass);
        }
      }

      const prevEl = _previousActiveElement;
      _previousActiveElement = null;
      if (
        entry.options.restoreFocus &&
        prevEl &&
        typeof prevEl.focus === 'function' &&
        (!documentObj || typeof documentObj.contains !== 'function' || documentObj.contains(prevEl))
      ) {
        try {
          prevEl.focus();
        } catch {}
      }

      if (entry.options.onClose) {
        entry.options.onClose(reason, result);
      }

      if (entry.options.removeOnClose) {
        destroyListenersOnly();
      }

      return true;
    };

    const destroyListenersOnly = () => {
      if (_destroyed) return;
      _destroyed = true;
      _clearResetTimer();
      _registered.delete(entry);
      if (typeof element.removeEventListener === 'function') {
        element.removeEventListener('pointerdown', onPointerDown);
        element.removeEventListener('pointerup', onPointerEnd);
        element.removeEventListener('pointercancel', onPointerEnd);
        element.removeEventListener('click', onClick);
      }
    };

    entry.close = close;
    _registered.add(entry);

    const controller = {
      id: entry.id,
      element,
      open,
      close,
      isOpen: () => _isOpen,
      updateOptions: (patch = {}) => {
        if (patch && typeof patch === 'object') {
          Object.assign(entry.options, patch);
          if (typeof patch.canClose === 'function') {
            entry.options.canClose = patch.canClose;
          }
        }
      },
      destroy: () => {
        if (_isOpen) close('destroy');
        else destroyListenersOnly();
      }
    };

    return controller;
  }

  function openModalOverlay(element, options = {}) {
    const ctrl = registerModal(element, {
      ...options,
      removeOnClose: true
    });
    ctrl.open();
    return ctrl;
  }

  function closeTopModal(reason = 'dismiss') {
    if (_openStack.length === 0) return null;
    const top = _openStack[_openStack.length - 1];
    if (reason === 'back' && top.options.closeOnBack === false) {
      return { handled: true, closed: false, blocked: true, id: top.id };
    }
    if (!top.canClose(reason)) {
      return { handled: true, closed: false, blocked: true, id: top.id };
    }
    const closed = top.close(reason);
    return { handled: true, closed, blocked: !closed, id: top.id };
  }

  function isAnyModalOpen() {
    return _openStack.length > 0;
  }

  function isModalOpen(idOrElement) {
    if (!idOrElement) return false;
    return _openStack.some((entry) => entry.id === idOrElement || entry.element === idOrElement);
  }

  function getTopModalId() {
    if (_openStack.length === 0) return null;
    return _openStack[_openStack.length - 1].id;
  }

  function destroy() {
    while (_openStack.length > 0) {
      const top = _openStack[_openStack.length - 1];
      top.close('destroy');
    }
    if (_keyListenerBound && documentObj && typeof documentObj.removeEventListener === 'function') {
      documentObj.removeEventListener('keydown', _handleKeyDown, true);
      _keyListenerBound = false;
    }
    _registered.clear();
  }

  return {
    registerModal,
    openModalOverlay,
    closeTopModal,
    isAnyModalOpen,
    isModalOpen,
    getTopModalId,
    destroy
  };
}

const _defaultManager = createModalManager();

export const registerModal = (...args) => _defaultManager.registerModal(...args);
export const openModalOverlay = (...args) => _defaultManager.openModalOverlay(...args);
export const closeTopModal = (...args) => _defaultManager.closeTopModal(...args);
export const isAnyModalOpen = (...args) => _defaultManager.isAnyModalOpen(...args);
export const isModalOpen = (...args) => _defaultManager.isModalOpen(...args);
export const getTopModalId = (...args) => _defaultManager.getTopModalId(...args);
