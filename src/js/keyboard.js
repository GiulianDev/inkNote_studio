// ============================================================
// SHORTCUT TASTIERA
// ============================================================

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignora se focus è su input/textarea/select
        const target = e.target;
        if (target && target.matches &&
            target.matches('input, textarea, select, [contenteditable="true"]')) {
            return;
        }

        const ctrl = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        // Ctrl+S: flush salvataggio
        if (ctrl && key === 's') {
            e.preventDefault();
            flushHistory();
            flushAutoSave();
            showToast('Salvato', '💾');
            return;
        }

        // Esc: deseleziona / chiudi modali
        if (key === 'escape') {
            if (!document.getElementById('settingsModal').classList.contains('hidden')) {
                closeSettingsModal();
                return;
            }
            if (!document.getElementById('newNotebookModal').classList.contains('hidden')) {
                closeNewNotebookModal();
                return;
            }
            if (appState.selectedStrokes.length > 0) {
                clearSelection();
                return;
            }
            return;
        }

        // Solo se non sono premuti Ctrl/Alt/Meta, gestiamo i tool
        if (ctrl || e.altKey || e.metaKey) return;

        // Tool
        if (key === 'p') { setTool('pen'); return; }
        if (key === 'm') { setTool('marker'); return; }
        if (key === 'h') { setTool('highlighter'); return; }
        if (key === 'l') { setTool('lasso'); return; }
        if (key === 'e') { setTool('eraser'); return; }
        if (key === 'x') { setTool('pencil'); return; }

        // F: fullscreen
        if (key === 'f') {
            e.preventDefault();
            toggleFullscreen();
            return;
        }

        // Zoom: +, -, 0
        if (key === '+' || key === '=') {
            e.preventDefault();
            transformState.scale = Math.min(transformState.scale * 1.2, transformState.maxScale);
            applyTransform();
            return;
        }
        if (key === '-') {
            e.preventDefault();
            transformState.scale = Math.max(transformState.scale / 1.2, transformState.minScale);
            applyTransform();
            return;
        }
        if (key === '0') {
            e.preventDefault();
            resetZoom();
            return;
        }
    });
}