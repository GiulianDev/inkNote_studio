import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSidebarHeaderTop } from './sidebar-layout.js';

describe('pages-sidebar layout helper', () => {
  it('returns rounded bottom when header is visible and height changed', () => {
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 61.4, bottom: 61.4 },
        isCompactMode: false,
        lastTop: null
      }),
      61
    );
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 74, bottom: 74.2 },
        isCompactMode: false,
        lastTop: 61
      }),
      74
    );
  });

  it('skips redundant writes when pixel offset is unchanged', () => {
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 61, bottom: 61.2 },
        isCompactMode: false,
        lastTop: 61
      }),
      null
    );
  });

  it('skips updates when header is hidden or in compact mode', () => {
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 0, bottom: 0 },
        isCompactMode: false,
        lastTop: 61
      }),
      null
    );
    assert.equal(
      resolveSidebarHeaderTop({
        rect: { height: 52, bottom: 64 },
        isCompactMode: true,
        lastTop: 61
      }),
      null
    );
    assert.equal(
      resolveSidebarHeaderTop({
        rect: null,
        isCompactMode: false,
        lastTop: 61
      }),
      null
    );
  });
});
