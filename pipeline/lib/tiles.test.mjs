import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { WALL, existingTiles, tileKey, tileSize, tilesForSong } from '../../shared/layout.mjs';
import { CELL_BYTES, boxDown, buildWall, decodeTile, encodeTile, memStore, patchSongs, renderK0, songsInTile } from './tiles.mjs';

const { cellW: CW, cellH: CH, tileH: TH } = WALL;

const solid = (w, rgb) => {
  const data = Buffer.alloc(w * TH * 3);
  for (let i = 0; i < data.length; i += 3) data.set(rgb, i);
  return { w, data };
};
const px = ({ w, data }, x, y) => [...data.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];

// A cheap, distinct fake cell per song: a flat colour with a lighter bar whose place depends on n.
function fakeCell(n, salt = 0) {
  const b = Buffer.alloc(CELL_BYTES);
  const rgb = [(n * 37 + salt) & 255, (n * 91) & 255, (n * 13 + 128) & 255];
  const bar = (n * 29) % (CW - 24);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const i = (y * CW + x) * 3, lift = x >= bar && x < bar + 24 ? 60 : 0;
    for (let c = 0; c < 3; c++) b[i + c] = (rgb[c] + lift) & 255;
  }
  return b;
}

test('boxDown averages 2x2 blocks with rounding', () => {
  const kid = solid(960, [0, 0, 0]);
  const set = (x, y, v) => kid.data.set([v, v, v], (y * 960 + x) * 3);
  set(0, 0, 10); set(1, 0, 20); set(0, 1, 30); set(1, 1, 41);
  const p = boxDown(1, 0, [[kid, null], [null, null]]);
  assert.equal(p.w, tileSize(1, 0).w);
  assert.deepEqual(px(p, 0, 0), [25, 25, 25]); // (101 + 2) >> 2
  assert.deepEqual(px(p, 1, 0), [0, 0, 0]);
});

test('boxDown puts each child in its quadrant and leaves missing ones black', () => {
  const kids = [[solid(960, [100, 0, 0]), solid(960, [0, 100, 0])], [solid(960, [0, 0, 100]), null]];
  const p = boxDown(1, 0, kids);
  assert.deepEqual(px(p, 0, 0), [100, 0, 0]);
  assert.deepEqual(px(p, 479, 269), [100, 0, 0]);
  assert.deepEqual(px(p, 480, 0), [0, 100, 0]);
  assert.deepEqual(px(p, 0, 270), [0, 0, 100]);
  assert.deepEqual(px(p, 959, 539), [0, 0, 0]);
});

test('boxDown handles an odd-width edge child (k6 from k5 tiles 960 + 195 wide)', () => {
  assert.equal(tileSize(5, 1).w, 195);
  const p = boxDown(6, 0, [[solid(960, [100, 100, 100]), solid(195, [200, 200, 200])], [null, null]]);
  assert.equal(p.w, 578);
  assert.deepEqual(px(p, 479, 0), [100, 100, 100]);
  assert.deepEqual(px(p, 576, 0), [200, 200, 200]);
  assert.deepEqual(px(p, 577, 0), [100, 100, 100]); // 2 real pixels + 2 black
  assert.deepEqual(px(p, 0, 270), [0, 0, 0]);
});

test('renderK0 places cells at the grid and keeps unfilled cells black', async () => {
  const songCount = 79; // row 1 holds songs 78 and 79 only
  const t = await renderK0(0, 0, songCount, async (n) => fakeCell(n));
  assert.equal(t.w, 960);
  const at = (n, x, y) => [...fakeCell(n).subarray((y * CW + x) * 3, (y * CW + x) * 3 + 3)];
  assert.deepEqual(px(t, 5, 7), at(1, 5, 7));
  assert.deepEqual(px(t, 480 + 5, 7), at(2, 5, 7));
  assert.deepEqual(px(t, 5, 270 + 7), at(78, 5, 7));
  assert.deepEqual(px(t, 480 + 5, 270 + 7), at(79, 5, 7));
  const edge = await renderK0(38, 0, 1, async (n) => fakeCell(n)); // column 76 only, past songCount
  assert.equal(edge.w, 480);
  assert.ok(edge.data.every((v) => v === 0));
});

test('encode then decode keeps the tile size', async () => {
  const t = solid(tileSize(7, 0).w, [40, 80, 120]);
  const buf = await encodeTile(t, 7);
  const d = await decodeTile(buf, t.w);
  assert.equal(d.w, 289);
  const meta = await sharp(buf).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 289, 540]);
});

async function compare(a, b, songCount, overrides = {}) {
  let n = 0;
  for (const { k, x, y } of existingTiles(songCount)) {
    const key = tileKey(k, x, y, songCount, overrides);
    const p = await a.get(key), q = await b.get(key);
    assert.ok(p && q, `missing ${key}`);
    assert.ok(p.equals(q), `${key} differs`);
    n++;
  }
  return n;
}

test('patching song N onto a wall of N-1 equals a full build of N, byte for byte', async () => {
  const getCell = async (n) => fakeCell(n);
  const N = 155; // first song of row 2: opens a new k0 tile row
  const full = memStore();
  const totals = await buildWall({ songCount: N, getCell, store: full });
  assert.equal(totals.tiles, [...existingTiles(N)].length);
  for (const { k, x, y } of existingTiles(N)) {
    const meta = await sharp(await full.get(tileKey(k, x, y, N))).metadata();
    assert.deepEqual([meta.width, meta.height], [tileSize(k, x).w, TH], `${k}/${x}_${y}`);
  }

  const patched = memStore();
  await buildWall({ songCount: N - 1, getCell, store: patched });
  const keys = await patchSongs({ songs: [N], songCount: N, getCell, store: patched });
  assert.deepEqual(keys, tilesForSong(N).map(({ k, x, y }) => tileKey(k, x, y, N)));
  assert.equal(await compare(full, patched, N), totals.tiles);
});

// A 33-song wall: song 33 opens a new tile at levels 0-4, so it is small but not trivial.
const SMALL = 33;
let small;
const smallWall = () => (small ||= (async () => {
  const store = memStore();
  await buildWall({ songCount: SMALL, getCell: async (n) => fakeCell(n), store });
  return store;
})());
const copyOf = (store) => {
  const m = memStore();
  for (const [k, v] of store.map) m.map.set(k, v);
  return m;
};

test('a fixed old cell under overrides matches a full build with the same overrides', async () => {
  const fixed = 5;
  const before = copyOf(await smallWall());
  const getCell = async (n) => fakeCell(n, n === fixed ? 99 : 0);
  const overrides = {};
  for (const { k, x, y } of tilesForSong(fixed)) {
    const v = Number(tileKey(k, x, y, SMALL).match(/_(\d+)\.webp$/)[1]);
    overrides[`${k}/${x}_${y}`] = { v, rev: 1 };
  }
  const keys = await patchSongs({ songs: [fixed], songCount: SMALL, overrides, getCell, store: before });
  assert.ok(keys.every((key) => key.endsWith('-r1.webp')));

  const full = memStore();
  await buildWall({ songCount: SMALL, overrides, getCell, store: full });
  await compare(full, before, SMALL, overrides);
});

test('patching several songs at once fills a gap', async () => {
  const getCell = async (n) => fakeCell(n);
  const gap = memStore();
  await buildWall({ songCount: SMALL - 5, getCell, store: gap });
  await patchSongs({ songs: [29, 30, 31, 32, 33], songCount: SMALL, getCell, store: gap });
  await compare(await smallWall(), gap, SMALL);
});

test('songsInTile lists the songs a tile holds', () => {
  assert.deepEqual(songsInTile(0, 0, 0, 6502), [1, 2, 78, 79]);
  assert.deepEqual(songsInTile(0, 0, 0, 78), [1, 2, 78]);
  assert.deepEqual(songsInTile(0, 38, 0, 6502), [77, 154]); // the last column is a half tile
  assert.equal(songsInTile(7, 0, 0, 6502).length, 6502);
});

test('a published tile key never gets new bytes', async () => {
  const store = memStore();
  const key = 'wall/p1/0/0_0_79.webp';
  assert.equal(await store.put(key, Buffer.from('a')), true);
  assert.equal(await store.put(key, Buffer.from('a')), false);
  await assert.rejects(store.put(key, Buffer.from('b')), { code: 'EOVERWRITE' });
  assert.equal(await store.put(key, Buffer.from('b'), { overwrite: true }), true);
  assert.equal(await store.put('meta/x.json', Buffer.from('c')), true);
  assert.equal(await store.put('meta/x.json', Buffer.from('d')), true);
});

test('a full build refuses to change published tiles unless rebuilding in place', async () => {
  const store = copyOf(await smallWall());
  const before = new Map(store.map);
  const getCell = async (n) => fakeCell(n, n === 5 ? 99 : 0); // song 5's cell changed, its tiles didn't move
  const err = await buildWall({ songCount: SMALL, getCell, store }).catch((e) => e);
  assert.equal(err.code, 'EOVERWRITE');
  assert.deepEqual(err.keys, tilesForSong(5).map(({ k, x, y }) => tileKey(k, x, y, SMALL)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
  for (const [key, buf] of before) assert.ok(store.map.get(key).equals(buf), `${key} kept its bytes`);
  const totals = await buildWall({ songCount: SMALL, getCell, store, inPlace: true });
  assert.equal(totals.written, 8);
});
