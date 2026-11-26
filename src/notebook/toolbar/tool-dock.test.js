import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureToolDockAttributes, registerToolDockElement, InkToolDockElement } from './tool-dock.js';

describe('tool-dock component', () => {
  it('adds ui-dock, context-dock, and default toolbar role without overriding existing role', () => {
    const classes = new Set(['hidden']);
    const attrs = new Map();
    const fakeEl = {
      classList: {
        add: (...items) => items.forEach((c) => classes.add(c)),
        contains: (c) => classes.has(c)
      },
      hasAttribute: (k) => attrs.has(k),
      setAttribute: (k, v) => attrs.set(k, v)
    };

    ensureToolDockAttributes(fakeEl);
    assert.equal(classes.has('ui-dock'), true);
    assert.equal(classes.has('context-dock'), true);
    assert.equal(classes.has('hidden'), true);
    assert.equal(attrs.get('role'), 'toolbar');

    attrs.set('role', 'group');
    ensureToolDockAttributes(fakeEl);
    assert.equal(attrs.get('role'), 'group');
  });

  it('registers <ink-tool-dock> once against a customElements registry', () => {
    const map = new Map();
    const registry = {
      get: (name) => map.get(name),
      define: (name, ctor) => map.set(name, ctor)
    };

    registerToolDockElement(registry);
    registerToolDockElement(registry);
    assert.equal(map.get('ink-tool-dock'), InkToolDockElement);
    assert.equal(map.size, 1);
  });
});
