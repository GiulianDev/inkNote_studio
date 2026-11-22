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

test('compressPageData and decompressPageData preserve negative and >1200 coordinates without clipping', async () => {
  const outOfBounds = prepareCloudStrokePayload(packStroke({
    tool: 'pen',
    color: '#0f172a',
    size: 4,
    opacity: 1,
    style: 'solid',
    points: [
      { x: -45.5, y: -12.25, pressure: 0.4, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
      { x: 600.25, y: 1205.5, pressure: 0.7, tiltX: 0, tiltY: 0, speed: 2, pointerType: 'pen' },
      { x: 1350.75, y: 1480.25, pressure: 0.9, tiltX: 0, tiltY: 0, speed: 3, pointerType: 'pen' }
    ]
  }));

  const compressed = await compressPageData([outOfBounds]);
  const restored = await decompressPageData(compressed.buffer);

  assert.equal(restored.length, 1);
  const unpacked = unpackStroke(restored[0]);
  assert.equal(unpacked.points.length, 3);

  const expected = [
    { x: -45.5, y: -12.25 },
    { x: 600.25, y: 1205.5 },
    { x: 1350.75, y: 1480.25 }
  ];
  expected.forEach((pt, idx) => {
    assert.ok(Math.abs(unpacked.points[idx].x - pt.x) < 0.05, `x[${idx}] mismatch: ${unpacked.points[idx].x} vs ${pt.x}`);
    assert.ok(Math.abs(unpacked.points[idx].y - pt.y) < 0.05, `y[${idx}] mismatch: ${unpacked.points[idx].y} vs ${pt.y}`);
  });
});

test('compressPageData handles single-point and collinear out-of-bounds strokes without NaN', async () => {
  const singleOut = prepareCloudStrokePayload(packStroke({
    tool: 'pen',
    color: '#000000',
    size: 3,
    opacity: 1,
    style: 'solid',
    points: [
      { x: 1280.5, y: -33.25, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 0, pointerType: 'pen' }
    ]
  }));

  const verticalEdge = prepareCloudStrokePayload(packStroke({
    tool: 'pen',
    color: '#000000',
    size: 3,
    opacity: 1,
    style: 'solid',
    points: [
      { x: 750, y: -10, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 0, pointerType: 'pen' },
      { x: 750, y: 1240, pressure: 0.6, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' }
    ]
  }));

  const compressed = await compressPageData([singleOut, verticalEdge]);
  const restored = await decompressPageData(compressed.buffer);

  assert.equal(restored.length, 2);
  const u0 = unpackStroke(restored[0]);
  assert.ok(Number.isFinite(u0.points[0].x) && Math.abs(u0.points[0].x - 1280.5) < 0.01);
  assert.ok(Number.isFinite(u0.points[0].y) && Math.abs(u0.points[0].y - (-33.25)) < 0.01);

  const u1 = unpackStroke(restored[1]);
  assert.ok(Math.abs(u1.points[0].x - 750) < 0.05);
  assert.ok(Math.abs(u1.points[0].y - (-10)) < 0.05);
  assert.ok(Math.abs(u1.points[1].x - 750) < 0.05);
  assert.ok(Math.abs(u1.points[1].y - 1240) < 0.05);
});

test('compressPageData omits rx/ry metadata for standard [0..1200] strokes on mixed pages', async () => {
  const { gunzipSync } = await import('node:zlib');
  const normal = prepareCloudStrokePayload(packStroke({
    tool: 'pen',
    color: '#000000',
    size: 3,
    opacity: 1,
    style: 'solid',
    points: [
      { x: 100, y: 200, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
      { x: 794, y: 1123, pressure: 0.6, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' }
    ]
  }));
  const extended = prepareCloudStrokePayload(packStroke({
    tool: 'pen',
    color: '#000000',
    size: 3,
    opacity: 1,
    style: 'solid',
    points: [
      { x: 100, y: 50, pressure: 0.5, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' },
      { x: 200, y: 1260, pressure: 0.6, tiltX: 0, tiltY: 0, speed: 1, pointerType: 'pen' }
    ]
  }));

  const compressed = await compressPageData([normal, extended]);
  const raw = new Uint8Array(gunzipSync(compressed));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const decoder = new TextDecoder();

  let o = 4; // skip strokeCount
  const metaLen0 = dv.getUint16(o, true); o += 2;
  const meta0 = JSON.parse(decoder.decode(raw.subarray(o, o + metaLen0))); o += metaLen0;
  const ptCount0 = dv.getUint32(o, true); o += 4 + ptCount0 * 9;

  const metaLen1 = dv.getUint16(o, true); o += 2;
  const meta1 = JSON.parse(decoder.decode(raw.subarray(o, o + metaLen1)));

  assert.equal(meta0.rx, undefined);
  assert.equal(meta0.ry, undefined);
  assert.equal(meta1.rx, undefined);
  assert.deepEqual(meta1.ry, [50, 1260]);
});

