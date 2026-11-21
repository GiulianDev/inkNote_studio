// ============================================================
// LIBRERIA — DRAG & DROP UNIFICATO (Mouse, Touch, Surface Pen)
// Supporta:
//  - Quaderno -> Raccolta (sposta nella raccolta)
//  - Quaderno -> Quaderno (crea automaticamente una Raccolta, stile Android)
//  - Raccolta -> Raccolta (annida come sottoraccolta, anti-ciclo)
//  - Card -> Breadcrumb superiore (porta al livello genitore)
// ============================================================

const MOUSE_DRAG_THRESHOLD_PX = 7;
const TOUCH_ARM_DELAY_MS = 230;
const TOUCH_SCROLL_CANCEL_PX = 9;
const TOUCH_DRAG_MOVE_PX = 5;
const EDGE_SCROLL_ZONE_PX = 72;
const EDGE_SCROLL_SPEED_PX = 10;

export function createLibraryDndController(gridEl, callbacks) {
  let _pointerId = null;
  let _pointerType = 'mouse';
  let _startX = 0;
  let _startY = 0;
  let _lastX = 0;
  let _lastY = 0;
  let _armTimer = null;
  let _armed = false;
  let _dragging = false;
  let _draggedEl = null;
  let _dragged = null; // { type: 'notebook'|'folder', id: string, title: string, color: string }
  let _ghostEl = null;
  let _ghostBadgeEl = null;
  let _currentDropTarget = null; // { kind: 'collection'|'merge'|'breadcrumb', id: string|null, el: Element, label: string }
  let _scrollRaf = null;
  let _lastDragEndAt = 0;

  function _clearArmTimer() {
    if (_armTimer !== null) {
      clearTimeout(_armTimer);
      _armTimer = null;
    }
  }

  function _stopAutoScroll() {
    if (_scrollRaf !== null) {
      cancelAnimationFrame(_scrollRaf);
      _scrollRaf = null;
    }
  }

  function _clearDropHighlight() {
    if (_currentDropTarget && _currentDropTarget.el) {
      _currentDropTarget.el.classList.remove(
        'drop-target-collection',
        'drop-target-merge',
        'drop-target-breadcrumb'
      );
    }
    _currentDropTarget = null;
    if (_ghostBadgeEl) {
      _ghostBadgeEl.textContent = '';
      _ghostBadgeEl.classList.add('hidden');
    }
  }

  function _createGhost(dragged, x, y) {
    const ghost = document.createElement('div');
    ghost.className = 'library-dnd-ghost';
    ghost.setAttribute('aria-hidden', 'true');

    const swatch = document.createElement('div');
    swatch.className = dragged.type === 'folder'
      ? 'library-dnd-ghost-icon is-folder'
      : 'library-dnd-ghost-icon';
    swatch.style.backgroundColor = dragged.color || '#4f46e5';

    const title = document.createElement('span');
    title.className = 'library-dnd-ghost-title';
    title.textContent = dragged.title || (dragged.type === 'folder' ? 'Raccolta' : 'Quaderno');

    const badge = document.createElement('span');
    badge.className = 'library-dnd-ghost-badge hidden';

    const row = document.createElement('div');
    row.className = 'library-dnd-ghost-card';
    row.appendChild(swatch);
    row.appendChild(title);

    ghost.appendChild(row);
    ghost.appendChild(badge);
    ghost.style.transform = `translate3d(${Math.round(x + 12)}px, ${Math.round(y + 12)}px, 0)`;

    document.body.appendChild(ghost);
    _ghostEl = ghost;
    _ghostBadgeEl = badge;
  }

  function _updateGhostPosition(x, y) {
    if (!_ghostEl) return;
    _ghostEl.style.transform = `translate3d(${Math.round(x + 12)}px, ${Math.round(y + 12)}px, 0)`;
  }

  function _resolveDropTarget(x, y) {
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    for (const node of stack) {
      if (!(node instanceof Element)) continue;

      const bcBtn = node.closest('#libraryBreadcrumbs [data-breadcrumb-id]');
      if (bcBtn) {
        const targetId = bcBtn.dataset.breadcrumbId || null;
        if (callbacks.canDropOnBreadcrumb?.(_dragged, targetId)) {
          const label = targetId ? (bcBtn.textContent?.trim() || 'Raccolta') : 'Libreria';
          return { kind: 'breadcrumb', id: targetId, el: bcBtn, label: `Sposta in "${label}"` };
        }
        return null;
      }

      const folderCard = node.closest('.folder-card[data-folder-id]');
      if (folderCard && folderCard !== _draggedEl) {
        const targetId = folderCard.dataset.folderId;
        if (targetId && callbacks.canDropOnCollection?.(_dragged, targetId)) {
          const name = folderCard.dataset.folderName || 'Raccolta';
          return { kind: 'collection', id: targetId, el: folderCard, label: `Sposta in "${name}"` };
        }
        return null;
      }

      const nbCard = node.closest('.notebook-card[data-nb-id]');
      if (nbCard && nbCard !== _draggedEl) {
        const targetId = nbCard.dataset.nbId;
        if (_dragged.type === 'notebook' && targetId && callbacks.canMergeNotebooks?.(_dragged.id, targetId)) {
          return { kind: 'merge', id: targetId, el: nbCard, label: '+ Crea raccolta' };
        }
        return null;
      }
    }
    return null;
  }

  function _updateDropTarget(x, y) {
    const next = _resolveDropTarget(x, y);

    if (_currentDropTarget && next &&
        _currentDropTarget.kind === next.kind &&
        _currentDropTarget.id === next.id &&
        _currentDropTarget.el === next.el) {
      return;
    }

    _clearDropHighlight();
    if (!next) return;

    _currentDropTarget = next;
    if (next.kind === 'collection') next.el.classList.add('drop-target-collection');
    else if (next.kind === 'merge') next.el.classList.add('drop-target-merge');
    else if (next.kind === 'breadcrumb') next.el.classList.add('drop-target-breadcrumb');

    if (_ghostBadgeEl && next.label) {
      _ghostBadgeEl.textContent = next.label;
      _ghostBadgeEl.classList.remove('hidden');
    }
  }

  function _stepAutoScroll() {
    _scrollRaf = null;
    if (!_dragging) return;

    const scrollEl = document.getElementById('libraryView');
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      let delta = 0;
      if (_lastY < rect.top + EDGE_SCROLL_ZONE_PX) {
        const ratio = Math.max(0, (rect.top + EDGE_SCROLL_ZONE_PX - _lastY) / EDGE_SCROLL_ZONE_PX);
        delta = -Math.ceil(EDGE_SCROLL_SPEED_PX * ratio);
      } else if (_lastY > rect.bottom - EDGE_SCROLL_ZONE_PX) {
        const ratio = Math.max(0, (_lastY - (rect.bottom - EDGE_SCROLL_ZONE_PX)) / EDGE_SCROLL_ZONE_PX);
        delta = Math.ceil(EDGE_SCROLL_SPEED_PX * ratio);
      }
      if (delta !== 0) {
        scrollEl.scrollTop += delta;
        _updateDropTarget(_lastX, _lastY);
        _scrollRaf = requestAnimationFrame(_stepAutoScroll);
        return;
      }
    }
  }

  function _ensureAutoScroll() {
    if (_scrollRaf === null && _dragging) {
      _scrollRaf = requestAnimationFrame(_stepAutoScroll);
    }
  }

  function _beginDrag(x, y) {
    if (_dragging || !_draggedEl || !_dragged) return;
    _dragging = true;
    _armed = false;
    _draggedEl.classList.remove('dnd-armed');
    _draggedEl.classList.add('is-dragging');
    document.body.classList.add('library-dnd-active');
    _createGhost(_dragged, x, y);
    _updateDropTarget(x, y);
    callbacks.onDragStateChange?.(true);
  }

  function _reset(cancelled = false) {
    _clearArmTimer();
    _stopAutoScroll();
    _clearDropHighlight();

    if (_draggedEl) {
      _draggedEl.classList.remove('dnd-armed', 'is-dragging');
    }
    if (_ghostEl) {
      _ghostEl.remove();
      _ghostEl = null;
      _ghostBadgeEl = null;
    }

    if (_dragging) {
      _lastDragEndAt = performance.now();
      document.body.classList.remove('library-dnd-active');
      callbacks.onDragStateChange?.(false);
    }

    _pointerId = null;
    _armed = false;
    _dragging = false;
    _draggedEl = null;
    _dragged = null;

    window.removeEventListener('pointermove', _onPointerMove, true);
    window.removeEventListener('pointerup', _onPointerUp, true);
    window.removeEventListener('pointercancel', _onPointerCancel, true);
    window.removeEventListener('keydown', _onKeyDown, true);
    window.removeEventListener('blur', _onBlur, true);
    window.removeEventListener('touchmove', _onTouchMove, { capture: true });

    if (cancelled) {
      _lastDragEndAt = performance.now();
    }
  }

  function _onTouchMove(e) {
    if (_armed || _dragging) {
      e.preventDefault();
    }
  }

  function _onKeyDown(e) {
    if (e.key === 'Escape' && (_armed || _dragging)) {
      e.preventDefault();
      e.stopPropagation();
      _reset(true);
    }
  }

  function _onBlur() {
    if (_pointerId !== null) _reset(true);
  }

  function _onPointerMove(e) {
    if (e.pointerId !== _pointerId) return;
    _lastX = e.clientX;
    _lastY = e.clientY;
    const dist = Math.hypot(e.clientX - _startX, e.clientY - _startY);

    if (!_dragging) {
      if (_pointerType === 'mouse') {
        if (dist >= MOUSE_DRAG_THRESHOLD_PX) {
          _beginDrag(e.clientX, e.clientY);
        }
      } else {
        if (!_armed) {
          if (dist > TOUCH_SCROLL_CANCEL_PX) {
            _reset(false);
          }
          return;
        }
        if (dist >= TOUCH_DRAG_MOVE_PX) {
          _beginDrag(e.clientX, e.clientY);
        }
      }
      return;
    }

    _updateGhostPosition(e.clientX, e.clientY);
    _updateDropTarget(e.clientX, e.clientY);
    _ensureAutoScroll();
  }

  function _onPointerUp(e) {
    if (e.pointerId !== _pointerId) return;
    const wasDragging = _dragging;
    const dragged = _dragged;
    const target = wasDragging ? _resolveDropTarget(e.clientX, e.clientY) : null;
    _reset(false);

    if (wasDragging && dragged && target) {
      if (target.kind === 'collection') {
        callbacks.onDropOnCollection?.(dragged, target.id);
      } else if (target.kind === 'breadcrumb') {
        callbacks.onDropOnBreadcrumb?.(dragged, target.id);
      } else if (target.kind === 'merge' && dragged.type === 'notebook') {
        callbacks.onMergeNotebooks?.(dragged.id, target.id);
      }
    }
  }

  function _onPointerCancel(e) {
    if (e.pointerId !== _pointerId) return;
    _reset(true);
  }

  function _onPointerDown(e) {
    if (_pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!callbacks.isEnabled?.() || callbacks.isSelectionMode?.()) return;
    if (e.target.closest('.delete-nb-btn, .favorite-nb-btn, .folder-action-btn, .selection-dot')) return;

    const card = e.target.closest('.notebook-card[data-nb-id], .folder-card[data-folder-id]');
    if (!card || !gridEl.contains(card)) return;

    const info = callbacks.getItemInfo?.(card);
    if (!info) return;

    _pointerId = e.pointerId;
    _pointerType = e.pointerType || 'mouse';
    _startX = e.clientX;
    _startY = e.clientY;
    _lastX = e.clientX;
    _lastY = e.clientY;
    _armed = false;
    _dragging = false;
    _draggedEl = card;
    _dragged = info;

    window.addEventListener('pointermove', _onPointerMove, true);
    window.addEventListener('pointerup', _onPointerUp, true);
    window.addEventListener('pointercancel', _onPointerCancel, true);
    window.addEventListener('keydown', _onKeyDown, true);
    window.addEventListener('blur', _onBlur, true);
    window.addEventListener('touchmove', _onTouchMove, { capture: true, passive: false });

    if (_pointerType !== 'mouse') {
      _armTimer = setTimeout(() => {
        _armTimer = null;
        if (_pointerId !== e.pointerId || _dragging || !_draggedEl) return;
        _armed = true;
        _draggedEl.classList.add('dnd-armed');
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
      }, TOUCH_ARM_DELAY_MS);
    }
  }

  gridEl.addEventListener('pointerdown', _onPointerDown);

  return {
    isDragging() {
      return _dragging;
    },
    wasRecentDrag() {
      return (performance.now() - _lastDragEndAt) < 280;
    },
    cancel() {
      _reset(true);
    },
    destroy() {
      _reset(true);
      gridEl.removeEventListener('pointerdown', _onPointerDown);
    }
  };
}
