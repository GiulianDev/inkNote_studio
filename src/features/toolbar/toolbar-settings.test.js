import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function installMemoryLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); }
  };
  return store;
}

installMemoryLocalStorage();

const { state } = await import('../../core/state.js');
const {
  LAST_TOOLBAR_STORAGE_KEY,
  DEFAULT_TOOLBAR_SETTINGS,
  initToolbarSettings,
  getActiveTool,
  getToolbarSettingsForSave,
  getInitialNewNotebookToolbarSettings,
  updateToolbarSettings,
  resetToolbarSettings
} = await import('./toolbar-settings.js');

describe('toolbar-settings: activeTool & last-saved persistence', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    resetToolbarSettings();
  });

  it('defaults activeTool to marker when no notebook or saved settings exist', () => {
    const s = initToolbarSettings(null);
    assert.equal(s.activeTool, 'marker');
    assert.equal(getActiveTool(), 'marker');
    assert.equal(state.activeTool, 'marker');
  });

  it('persists activeTool and tool properties in getToolbarSettingsForSave and localStorage', () => {
    initToolbarSettings(null);
    updateToolbarSettings({
      activeTool: 'pencil',
      smoothing: 25,
      tools: {
        ...getToolbarSettingsForSave().tools,
        pencil: { color: '#2563eb', width: 7, opacity: 0.8, style: 'dashed' }
      }
    });

    const saved = getToolbarSettingsForSave();
    assert.equal(saved.activeTool, 'pencil');
    assert.equal(saved.smoothing, 25);
    assert.equal(saved.tools.pencil.color, '#2563eb');
    assert.equal(saved.tools.pencil.width, 7);

    const raw = JSON.parse(globalThis.localStorage.getItem(LAST_TOOLBAR_STORAGE_KEY));
    assert.equal(raw.activeTool, 'pencil');
    assert.equal(raw.smoothing, 25);
    assert.equal(raw.tools.pencil.color, '#2563eb');
  });

  it('falls back to last saved toolbar settings on initToolbarSettings(null) and ignores invalid tools', () => {
    initToolbarSettings(null);
    updateToolbarSettings({ activeTool: 'highlighter', smoothing: 72 });
    resetToolbarSettings();

    // resetToolbarSettings restores runtime defaults without wiping localStorage
    assert.equal(getActiveTool(), DEFAULT_TOOLBAR_SETTINGS.activeTool);
    assert.ok(globalThis.localStorage.getItem(LAST_TOOLBAR_STORAGE_KEY));

    const reopened = initToolbarSettings(null);
    assert.equal(reopened.activeTool, 'highlighter');
    assert.equal(reopened.smoothing, 72);

    const invalidWithLastSaved = initToolbarSettings({ activeTool: 'nonexistent-tool', smoothing: 15 });
    assert.equal(invalidWithLastSaved.activeTool, 'highlighter');
    assert.equal(invalidWithLastSaved.smoothing, 15);

    globalThis.localStorage.clear();
    const invalidWithoutLastSaved = initToolbarSettings({ activeTool: 'nonexistent-tool', smoothing: 15 });
    assert.equal(invalidWithoutLastSaved.activeTool, 'marker');
  });

  it('restores explicit notebook activeTool over localStorage fallback', () => {
    initToolbarSettings(null);
    updateToolbarSettings({ activeTool: 'pen', smoothing: 80 });

    const nbSettings = initToolbarSettings({ activeTool: 'eraser', smoothing: 10 });
    assert.equal(nbSettings.activeTool, 'eraser');
    assert.equal(getActiveTool(), 'eraser');
    assert.equal(nbSettings.smoothing, 10);
  });

  it('seeds new notebooks from last saved tool/colors while clearing per-page paper overrides', () => {
    initToolbarSettings(null);
    updateToolbarSettings({
      activeTool: 'pen',
      smoothing: 35,
      paperColor: '#fef3c7',
      patternColor: '#d97706',
      compactMode: true
    });

    const fresh = getInitialNewNotebookToolbarSettings();
    assert.equal(fresh.activeTool, 'pen');
    assert.equal(fresh.smoothing, 35);
    assert.equal(fresh.paperColor, null);
    assert.equal(fresh.patternColor, null);
    assert.equal(fresh.compactMode, false);
  });
});
