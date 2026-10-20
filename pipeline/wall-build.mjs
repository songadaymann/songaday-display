// Full pyramid build: every tile for songs 1..N into PUBLISH/wall/<pyramid>/<k>/<x>_<y>_<v>.webp,
// the pyramid descriptor wall.json, and STATE/wall.json. N defaults to the highest song such that
// 1..N all have a cell, and never quietly shrinks the wall: if that is below the wall's songCount it
// stops and lists the holes (--songs N shrinks on purpose). Unchanged tiles are left untouched.
//
// Published tile keys are immutable. A song whose cell changed since its tiles were built (STATE/
// wall.json `built`) moves to fresh -r<rev> keys, as wall-add --force does; any other key that
// would get new bytes stops the build, unless --rebuild-in-place (only before anything was uploaded).
//
//   npm run wall:build [-- --songs N] [--rebuild-in-place]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WALL } from '../shared/layout.mjs';
import { PUBLISH } from './lib/env.mjs';
import { cellReader, contiguousCount, holes, loadCells } from './lib/cells.mjs';
import { bumpOverrides, descriptorKey, pruneOverrides, readWallState, withLock, writeAtomic, writeWallState } from './lib/manifest.mjs';
import { buildWall, dirStore, ensureThreadpool, songsInTile, wallDescriptor } from './lib/tiles.mjs';

ensureThreadpool();

const { values: args } = parseArgs({ options: { songs: { type: 'string' }, 'rebuild-in-place': { type: 'boolean' } } });
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const list = (ns, max = 20) => `${ns.slice(0, max).join(', ')}${ns.length > max ? ` and ${ns.length - max} more` : ''}`;

await withLock(async () => {
  const t0 = performance.now();
  const cells = loadCells();
  const state = readWallState();
  const published = state?.songCount || 0;
  const ready = contiguousCount(cells);
  if (!args.songs && ready < published) {
    throw new Error(`cells cover only 1..${ready}, but the wall has ${published} songs; missing ${list(holes(cells, published))}. `
      + 'Restore them (npm run cells:import), or pass --songs N to shrink the wall on purpose');
  }
  const songCount = args.songs ? Number(args.songs) : ready;
  if (!Number.isInteger(songCount) || songCount < 1) throw new Error('no cells yet: run npm run cells:import');
  if (songCount > ready) throw new Error(`cells cover 1..${ready}; missing ${list(holes(cells, songCount))}`);
  if (songCount < published) console.log(`  shrinking the wall from ${published} to ${songCount} songs (--songs)`);

  // Cells that changed since their tiles were built get fresh keys instead of new bytes at old ones.
  const built = state?.built ?? {};
  const changed = Object.keys(built).map(Number).filter((n) => n <= songCount && cells[n]?.sha256 !== built[n]).sort((a, b) => a - b);
  let overrides = pruneOverrides(state?.overrides, songCount);
  if (changed.length) overrides = bumpOverrides(overrides, changed, songCount);
  const root = path.join(PUBLISH, 'wall', WALL.pyramid);
  console.log(`wall:build songs 1..${songCount}, ${Object.keys(overrides).length} overrides -> ${root}`);
  if (changed.length) console.log(`  ${changed.length} cells changed since their tiles were built, moving to new -r<rev> keys: ${list(changed)}`);

  let totals;
  try {
    totals = await buildWall({
      songCount,
      overrides,
      getCell: cellReader(),
      store: dirStore(PUBLISH),
      inPlace: args['rebuild-in-place'],
      onLevel: (l) => console.log(`  k${l.k}: ${String(l.tiles).padStart(5)} tiles ${mb(l.bytes).padStart(9)} (avg ${(l.bytes / l.tiles / 1024).toFixed(0)} KB), ${l.written} written, ${(l.ms / 1000).toFixed(1)} s`),
    });
  } catch (err) {
    if (err.code !== 'EOVERWRITE') throw err;
    const songs = [...new Set(err.keys.filter((k) => k.startsWith(`wall/${WALL.pyramid}/0/`)).flatMap((k) => {
      const [x, y] = path.basename(k).split('_').map(Number);
      return songsInTile(0, x, y, songCount);
    }))].sort((a, b) => a - b);
    const which = songs.length ? `The k0 tiles hold songs ${list(songs)}: re-add them with npm run wall:add -- --song-id N --force, or`
      : 'Only coarser tiles differ (their keys were last written from other children, e.g. before a shrink):';
    throw new Error(`${err.message}. Nothing published changed and STATE/wall.json is untouched. ${which} `
      + 'rerun with --rebuild-in-place if nothing has been uploaded yet');
  }
  writeAtomic(path.join(PUBLISH, descriptorKey()), `${JSON.stringify(wallDescriptor(), null, 2)}\n`);
  const next = Object.fromEntries(Array.from({ length: songCount }, (_, i) => [i + 1, cells[i + 1].sha256]));
  writeWallState({ songCount, overrides, built: next });
  const s = (performance.now() - t0) / 1000;
  console.log(`  total: ${totals.tiles} tiles, ${mb(totals.bytes)}, ${totals.written} written, ${s.toFixed(1)} s`);
  console.log(`  wrote ${path.join(PUBLISH, descriptorKey())} and STATE/wall.json (songCount ${songCount}); next: npm run wall:manifest`);
}).catch((err) => {
  console.error(`wall:build failed: ${err.message}`);
  process.exitCode = 1;
});
