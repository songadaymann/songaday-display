// Builds the lossless 480x270 cell master for every song (CELLS/<n>.webp), its public still
// (PUBLISH/stills/<n>[-r<rev>].webp) and STATE/cells.json. Incremental: a song whose source file has
// the same mtime and size is skipped. Cells fixed with wall-add --still are kept, and --force never
// swaps a cell for a worse source because its own went online-only. Tiles are not touched: songs
// whose cell changed go back on the wall with wall:add (or wall:build). Writes a summary to
// output/cells-import.json.
//
//   npm run cells:import [-- --from N] [--to N] [--only 6000,6210] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CELLS, REPO } from './lib/env.mjs';
import { contiguousCount, flagged, holes, importSongs, latestSong, songOn } from './lib/cells.mjs';
import { withLock } from './lib/manifest.mjs';
import { ensureThreadpool } from './lib/tiles.mjs';

ensureThreadpool();

const { values: args } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, only: { type: 'string' }, force: { type: 'boolean' } },
});

// "1,2,5-9" -> [1,2,5,6,7,8,9]
const ranges = (list) => {
  const out = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(j > i ? `${list[i]}-${list[j]}` : `${list[i]}`);
    i = j + 1;
  }
  return out.join(',') || '-';
};
const parseList = (s) => s.split(',').flatMap((part) => {
  const [a, b] = part.split('-').map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
});

await withLock(async () => {
  const t0 = performance.now();
  const last = args.to ? Number(args.to) : latestSong();
  const from = args.from ? Number(args.from) : 1;
  const songs = args.only ? parseList(args.only) : Array.from({ length: last - from + 1 }, (_, i) => from + i);
  console.log(`cells:import songs ${ranges(songs)} (today is #${songOn()}) -> ${CELLS}`);

  const { results, cells, duplicates, timings } = await importSongs(songs, { force: args.force, log: console.log });

  const by = (key) => results.reduce((m, r) => ((m[r[key] ?? '-'] = (m[r[key] ?? '-'] || 0) + 1), m), {});
  const pick = (status) => results.filter((r) => r.status === status).map((r) => r.n);
  const songCount = contiguousCount(cells);
  const upTo = Math.max(last, ...songs);
  const gaps = holes(cells, upTo);
  const kinds = {};
  for (const e of Object.values(cells)) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const report = {
    at: new Date().toISOString(),
    songs: { from: songs[0], to: songs.at(-1), count: songs.length },
    status: by('status'),
    importedByKind: results.filter((r) => r.status === 'imported').reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {}),
    cellsByKind: kinds,
    songCount,
    holes: gaps,
    dark: flagged(cells, 'dark'),
    duplicates,
    cards: flagged(cells, 'card'),
    portrait: flagged(cells, 'portrait'),
    aspect: flagged(cells, 'aspect'),
    nonStill: Object.fromEntries(Object.entries(cells).filter(([, e]) => ['art', 'frame', 'card', 'file'].includes(e.kind)).map(([n, e]) => [n, e.source])),
    kept: pick('kept'),
    unavailable: pick('unavailable'),
    failed: results.filter((r) => r.status === 'failed').map((r) => ({ n: r.n, error: r.error })),
    timings: { masterDecodeS: +(timings.masterDecodeMs / 1000).toFixed(1), importS: +(timings.importMs / 1000).toFixed(1), totalS: +((performance.now() - t0) / 1000).toFixed(1) },
  };
  const out = path.join(REPO, 'output', 'cells-import.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`  status: ${Object.entries(report.status).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  imported by source: ${Object.entries(report.importedByKind).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  console.log(`  cells by source: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  songCount ${songCount} (songs 1..${songCount} all have a cell)`);
  console.log(`  holes (${gaps.length}): ${ranges(gaps)}`);
  console.log(`  dark (${report.dark.length}): ${ranges(report.dark)}`);
  console.log(`  duplicates (${duplicates.length} groups): ${duplicates.map((g) => g.join('=')).join(' ') || '-'}`);
  console.log(`  cards (${report.cards.length}): ${ranges(report.cards)}`);
  console.log(`  portrait ${ranges(report.portrait)}; other aspect ${ranges(report.aspect)}`);
  for (const [n, source] of Object.entries(report.nonStill)) console.log(`  #${n} from ${source}`);
  if (report.kept.length) console.log(`  kept (better source online-only, or pinned by wall-add --still): ${ranges(report.kept)}`);
  if (report.unavailable.length) console.log(`  no usable source yet: ${ranges(report.unavailable)}`);
  for (const f of report.failed) console.log(`  FAILED #${f.n}: ${f.error}`);
  console.log(`  time: master decode ${report.timings.masterDecodeS} s, import ${report.timings.importS} s, total ${report.timings.totalS} s`);
  console.log(`  report: ${out}`);
  if (report.failed.length) process.exitCode = 1;
}).catch((err) => {
  console.error(`cells:import failed: ${err.message}`);
  process.exitCode = 1;
});
