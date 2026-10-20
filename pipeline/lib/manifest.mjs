// Wall state, the published manifest, the writer lock and the upload queue.
//
// STATE/wall.json { schema, pyramid, songCount, overrides, built } is the single writer's record of
// what PUBLISH/wall holds: songs 1..songCount, and built[n], the sha256 of the cell song n's tiles
// were rendered from. Writers save it last, so a run that stops early is redone by the next one.
// The manifest (schema 1 in shared/README.md) is composed from it plus STATE/cells.json
// (missingArt, stillRev), STATE/gifs.json and PUBLISH/gifs (noGif, gifRev) and STATE/catalog.json.
// wall/current.json is the only file that changes in place; wall/manifests/<songCount>-<hash>.json
// keeps an immutable copy of each version for rollback.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WALL, newestInTile, tilesForSong } from '../../shared/layout.mjs';
import { CACHE, PUBLISH, STATE } from './env.mjs';
import { gifRevs } from './gifs.mjs';

export const SCHEMA = 1;
export const LOCK = path.join(CACHE, 'wall.lock');
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const LOCK_GRACE_MS = 5000; // an unreadable lock this young is still being written
export const CURRENT_KEY = 'wall/current.json';
const hash8 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
export const historyKey = (songCount, text) => `wall/manifests/${songCount}-${hash8(text)}.json`;
export const descriptorKey = () => `wall/${WALL.pyramid}/wall.json`;

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${err.message}`);
  }
}

export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---- Wall state ----

export const readWallState = (state = STATE) => readJson(path.join(state, 'wall.json'));

export function writeWallState({ songCount, overrides = {}, built = {} }, state = STATE) {
  const kept = Object.keys(built).map(Number).filter((n) => n >= 1 && n <= songCount).sort((a, b) => a - b);
  const wall = { schema: SCHEMA, pyramid: WALL.pyramid, songCount, overrides: pruneOverrides(overrides, songCount) };
  // One song per line, like cells.json.
  const head = JSON.stringify(wall, null, 2).replace(/\n}$/, '');
  const rows = kept.map((n) => `    "${n}": ${JSON.stringify(built[n])}`).join(',\n');
  writeAtomic(path.join(state, 'wall.json'), `${head},\n  "built": ${rows ? `{\n${rows}\n  }` : '{}'}\n}\n`);
  return { ...wall, built: Object.fromEntries(kept.map((n) => [n, built[n]])) };
}

const parseId = (id) => {
  const [k, xy] = id.split('/');
  const [x, y] = xy.split('_').map(Number);
  return { k: Number(k), x, y };
};

// Overrides apply only while their tile's newest song is still v; drop the rest.
export function pruneOverrides(overrides = {}, songCount) {
  return Object.fromEntries(Object.entries(overrides)
    .filter(([id, o]) => {
      const { k, x, y } = parseId(id);
      return o && o.rev > 0 && newestInTile(k, x, y, songCount) === o.v;
    })
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
}

// Fresh -r<rev> keys for the tiles holding song n (or each of several songs, every tile once), for
// when an old cell is fixed in place.
export function bumpOverrides(overrides, songs, songCount) {
  const out = pruneOverrides(overrides, songCount);
  const tiles = new Map();
  for (const n of [].concat(songs)) for (const t of tilesForSong(n)) tiles.set(`${t.k}/${t.x}_${t.y}`, t);
  for (const [id, { k, x, y }] of tiles) {
    const v = newestInTile(k, x, y, songCount), o = out[id];
    out[id] = { v, rev: o && o.v === v ? o.rev + 1 : 1 };
  }
  return pruneOverrides(out, songCount);
}

// ---- Manifest ----

// gifs.json (pipeline/gifs-index.mjs) lists noGif for 1..its songCount: no real local GIF and no
// Azure copy. A song stays listed only while PUBLISH/gifs still has nothing for it, so a GIF that
// turns up later clears it; songs newer than gifs.json count as having a GIF once one is published.
export function noGifFrom(gifs, songCount, hasGif = () => true) {
  if (!gifs) return [];
  const known = Number(gifs.songCount) || 0;
  const out = (gifs.noGif || []).filter((n) => n <= songCount && !hasGif(n));
  for (let n = known + 1; n <= songCount; n++) if (!hasGif(n)) out.push(n);
  return out.sort((a, b) => a - b);
}

// { n: rev } for every song whose still or GIF has moved past revision 0.
const revMap = (pairs) => Object.fromEntries([...pairs].filter(([, rev]) => rev > 0).sort((a, b) => a[0] - b[0]));

export function composeManifest({ songCount, overrides = {}, cells = {}, gifs = null, catalog = null, hasGif, gifRev = new Map(), updatedAt = null }) {
  return {
    schema: SCHEMA,
    pyramid: WALL.pyramid,
    songCount,
    updatedAt,
    overrides: pruneOverrides(overrides, songCount),
    missingArt: Object.keys(cells).map(Number).filter((n) => n <= songCount && cells[n].flags?.includes('card')).sort((a, b) => a - b),
    noGif: noGifFrom(gifs, songCount, hasGif),
    stillRev: revMap(Object.entries(cells).map(([n, e]) => [Number(n), e.stillRev || 0])),
    gifRev: revMap(gifRev),
    catalog: catalog ? { schema: catalog.schema, chunkSize: catalog.chunkSize, index: catalog.index, detail: catalog.detail } : null,
  };
}

// Writes wall/current.json and its immutable copy wall/manifests/<songCount>-<hash>.json, from
// `wall` (default STATE/wall.json). updatedAt changes only when the content does, so rerunning is
// a no-op. Returns the keys written, for the upload queue.
export function writeManifest({ publish = PUBLISH, state = STATE, now = new Date(), wall = readWallState(state) } = {}) {
  if (!wall) throw new Error('no wall state yet: run npm run wall:build');
  const revs = gifRevs(publish);
  const body = composeManifest({
    songCount: wall.songCount,
    overrides: wall.overrides,
    cells: readJson(path.join(state, 'cells.json'), {}),
    gifs: readJson(path.join(state, 'gifs.json')),
    catalog: readJson(path.join(state, 'catalog.json')),
    hasGif: (n) => revs.has(n),
    gifRev: revs,
  });
  const currentFile = path.join(publish, CURRENT_KEY);
  const prev = readJson(currentFile);
  const same = prev && JSON.stringify({ ...prev, updatedAt: null }) === JSON.stringify(body);
  const manifest = same ? prev : { ...body, updatedAt: now.toISOString() };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!same) writeAtomic(currentFile, text);
  const history = historyKey(wall.songCount, text), historyFile = path.join(publish, history);
  if (!fs.existsSync(historyFile)) writeAtomic(historyFile, text);
  return { manifest, changed: !same, keys: { current: CURRENT_KEY, history }, files: { current: currentFile, history: historyFile } };
}

// ---- Lock ----

const unique = () => `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

// The lock appears whole or not at all: written aside, then hard-linked into place (EEXIST if held).
function createLock(file, body) {
  const tmp = `${file}.new-${unique()}`;
  fs.writeFileSync(tmp, body);
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Throws ENOENT once the lock is released. An empty or unreadable lock (a writer from before locks
// were linked into place, caught mid-write) counts as held until it is LOCK_GRACE_MS old.
function lockHolder(file) {
  const st = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  let held = null;
  try {
    held = JSON.parse(text);
  } catch {}
  if (!held?.pid) return { ino: st.ino, text, stale: Date.now() - st.mtimeMs > LOCK_GRACE_MS };
  const at = held.at ? Date.parse(held.at) : st.mtimeMs;
  let alive = true;
  try {
    process.kill(held.pid, 0);
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  return { ...held, ino: st.ino, text, stale: !alive || Date.now() - at > LOCK_STALE_MS };
}

// Removes the lock judged stale, and only that one. Renaming is atomic, so of two waiters that both
// judged it stale only one moves it; the other moves whatever lock replaced it, sees it isn't the
// one it judged, and puts it straight back.
function breakLock(file, judged) {
  const aside = `${file}.stale-${unique()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // already gone
  }
  let same = false;
  try {
    same = fs.statSync(aside).ino === judged.ino && fs.readFileSync(aside, 'utf8') === judged.text;
  } catch {}
  if (!same) {
    try {
      fs.linkSync(aside, file);
    } catch {}
  }
  fs.rmSync(aside, { force: true });
}

// One writer at a time on this Mac. The lock file names its pid; it is stale after 10 minutes or
// once that process is gone. Waits up to waitMs for a live lock, then throws (code ELOCKED).
export async function withLock(fn, { file = LOCK, waitMs = 0, label = path.basename(process.argv[1] || 'node') } = {}) {
  const until = Date.now() + waitMs;
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      createLock(file, JSON.stringify({ pid: process.pid, cmd: label, at: new Date().toISOString(), token }));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let held;
      try {
        held = lockHolder(file);
      } catch {
        continue; // released between our write and our read
      }
      if (held.stale) {
        breakLock(file, held);
        continue;
      }
      if (Date.now() >= until) {
        const who = held.pid ? `${held.cmd} (pid ${held.pid}) since ${held.at}` : 'a writer that is still starting';
        throw Object.assign(new Error(`${file} is held by ${who}`), { code: 'ELOCKED' });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file);
    } catch {}
  };
  process.once('exit', release);
  try {
    return await fn();
  } finally {
    release();
    process.off('exit', release);
  }
}

// ---- Upload queue ----

// Appends objects to upload, in commit order, to STATE/pending-uploads.jsonl. `file` is relative to
// CACHE; bucket is 'media' (public) or 'archive' (private). The R2 uploader drains it later.
export function appendPending(items, { state = STATE, cache = CACHE, songId = null, now = new Date() } = {}) {
  const at = now.toISOString();
  const lines = items.map(({ bucket = 'media', key, file }) => JSON.stringify({ at, songId, bucket, key, file: path.relative(cache, file) }));
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, 'pending-uploads.jsonl'), `${lines.join('\n')}\n`);
  return lines.length;
}
