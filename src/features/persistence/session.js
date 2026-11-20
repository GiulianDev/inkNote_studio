// ============================================================
// SESSION: notebook attualmente aperto + sync + save serializzato
// ============================================================

import { state } from '../../core/state.js';
import { generatePageId } from '../../core/utils.js';
import { saveNotebookToDB } from '../../services/db.js';
import { getToolbarSettingsForSave } from '../toolbar/toolbar-settings.js';
import { packStrokes } from './serialization.js';
import { normalizeTextBoxes } from '../tools/text.js';

let _currentNotebook = null;
const _dirtyPageIds = new Set();
const _deletedPageIds = new Set();
let _orderDirty = false;

let _saveQueue = Promise.resolve();
let _pendingSaves = 0;

export function getCurrentNotebook() { return _currentNotebook; }

export function setCurrentNotebook(nb) {
  _currentNotebook = nb;
  _dirtyPageIds.clear();
  _deletedPageIds.clear();
  _orderDirty = false;
}

export function markPageDirty(pageId) {
  if (typeof pageId === 'string' && pageId) {
    _deletedPageIds.delete(pageId);
    _dirtyPageIds.add(pageId);
  }
}

export function markPageDeleted(pageId) {
  if (typeof pageId === 'string' && pageId) {
    _dirtyPageIds.delete(pageId);
    _deletedPageIds.add(pageId);
    _orderDirty = true;
  }
}

export function markOrderDirty() {
  _orderDirty = true;
}

export function syncCurrentState() {
  if (!_currentNotebook) return;
  _currentNotebook.pattern = state.bgPattern;
  _currentNotebook.toolbarSettings = getToolbarSettingsForSave();
  _currentNotebook.lastPageIndex = state.activePageIndex;

  const prevById = new Map();
  if (Array.isArray(_currentNotebook.pages)) {
    for (const p of _currentNotebook.pages) {
      if (p && p.pageId) prevById.set(p.pageId, p);
    }
  }

  const seenIds = new Set();
  const nextPages = [];
  const nextOrder = [];

  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    if (!page) continue;

    if (!page.pageId || seenIds.has(page.pageId)) {
      page.pageId = generatePageId();
      if (page.wrapper) page.wrapper.dataset.pageId = page.pageId;
      _dirtyPageIds.add(page.pageId);
      _orderDirty = true;
    }
    seenIds.add(page.pageId);
    nextOrder.push(page.pageId);

    if (_dirtyPageIds.has(page.pageId) || !prevById.has(page.pageId)) {
      nextPages.push({
        pageId: page.pageId,
        strokes: packStrokes(page.strokes),
        textBoxes: normalizeTextBoxes(page.textBoxes || [])
      });
    } else {
      nextPages.push(prevById.get(page.pageId));
    }
  }

  _currentNotebook.pages = nextPages;
  _currentNotebook.pageOrder = nextOrder;
}

export function saveCurrentNotebook() {
  const targetNb = _currentNotebook;
  if (!targetNb) return Promise.resolve();

  const execute = () => {
    if (_currentNotebook !== targetNb) return Promise.resolve();

    syncCurrentState();

    const dirtyIds = Array.from(_dirtyPageIds);
    const deletedIds = Array.from(_deletedPageIds);
    const orderChanged = _orderDirty;

    _dirtyPageIds.clear();
    _deletedPageIds.clear();
    _orderDirty = false;

    return saveNotebookToDB(targetNb, dirtyIds, {
      deletedPageIds: deletedIds,
      orderChanged
    }).catch(err => {
      if (_currentNotebook === targetNb) {
        for (const id of dirtyIds) {
          if (!_deletedPageIds.has(id)) _dirtyPageIds.add(id);
        }
        for (const id of deletedIds) {
          _deletedPageIds.add(id);
          _dirtyPageIds.delete(id);
        }
        if (orderChanged) _orderDirty = true;
      }
      throw err;
    });
  };

  _pendingSaves++;
  const runQueued = () => execute().finally(() => { _pendingSaves--; });

  const next = _pendingSaves > 1
    ? _saveQueue.then(runQueued, runQueued)
    : runQueued();

  _saveQueue = next.catch(() => {});
  return next;
}