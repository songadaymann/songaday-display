// Daily patch: put song N on the wall by rewriting the 8 tiles that hold it (one per level), then the
// catalog and the manifest. Local only for now: it writes PUBLISH and STATE and queues the objects to
// upload, in commit order (cell, still, GIF, catalog chunks, tiles finest first, manifests,
// current.json last), in STATE/pending-uploads.jsonl. Songs between the wall's songCount and N are
// added first, in order. An N already on the wall is re-imported; if a cell in its tiles differs from
// the one they were built from (STATE/wall.json `built`), or with --force, its tiles move to fresh
// -r<rev> keys recorded in the manifest's overrides. Otherwise it is already current, and the run
// only catches up on GIFs that turned up since (N's, and those the manifest lists as missing).
//
// Commit order on this Mac: tiles, GIFs, catalog, manifest, upload queue, then STATE/wall.json last.
// A run that stops partway leaves wall.json as it was, so the next run redoes the work; tile and
// still keys never get new bytes, so redoing it writes the same files again.
//
//   node pipeline/wall-add.mjs --song-id N [--still path] [--json] [--force] [--fallback] [--wait 120]
//
// N's cell must come from its still (EverySongADayPNG/N.jpg|png, or --still); --fallback lets it use
// the catch-up chain instead (art, video frame, card). A missing GIF never fails the run. Catalog
// records come from the toolkit's initial-metadata.json (else metadata.json, else title and date
// only), never D1; the nightly catalog:build fills in the rest.
// Exit 0 added or already current, 2 input unavailable, 1 anything else. --json prints one line:
// {"status","songId","tilesWritten","ms",...}.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { tileKey, tileOfSong, tilesForSong } from '../shared/layout.mjs';
import { PUBLISH, STATE, archiveDir, outputDir, toolkitOutputDir } from './lib/env.mjs';
import { cellFile, cellKey, cellReader, importSongs, loadCells, localFiles, songOn, stillKey } from './lib/cells.mjs';
import { appendSongs, chunkOf, dateOf, fromInitial, fromTokenMetadata, mergeSong, writeCatalogState } from './lib/catalog.mjs';
import { AZURE, GIF_DIR, gifHeader, gifKey, gifRevs, publishGif, readHead } from './lib/gifs.mjs';
import { CURRENT_KEY, appendPending, bumpOverrides, readJson, readWallState, withLock, writeManifest, writeWallState } from './lib/manifest.mjs';
import { dirStore, encodeTile, patchSongs, renderK0, songsInTile } from './lib/tiles.mjs';

const { values: args } = parseArgs({
  options: {
    'song-id': { type: 'string' },
    still: { type: 'string' },
    json: { type: 'boolean' },
    force: { type: 'boolean' },
    fallback: { type: 'boolean' },
    wait: { type: 'string', default: '120' },
  },
});
const t0 = performance.now();
const n = Number(args['song-id']);
const say = (msg) => args.json || console.log(msg);
const pub = (key) => ({ key, file: path.join(PUBLISH, key) });

class Unavailable extends Error {}

// Songs sharing m's k0 tile. They share its whole chain of parents, so they're rendered together.
const k0Mates = (m, songCount) => {
  const { x, y } = tileOfSong(0, m);
  return songsInTile(0, x, y, songCount);
};

// For walls built before STATE/wall.json recorded `built`: does the published k0 tile holding m
// still show its cells as they are now?
async function k0Current(m, songCount, overrides, store) {
  const { x, y } = tileOfSong(0, m);
  const old = await store.get(tileKey(0, x, y, songCount, overrides));
  return Boolean(old) && (await encodeTile(await renderK0(x, y, songCount, cellReader()), 0)).equals(old);
}

// Best effort: the archive's GIFs for these songs into PUBLISH/gifs, a changed one at its next
// revision. Updates `revs` and returns the keys copied.
function collectGifs(songs, revs) {
  let dir;
  try {
    dir = path.join(archiveDir(), GIF_DIR);
  } catch {
    return [];
  }
  const files = new Map(songs.map((m) => [path.join(dir, `${m}.gif`), m]));
  const local = localFiles([...files.keys()]);
  const copied = [];
  for (const [file, m] of files) {
    if (!local.has(file)) continue;
    try {
      if (!gifHeader(readHead(file))) continue;
      const st = fs.statSync(file);
      const r = publishGif(PUBLISH, m, { file, size: st.size, mtimeMs: st.mtimeMs }, revs.get(m) ?? 0);
      revs.set(m, r.rev);
      if (r.copied) copied.push(r.key);
    } catch {}
  }
  return copied;
}

// Song m's catalog records from the toolkit: initial-metadata.json (the upload form, written at the
// start of the run), else metadata.json (written after the IPFS step). The toolkit rewrites
// initial-metadata.json in place, so a file that doesn't parse is read again. A file that names
// another song (output/6210 holds 6209's upload) is ignored.
async function toolkitRecords(m) {
  const dirs = [];
  for (const dir of [outputDir, toolkitOutputDir]) {
    try {
      dirs.push(path.resolve(dir()));
    } catch {}
  }
  const kinds = [
    ['initial-metadata.json', (j) => fromInitial(j, m), (j) => j.songNbr ?? null],
    ['metadata.json', (j) => fromTokenMetadata('metadata', j, m), (j) => j.token_id ?? null],
  ];
  for (const [name, parse, idOf] of kinds) {
    const files = [...new Set(dirs.map((d) => path.join(d, String(m), name)))];
    const local = localFiles(files);
    for (const file of files.filter((f) => local.has(f))) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const json = JSON.parse(fs.readFileSync(file, 'utf8'));
          const id = idOf(json);
          const r = parse(json);
          if ((id !== null && Number(id) !== m) || (r.date && r.date !== dateOf(m))) break;
          return [r];
        } catch {
          if (attempt < 3) await sleep(1000);
        }
      }
    }
  }
  return [];
}

// Songs past the catalog's end, up to upTo, go into its last chunk pair (or a new one). Songs it
// already has are left to the nightly catalog:build. Returns the chunk keys written.
async function addToCatalog(upTo) {
  const file = path.join(STATE, 'catalog.json');
  const state = readJson(file);
  if (!state || state.songCount >= upTo) return [];
  const items = [];
  for (let m = state.songCount + 1; m <= upTo; m++) items.push(mergeSong(m, await toolkitRecords(m)));
  const next = appendSongs(PUBLISH, state, items);
  writeCatalogState(file, next);
  return next.written;
}

// Catalog chunks covering `songs` in the manifest, plus any just written.
function chunkKeys(manifest, songs, written) {
  const keys = new Set(written);
  if (manifest.catalog) {
    for (const c of new Set(songs.map((m) => chunkOf(m, manifest.catalog.chunkSize)))) {
      for (const key of [manifest.catalog.index[c], manifest.catalog.detail[c]]) {
        if (key && fs.existsSync(path.join(PUBLISH, key))) keys.add(key);
      }
    }
  }
  return [...keys];
}

// GIFs the published manifest still lists as missing, newer than the Azure copy (which has its own
// backup): a late GIF is caught up by whichever wall-add runs next, without touching tiles.
const lateGifs = () => (readJson(path.join(PUBLISH, CURRENT_KEY))?.noGif || []).filter((m) => m > AZURE.to);

async function add() {
  const wall = readWallState();
  if (!wall) throw new Error('no wall yet: run npm run cells:import, then npm run wall:build');
  const S = wall.songCount;
  let overrides = wall.overrides ?? {};
  const built = { ...wall.built };
  const cells = loadCells();
  const store = dirStore(PUBLISH);
  const revs = gifRevs(PUBLISH);

  const files = args.still ? { [n]: args.still } : {};
  const strict = args.fallback ? new Set() : new Set([n]);
  const [head] = (await importSongs([n], { cells, files, strict, force: args.force })).results;
  if (head.status === 'unavailable' || head.status === 'failed') {
    throw new Unavailable(head.error || `no usable still for #${n}${args.still ? ` at ${args.still}` : ' in EverySongADayPNG (missing, empty or online-only)'}`);
  }

  let songs, songCount, changed = [];
  if (n <= S) {
    const mates = k0Mates(n, S);
    if (mates.some((m) => !built[m]) && (await k0Current(n, S, overrides, store))) {
      for (const m of mates) built[m] ||= cells[m].sha256;
    }
    changed = mates.filter((m) => built[m] !== cells[m]?.sha256);
    const intact = tilesForSong(n).every(({ k, x, y }) => fs.existsSync(path.join(PUBLISH, tileKey(k, x, y, S, overrides))));
    if (!changed.length && !args.force && intact) return catchUp(wall);
    if (changed.length || args.force) overrides = bumpOverrides(overrides, n, S);
    songs = [n];
    songCount = S;
  } else {
    const gap = Array.from({ length: n - S - 1 }, (_, i) => S + 1 + i);
    if (gap.length) {
      say(`  adding ${gap.length} missing song(s) first: #${S + 1}..#${n - 1}`);
      const { results } = await importSongs(gap, { cells });
      const bad = results.filter((r) => r.status === 'failed' || r.status === 'unavailable');
      if (bad.length) throw new Error(`cannot fill the gap: ${bad.map((r) => `#${r.n} ${r.error || r.status}`).join('; ')}`);
    }
    songs = [...gap, n];
    songCount = n;
  }

  const tiles = await patchSongs({ songs, songCount, overrides, getCell: cellReader(), store });
  for (const m of songs) for (const mate of k0Mates(m, songCount)) built[mate] = cells[mate].sha256;
  const late = collectGifs([...new Set([...songs, ...lateGifs()])], revs).filter((key) => !songs.some((m) => key.startsWith(`gifs/${m}.`) || key.startsWith(`gifs/${m}-`)));
  const written = await addToCatalog(songCount);
  const next = { songCount, overrides, built };
  const { manifest, keys } = writeManifest({ wall: next });

  const items = songs.map((m) => ({ bucket: 'archive', key: cellKey(m), file: cellFile(m) }));
  for (const m of songs) items.push(pub(stillKey(m, cells[m].stillRev)));
  for (const m of songs) if (revs.has(m)) items.push(pub(gifKey(m, revs.get(m))));
  items.push(...late.map(pub), ...chunkKeys(manifest, songs, written).map(pub));
  items.push(...tiles.map(pub), pub(keys.history), pub(CURRENT_KEY));
  appendPending(items, { songId: n });
  writeWallState(next); // last: from here on this Mac counts the work as done

  return {
    status: 'added',
    songId: n,
    tilesWritten: tiles.length,
    songCount,
    ...(songs.length > 1 ? { added: songs } : {}),
    ...(n <= S ? { revised: true, cellsChanged: changed } : {}),
    source: cells[n].source,
    flags: cells[n].flags,
    gif: revs.has(n),
    ...(late.length ? { lateGifs: late } : {}),
    ...(written.length ? { catalogChunks: written } : {}),
    queued: items.length,
  };
}

// N is on the wall and its tiles match its cells. Late GIFs and a catalog that fell behind still
// get published; the tiles stay as they are.
async function catchUp(wall) {
  const S = wall.songCount;
  const gifs = collectGifs([...new Set([n, ...lateGifs()])], gifRevs(PUBLISH));
  const written = await addToCatalog(S);
  const base = { status: 'already-current', songId: n, tilesWritten: 0, songCount: S };
  if (!gifs.length && !written.length) return base;
  const { keys } = writeManifest({ wall });
  const items = [...gifs.map(pub), ...written.map(pub), pub(keys.history), pub(CURRENT_KEY)];
  appendPending(items, { songId: n });
  return { ...base, ...(gifs.length ? { lateGifs: gifs } : {}), ...(written.length ? { catalogChunks: written } : {}), queued: items.length };
}

let result, code = 0;
try {
  if (!Number.isInteger(n) || n < 1) throw new Error('usage: wall-add --song-id N [--still path] [--json] [--force] [--fallback]');
  if (n > songOn() + 1) throw new Error(`song #${n} is in the future (today is #${songOn()})`);
  result = await withLock(add, { waitMs: Number(args.wait) * 1000 });
} catch (err) {
  code = err instanceof Unavailable ? 2 : 1;
  result = { status: code === 2 ? 'input-unavailable' : 'failed', songId: Number.isInteger(n) ? n : null, tilesWritten: 0, error: err.message };
}
const { status, songId, tilesWritten, ...rest } = result;
const line = { status, songId, tilesWritten, ms: Math.round(performance.now() - t0), ...rest };
if (args.json) console.log(JSON.stringify(line));
else {
  console.log(`wall:add #${songId}: ${status}${tilesWritten ? `, ${tilesWritten} tiles` : ''} in ${line.ms} ms${line.songCount ? `; wall has ${line.songCount} songs` : ''}`);
  if (line.error) console.log(`  ${line.error}`);
  if (line.revised) console.log(`  #${songId} was already on the wall: its tiles moved to new -r<rev> keys (manifest overrides)${line.cellsChanged?.length ? `; changed cells: ${line.cellsChanged.join(', ')}` : ''}`);
  if (line.lateGifs) console.log(`  GIFs that turned up late: ${line.lateGifs.join(', ')}`);
  if (line.catalogChunks) console.log(`  catalog chunks: ${line.catalogChunks.join(', ')}`);
  if (line.queued) console.log(`  queued ${line.queued} uploads in STATE/pending-uploads.jsonl${line.source ? `; gif ${line.gif ? 'yes' : 'none'}; source ${line.source}` : ''}`);
  if (code === 2) console.log(`  retry later: npm run wall:add -- --song-id ${songId}${args.fallback ? '' : ' (or --fallback for a frame or card)'}`);
}
process.exitCode = code;
