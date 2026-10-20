import test from 'node:test';
import assert from 'node:assert/strict';
import { previewSongs, nextMode, NEARBY_MAX } from './previews.js';
import { visibleCells } from './frame.js';

test('previews: off, hover and nearby', () => {
  const noGif = new Set([940]);
  const near = visibleCells({ ox: -480 * 10, oy: -270 * 10, s: 1 }, 1440, 810, 6502); // 3 x 3 cells
  const far = visibleCells({ ox: 0, oy: 0, s: 0.05 }, 1440, 900, 6502);
  const base = { songCount: 6502, noGif };
  assert.deepEqual(previewSongs('off', { ...base, range: near, hover: 781, cellPx: 480 }), []);
  assert.deepEqual(previewSongs('hover', { ...base, range: near, hover: 781, cellPx: 480 }), [781]);
  assert.deepEqual(previewSongs('hover', { ...base, range: far, hover: 781, cellPx: 24 }), [], 'too small to animate');
  const nearby = previewSongs('nearby', { ...base, range: near, hover: 781, cellPx: 480 });
  assert.equal(nearby[0], 781, 'hovered first');
  assert.equal(nearby.length, near.count);
  assert.deepEqual(previewSongs('nearby', { ...base, range: far, hover: 0, cellPx: 24 }), [], `over ${NEARBY_MAX} visible`);
  const withMissing = previewSongs('nearby', { ...base, range: visibleCells({ ox: -480 * 16, oy: -270 * 12, s: 1 }, 960, 540, 6502), hover: 940, cellPx: 480 });
  assert.ok(!withMissing.includes(940), 'songs in noGif show nothing');
  assert.equal(nextMode('off'), 'hover');
  assert.equal(nextMode('hover'), 'nearby');
  assert.equal(nextMode('nearby'), 'off');
});
