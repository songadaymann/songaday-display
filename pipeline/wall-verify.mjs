// Checks the published wall against STATE/wall.json and the cell masters:
//   (a) equivalence: a scratch build of songCount-1 plus the daily patch of songCount equals the
//       published tiles byte for byte
//   (b) every tile is the size tileSize() says (and 540 tall)
//   (c) random cells cut from the k0 tiles match their own cell masters: median PSNR >= 38 dB, none
//       under 30 dB, and each at least 6 dB closer to its own master than to any neighbour's (neighbours
//       whose master is itself within 40 dB, like 4343 and 4344, are listed instead)
//   (d) the tile files on disk are exactly existingTiles() (older versions of current tiles are
//       allowed and counted: they stay published for rollback)
//   (e) every song's cell is the one its tiles were built from (STATE/wall.json `built`)
// Exits 1 on any failure.
//
//   npm run wall:verify [-- --cells 50] [--seed N] [--skip-equivalence]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { WALL, cellOf, existingTiles, tileCells, tileKey, tileOfSong, tileSize } from '../shared/layout.mjs';
import { CACHE, PUBLISH } from './lib/env.mjs';
import { cellReader, loadCells } from './lib/cells.mjs';
import { readWallState, withLock } from './lib/manifest.mjs';
import { buildWall, decodeTile, dirStore, ensureThreadpool, patchSongs, pool } from './lib/tiles.mjs';

ensureThreadpool();

const { values: args } = parseArgs({
  options: { cells: { type: 'string', default: '50' }, seed: { type: 'string' }, 'skip-equivalence': { type: 'boolean' } },
});
const MIN_PSNR = 38, FLOOR = 30, MARGIN = 6, TWIN = 40;
const { cellW: CW, cellH: CH, tileH: TH } = WALL;
const secs = (t) => `${((performance.now() - t) / 1000).toFixed(1)} s`;

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / a.length));
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME = /^(\d+)_(\d+)_(\d+)(?:-r(\d+))?\.webp$/;

await withLock(async () => {
  const wall = readWallState();
  if (!wall) throw new Error('no wall state yet: run npm run wall:build');
  const { songCount, overrides = {} } = wall;
  const store = dirStore(PUBLISH);
  const failures = [];
  const expected = [...existingTiles(songCount)].map((t) => {
    const key = tileKey(t.k, t.x, t.y, songCount, overrides);
    return { ...t, key, rev: Number(path.basename(key).match(NAME)[4] || 0) };
  });
  console.log(`wall:verify songCount ${songCount}, ${expected.length} tiles, ${Object.keys(overrides).length} overrides`);

  // (e) cells changed since their tiles were built: (a) and (c) fail for these until they're re-added
  const cells = loadCells();
  if (!wall.built) console.log('  (e) STATE/wall.json predates `built`; npm run wall:build records it');
  else {
    const pending = Array.from({ length: songCount }, (_, i) => i + 1).filter((n) => wall.built[n] !== cells[n]?.sha256);
    console.log(`  (e) cells: ${songCount - pending.length}/${songCount} match the cell their tiles were built from`);
    if (pending.length) failures.push(`(e) ${pending.length} cells changed since their tiles were built (${pending.slice(0, 10).join(', ')}): npm run wall:add -- --song-id N`);
  }

  // (d) files on disk vs existingTiles
  let t = performance.now();
  const current = new Map(expected.map((e) => [`${e.k}/${e.x}_${e.y}`, e]));
  const onDisk = new Set(), unexpected = [];
  let superseded = 0;
  for (let k = 0; k < WALL.levels; k++) {
    const dir = path.join(PUBLISH, 'wall', WALL.pyramid, String(k));
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const m = name.match(NAME);
      const cur = m && current.get(`${k}/${m[1]}_${m[2]}`);
      const key = `wall/${WALL.pyramid}/${k}/${name}`;
      if (cur && cur.key === key) onDisk.add(key);
      else if (cur && (Number(m[3]) < cur.v || (Number(m[3]) === cur.v && Number(m[4] || 0) < cur.rev))) superseded++;
      else unexpected.push(key);
    }
  }
  const missing = expected.filter((e) => !onDisk.has(e.key)).map((e) => e.key);
  console.log(`  (d) files: ${onDisk.size}/${expected.length} expected present, ${missing.length} missing, ${unexpected.length} unexpected, ${superseded} older versions kept (${secs(t)})`);
  if (missing.length) failures.push(`(d) ${missing.length} tiles missing, e.g. ${missing.slice(0, 5).join(', ')}`);
  if (unexpected.length) failures.push(`(d) ${unexpected.length} unexpected files, e.g. ${unexpected.slice(0, 5).join(', ')}`);

  // (b) sizes
  t = performance.now();
  const wrong = [];
  await pool(expected.filter((e) => onDisk.has(e.key)), 16, async (e) => {
    const meta = await sharp(store.file(e.key)).metadata();
    const want = tileSize(e.k, e.x);
    if (meta.format !== 'webp' || meta.width !== want.w || meta.height !== TH) wrong.push(`${e.key} is ${meta.format} ${meta.width}x${meta.height}, want ${want.w}x${TH}`);
  });
  console.log(`  (b) sizes: ${onDisk.size - wrong.length}/${onDisk.size} match tileSize() (${secs(t)})`);
  if (wrong.length) failures.push(`(b) ${wrong.length} tiles have the wrong size, e.g. ${wrong.slice(0, 3).join('; ')}`);

  // (c) random cells vs their masters. WebP q85 leaves some busy cells a little under MIN_PSNR, so
  // that is the median target; every cell must also stay above FLOOR and match its own master at
  // least MARGIN dB better than any neighbour's, which is what catches an off-by-one in numbering.
  t = performance.now();
  const seed = args.seed ? Number(args.seed) : Date.now() % 1e9;
  const rand = mulberry32(seed), count = Math.min(Number(args.cells), songCount);
  const picks = new Set();
  while (picks.size < count) picks.add(1 + Math.floor(rand() * songCount));
  const getCell = cellReader();
  const scores = await pool([...picks].sort((a, b) => a - b), 8, async (n) => {
    const { x, y } = tileOfSong(0, n);
    const buf = await store.get(tileKey(0, x, y, songCount, overrides));
    const cell = await getCell(n);
    if (!buf || !cell) return { n, db: -Infinity, rival: Infinity };
    const tile = await decodeTile(buf, tileSize(0, x).w);
    const { col, row } = cellOf(n), { c0, r0 } = tileCells(0, x, y);
    const crop = Buffer.alloc(CW * CH * 3), ox = (col - c0) * CW, oy = (row - r0) * CH;
    for (let r = 0; r < CH; r++) tile.data.copy(crop, r * CW * 3, ((oy + r) * tile.w + ox) * 3, ((oy + r) * tile.w + ox + CW) * 3);
    let rival = -Infinity, rivalN = 0;
    const twins = [];
    for (const m of [n - 1, n + 1, n - WALL.cols, n + WALL.cols]) {
      if (m < 1 || m > songCount) continue;
      const other = await getCell(m);
      if (!other) continue;
      if (psnr(other, cell) >= TWIN) {
        twins.push(m); // the masters themselves are (nearly) the same frame: pixels can't tell them apart
        continue;
      }
      const db = psnr(crop, other);
      if (db > rival) [rival, rivalN] = [db, m];
    }
    return { n, db: psnr(crop, cell), rival, rivalN, twins };
  });
  const dbs = scores.map((s) => s.db).sort((a, b) => a - b);
  const median = dbs[dbs.length >> 1];
  const low = scores.filter((s) => s.db < MIN_PSNR);
  const bad = scores.filter((s) => s.db < FLOOR || s.db - s.rival < MARGIN);
  const twins = scores.filter((s) => s.twins.length).map((s) => `${s.n}~${s.twins.join('~')}`);
  const margin = Math.min(...scores.map((s) => s.db - s.rival).filter(Number.isFinite));
  console.log(`  (c) ${scores.length} random cells (seed ${seed}): PSNR min ${dbs[0].toFixed(1)} median ${median.toFixed(1)} max ${dbs.at(-1).toFixed(1)} dB; `
    + `${low.length} under ${MIN_PSNR} dB${low.length ? ` (${low.map((s) => `#${s.n} ${s.db.toFixed(1)}`).join(', ')})` : ''}; `
    + `own cell beats every neighbour by >= ${margin.toFixed(1)} dB (${secs(t)})`);
  if (twins.length) console.log(`      near-duplicate neighbours (masters >= ${TWIN} dB alike, not checked): ${twins.join(', ')}`);
  if (median < MIN_PSNR) failures.push(`(c) median PSNR ${median.toFixed(1)} dB is under ${MIN_PSNR} dB`);
  if (bad.length) failures.push(`(c) cells that don't match their own master: ${bad.map((s) => `#${s.n} ${s.db.toFixed(1)} dB vs #${s.rivalN} ${s.rival.toFixed(1)} dB`).join(', ')}`);

  // (a) equivalence: build songCount-1 in scratch, patch songCount, compare everything
  if (!args['skip-equivalence']) {
    t = performance.now();
    const scratch = path.join(CACHE, 'tmp', `verify-${process.pid}`);
    try {
      const tmpStore = dirStore(scratch);
      await buildWall({ songCount: songCount - 1, overrides, getCell, store: tmpStore });
      const built = secs(t);
      const tp = performance.now();
      const keys = await patchSongs({ songs: [songCount], songCount, overrides, getCell, store: tmpStore });
      const patchMs = performance.now() - tp;
      const diff = [];
      await pool(expected, 16, async (e) => {
        const [a, b] = await Promise.all([tmpStore.get(e.key), store.get(e.key)]);
        if (!a || !b || !a.equals(b)) diff.push(e.key);
      });
      console.log(`  (a) build of ${songCount - 1} (${built}) + patch of #${songCount} (${keys.length} tiles, ${patchMs.toFixed(0)} ms): ${expected.length - diff.length}/${expected.length} byte-identical, ${diff.length} mismatches (${secs(t)})`);
      if (diff.length) failures.push(`(a) ${diff.length} tiles differ from patch-equivalent build, e.g. ${diff.slice(0, 5).join(', ')}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (failures.length) {
    console.log(`FAIL\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else console.log('OK');
}, { waitMs: 60_000 }).catch((err) => {
  console.error(`wall:verify failed: ${err.message}`);
  process.exitCode = 1;
});
