import test from 'node:test';
import assert from 'node:assert/strict';
import { WALL, CAPACITY, cellOf, songAt, span, tileCells, tileOfSong, tilesForSong, newestInTile, tileKey, existingTiles, levelW, tileSize } from './layout.mjs';

function bruteNewest(k, x, y, songCount) {
  const { c0, c1, r0, r1 } = tileCells(k, x, y);
  let best = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const n = songAt(c, r);
    if (n <= songCount && n > best) best = n;
  }
  return best;
}

test('cellOf and songAt are inverses', () => {
  for (let n = 1; n <= 20000; n += 7) {
    const { col, row } = cellOf(n);
    assert.equal(songAt(col, row), n);
  }
});

test('newestInTile matches brute force', () => {
  const counts = [1, 2, 76, 77, 78, 154, 155, 300, 5852, 5853, 6501, 6502, 6545, 6546, 10000, CAPACITY - 1, CAPACITY];
  for (let n = 6400; n <= 7300; n++) counts.push(n);
  for (const songCount of counts) {
    const maxRow = Math.min(WALL.capacityRows, Math.ceil(songCount / WALL.cols) + 4);
    for (let k = 0; k < WALL.levels; k++) {
      const s = span(k);
      for (let y = 0; y * s < maxRow; y++) for (let x = 0; x * s < WALL.cols; x++) {
        assert.equal(newestInTile(k, x, y, songCount), bruteNewest(k, x, y, songCount), `k${k} ${x},${y} @${songCount}`);
      }
    }
  }
});

test('adding song n changes exactly the tiles that contain it', () => {
  for (const n of [2, 77, 78, 5853, 6502, 6546, 19712]) {
    const changed = [];
    for (let k = 0; k < WALL.levels; k++) {
      const s = span(k);
      for (let y = 0; y * s < WALL.capacityRows; y++) for (let x = 0; x * s < WALL.cols; x++) {
        if (tileKey(k, x, y, n - 1) !== tileKey(k, x, y, n)) changed.push(`${k}/${x}_${y}`);
      }
    }
    assert.deepEqual(changed, tilesForSong(n).map(t => `${t.k}/${t.x}_${t.y}`));
  }
});

test('tile counts match the plan', () => {
  assert.equal([...existingTiles(5852)].length, 2002);
  assert.equal([...existingTiles(6502)].length, 2239);
});

test('tile sizes cover each level exactly', () => {
  for (let k = 0; k < WALL.levels; k++) {
    const nx = Math.ceil(WALL.cols / span(k));
    let w = 0;
    for (let x = 0; x < nx; x++) w += tileSize(k, x).w;
    assert.equal(w, levelW(k));
  }
});

test('tileOfSong agrees with tileCells', () => {
  for (let n = 1; n <= CAPACITY; n += 13) for (let k = 0; k < WALL.levels; k++) {
    const { x, y } = tileOfSong(k, n), { c0, c1, r0, r1 } = tileCells(k, x, y), { col, row } = cellOf(n);
    assert.ok(col >= c0 && col <= c1 && row >= r0 && row <= r1);
  }
});

test('overrides apply only while v matches', () => {
  const ov = { '0/0_0': { v: 78, rev: 2 } };
  assert.equal(tileKey(0, 0, 0, 78, ov), 'wall/p1/0/0_0_78-r2.webp');
  assert.equal(tileKey(0, 0, 0, 79, ov), 'wall/p1/0/0_0_79.webp');
  assert.equal(tileKey(0, 0, 0, 200, ov), 'wall/p1/0/0_0_79.webp');
  assert.equal(tileKey(0, 5, 100, 6502), null);
});
