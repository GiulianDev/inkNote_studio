import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEditableElement,
  shouldSuppressNativeEvent,
  setupSystemMenuSuppression
} from './system-menu-guard.js';

function makeMockElement(tagName, attrs = {}) {
  return {
    tagName,
    type: attrs.type || '',
    isContentEditable: !!attrs.isContentEditable,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    closest: (selector) => {
      const want = selector.split(',').map(s => s.trim().toUpperCase());
      const tag = tagName.toUpperCase();
      if (want.includes(tag)) return makeMockElement(tagName, attrs);
      if (want.includes('[CONTENTEDITABLE]') && 'contenteditable' in attrs) {
        return makeMockElement(tagName, attrs);
      }
      return null;
    }
  };
}

test('isEditableElement identifies text inputs, textareas, and contenteditable only', () => {
  assert.equal(isEditableElement(makeMockElement('TEXTAREA')), true);
  assert.equal(isEditableElement(makeMockElement('INPUT', { type: 'text' })), true);
  assert.equal(isEditableElement(makeMockElement('INPUT', { type: 'search' })), true);
  assert.equal(isEditableElement(makeMockElement('DIV', { contenteditable: 'true' })), true);

  assert.equal(isEditableElement(makeMockElement('INPUT', { type: 'range' })), false);
  assert.equal(isEditableElement(makeMockElement('INPUT', { type: 'color' })), false);
  assert.equal(isEditableElement(makeMockElement('BUTTON')), false);
  assert.equal(isEditableElement(makeMockElement('CANVAS')), false);
  assert.equal(isEditableElement(null), false);
});

test('shouldSuppressNativeEvent blocks contextmenu everywhere and selectstart/dragstart outside text inputs', () => {
  const buttonEl = makeMockElement('BUTTON');
  const canvasEl = makeMockElement('CANVAS');
  const textareaEl = makeMockElement('TEXTAREA');
  const titleInputEl = makeMockElement('INPUT', { type: 'text' });

  // contextmenu is always blocked (sheet, menus, inputs)
  assert.equal(shouldSuppressNativeEvent('contextmenu', canvasEl), true);
  assert.equal(shouldSuppressNativeEvent('contextmenu', buttonEl), true);
  assert.equal(shouldSuppressNativeEvent('contextmenu', textareaEl), true);

  // selectstart & dragstart blocked on canvas/menus, allowed inside text boxes/inputs
  assert.equal(shouldSuppressNativeEvent('selectstart', canvasEl), true);
  assert.equal(shouldSuppressNativeEvent('selectstart', buttonEl), true);
  assert.equal(shouldSuppressNativeEvent('dragstart', buttonEl), true);
  assert.equal(shouldSuppressNativeEvent('selectstart', textareaEl), false);
  assert.equal(shouldSuppressNativeEvent('selectstart', titleInputEl), false);
  assert.equal(shouldSuppressNativeEvent('dragstart', textareaEl), false);
});

test('setupSystemMenuSuppression attaches capture listeners and prevents default properly', () => {
  const listeners = new Map();
  const mockWin = {
    addEventListener(type, fn, opts) {
      listeners.set(type, { fn, opts });
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };

  const cleanup = setupSystemMenuSuppression(mockWin);
  assert.equal(listeners.get('contextmenu')?.opts?.capture, true);
  assert.equal(listeners.get('selectstart')?.opts?.capture, true);
  assert.equal(listeners.get('dragstart')?.opts?.capture, true);

  let prevented = false;
  listeners.get('contextmenu').fn({
    target: makeMockElement('BUTTON'),
    preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true);

  let textareaSelectionPrevented = false;
  listeners.get('selectstart').fn({
    target: makeMockElement('TEXTAREA'),
    preventDefault() { textareaSelectionPrevented = true; }
  });
  assert.equal(textareaSelectionPrevented, false);

  cleanup();
  assert.equal(listeners.size, 0);
});
