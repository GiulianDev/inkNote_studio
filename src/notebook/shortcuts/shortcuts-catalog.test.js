import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMacStylePlatform,
  getModifierKeyLabel,
  getShortcutGroups,
  shouldToggleShortcutsModalKey,
  HELP_MODAL_TABS,
  normalizeHelpTab,
  getAppGuideSections
} from './shortcuts-catalog.js';

describe('shortcuts-catalog', () => {
  it('uses ⌘ on macOS and iPadOS, and Ctrl on Windows/Linux/Android/unknown', () => {
    assert.equal(isMacStylePlatform({ os: 'macos' }), true);
    assert.equal(isMacStylePlatform({ os: 'ipados' }), true);
    assert.equal(getModifierKeyLabel({ os: 'macos' }), '⌘');
    assert.equal(getModifierKeyLabel({ os: 'ipados' }), '⌘');

    for (const os of ['windows', 'linux', 'android', 'ios', 'unknown', undefined]) {
      assert.equal(isMacStylePlatform({ os }), false);
      assert.equal(getModifierKeyLabel({ os }), 'Ctrl');
    }
    assert.equal(getModifierKeyLabel(null), 'Ctrl');
  });

  it('builds the three expected shortcut groups with OS-appropriate modifier keys', () => {
    const winGroups = getShortcutGroups({ os: 'windows' });
    assert.deepEqual(winGroups.map(g => g.id), ['tools', 'edit', 'view']);

    const tools = winGroups[0].items;
    assert.deepEqual(
      tools.map(i => i.combos[0][0]),
      ['M', 'X', 'P', 'H', 'T', 'L', 'E']
    );

    const edit = winGroups[1].items;
    const undo = edit.find(i => i.id === 'edit-undo');
    const redo = edit.find(i => i.id === 'edit-redo');
    assert.deepEqual(undo?.combos, [['Ctrl', 'Z']]);
    assert.deepEqual(redo?.combos, [['Ctrl', 'Y'], ['Ctrl', 'Shift', 'Z']]);

    const view = winGroups[2].items;
    const help = view.find(i => i.id === 'view-help');
    assert.deepEqual(help?.combos, [['?']]);

    const macGroups = getShortcutGroups({ os: 'macos' });
    const macSave = macGroups[2].items.find(i => i.id === 'view-save');
    assert.deepEqual(macSave?.combos, [['⌘', 'S']]);
  });

  it('matches ? key (including Shift+?) and ignores editable fields or extra modifiers', () => {
    assert.equal(shouldToggleShortcutsModalKey({ key: '?', shiftKey: true }), true);
    assert.equal(shouldToggleShortcutsModalKey({ key: '?', shiftKey: false }), true);

    assert.equal(shouldToggleShortcutsModalKey({ key: '?', ctrlKey: true }), false);
    assert.equal(shouldToggleShortcutsModalKey({ key: '?', metaKey: true }), false);
    assert.equal(shouldToggleShortcutsModalKey({ key: '?', altKey: true }), false);
    assert.equal(shouldToggleShortcutsModalKey({ key: 'p', shiftKey: false }), false);
    assert.equal(shouldToggleShortcutsModalKey({ key: '?', isComposing: true }), false);
    assert.equal(shouldToggleShortcutsModalKey({ key: '?', defaultPrevented: true }), false);

    assert.equal(
      shouldToggleShortcutsModalKey({
        key: '?',
        shiftKey: true,
        target: { matches: (sel) => sel.includes('input') }
      }),
      false
    );
    assert.equal(
      shouldToggleShortcutsModalKey({
        key: '?',
        shiftKey: true,
        target: { isContentEditable: true }
      }),
      false
    );
    assert.equal(
      shouldToggleShortcutsModalKey({
        key: '?',
        shiftKey: true,
        target: { matches: () => false, isContentEditable: false }
      }),
      true
    );
  });

  it('normalizes help modal tabs and provides drag-and-drop & app guide sections', () => {
    assert.deepEqual(HELP_MODAL_TABS, ['guide', 'shortcuts']);
    assert.equal(normalizeHelpTab('guide'), 'guide');
    assert.equal(normalizeHelpTab('shortcuts'), 'shortcuts');
    assert.equal(normalizeHelpTab('unknown'), 'shortcuts');
    assert.equal(normalizeHelpTab(undefined), 'shortcuts');

    const winSections = getAppGuideSections({ os: 'windows' });
    assert.deepEqual(winSections.map(s => s.id), ['drag-drop', 'shapes-math', 'touch-ink', 'library-sync']);
    assert.ok(winSections[0].items.some(i => i.title.includes('strumenti')));
    assert.ok(winSections[3].items.some(i => i.description.includes('Ctrl+S')));

    const macSections = getAppGuideSections({ os: 'macos' });
    assert.ok(macSections[3].items.some(i => i.description.includes('⌘+S')));
  });
});
