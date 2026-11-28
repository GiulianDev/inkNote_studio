import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabSyncController } from './tab-sync.js';

function createMockBus() {
  const channels = new Set();
  return (name) => {
    const ch = {
      name,
      onmessage: null,
      closed: false,
      postMessage(data) {
        if (this.closed) throw new Error('closed');
        for (const peer of channels) {
          if (peer !== this && !peer.closed && peer.name === this.name && typeof peer.onmessage === 'function') {
            peer.onmessage({ data });
          }
        }
      },
      close() {
        this.closed = true;
        channels.delete(this);
      }
    };
    channels.add(ch);
    return ch;
  };
}

test('createTabSyncController delivers events across different tabs and ignores self', () => {
  const factory = createMockBus();
  const tabA = createTabSyncController({ channelFactory: factory, tabId: 'tab-A' });
  const tabB = createTabSyncController({ channelFactory: factory, tabId: 'tab-B' });

  const receivedA = [];
  const receivedB = [];

  tabA.onTabEvent('notebook:saved', (payload) => receivedA.push(payload));
  tabB.onTabEvent('notebook:saved', (payload) => receivedB.push(payload));

  assert.equal(tabA.broadcast('notebook:saved', { notebookId: 'nb_1' }), true);

  assert.deepEqual(receivedA, []);
  assert.deepEqual(receivedB, [{ notebookId: 'nb_1' }]);

  tabA.destroy();
  tabB.destroy();
});

test('createTabSyncController degrades gracefully when BroadcastChannel is unavailable', () => {
  const tab = createTabSyncController({ channelFactory: () => null, tabId: 'tab-only' });
  const unsub = tab.onTabEvent('library:mutated', () => {});
  assert.equal(tab.broadcast('library:mutated', {}), false);
  unsub();
  tab.destroy();
});
