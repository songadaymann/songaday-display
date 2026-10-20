import test from 'node:test';
import assert from 'node:assert/strict';
import { WALL, CANVAS_W, cellOf } from '../../../shared/layout.mjs';
import { hitTest, cellRect, visibleCells, songsIn, inRange, songViewportRect } from './frame.js';

const frames = [
  { ox: 0, oy: 0, s: 1 },
  { ox: -1234.5, oy: -987.25, s: 0.73 },
  { ox: 40, oy: 12, s: 1440 / CANVAS_W },
  { ox: -50000, oy: -20000, s: 2 },
];

test('hit-testing the centre of every drawn cell finds that cell', () => {
  for (const f of frames) {
    for (let n = 1; n <= 6502; n += 37) {
      const r = cellRect(n, f);
      assert.equal(hitTest(f, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, 6502), n);
      assert.equal(hitTest(f, { x: r.x + 0.01, y: r.y + 0.01 }, 6502), n, 'top-left corner');
      assert.equal(hitTest(f, { x: r.x + r.w - 0.01, y: r.y + r.h - 0.01 }, 6502), n, 'bottom-right corner');
    }
  }
});

test('hit-testing outside the filled wall finds nothing', () => {
  const f = { ox: 10, oy: 10, s: 0.05 };
  assert.equal(hitTest(f, { x: 9, y: 20 }, 6502), 0, 'left of the wall');
  assert.equal(hitTest(f, { x: 20, y: 9 }, 6502), 0, 'above the wall');
  assert.equal(hitTest(f, { x: 10 + CANVAS_W * f.s + 1, y: 20 }, 6502), 0, 'right of the wall');
  const last = cellRect(6502, f);
  assert.equal(hitTest(f, { x: last.x + last.w * 1.5, y: last.y + last.h / 2 }, 6502), 0, 'empty cell after the newest song');
  assert.equal(hitTest(f, { x: last.x + last.w / 2, y: last.y + last.h / 2 }, 6501), 0, 'not yet on the wall');
  assert.equal(hitTest(f, null, 6502), 0);
  assert.equal(hitTest({ ox: 0, oy: 0, s: 0 }, { x: 1, y: 1 }, 6502), 0);
});

test('cellRect matches the wall layout', () => {
  const f = { ox: 5, oy: 7, s: 0.5 };
  const { col, row } = cellOf(6502);
  assert.deepEqual(cellRect(6502, f), { x: 5 + col * 240, y: 7 + row * 135, w: 240, h: 135 });
});

test('visibleCells counts exactly the songs on screen', () => {
  const songCount = 6502;
  for (const f of frames) {
    for (const [w, h] of [[1440, 800], [375, 700], [3000, 2000]]) {
      const range = visibleCells(f, w, h, songCount);
      let brute = 0;
      for (let n = 1; n <= songCount; n++) {
        const r = cellRect(n, f);
        if (r.x < w && r.x + r.w > 0 && r.y < h && r.y + r.h > 0) brute++;
      }
      if (!range) {
        assert.equal(brute, 0);
        continue;
      }
      const listed = [...songsIn(range, songCount)];
      assert.equal(range.count, listed.length);
      assert.equal(range.count, brute);
      for (const n of listed) assert.ok(inRange(range, n));
    }
  }
});

test('visibleCells at home view and when zoomed in', () => {
  const home = { ox: 0, oy: 0, s: 1440 / CANVAS_W };
  const all = visibleCells(home, 1440, 2000, 6502);
  assert.equal(all.count, 6502);
  const close = { ox: -480 * 10, oy: -270 * 20, s: 1 };
  const r = visibleCells(close, 1440, 810, 6502);
  assert.deepEqual([r.c0, r.c1, r.r0, r.r1, r.count], [10, 12, 20, 22, 9], 'cells that only touch the edge are out');
  assert.equal(visibleCells({ ox: 5000, oy: 0, s: 1 }, 1440, 800, 6502), null);
});

test('songViewportRect is the cell in viewport units, padded about its centre', () => {
  const r = songViewportRect(78);
  assert.deepEqual(r, { x: 0, y: WALL.cellH / CANVAS_W, width: WALL.cellW / CANVAS_W, height: WALL.cellH / CANVAS_W });
  const p = songViewportRect(78, 1.5);
  assert.ok(Math.abs(p.x + p.width / 2 - (r.x + r.width / 2)) < 1e-12);
  assert.ok(Math.abs(p.width - r.width * 1.5) < 1e-12);
});
