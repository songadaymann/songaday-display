// Tile rendering for the wall pyramid (Design A). Geometry lives in shared/layout.mjs.
//
// A k0 tile is drawn from its up to 4 lossless 480x270 cell masters. Every coarser tile is an exact
// 2x2 box downsample of its up to 4 children, decoded from their published WebP bytes, so patching
// one song writes byte-for-byte what a full build writes. Empty cells, and pixels past the canvas
// edge, are black. Tiles are 540 tall; widths come from tileSize().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { CANVAS_W, CAPACITY, WALL, existingTiles, songAt, tileCells, tileKey, tileOfSong, tileSize } from '../../shared/layout.mjs';

sharp.concurrency(1); // one libvips thread per image; we parallelise across tiles

const { cellW: CW, cellH: CH, tileW: TW, tileH: TH } = WALL;
export const CELL_BYTES = CW * CH * 3;

// Encoder settings per level. Deterministic for a given sharp/libwebp build, which wall.json records.
export const CODEC = Object.freeze({ format: 'webp', quality: 85, effort: 4, smartSubsample: true });
export const codecFor = () => CODEC;

export const BUILDER = Object.freeze({
  name: 'songaday-display/tiles',
  version: 1,
  sharp: sharp.versions.sharp,
  libvips: sharp.versions.vips,
  libwebp: sharp.versions.webp,
});

// The pyramid descriptor published at wall/<pyramid>/wall.json. No timestamps: it is immutable.
export const wallDescriptor = () => ({
  schema: 1,
  ...WALL,
  canvasW: CANVAS_W,
  capacity: CAPACITY,
  codec: Array.from({ length: WALL.levels }, (_, k) => ({ k, ...codecFor(k) })),
  downsample: '2x2 box over the decoded published children, (a+b+c+d+2)>>2; pixels past the canvas edge count as black',
  emptyCell: '#000000',
  builder: BUILDER,
});

// libuv runs sharp's work on UV_THREADPOOL_SIZE threads (default 4), and the pool is created before
// any of our code runs. Bulk commands call this first: it re-runs the command once with one thread
// per core and exits with its status.
export function ensureThreadpool(size = os.availableParallelism()) {
  if (process.env.UV_THREADPOOL_SIZE) return;
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, UV_THREADPOOL_SIZE: String(size) },
  });
  if (r.error) console.error(r.error.message);
  process.exit(r.status ?? 1);
}

export async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j], j);
    }
  }));
  return out;
}

// ---- Pixels ----

function pasteCell(dst, dw, cell, dx, dy) {
  for (let y = 0; y < CH; y++) cell.copy(dst, ((dy + y) * dw + dx) * 3, y * CW * 3, (y + 1) * CW * 3);
}

// Songs inside tile (k, x, y) on a wall of songCount songs. The songs of one k0 tile share its whole
// chain of parents, so they are always re-rendered together.
export function songsInTile(k, x, y, songCount) {
  const { c0, c1, r0, r1 } = tileCells(k, x, y);
  const out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (songAt(c, r) <= songCount) out.push(songAt(c, r));
  return out;
}

// k0 tile (x, y) as raw RGB. getCell(n) resolves to a 480x270x3 buffer; songs past songCount stay black.
export async function renderK0(x, y, songCount, getCell) {
  const { w } = tileSize(0, x);
  const data = Buffer.alloc(w * TH * 3);
  const { c0, c1, r0, r1 } = tileCells(0, x, y);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const n = songAt(c, r);
    if (n > songCount) continue;
    const cell = await getCell(n);
    if (!cell || cell.length !== CELL_BYTES) throw new Error(`cell ${n} is missing or the wrong size`);
    pasteCell(data, w, cell, (c - c0) * CW, (r - r0) * CH);
  }
  return { w, data };
}

// Parent tile (k, x) from kids[dy][dx] = child (k-1, 2x+dx, 2y+dy) as { w, data } or null (black).
// Each child fills one quadrant. TW and TH are even, so every parent pixel's 4 sources lie in one
// child; an odd-width child's last column averages its 2 pixels with 2 black ones.
export function boxDown(k, x, kids) {
  const { w } = tileSize(k, x);
  const out = Buffer.alloc(w * TH * 3);
  const hw = TW / 2, hh = TH / 2;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const kid = kids[dy][dx];
    if (!kid) continue;
    const { w: cw, data: src } = kid;
    const pw = Math.ceil(cw / 2);
    if (dx * hw + pw > w) throw new Error(`child of ${k}/${x} is ${cw} wide; parent is ${w}`);
    for (let y = 0; y < hh; y++) {
      const s0 = 2 * y * cw * 3, s1 = s0 + cw * 3, d = ((dy * hh + y) * w + dx * hw) * 3;
      for (let px = 0; px < pw; px++) {
        const a = 6 * px, pair = 2 * px + 1 < cw;
        for (let b = 0; b < 3; b++) {
          let s = src[s0 + a + b] + src[s1 + a + b];
          if (pair) s += src[s0 + a + 3 + b] + src[s1 + a + 3 + b];
          out[d + 3 * px + b] = (s + 2) >> 2;
        }
      }
    }
  }
  return { w, data: out };
}

// ---- Codec ----

export function encodeTile({ w, data }, k = 0) {
  const { quality, effort, smartSubsample } = codecFor(k);
  return sharp(data, { raw: { width: w, height: TH, channels: 3 } }).webp({ quality, effort, smartSubsample }).toBuffer();
}

export async function decodeTile(buf, expectW) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.height !== TH || (expectW && info.width !== expectW) || info.channels !== 3) {
    throw new Error(`tile decodes to ${info.width}x${info.height}x${info.channels}, expected ${expectW}x${TH}x3`);
  }
  return { w: info.width, data };
}

async function kidsOf(k, x, y, fetch) {
  const kids = [[null, null], [null, null]];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const buf = await fetch(2 * x + dx, 2 * y + dy);
    if (buf) kids[dy][dx] = await decodeTile(buf, tileSize(k - 1, 2 * x + dx).w);
  }
  return kids;
}

// ---- Stores: where published tiles live, keyed by tileKey() ----

// Tile keys are uploaded with `immutable, max-age=31536000`, so a key that already holds other bytes
// is never rewritten: a store refuses (code EOVERWRITE) unless put() is told { overwrite: true }.
// Changed cells get fresh -r<rev> keys instead (bumpOverrides).
export const isTileKey = (key) => /^wall\/[^/]+\/\d+\//.test(key);

function refuse(key) {
  return Object.assign(new Error(`${key} already holds other bytes, and published tile keys are immutable`), { code: 'EOVERWRITE', key });
}

export function dirStore(root, { immutable = isTileKey } = {}) {
  const file = (key) => path.join(root, key);
  return {
    root,
    file,
    async get(key) {
      try {
        return await fs.promises.readFile(file(key));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    // Atomic write; returns false when the file already holds these bytes.
    async put(key, buf, { overwrite = false } = {}) {
      const f = file(key);
      const old = await this.get(key);
      if (old && old.equals(buf)) return false;
      if (old && !overwrite && immutable(key)) throw refuse(key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.tmp-${process.pid}`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, f);
      return true;
    },
  };
}

export function memStore({ immutable = isTileKey } = {}) {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, buf, { overwrite = false } = {}) {
      const old = map.get(key);
      if (old && old.equals(buf)) return false;
      if (old && !overwrite && immutable(key)) throw refuse(key);
      map.set(key, buf);
      return true;
    },
  };
}

// ---- Builds ----

// Every tile for songs 1..songCount, finest level first. Parents are decoded from the bytes just
// published for the level below. A key that already holds other bytes is left alone and reported:
// the build throws EOVERWRITE with err.keys at the end, unless inPlace (wall-build
// --rebuild-in-place, only safe before anything was uploaded).
export async function buildWall({ songCount, overrides = {}, getCell, store, inPlace = false, concurrency = os.availableParallelism(), onLevel }) {
  const levels = Array.from({ length: WALL.levels }, () => []);
  for (const t of existingTiles(songCount)) levels[t.k].push(t);
  const totals = { tiles: 0, bytes: 0, written: 0, levels: [] };
  const conflicts = [];
  let prev = new Map();
  for (let k = 0; k < WALL.levels; k++) {
    const t0 = performance.now(), cur = new Map();
    let bytes = 0, written = 0;
    await pool(levels[k], concurrency, async ({ x, y }) => {
      const raw = k === 0
        ? await renderK0(x, y, songCount, getCell)
        : boxDown(k, x, await kidsOf(k, x, y, async (cx, cy) => prev.get(`${cx}_${cy}`) ?? null));
      const buf = await encodeTile(raw, k);
      const key = tileKey(k, x, y, songCount, overrides);
      try {
        if (await store.put(key, buf, { overwrite: inPlace })) written++;
      } catch (err) {
        if (err.code !== 'EOVERWRITE') throw err;
        conflicts.push(key);
      }
      cur.set(`${x}_${y}`, buf);
      bytes += buf.length;
    });
    const level = { k, tiles: levels[k].length, bytes, written, ms: performance.now() - t0 };
    totals.levels.push(level);
    totals.tiles += level.tiles;
    totals.bytes += bytes;
    totals.written += written;
    onLevel?.(level);
    prev = cur;
  }
  if (conflicts.length) {
    const keys = conflicts.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    throw Object.assign(new Error(`${keys.length} published tile keys would get new bytes, e.g. ${keys.slice(0, 5).join(', ')}`), { code: 'EOVERWRITE', keys, totals });
  }
  return totals;
}

// Re-render the tiles holding `songs` on a wall of songCount songs: one tile per level per song,
// shared tiles once. Siblings come from the store at their current keys. Returns the keys written,
// finest level first (upload order).
export async function patchSongs({ songs, songCount, overrides = {}, getCell, store, concurrency = 4 }) {
  const keys = [];
  for (const n of songs) if (n < 1 || n > songCount) throw new Error(`song ${n} is outside 1..${songCount}`);
  for (let k = 0; k < WALL.levels; k++) {
    const tiles = new Map();
    for (const n of songs) {
      const t = tileOfSong(k, n);
      tiles.set(`${t.x}_${t.y}`, t);
    }
    const fetch = async (cx, cy) => {
      const key = tileKey(k - 1, cx, cy, songCount, overrides);
      if (!key) return null;
      const buf = await store.get(key);
      if (!buf) throw new Error(`published tile ${key} is missing; it is needed to rebuild level ${k}`);
      return buf;
    };
    const level = await pool([...tiles.values()], concurrency, async ({ x, y }) => {
      const raw = k === 0 ? await renderK0(x, y, songCount, getCell) : boxDown(k, x, await kidsOf(k, x, y, fetch));
      const key = tileKey(k, x, y, songCount, overrides);
      await store.put(key, await encodeTile(raw, k));
      return key;
    });
    keys.push(...level);
  }
  return keys;
}
