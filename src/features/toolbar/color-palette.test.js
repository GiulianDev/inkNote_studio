import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_COLORS_MAX,
  normalizeHexColor,
  isPresetColor,
  pushRecentColor,
  colorsEqual,
  hsvToHex,
  hexToHsv,
  getReadableContrastColor
} from './color-palette.js';

test('normalizeHexColor normalizes shorthand and uppercase hex strings', () => {
  assert.equal(normalizeHexColor('#ABC'), '#aabbcc');
  assert.equal(normalizeHexColor('  #2563EB '), '#2563eb');
  assert.equal(normalizeHexColor('not-a-color', '#000000'), '#000000');
  assert.equal(normalizeHexColor(null), null);
});

test('isPresetColor distinguishes default pen colors and highlighter presets', () => {
  assert.equal(isPresetColor('#000000', 'pen'), true);
  assert.equal(isPresetColor('#2563EB', 'marker'), true);
  assert.equal(isPresetColor('#FFEB3B', 'highlighter'), true);
  assert.equal(isPresetColor('#FFEB3B', 'pen'), false);
  assert.equal(isPresetColor('#8b5cf6', 'pen'), false);
});

test('pushRecentColor enforces MRU ordering, max 4 limit, and excludes presets', () => {
  let list = [];
  list = pushRecentColor(list, '#000000', { toolName: 'pen' });
  assert.deepEqual(list, []);

  list = pushRecentColor(list, '#FFEB3B', { toolName: 'highlighter' });
  assert.deepEqual(list, []);

  list = pushRecentColor(list, '#8B5CF6');
  list = pushRecentColor(list, '#14B8A6');
  list = pushRecentColor(list, '#EC4899');
  list = pushRecentColor(list, '#84CC16');
  assert.equal(list.length, RECENT_COLORS_MAX);
  assert.deepEqual(list, ['#84cc16', '#ec4899', '#14b8a6', '#8b5cf6']);

  // Promoting an existing color moves it to front without duplicates
  list = pushRecentColor(list, '#14b8a6');
  assert.deepEqual(list, ['#14b8a6', '#84cc16', '#ec4899', '#8b5cf6']);

  // Adding a 5th drops the least recently used one
  list = pushRecentColor(list, '#f43f5e');
  assert.deepEqual(list, ['#f43f5e', '#14b8a6', '#84cc16', '#ec4899']);
});

test('hsvToHex and hexToHsv round-trip accurately across primary and custom hues', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#2563eb', '#8b5cf6', '#000000', '#ffffff']) {
    const hsv = hexToHsv(hex);
    assert.equal(hsvToHex(hsv.h, hsv.s, hsv.v), hex);
  }
  assert.equal(colorsEqual('#2563EB', '#2563eb'), true);
  assert.equal(colorsEqual('#2563EB', '#000000'), false);
});

test('getReadableContrastColor chooses dark text on bright/low-opacity swatches and white on dark', () => {
  assert.equal(getReadableContrastColor('#000000', 1), '#ffffff');
  assert.equal(getReadableContrastColor('#2563eb', 1), '#ffffff');
  assert.equal(getReadableContrastColor('#ffeb3b', 1), '#0f172a');
  assert.equal(getReadableContrastColor('#000000', 0.2), '#0f172a');
});
