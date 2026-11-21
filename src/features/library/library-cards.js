// ============================================================
// LIBRERIA — RENDERING CARD (Quaderni & Raccolte, Griglia & Lista)
// ============================================================

import { escapeHtml } from '../../core/utils.js';
import { formatFolderCountLabel, formatFolderPathLabel } from './library-helpers.js';

const LP_PRESS_MS = 680;
const LP_MOVE_CANCEL_PX = 8;

const DATE_FMT_FULL = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: 'short',
  year: 'numeric'
});

const DATE_FMT_SHORT = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: 'short',
  year: '2-digit'
});

const DRAG_HANDLE_SVG = `
  <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/>
    <circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/>
    <circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/>
  </svg>
`;

const CHECK_SVG = `
  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6 9 17l-5-5"/>
  </svg>
`;

function _trashSvg(sizeClass) {
  return `
    <svg class="${sizeClass} pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  `;
}

function _editSvg(sizeClass) {
  return `
    <svg class="${sizeClass} pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
    </svg>
  `;
}

function _moveSvg(sizeClass) {
  return `
    <svg class="${sizeClass} pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 7V5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/>
      <rect width="18" height="13" x="3" y="8" rx="2.5"/><path d="M8 14h8"/><path d="m13 11 3 3-3 3"/>
    </svg>
  `;
}

function _starSvg(isFav) {
  return `
    <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  `;
}

function _collectionGlyphSvg(className = 'w-6 h-6') {
  return `
    <svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 7V5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1"/>
      <rect width="18" height="13" x="3" y="8" rx="2.5" fill="currentColor" fill-opacity="0.14"/>
      <rect width="4" height="7" x="6.5" y="11" rx="1" fill="currentColor" fill-opacity="0.35" stroke="none"/>
      <rect width="4" height="7" x="12" y="11" rx="1" fill="currentColor" fill-opacity="0.22" stroke="none"/>
    </svg>
  `;
}

function _formatEditDates(editIso) {
  const date = new Date(editIso);
  if (Number.isNaN(date.getTime())) {
    return { full: '—', short: '—' };
  }
  return {
    full: DATE_FMT_FULL.format(date),
    short: DATE_FMT_SHORT.format(date)
  };
}

function _renderFolderMiniGrid(preview) {
  const nbs = (preview?.notebooks || []).slice(0, 3);
  const subs = (preview?.subfolders || []).slice(0, Math.max(0, 3 - nbs.length));
  const items = [
    ...nbs.map((nb) => ({ kind: 'nb', item: nb })),
    ...subs.map((sf) => ({ kind: 'sub', item: sf }))
  ].slice(0, 3);

  if (items.length === 0) return '';

  const cards = items.map(({ kind, item }) => {
    if (kind === 'nb') {
      return `
        <div class="folder-peek-nb" style="background-color: ${escapeHtml(item.coverColor || '#4f46e5')};">
          <span class="folder-peek-nb-spine"></span>
        </div>
      `;
    }
    const subColor = escapeHtml(item.color || '#6366f1');
    return `
      <div class="folder-peek-sub" style="background-color: ${subColor};">
        <span class="folder-peek-sub-tab" style="background-color: ${subColor};"></span>
        ${_collectionGlyphSvg('w-3.5 h-3.5')}
      </div>
    `;
  });

  return `<div class="folder-peek-fan count-${items.length}">${cards.join('')}</div>`;
}

function _renderFolderActionButtons(iconSizeClass) {
  return `
    <button type="button" class="folder-action-btn" data-folder-action="edit" title="Modifica raccolta" aria-label="Modifica raccolta">
      ${_editSvg(iconSizeClass)}
    </button>
    <button type="button" class="folder-action-btn" data-folder-action="move" title="Sposta raccolta" aria-label="Sposta raccolta">
      ${_moveSvg(iconSizeClass)}
    </button>
    <button type="button" class="folder-action-btn danger" data-folder-action="delete" title="Elimina raccolta" aria-label="Elimina raccolta">
      ${_trashSvg(iconSizeClass)}
    </button>
  `;
}

export function createFolderCardElement({
  folder,
  counts,
  folderMap,
  previewMap,
  showParentBadge,
  viewMode,
  showTextBelow,
  dndController,
  getDndController,
  onLongPress,
  onClick,
  onEdit,
  onMove,
  onDelete,
  onOpen
}) {
  const card = document.createElement('div');
  card.className = viewMode === 'list' ? 'folder-card is-list-item group' : 'folder-card group';
  card.dataset.folderId = folder.id;
  card.dataset.folderName = folder.name || 'Raccolta';
  card.dataset.folderColor = folder.color || '#6366f1';

  const color = folder.color || '#6366f1';
  const safeColor = escapeHtml(color);
  const metaText = formatFolderCountLabel(counts.get(folder.id));
  const parentLabel = showParentBadge && folder.parentId && folderMap.has(folder.parentId)
    ? formatFolderPathLabel(folder.parentId, folderMap)
    : '';
  const preview = previewMap.get(folder.id);

  if (viewMode === 'list') {
    card.innerHTML = `
      <button type="button" class="dnd-drag-handle is-list" title="Trascina raccolta" aria-label="Trascina raccolta">
        ${DRAG_HANDLE_SVG}
      </button>
      <div class="selection-dot is-list" aria-hidden="true">${CHECK_SVG}</div>
      <div class="list-row-thumb is-folder" style="background-color: ${safeColor}18; border-color: ${safeColor}40; color: ${safeColor};">
        ${_collectionGlyphSvg('w-4 h-4')}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <h4 class="folder-name truncate">${escapeHtml(folder.name)}</h4>
          ${parentLabel ? `<span class="list-path-pill truncate">${escapeHtml(parentLabel)}</span>` : ''}
        </div>
        <span class="folder-meta">${escapeHtml(metaText)}</span>
      </div>
      <div class="folder-actions is-list">
        ${_renderFolderActionButtons('w-3.5 h-3.5')}
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="folder-shell" style="--folder-color: ${safeColor};">
        <div class="folder-tab-ear" aria-hidden="true"></div>
        <div class="folder-back" aria-hidden="true"></div>

        <div class="folder-peek-area" aria-hidden="true">
          ${_renderFolderMiniGrid(preview)}
        </div>

        <div class="folder-cover">
          <div class="selection-dot" aria-hidden="true">${CHECK_SVG}</div>

          <button type="button" class="dnd-drag-handle is-folder" title="Trascina raccolta" aria-label="Trascina raccolta">
            ${DRAG_HANDLE_SVG}
          </button>

          <div class="folder-actions">
            ${_renderFolderActionButtons('w-3 h-3')}
          </div>

          <div class="folder-cover-label">
            <span class="folder-cover-title">${escapeHtml(folder.name || 'Raccolta')}</span>
          </div>

          ${parentLabel && !showTextBelow ? `<div class="folder-cover-path-pill">${escapeHtml(parentLabel)}</div>` : ''}

          <div class="folder-badge">
            <span>${escapeHtml(metaText)}</span>
          </div>
        </div>
      </div>

      ${showTextBelow ? `
      <div class="card-meta-below">
        ${parentLabel ? `<span class="card-path-tag truncate">${escapeHtml(parentLabel)}</span>` : ''}
        <h4 class="folder-name">${escapeHtml(folder.name)}</h4>
        <span class="folder-meta">${escapeHtml(metaText)}</span>
      </div>` : ''}
    `;
  }

  const resolveDnd = typeof getDndController === 'function' ? getDndController : () => dndController;

  _bindCardInteractions(card, folder, {
    ignoreSelector: '.folder-action-btn, .dnd-drag-handle',
    getDndController: resolveDnd,
    onLongPress,
    onClick: onClick || ((_e, targetFolder) => onOpen?.(targetFolder))
  });

  card.querySelectorAll('[data-folder-action]').forEach((actionBtn) => {
    actionBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const action = actionBtn.dataset.folderAction;
      if (action === 'edit') onEdit(folder);
      else if (action === 'move') onMove(folder);
      else if (action === 'delete') onDelete(folder);
    });
  });

  return card;
}

function _bindCardInteractions(card, item, handlers) {
  let pressTimer = null;
  let pressStart = null;
  let pressPointerId = null;
  let skipClickAfterLongPress = false;
  const ignoreSel = handlers.ignoreSelector || '.dnd-drag-handle';

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressStart = null;
    pressPointerId = null;
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest(ignoreSel)) return;

    cancelPress();
    pressPointerId = e.pointerId;
    pressStart = { x: e.clientX, y: e.clientY };
    skipClickAfterLongPress = false;

    if (typeof handlers.onLongPress !== 'function') return;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (!card.isConnected) return;
      if (pressPointerId !== e.pointerId) return;
      const dnd = handlers.getDndController?.();
      if (dnd?.isDragging() || dnd?.wasRecentDrag()) return;
      dnd?.cancel();
      skipClickAfterLongPress = true;
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
      handlers.onLongPress(item);
    }, LP_PRESS_MS);
  });

  card.addEventListener('pointermove', (e) => {
    if (handlers.getDndController?.()?.isDragging()) {
      cancelPress();
      return;
    }
    if (!pressStart || e.pointerId !== pressPointerId) return;
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > LP_MOVE_CANCEL_PX) {
      cancelPress();
    }
  });

  card.addEventListener('pointerup', cancelPress);
  card.addEventListener('pointercancel', cancelPress);
  card.addEventListener('pointerleave', cancelPress);

  card.addEventListener('click', (e) => {
    if (e.target.closest(ignoreSel)) {
      e.stopPropagation();
      return;
    }

    const dnd = handlers.getDndController?.();
    if (dnd?.isDragging() || dnd?.wasRecentDrag()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (skipClickAfterLongPress) {
      skipClickAfterLongPress = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    handlers.onClick?.(e, item);
  });
}

export function createNotebookCardElement({
  nb,
  folderMap,
  showPathTags,
  viewMode,
  showTextBelow,
  getDndController,
  onLongPress,
  onClick,
  onToggleFavorite,
  onDelete
}) {
  const editIso = nb.lastEditAt || nb.updatedAt;
  const { full: dateStr, short: coverDateStr } = _formatEditDates(editIso);
  const pageCount = nb.pageCount || 1;
  const isFav = !!nb.isFavorite;
  const folderLabel = (showPathTags && nb.folderId && folderMap.has(nb.folderId))
    ? formatFolderPathLabel(nb.folderId, folderMap)
    : '';
  const coverColor = nb.coverColor || '#4f46e5';
  const safeId = escapeHtml(nb.id);
  const safeCoverColor = escapeHtml(coverColor);
  const favTitle = isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';

  const card = document.createElement('div');
  card.className = viewMode === 'list' ? 'notebook-card is-list-item group relative' : 'notebook-card group relative';
  card.dataset.nbId = nb.id;
  card.dataset.nbTitle = nb.title || 'Quaderno';
  card.dataset.nbColor = coverColor;

  if (viewMode === 'list') {
    card.innerHTML = `
      <button type="button" class="dnd-drag-handle is-list" title="Trascina quaderno" aria-label="Trascina quaderno">
        ${DRAG_HANDLE_SVG}
      </button>
      <div class="selection-dot is-list" aria-hidden="true">${CHECK_SVG}</div>
      <div class="list-row-thumb" style="background-color: ${safeCoverColor};">
        <span class="list-row-spine"></span>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <h4 class="notebook-title truncate">${escapeHtml(nb.title)}</h4>
          ${folderLabel ? `<span class="list-path-pill truncate">${escapeHtml(folderLabel)}</span>` : ''}
        </div>
        <span class="notebook-date">${escapeHtml(String(pageCount))} pag. · ${escapeHtml(dateStr)}</span>
      </div>
      <div class="list-row-actions">
        <button type="button" class="favorite-nb-btn is-list ${isFav ? 'is-favorite' : ''}" data-fav-id="${safeId}"
          title="${favTitle}" aria-label="${favTitle}">
          ${_starSvg(isFav)}
        </button>
        <button type="button" class="delete-nb-btn is-list" data-delete-id="${safeId}" title="Elimina Quaderno" aria-label="Elimina Quaderno">
          ${_trashSvg('w-3.5 h-3.5')}
        </button>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="notebook-cover" style="background-color: ${safeCoverColor};">
        <div class="notebook-spine"></div>
        <div class="notebook-paper-edge"></div>

        <div class="selection-dot" aria-hidden="true">${CHECK_SVG}</div>

        <button type="button" class="dnd-drag-handle is-notebook" title="Trascina quaderno" aria-label="Trascina quaderno">
          ${DRAG_HANDLE_SVG}
        </button>

        <button type="button" class="favorite-nb-btn ${isFav ? 'is-favorite' : ''}" data-fav-id="${safeId}"
          title="${favTitle}" aria-label="${favTitle}">
          ${_starSvg(isFav)}
        </button>

        <button type="button" class="delete-nb-btn" data-delete-id="${safeId}" title="Elimina Quaderno" aria-label="Elimina Quaderno">
          ${_trashSvg('w-3.5 h-3.5')}
        </button>

        <div class="notebook-cover-label">
          <span class="notebook-cover-title">${escapeHtml(nb.title || 'Quaderno')}</span>
        </div>

        ${folderLabel && !showTextBelow ? `<div class="notebook-cover-path-pill">${escapeHtml(folderLabel)}</div>` : ''}

        <div class="notebook-cover-date">
          <span>${escapeHtml(coverDateStr)}</span>
        </div>

        <div class="notebook-badge">
          <span>${escapeHtml(String(pageCount))} pag.</span>
        </div>
      </div>

      ${showTextBelow ? `
      <div class="card-meta-below">
        ${folderLabel ? `<span class="card-path-tag truncate">${escapeHtml(folderLabel)}</span>` : ''}
        <h4 class="notebook-title">${escapeHtml(nb.title)}</h4>
        <span class="notebook-date">${escapeHtml(dateStr)}</span>
      </div>` : ''}
    `;
  }

  _bindCardInteractions(card, nb, {
    ignoreSelector: '.delete-nb-btn, .favorite-nb-btn, .dnd-drag-handle',
    getDndController,
    onLongPress,
    onClick
  });

  card.querySelector('.favorite-nb-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onToggleFavorite(nb);
  });

  card.querySelector('.delete-nb-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onDelete(ev, nb.id);
  });

  return card;
}
