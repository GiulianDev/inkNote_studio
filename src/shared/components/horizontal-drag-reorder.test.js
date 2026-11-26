import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findHorizontalInsertBefore,
  createHorizontalLongPressReorder
} from './horizontal-drag-reorder.js';

describe('horizontal-drag-reorder', () => {
  it('findHorizontalInsertBefore finds first sibling whose midpoint exceeds clientX', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const rects = [
      { el: a, left: 0, width: 40 },    // midpoint 20
      { el: b, left: 48, width: 40 },   // midpoint 68
      { el: c, left: 96, width: 40 }    // midpoint 116
    ];

    assert.equal(findHorizontalInsertBefore(10, rects), a);
    assert.equal(findHorizontalInsertBefore(35, rects), b);
    assert.equal(findHorizontalInsertBefore(90, rects), c);
    assert.equal(findHorizontalInsertBefore(130, rects), null);
  });

  it('reorders items after long press, cancels on early drift, and supports drop-outside', async () => {
    const prevDoc = globalThis.document;

    const docListeners = new Map();
    const bodyClasses = new Set();
    const containerClasses = new Set();

    const fakeDoc = {
      body: {
        classList: {
          add: (c) => bodyClasses.add(c),
          remove: (c) => bodyClasses.delete(c)
        }
      },
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => {
        docListeners.get(type)?.delete(fn);
      },
      dispatch(type, ev) {
        for (const fn of [...(docListeners.get(type) || [])]) fn(ev);
      }
    };
    globalThis.document = fakeDoc;

    const makeBtn = (id, left) => {
      const classes = new Set();
      const btn = {
        id,
        style: { display: '' },
        _left: left,
        classList: {
          add: (...cs) => cs.forEach(c => classes.add(c)),
          remove: (...cs) => cs.forEach(c => classes.delete(c)),
          toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
          has: (c) => classes.has(c)
        },
        closest: (sel) => (sel === '.btn' ? btn : null),
        getBoundingClientRect: () => ({ left: btn._left, width: 40 }),
        get nextSibling() {
          const idx = children.indexOf(btn);
          return idx >= 0 && idx + 1 < children.length ? children[idx + 1] : null;
        }
      };
      return btn;
    };

    const children = [makeBtn('a', 0), makeBtn('b', 50), makeBtn('c', 100)];
    const cListeners = new Map();
    const container = {
      contains: (el) => children.includes(el),
      querySelectorAll: () => children.slice(),
      insertBefore: (node, ref) => {
        const cur = children.indexOf(node);
        if (cur >= 0) children.splice(cur, 1);
        if (!ref) {
          children.push(node);
        } else {
          const idx = children.indexOf(ref);
          children.splice(idx >= 0 ? idx : children.length, 0, node);
        }
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 50 }),
      classList: {
        toggle: (c, force) => (force ? containerClasses.add(c) : containerClasses.delete(c)),
        remove: (c) => containerClasses.delete(c)
      },
      addEventListener: (type, fn, cap) => cListeners.set(`${type}:${!!cap}`, fn),
      removeEventListener: (type, fn, cap) => {
        if (cListeners.get(`${type}:${!!cap}`) === fn) cListeners.delete(`${type}:${!!cap}`);
      }
    };

    let committed = null;
    let droppedOutside = null;
    let dragStarts = 0;

    const ctrl = createHorizontalLongPressReorder({
      container,
      itemSelector: '.btn',
      bodyDragClass: 'test-dragging',
      longPressMs: 15,
      moveCancelPx: 10,
      dropOutsideThresholdPx: 30,
      onDragStart: () => { dragStarts++; },
      onCommit: (els) => { committed = els.map(e => e.id); },
      onDropOutside: (el) => { droppedOutside = el.id; }
    });

    try {
      // 1. Early drift > 10px cancels long press
      cListeners.get('pointerdown:false')({
        target: children[0],
        pointerId: 1,
        pointerType: 'touch',
        clientX: 10,
        clientY: 10
      });
      fakeDoc.dispatch('pointermove', { pointerId: 1, clientX: 30, clientY: 10, preventDefault() {} });
      await new Promise(r => setTimeout(r, 25));
      assert.equal(dragStarts, 0);

      // 2. Long press arms, then drag 'a' past 'b' midpoint (70) -> ['b', 'a', 'c']
      cListeners.get('pointerdown:false')({
        target: children[0],
        pointerId: 2,
        pointerType: 'mouse',
        button: 0,
        clientX: 15,
        clientY: 20
      });
      await new Promise(r => setTimeout(r, 25));
      assert.equal(dragStarts, 1);
      assert.equal(bodyClasses.has('test-dragging'), true);

      fakeDoc.dispatch('pointermove', { pointerId: 2, clientX: 85, clientY: 20, preventDefault() {} });
      fakeDoc.dispatch('pointerup', { type: 'pointerup', pointerId: 2, clientX: 85, clientY: 20 });

      assert.deepEqual(committed, ['b', 'a', 'c']);
      assert.equal(bodyClasses.has('test-dragging'), false);

      // Click immediately after drag is suppressed
      let clickPropagated = true;
      let clickDefaultPrevented = false;
      cListeners.get('click:true')({
        stopPropagation: () => { clickPropagated = false; },
        preventDefault: () => { clickDefaultPrevented = true; }
      });
      assert.equal(clickPropagated, false);
      assert.equal(clickDefaultPrevented, true);

      // 3. Dragging below threshold (> 50 + 30 = 80) triggers drop outside
      cListeners.get('pointerdown:false')({
        target: children[0],
        pointerId: 3,
        pointerType: 'mouse',
        button: 0,
        clientX: 15,
        clientY: 20
      });
      await new Promise(r => setTimeout(r, 25));
      fakeDoc.dispatch('pointermove', { pointerId: 3, clientX: 15, clientY: 95, preventDefault() {} });
      assert.equal(containerClasses.has('drop-outside'), true);
      assert.equal(children[0].classList.has('will-hide'), true);

      fakeDoc.dispatch('pointerup', { type: 'pointerup', pointerId: 3, clientX: 15, clientY: 95 });
      assert.equal(droppedOutside, 'b');
      assert.equal(containerClasses.has('drop-outside'), false);
    } finally {
      ctrl.destroy();
      globalThis.document = prevDoc;
    }
  });
});
