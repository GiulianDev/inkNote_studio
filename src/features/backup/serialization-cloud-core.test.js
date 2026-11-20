import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { packStroke, unpackStroke } from '../persistence/serialization.js';
import {
  prepareCloudStrokePayload,
  compressPageData,
  decompressPageData,
  compressPageBundle,
  decompressPageBundle
} from './serialization-cloud-core.js';

test('compressPageData and decompressPageData preserve stroke style', async () => {
  const styles = ['solid', 'dashed', 'dashed-large', 'dotted', 'dash-dot'];
  const rawPacked = styles.map((style, idx) =>
    packStroke({
      tool: idx % 2 === 0 ? 'pen' : 'marker',
      color: '#1e293b',
      size: 4 + idx,
      opacity: 0.75,
      style,
      points: [
        { x: 10 + idx * 5, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
        { x: 100 + idx * 5, y: 120, pressure: 0.8, tiltX: 5, tiltY: -5, speed: 3, pointerType: 'pen' }
      ]
    })
  );

  const payload = rawPacked.map(prepareCloudStrokePayload);
  const compressed = await compressPageData(payload);
  const restored = await decompressPageData(compressed.buffer);

  assert.equal(restored.length, styles.length);
  styles.forEach((expectedStyle, idx) => {
    assert.equal(restored[idx].style, expectedStyle);
    assert.equal(restored[idx].count, 2);
    assert.equal(restored[idx].opacity, 0.75);
    const unpacked = unpackStroke(restored[idx]);
    assert.equal(unpacked.style, expectedStyle);
    assert.equal(unpacked.points.length, 2);
  });
});

test('prepareCloudStrokePayload normalizes legacy unpacked strokes without crashing', async () => {
  const legacyUnpackedStroke = {
    tool: 'pen',
    color: '#ef4444',
    size: 5,
    // no packed, no count, no opacity, no style
    points: [
      { x: 50, y: 60, pressure: 0.6, tiltX: 0, tiltY: 0, speed: 0, pointerType: 'pen' },
      { x: 90, y: 110, pressure: 0.7, tiltX: 2, tiltY: 3, speed: 2, pointerType: 'pen' }
    ]
  };
  const legacyBlackHighlighter = {
    tool: 'highlighter',
    color: '#000000',
    size: 8,
    points: [
      { x: 15, y: 25, pressure: 0.5 },
      { x: 85, y: 25, pressure: 0.5 }
    ]
  };

  const payload = [legacyUnpackedStroke, legacyBlackHighlighter].map(prepareCloudStrokePayload);
  const compressed = await compressPageData(payload);
  const restored = await decompressPageData(compressed.buffer);

  assert.equal(restored.length, 2);
  assert.equal(restored[0].count, 2);
  assert.equal(restored[0].opacity, 1.0);
  assert.equal(restored[0].style, 'solid');
  assert.equal(restored[1].color, '#FFEB3B');
  assert.equal(restored[1].opacity, 0.4);
  assert.equal(restored[1].style, 'solid');
});

test('decompressPageData handles legacy .inknote chunks without style field in meta', async () => {
  const encoder = new TextEncoder();
  const metaBytes = encoder.encode(JSON.stringify({
    tool: 'pen',
    color: '#000000',
    size: 3,
    opacity: 1
  }));
  const rawLen = 4 + 2 + metaBytes.length + 4 + 9;
  const raw = new Uint8Array(rawLen);
  const dv = new DataView(raw.buffer);
  let o = 0;
  dv.setUint32(o, 1, true); o += 4;
  dv.setUint16(o, metaBytes.length, true); o += 2;
  raw.set(metaBytes, o); o += metaBytes.length;
  dv.setUint32(o, 1, true); o += 4;
  // 1 point all zeros (9 bytes)

  const gz = new Uint8Array(gzipSync(raw));
  const restored = await decompressPageData(gz.buffer);

  assert.equal(restored.length, 1);
  assert.equal(restored[0].style, 'solid');
  assert.equal(restored[0].opacity, 1);
  assert.equal(restored[0].count, 1);

  const legacyBundle = await decompressPageBundle(gz.buffer);
  assert.equal(legacyBundle.strokes.length, 1);
  assert.deepEqual(legacyBundle.textBoxes, []);
});

test('compressPageBundle and decompressPageBundle roundtrip strokes and textBoxes cleanly', async () => {
  const stroke = prepareCloudStrokePayload(packStroke({
    tool: 'pen',
    color: '#000000',
    size: 3,
    opacity: 1,
    style: 'solid',
    points: [
      { x: 20, y: 30, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
      { x: 80, y: 90, pressure: 0.6, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' }
    ]
  }));

  const textBoxes = [
    {
      id: 'tb_1',
      x: 120,
      y: 160,
      width: 300,
      height: 76,
      text: 'Appunti di prova\nsu più righe',
      fontFamily: 'serif',
      fontSize: 22,
      bold: true,
      italic: true,
      align: 'center',
      color: '#4f46e5'
    },
    {
      id: 'tb_empty',
      x: 10,
      y: 10,
      width: 200,
      height: 40,
      text: '   '
    }
  ];

  const compressed = await compressPageBundle([stroke], textBoxes);
  const { strokes: outStrokes, textBoxes: outBoxes } = await decompressPageBundle(compressed.buffer);

  assert.equal(outStrokes.length, 1);
  assert.equal(outStrokes[0].count, 2);
  assert.equal(outBoxes.length, 1);
  assert.equal(outBoxes[0].id, 'tb_1');
  assert.equal(outBoxes[0].text, 'Appunti di prova\nsu più righe');
  assert.equal(outBoxes[0].fontFamily, 'serif');
  assert.equal(outBoxes[0].fontSize, 22);
  assert.equal(outBoxes[0].bold, true);
  assert.equal(outBoxes[0].italic, true);
  assert.equal(outBoxes[0].align, 'center');
  assert.equal(outBoxes[0].color, '#4f46e5');
});
