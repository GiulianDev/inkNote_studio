import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLazyStrokes } from './lazy-strokes.js';

test('does not call unpackFn until strokes property is read', () => {
  let unpackCalls = 0;
  const page = { pageId: 'p1' };
  const raw = [{ packed: new Float32Array([1, 2, 0.5, 0, 0, 0, 0]), count: 1 }];

  attachLazyStrokes(page, raw, (items) => {
    unpackCalls++;
    return items.map(() => ({ points: [{ x: 1, y: 2 }] }));
  });

  assert.equal(unpackCalls, 0);
  assert.ok(Object.keys(page).includes('strokes'));
  assert.equal(unpackCalls, 0);

  const firstRead = page.strokes;
  assert.equal(unpackCalls, 1);
  assert.equal(Array.isArray(firstRead), true);
  assert.equal(firstRead.length, 1);

  const secondRead = page.strokes;
  assert.equal(unpackCalls, 1);
  assert.strictEqual(secondRead, firstRead);
});

test('supports mutating returned array and direct reassignment', () => {
  let unpackCalls = 0;
  const page = {};
  attachLazyStrokes(page, [{ id: 'raw1' }], (items) => {
    unpackCalls++;
    return items.map(x => ({ unpacked: x.id }));
  });

  page.strokes.push({ unpacked: 'added' });
  assert.equal(unpackCalls, 1);
  assert.equal(page.strokes.length, 2);

  page.strokes = [{ unpacked: 'replaced' }];
  assert.equal(unpackCalls, 1);
  assert.deepEqual(page.strokes, [{ unpacked: 'replaced' }]);
});

test('setting strokes before first read skips unpacking completely', () => {
  let unpackCalls = 0;
  const page = {};
  attachLazyStrokes(page, [{ id: 'raw1' }], () => {
    unpackCalls++;
    return [{ unpacked: 'should-not-run' }];
  });

  page.strokes = [];
  assert.equal(unpackCalls, 0);
  assert.deepEqual(page.strokes, []);
  assert.equal(unpackCalls, 0);
});

test('alreadyUnpacked or empty rawStrokes assigns directly without calling unpackFn', () => {
  let unpackCalls = 0;
  const emptyPage = {};
  attachLazyStrokes(emptyPage, [], () => {
    unpackCalls++;
    return [];
  });
  assert.deepEqual(emptyPage.strokes, []);
  assert.equal(unpackCalls, 0);

  const pre = [{ points: [{ x: 5, y: 6 }] }];
  const prePage = {};
  attachLazyStrokes(prePage, pre, () => {
    unpackCalls++;
    return [];
  }, { alreadyUnpacked: true });
  assert.strictEqual(prePage.strokes, pre);
  assert.equal(unpackCalls, 0);
});
