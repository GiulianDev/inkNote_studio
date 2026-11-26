/**
 * @module shared/components/horizontal-drag-reorder
 *
 * Helper riutilizzabile per il riordino orizzontale via Pointer Events con
 * long-press (stile iOS/Android) per barre e dock compatti.
 *
 * Gestisce:
 *  - Long-press configurabile (cancellato se ci si sposta oltre `moveCancelPx`)
 *  - Soppressione automatica del `click` al rilascio dopo un drag riuscito
 *  - Riordino live degli elementi fratelli visibili lungo l'asse X
 *  - Eventuale zona "drop fuori" verso il basso (es. per nascondere voci mainbar)
 */

const DEFAULT_LONG_PRESS_MS = 450;
const DEFAULT_MOVE_CANCEL_PX = 10;

/**
 * Trova l'elemento fratello davanti al quale inserire l'elemento trascinato.
 * Funzione pura usabile anche nei test unitari.
 *
 * @param {number} clientX
 * @param {Array<{ el: HTMLElement, left: number, width: number }>} siblingRects
 * @returns {HTMLElement|null}
 */
export function findHorizontalInsertBefore(clientX, siblingRects) {
  for (let i = 0; i < siblingRects.length; i++) {
    const item = siblingRects[i];
    if (clientX < item.left + item.width / 2) {
      return item.el;
    }
  }
  return null;
}

/**
 * Collega il riordino drag & drop orizzontale con long-press a un contenitore.
 *
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {string} options.itemSelector
 * @param {string} options.bodyDragClass
 * @param {number} [options.longPressMs=450]
 * @param {number} [options.moveCancelPx=10]
 * @param {number|null} [options.dropOutsideThresholdPx=null]
 * @param {boolean} [options.capturePointer=true]
 * @param {(el: HTMLElement) => boolean} [options.canDragItem]
 * @param {(el: HTMLElement) => boolean} [options.isItemVisible]
 * @param {(el: HTMLElement) => void} [options.onDragStart]
 * @param {(orderedEls: HTMLElement[]) => void} [options.onCommit]
 * @param {(el: HTMLElement) => void} [options.onDropOutside]
 * @returns {{ destroy: () => void }}
 */
export function createHorizontalLongPressReorder({
  container,
  itemSelector,
  bodyDragClass,
  longPressMs = DEFAULT_LONG_PRESS_MS,
  moveCancelPx = DEFAULT_MOVE_CANCEL_PX,
  dropOutsideThresholdPx = null,
  capturePointer = false,
  canDragItem = null,
  isItemVisible = (el) => el.style.display !== 'none',
  onDragStart = null,
  onCommit = null,
  onDropOutside = null
}) {
  if (!container || !itemSelector) {
    return { destroy() {} };
  }

  const drag = {
    btn: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    pressTimer: null,
    isDragging: false,
    skipNextClick: false,
    outside: false
  };

  function cancelPress() {
    if (drag.pressTimer !== null) {
      clearTimeout(drag.pressTimer);
      drag.pressTimer = null;
    }
  }

  function detachDocListeners() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
  }

  function enterDragMode(btn) {
    drag.isDragging = true;
    drag.skipNextClick = true;
    btn.classList.add('dragging');
    if (bodyDragClass) document.body.classList.add(bodyDragClass);
    if (capturePointer) {
      try { btn.setPointerCapture?.(drag.pointerId); } catch {}
    }
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
    onDragStart?.(btn);
  }

  function updateOrderAt(clientX) {
    const btn = drag.btn;
    if (!btn) return;

    const siblings = [...container.querySelectorAll(itemSelector)]
      .filter((el) => el !== btn && (!isItemVisible || isItemVisible(el)));

    const next = findHorizontalInsertBefore(
      clientX,
      siblings.map((el) => {
        const r = el.getBoundingClientRect();
        return { el, left: r.left, width: r.width };
      })
    );

    if (next) {
      container.insertBefore(btn, next);
    } else if (siblings.length > 0) {
      const last = siblings[siblings.length - 1];
      container.insertBefore(btn, last.nextSibling);
    }
  }

  function onPointerMove(e) {
    if (!drag.btn || e.pointerId !== drag.pointerId) return;

    if (!drag.isDragging) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.hypot(dx, dy) > moveCancelPx) {
        cancelPress();
        detachDocListeners();
        drag.btn = null;
        drag.pointerId = null;
      }
      return;
    }

    e.preventDefault();

    if (typeof dropOutsideThresholdPx === 'number') {
      const rect = container.getBoundingClientRect();
      const isOutside = e.clientY > rect.bottom + dropOutsideThresholdPx;
      if (isOutside !== drag.outside) {
        drag.outside = isOutside;
        container.classList.toggle('drop-outside', isOutside);
        drag.btn.classList.toggle('will-hide', isOutside);
      }
      if (isOutside) return;
    }

    updateOrderAt(e.clientX);
  }

  function resetVisuals(btn, pointerId) {
    if (capturePointer && btn && pointerId !== null) {
      try {
        if (btn.hasPointerCapture?.(pointerId)) btn.releasePointerCapture(pointerId);
      } catch {}
    }
    if (btn) btn.classList.remove('dragging', 'will-hide');
    if (bodyDragClass) document.body.classList.remove(bodyDragClass);
    container.classList.remove('drop-outside');
  }

  function onPointerUp(e) {
    if (!drag.btn || e.pointerId !== drag.pointerId) return;

    const btn = drag.btn;
    const wasDragging = drag.isDragging;
    const wasOutside = drag.outside;

    cancelPress();
    detachDocListeners();

    if (wasDragging) {
      resetVisuals(btn, e.pointerId);

      if (e.type !== 'pointercancel') {
        if (wasOutside) {
          onDropOutside?.(btn);
        } else {
          onCommit?.([...container.querySelectorAll(itemSelector)]);
        }
      }

      setTimeout(() => { drag.skipNextClick = false; }, 60);
    }

    drag.btn = null;
    drag.pointerId = null;
    drag.isDragging = false;
    drag.outside = false;
  }

  function onPointerDown(e) {
    const btn = e.target.closest(itemSelector);
    if (!btn || !container.contains(btn)) return;
    if (canDragItem && !canDragItem(btn)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    cancelPress();
    detachDocListeners();

    drag.btn = btn;
    drag.pointerId = e.pointerId;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.isDragging = false;
    drag.skipNextClick = false;
    drag.outside = false;

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);

    drag.pressTimer = setTimeout(() => {
      drag.pressTimer = null;
      enterDragMode(btn);
    }, longPressMs);
  }

  function onClickCapture(e) {
    if (drag.skipNextClick) {
      e.stopPropagation();
      e.preventDefault();
      drag.skipNextClick = false;
    }
  }

  container.addEventListener('click', onClickCapture, true);
  container.addEventListener('pointerdown', onPointerDown);

  return {
    destroy() {
      cancelPress();
      detachDocListeners();
      resetVisuals(drag.btn, drag.pointerId);
      drag.btn = null;
      drag.pointerId = null;
      drag.isDragging = false;
      drag.skipNextClick = false;
      drag.outside = false;
      container.removeEventListener('click', onClickCapture, true);
      container.removeEventListener('pointerdown', onPointerDown);
    }
  };
}
