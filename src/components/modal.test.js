import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createModalManager } from './modal.js';

function createFakeElement(id = '', initialClasses = [], docRef = null) {
  const classes = new Set(initialClasses);
  const attrs = new Map();
  const listeners = new Map();
  let parentNode = null;
  let removed = false;
  let focused = 0;

  const el = {
    id,
    get parentNode() {
      return parentNode;
    },
    set parentNode(v) {
      parentNode = v;
    },
    get removed() {
      return removed;
    },
    get focusCount() {
      return focused;
    },
    classList: {
      add: (...items) => items.forEach((c) => classes.add(c)),
      remove: (...items) => items.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
    dispatch: (type, event = {}) => {
      const ev = { target: event.target ?? null, ...event };
      listeners.get(type)?.forEach((fn) => fn(ev));
    },
    querySelector: () => null,
    focus: () => {
      focused += 1;
      if (docRef) docRef.activeElement = el;
    },
    remove: () => {
      removed = true;
      parentNode = null;
    }
  };
  return el;
}

function createFakeDocument() {
  const listeners = new Map();
  const children = [];
  let activeElement = null;

  return {
    body: {
      appendChild: (el) => {
        el.parentNode = {};
        children.push(el);
      }
    },
    get activeElement() {
      return activeElement;
    },
    set activeElement(v) {
      activeElement = v;
    },
    contains: (el) => Boolean(el),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchKey: (key) => {
      let prevented = false;
      let stopped = false;
      listeners.get('keydown')?.forEach((fn) => fn({
        key,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
        stopImmediatePropagation: () => { stopped = true; }
      }));
      return { prevented, stopped };
    }
  };
}

describe('modal controller', () => {
  it('assigns ARIA attributes, manages LIFO stack, and closes only top modal on Escape', () => {
    const doc = createFakeDocument();
    const mgr = createModalManager({ documentObj: doc });

    const triggerBtn = createFakeElement('trigger', [], doc);
    doc.activeElement = triggerBtn;

    const firstEl = createFakeElement('firstModal', ['hidden'], doc);
    const firstInput = createFakeElement('firstInput', [], doc);
    const secondEl = createFakeElement('secondModal', ['hidden'], doc);
    const reasons = [];

    const first = mgr.registerModal(firstEl, {
      initialFocus: firstInput,
      onClose: (r) => reasons.push(`first:${r}`)
    });
    const second = mgr.registerModal(secondEl, {
      onClose: (r) => reasons.push(`second:${r}`)
    });

    assert.equal(firstEl.getAttribute('role'), 'dialog');
    assert.equal(firstEl.getAttribute('aria-modal'), 'true');
    assert.equal(mgr.isAnyModalOpen(), false);

    first.open();
    assert.equal(firstEl.classList.contains('hidden'), false);
    assert.equal(firstEl.classList.contains('flex'), true);
    assert.equal(mgr.getTopModalId(), 'firstModal');
    assert.equal(doc.activeElement, firstInput);

    second.open();
    assert.equal(mgr.getTopModalId(), 'secondModal');
    assert.equal(mgr.isModalOpen('firstModal'), true);
    assert.equal(mgr.isModalOpen('secondModal'), true);

    const esc1 = doc.dispatchKey('Escape');
    assert.equal(esc1.prevented, true);
    assert.equal(esc1.stopped, true);
    assert.equal(second.isOpen(), false);
    assert.equal(first.isOpen(), true);
    assert.equal(mgr.getTopModalId(), 'firstModal');
    assert.equal(doc.activeElement, firstInput);

    doc.dispatchKey('Escape');
    assert.equal(first.isOpen(), false);
    assert.equal(mgr.isAnyModalOpen(), false);
    assert.deepEqual(reasons, ['second:escape', 'first:escape']);
    assert.equal(doc.activeElement, triggerBtn);

    mgr.destroy();
  });

  it('ignores backdrop clicks that started inside modal content', () => {
    const doc = createFakeDocument();
    const mgr = createModalManager({ documentObj: doc });
    const overlay = createFakeElement('settingsModal', ['hidden']);
    const innerInput = createFakeElement('innerInput');
    const modal = mgr.registerModal(overlay);

    modal.open();

    // Drag iniziato dentro il contenuto e rilasciato sul backdrop -> NON deve chiudere
    overlay.dispatch('pointerdown', { target: innerInput });
    overlay.dispatch('click', { target: overlay });
    assert.equal(modal.isOpen(), true);

    // Click pulito sul backdrop -> deve chiudere
    overlay.dispatch('pointerdown', { target: overlay });
    overlay.dispatch('click', { target: overlay });
    assert.equal(modal.isOpen(), false);

    mgr.destroy();
  });

  it('respects non-closeable / blocked modals on Escape, backdrop, and Back navigation', () => {
    const doc = createFakeDocument();
    const mgr = createModalManager({ documentObj: doc });
    const progressEl = createFakeElement('progressModal');

    const ctrl = mgr.openModalOverlay(progressEl, {
      closeOnEscape: false,
      closeOnBackdrop: false,
      closeOnBack: false,
      ariaBusy: true
    });

    assert.equal(progressEl.getAttribute('aria-busy'), 'true');
    assert.equal(mgr.isAnyModalOpen(), true);

    const esc = doc.dispatchKey('Escape');
    assert.equal(esc.stopped, true);
    assert.equal(ctrl.isOpen(), true);

    progressEl.dispatch('pointerdown', { target: progressEl });
    progressEl.dispatch('click', { target: progressEl });
    assert.equal(ctrl.isOpen(), true);

    const backRes = mgr.closeTopModal('back');
    assert.deepEqual(backRes, { handled: true, closed: false, blocked: true, id: 'progressModal' });
    assert.equal(ctrl.isOpen(), true);

    ctrl.close();
    assert.equal(ctrl.isOpen(), false);
    assert.equal(progressEl.removed, true);
    assert.equal(mgr.isAnyModalOpen(), false);

    mgr.destroy();
  });
});
