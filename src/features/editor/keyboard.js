// ============================================================
// SHORTCUTS TASTIERA
// ============================================================

import { state, viewport } from '../../core/state.js';
import { showToast } from '../../core/utils.js';
import { setTool } from './toolbar.js';
import { flushAutoSave } from './autosave.js';
import { flushHistory, handleHistoryKeyboard } from './history.js';
import { toggleFullscreen } from './export.js';
import { applyTransform } from './transform.js';
import { resetZoom } from './pages.js';
import { closeSettingsModal } from '../settings/settings.js';
import { closeNewNotebookModal } from '../library/library.js';
import { clearSelection } from './lasso.js';

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', handleHistoryKeyboard);

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && target.matches && target.matches('input, textarea, select, [contenteditable="true"]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl && key === 's') {
      e.preventDefault();
      flushHistory(); flushAutoSave();
      showToast('Salvato', '💾');
      return;
    }
    if (key === 'escape') {
      if (!document.getElementById('settingsModal').classList.contains('hidden')) { closeSettingsModal(); return; }
      if (!document.getElementById('newNotebookModal').classList.contains('hidden')) { closeNewNotebookModal(); return; }
      if (state.selectedStrokes.length > 0) { clearSelection(); return; }
      return;
    }
    if (ctrl || e.altKey || e.metaKey) return;

    if (key === 'p') { setTool('pen'); return; }
    if (key === 'm') { setTool('marker'); return; }
    if (key === 'h') { setTool('highlighter'); return; }
    if (key === 'l') { setTool('lasso'); return; }
    if (key === 'e') { setTool('eraser'); return; }
    if (key === 'x') { setTool('pencil'); return; }

    if (key === 'f') { e.preventDefault(); toggleFullscreen(); return; }
    if (key === '+' || key === '=') {
      e.preventDefault();
      viewport.scale = Math.min(viewport.scale * 1.2, viewport.maxScale);
      applyTransform(); return;
    }
    if (key === '-') {
      e.preventDefault();
      viewport.scale = Math.max(viewport.scale / 1.2, viewport.minScale);
      applyTransform(); return;
    }
    if (key === '0') {
      e.preventDefault();
      resetZoom(); return;
    }
  });
}