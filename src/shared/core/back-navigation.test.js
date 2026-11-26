import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackNavigationController,
  BACK_STATE_KEY,
  BACK_KIND_BASE,
  BACK_KIND_GUARD,
  BACK_KIND_FOLDER,
  BACK_KIND_EDITOR
} from './back-navigation.js';

function createMockHistory() {
  const entries = [null];
  let index = 0;
  const listeners = new Map();

  const windowObj = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchPopstate(state) {
      for (const fn of listeners.get('popstate') || []) {
        fn({ state });
      }
    }
  };

  const historyObj = {
    get state() {
      return entries[index];
    },
    get length() {
      return entries.length;
    },
    replaceState(state) {
      entries[index] = state;
    },
    pushState(state) {
      entries.splice(index + 1);
      entries.push(state);
      index = entries.length - 1;
    },
    back() {
      if (index > 0) {
        index -= 1;
        windowObj.dispatchPopstate(entries[index]);
      }
    },
    go(delta) {
      const next = index + delta;
      if (next >= 0 && next < entries.length) {
        index = next;
        windowObj.dispatchPopstate(entries[index]);
      }
    },
    _dump: () => ({ entries: [...entries], index })
  };

  return { historyObj, windowObj };
}

test('back inside open notebook returns to library cleanly', () => {
  const { historyObj, windowObj } = createMockHistory();
  let editorOpen = false;
  let currentFolderId = null;
  let returnedCalls = [];

  const nav = createBackNavigationController({
    historyObj,
    windowObj,
    isEditorOpen: () => editorOpen,
    getCurrentFolderId: () => currentFolderId,
    onReturnToLibrary: (info) => {
      editorOpen = false;
      returnedCalls.push(info);
    }
  });
  nav.init();

  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);

  editorOpen = true;
  nav.pushEditor('nb_1', null);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_EDITOR);

  historyObj.back();
  assert.equal(editorOpen, false);
  assert.equal(returnedCalls.length, 1);
  assert.equal(returnedCalls[0].fromPopstate, true);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);
});

test('navigates folder hierarchy and returns from notebook to originating folder', () => {
  const { historyObj, windowObj } = createMockHistory();
  let editorOpen = false;
  let currentFolderId = null;

  const nav = createBackNavigationController({
    historyObj,
    windowObj,
    isEditorOpen: () => editorOpen,
    getCurrentFolderId: () => currentFolderId,
    onNavigateFolder: (fid) => { currentFolderId = fid; },
    onReturnToLibrary: ({ targetFolderId }) => {
      editorOpen = false;
      currentFolderId = targetFolderId;
    }
  });
  nav.init();

  currentFolderId = 'fld_a';
  nav.pushFolder('fld_a');
  currentFolderId = 'fld_b';
  nav.pushFolder('fld_b');

  editorOpen = true;
  nav.pushEditor('nb_inside_b', 'fld_b');

  // Back #1: notebook -> folder B
  historyObj.back();
  assert.equal(editorOpen, false);
  assert.equal(currentFolderId, 'fld_b');
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_FOLDER);

  // Back #2: folder B -> folder A
  historyObj.back();
  assert.equal(currentFolderId, 'fld_a');

  // Back #3: folder A -> root guard
  historyObj.back();
  assert.equal(currentFolderId, null);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);
});

test('breadcrumb navigation pops folder history entries cleanly', () => {
  const { historyObj, windowObj } = createMockHistory();
  let currentFolderId = null;

  const nav = createBackNavigationController({
    historyObj,
    windowObj,
    getCurrentFolderId: () => currentFolderId,
    onNavigateFolder: (fid) => { currentFolderId = fid; }
  });
  nav.init();

  currentFolderId = 'fld_a';
  nav.pushFolder('fld_a');
  currentFolderId = 'fld_b';
  nav.pushFolder('fld_b');

  const delegated = nav.navigateToBreadcrumb(null, 0);
  assert.equal(delegated, true);
  assert.equal(currentFolderId, null);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);
});

test('transient UI overlays dismiss first without leaving notebook or app', () => {
  const { historyObj, windowObj } = createMockHistory();
  let editorOpen = true;
  let settingsOpen = true;
  let returnCount = 0;

  const nav = createBackNavigationController({
    historyObj,
    windowObj,
    isEditorOpen: () => editorOpen,
    onDismissTransientUI: () => {
      if (settingsOpen) {
        settingsOpen = false;
        return 'settings-modal';
      }
      return null;
    },
    onReturnToLibrary: () => {
      editorOpen = false;
      returnCount++;
    }
  });
  nav.init();
  nav.pushEditor('nb_1', null);

  // First back dismisses settings modal, keeps user inside notebook
  historyObj.back();
  assert.equal(settingsOpen, false);
  assert.equal(editorOpen, true);
  assert.equal(returnCount, 0);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_EDITOR);

  // Second back exits notebook to library
  historyObj.back();
  assert.equal(editorOpen, false);
  assert.equal(returnCount, 1);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);
});

test('root library prompts once before exiting and allows double-back within window', () => {
  const { historyObj, windowObj } = createMockHistory();
  let timeMs = 1000;
  let prompts = 0;

  const nav = createBackNavigationController({
    historyObj,
    windowObj,
    now: () => timeMs,
    exitConfirmWindowMs: 2000,
    onExitPrompt: () => { prompts++; }
  });
  nav.init();

  // First back at root -> shows exit prompt & re-arms guard
  historyObj.back();
  assert.equal(prompts, 1);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);

  // Wait > 2000ms -> still prompts again instead of exiting
  timeMs += 2500;
  historyObj.back();
  assert.equal(prompts, 2);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);

  // Second back within 2000ms -> exits down to base entry
  timeMs += 800;
  historyObj.back();
  assert.equal(prompts, 2);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_BASE);
});

test('popEditorIfActive syncs history when returning via UI button without double-triggering', () => {
  const { historyObj, windowObj } = createMockHistory();
  let editorOpen = false;
  let returnCalls = 0;

  const nav = createBackNavigationController({
    historyObj,
    windowObj,
    isEditorOpen: () => editorOpen,
    onReturnToLibrary: () => {
      editorOpen = false;
      returnCalls++;
    }
  });
  nav.init();

  editorOpen = true;
  nav.pushEditor('nb_1', null);

  // User clicks UI "Libreria" button
  editorOpen = false;
  const popped = nav.popEditorIfActive();
  assert.equal(popped, true);
  assert.equal(returnCalls, 0);
  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_GUARD);
});

test('pushEditorBackState omits folderId -> inherits getCurrentFolderId()', async () => {
  const { initBackNavigation, pushEditorBackState } = await import('./back-navigation.js');
  const { historyObj, windowObj } = createMockHistory();
  let currentFolderId = 'fld_parent';

  const nav = initBackNavigation({
    historyObj,
    windowObj,
    getCurrentFolderId: () => currentFolderId
  });
  nav.pushFolder('fld_parent');
  pushEditorBackState('nb_42');

  assert.equal(historyObj.state[BACK_STATE_KEY], BACK_KIND_EDITOR);
  assert.equal(historyObj.state.folderId, 'fld_parent');
  nav.destroy();
});
