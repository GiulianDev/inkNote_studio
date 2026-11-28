import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveToastIconHtml,
  getEmptyStateIconSvg,
  getPullIndicatorIconSvg
} from './ui-icons.js';

describe('ui-icons SVG registry', () => {
  it('maps semantic keys and legacy emojis to uniform 1.75px SVG icons', () => {
    for (const token of ['info', '⚠️', '❌', '✅', '🗑️', '☁️', '⚙️', '✏️', '🖐️']) {
      const html = resolveToastIconHtml(token);
      assert.ok(html.includes('<svg '), `expected <svg> for ${token}`);
      assert.ok(html.includes('stroke-width="1.75"'));
    }
  });

  it('preserves mathematical and Greek symbol glyphs cleanly', () => {
    const math = resolveToastIconHtml('∑');
    assert.ok(math.includes('∑'));
    assert.ok(!math.includes('<svg'));

    const greek = resolveToastIconHtml('α');
    assert.ok(greek.includes('α'));
  });

  it('provides SVG icons for library empty states and pull indicator', () => {
    for (const kind of ['search', 'star', 'folder', 'warning', 'notebook']) {
      const svg = getEmptyStateIconSvg(kind);
      assert.ok(svg.includes('<svg '));
    }
    assert.ok(getPullIndicatorIconSvg(false).includes('<svg '));
    assert.ok(getPullIndicatorIconSvg(true).includes('<svg '));
  });
});
