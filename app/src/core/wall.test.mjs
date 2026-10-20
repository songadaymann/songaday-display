import test from 'node:test';
import assert from 'node:assert/strict';
import { WALL, existingTiles, osdLevel, rowsFor } from '../../../shared/layout.mjs';
import { wallSource, tilesChanged, manifestProblems, needsNewApp, wallMismatch } from './wall.js';

const url = (p) => `/media/${p}`;

test('the tile source declares the filled rows and requests exactly the existing tiles', () => {
  for (const songCount of [1, 77, 78, 5852, 6501, 6502, 6546]) {
    const src = wallSource({ songCount, overrides: {} }, url);
    assert.equal(src.width, 36960);
    assert.equal(src.height, rowsFor(songCount) * WALL.cellH);
    assert.equal(src.maxLevel, WALL.levels - 1);
    const expected = new Set([...existingTiles(songCount)].map((t) => `${osdLevel(t.k)}/${t.x}_${t.y}`));
    const got = new Set();
    for (let level = 0; level < WALL.levels; level++) {
      // OSD's own grid for this level, from the declared size.
      const scale = 2 ** (level - (WALL.levels - 1));
      const nx = Math.ceil((src.width * scale) / WALL.tileW), ny = Math.ceil((src.height * scale) / WALL.tileH);
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (src.hasTile(level, x, y)) got.add(`${level}/${x}_${y}`);
    }
    assert.deepEqual(got, expected, `songCount ${songCount}`);
  }
});

test('tile URLs come from tileKey, with overrides', () => {
  // Song 6502 is col 33, row 84: tile 16_42 at full resolution (OSD level 7 is our level 0).
  const src = wallSource({ songCount: 6502, overrides: { '0/16_42': { v: 6502, rev: 2 }, '1/0_0': { v: 1, rev: 1 } } }, url);
  assert.equal(src.getTileUrl(7, 16, 42), '/media/wall/p1/0/16_42_6502-r2.webp');
  assert.equal(src.getTileUrl(6, 0, 0), '/media/wall/p1/1/0_0_235.webp', 'stale override ignored');
  assert.equal(src.getTileUrl(0, 0, 0), '/media/wall/p1/7/0_0_6502.webp');
  assert.equal(src.getTileUrl(7, 0, 0), '/media/wall/p1/0/0_0_79.webp');
  assert.equal(src.hasTile(7, 0, 50), false);
  assert.match(src.getTileUrl(7, 0, 50), /^\/media\/wall\/none\//);
});

test('tilesChanged', () => {
  const a = { songCount: 10, pyramid: 'p1', overrides: {} };
  assert.equal(tilesChanged(a, { ...a }), false);
  assert.equal(tilesChanged(a, { ...a, updatedAt: 'x', missingArt: [1] }), false);
  assert.equal(tilesChanged(a, { ...a, songCount: 11 }), true);
  assert.equal(tilesChanged(a, { ...a, overrides: { '0/0_0': { v: 4, rev: 1 } } }), true);
});

test('manifest and wall.json checks', () => {
  assert.deepEqual(manifestProblems({ schema: 1, pyramid: 'p1', songCount: 6502 }), []);
  assert.equal(manifestProblems({ schema: 2, pyramid: 'p1', songCount: 0 }).length, 2);
  assert.deepEqual(manifestProblems(null), ['not an object']);
  assert.equal(needsNewApp({ schema: 1, pyramid: 'p1', songCount: 6502 }), false);
  assert.equal(needsNewApp({ schema: 1, pyramid: 'p2', songCount: 6502 }), true);
  assert.equal(needsNewApp({ schema: 2, pyramid: 'p1', songCount: 6502 }), true);
  assert.equal(needsNewApp({ schema: 1, pyramid: 'p1', songCount: 0 }), false, 'a broken manifest is refused, not reloaded for');
  assert.deepEqual(wallMismatch({ ...WALL, codec: {} }), []);
  assert.deepEqual(wallMismatch({ wall: { cols: 80, levels: 8 } }), ['cols']);
  assert.deepEqual(wallMismatch(null), []);
});
