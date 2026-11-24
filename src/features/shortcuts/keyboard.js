// ============================================================
// SHORTCUTS TASTIERA
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import { setTool } from '../toolbar/toolbar.js';
import { flushAutoSave } from '../persistence/autosave.js';
import { flushHistory, handleHistoryKeyboard } from '../history/history.js';
import { toggleFullscreen } from '../editor/export-pdf.js';
import { applyPinchTransform } from '../viewport/transform.js';
import { resetZoom } from '../editor/pages.js';
import { closeSettingsModal } from '../settings/settings-modal.js';
import { closeNewNotebookModal } from '../library/library.js';
import {
  clearSelection, hasLassoSelection, hasLassoClipboard,
  deleteSelection, copySelection, cutSelection, pasteSelection, duplicateSelection,
  isSelectionStylePopoverOpen, hideSelectionStylePopover
} from '../tools/lazo.js';
import {
  commitActiveTextBox, clearTextBoxSelection, deleteSelectedTextBox
} from '../tools/text.js';

function _isEditorInteractive() {
  const lib = document.getElementById('libraryView');
  if (lib && !lib.classList.contains('hidden')) return false;
  const settings = document.getElementById('settingsModal');
  if (settings && !settings.classList.contains('hidden')) return false;
  const newNb = document.getElementById('newNotebookModal');
  if (newNb && !newNb.classList.contains('hidden')) return false;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  return true;
}

function _zoomByFactor(factor) {
  const newScale = Math.min(
    Math.max(viewport.scale * factor, viewport.minScale),
    viewport.maxScale
  );
  if (newScale === viewport.scale) return;
  const vp = document.getElementById('viewport');
  const rect = vp ? vp.getBoundingClientRect() : null;
  const center = rect
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  applyPinchTransform(
    center,
    { x: viewport.x, y: viewport.y, scale: viewport.scale },
    center,
    newScale
  );
}

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', handleHistoryKeyboard);

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && target.matches && target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (!e.key) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (key === 'escape') {
      const settings = document.getElementById('settingsModal');
      if (settings && !settings.classList.contains('hidden')) { closeSettingsModal(); return; }
      const newNb = document.getElementById('newNotebookModal');
      if (newNb && !newNb.classList.contains('hidden')) { closeNewNotebookModal(); return; }
      if (_isEditorInteractive()) {
        if (isSelectionStylePopoverOpen()) { hideSelectionStylePopover(); return; }
        if (state.editingTextBoxId) { commitActiveTextBox(); return; }
        if (state.selectedTextBoxId) { clearTextBoxSelection(); return; }
        if (hasLassoSelection()) { clearSelection(); return; }
      }
      return;
    }

    if (!_isEditorInteractive()) return;

    if (ctrl && key === 's') {
      e.preventDefault();
      flushHistory(); flushAutoSave();
      showToast('Salvato', '💾');
      return;
    }
    if (ctrl && !e.altKey && !e.shiftKey) {
      if (key === 'c') {
        if (hasLassoSelection()) { e.preventDefault(); copySelection(); }
        return;
      }
      if (key === 'x') {
        if (hasLassoSelection()) { e.preventDefault(); cutSelection(); }
        return;
      }
      if (key === 'v') {
        if (hasLassoClipboard()) { e.preventDefault(); pasteSelection(); }
        return;
      }
      if (key === 'd') {
        if (hasLassoSelection()) { e.preventDefault(); duplicateSelection(); }
        return;
      }
    }
    if (ctrl || e.altKey || e.metaKey) return;

    if (key === 'delete' || key === 'backspace') {
      if (state.selectedTextBoxId && !state.editingTextBoxId) {
        e.preventDefault();
        deleteSelectedTextBox();
        return;
      }
      if (hasLassoSelection()) {
        e.preventDefault();
        deleteSelection();
        return;
      }
    }

    if (key === 'p') { setTool('pen'); return; }
    if (key === 'm') { setTool('marker'); return; }
    if (key === 'h') { setTool('highlighter'); return; }
    if (key === 't') { setTool('text'); return; }
    if (key === 'l') { setTool('lasso'); return; }
    if (key === 'e') { setTool('eraser'); return; }
    if (key === 'x') { setTool('pencil'); return; }

    if (key === 'f') { e.preventDefault(); toggleFullscreen(); return; }
    if (key === '+' || key === '=') {
      e.preventDefault();
      _zoomByFactor(1.2);
      return;
    }
    if (key === '-') {
      e.preventDefault();
      _zoomByFactor(1 / 1.2);
      return;
    }
    if (key === '0') {
      e.preventDefault();
      resetZoom(); return;
    }
  });
}