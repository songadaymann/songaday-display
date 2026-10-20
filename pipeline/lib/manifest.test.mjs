import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tileKey, tilesForSong } from '../../shared/layout.mjs';
import { appendPending, bumpOverrides, composeManifest, noGifFrom, pruneOverrides, readWallState, withLock, writeManifest, writeWallState } from './manifest.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-manifest-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('bumpOverrides moves every tile holding an old song to a new revision', () => {
  const S = 6502;
  const once = bumpOverrides({}, 100, S);
  assert.equal(Object.keys(once).length, 8);
  for (const { k, x, y } of tilesForSong(100)) {
    assert.match(tileKey(k, x, y, S, once), /-r1\.webp$/);
  }
  const twice = bumpOverrides(once, 100, S);
  assert.ok(Object.values(twice).every((o) => o.rev === 2));
  // Once a newer song lands in a tile, its override no longer applies and is dropped.
  // Song 6500 shares its k5-k7 tiles with 6501 and 6502, so only its k0-k4 overrides survive.
  const later = pruneOverrides(bumpOverrides({}, 6500, 6501), 6502);
  assert.deepEqual(Object.keys(later).map((id) => id[0]), ['0', '1', '2', '3', '4']);
  assert.ok(Object.values(later).every((o) => o.v === 6500));
  assert.equal(Object.keys(pruneOverrides({ '0/0_0': { v: 1, rev: 1 } }, 2)).length, 0);
  // Several songs at once bump each shared tile once.
  const both = bumpOverrides({}, [100, 101], S);
  assert.ok(Object.values(both).every((o) => o.rev === 1));
  assert.equal(Object.keys(both).length, new Set([...tilesForSong(100), ...tilesForSong(101)].map((t) => `${t.k}/${t.x}_${t.y}`)).size);
});

test('noGif comes from gifs.json, plus newer songs with no GIF published', () => {
  assert.deepEqual(noGifFrom(null, 10), []);
  const gifs = { songCount: 8, noGif: [3] };
  assert.deepEqual(noGifFrom(gifs, 10, (n) => n !== 10 && n !== 3), [3, 10]);
  assert.deepEqual(noGifFrom(gifs, 10, (n) => n !== 10), [10], 'a GIF that turned up later clears the song');
});

test('composeManifest follows the schema in shared/README.md', () => {
  const m = composeManifest({
    songCount: 6502,
    cells: { 6000: { flags: ['art'] }, 6210: { flags: ['card', 'dark'] }, 6600: { flags: ['card'] }, 143: { flags: [], stillRev: 2 } },
    gifs: { songCount: 6502, noGif: [940, 5832] },
    hasGif: () => false,
    gifRev: new Map([[1, 1], [5, 0]]),
    catalog: { schema: 1, chunkSize: 500, index: ['meta/index-0-aa.json'], detail: ['meta/detail-0-bb.json'], songCount: 6502, builtAt: 'x' },
    updatedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(m), ['schema', 'pyramid', 'songCount', 'updatedAt', 'overrides', 'missingArt', 'noGif', 'stillRev', 'gifRev', 'catalog']);
  assert.deepEqual(m.missingArt, [6210]);
  assert.deepEqual(m.noGif, [940, 5832]);
  assert.deepEqual(m.stillRev, { 143: 2 });
  assert.deepEqual(m.gifRev, { 1: 1 });
  assert.deepEqual(m.catalog, { schema: 1, chunkSize: 500, index: ['meta/index-0-aa.json'], detail: ['meta/detail-0-bb.json'] });
});

test('writeManifest writes current and an immutable history copy, and is a no-op when nothing changed', () => {
  const state = path.join(tmp, 'state'), publish = path.join(tmp, 'publish');
  writeWallState({ songCount: 155 }, state);
  fs.writeFileSync(path.join(state, 'cells.json'), JSON.stringify({ 3: { flags: ['card'] } }));
  const a = writeManifest({ publish, state, now: new Date('2026-10-20T01:00:00Z') });
  assert.equal(a.changed, true);
  assert.deepEqual(a.manifest.missingArt, [3]);
  assert.match(a.keys.history, /^wall\/manifests\/155-[0-9a-f]{8}\.json$/);
  assert.equal(fs.readFileSync(path.join(publish, 'wall/current.json'), 'utf8'), fs.readFileSync(path.join(publish, a.keys.history), 'utf8'));
  const b = writeManifest({ publish, state, now: new Date('2026-10-21T01:00:00Z') });
  assert.equal(b.changed, false);
  assert.equal(b.manifest.updatedAt, '2026-10-20T01:00:00.000Z');
  assert.equal(b.keys.history, a.keys.history);
  // A change at the same songCount gets a new history key; the old copy keeps its bytes.
  const old = fs.readFileSync(path.join(publish, a.keys.history), 'utf8');
  const c = writeManifest({ publish, state, wall: { songCount: 155, overrides: bumpOverrides({}, 3, 155) } });
  assert.notEqual(c.keys.history, a.keys.history);
  assert.equal(fs.readFileSync(path.join(publish, a.keys.history), 'utf8'), old);
  assert.equal(Object.keys(c.manifest.overrides).length, 8);
});

test('wall state keeps the cell each song was built from, one song per line', () => {
  const state = path.join(tmp, 'state-built');
  writeWallState({ songCount: 3, built: { 1: 'a', 2: 'b', 3: 'c', 9: 'gone' } }, state);
  const w = readWallState(state);
  assert.deepEqual([w.songCount, w.built], [3, { 1: 'a', 2: 'b', 3: 'c' }]);
  assert.equal(fs.readFileSync(path.join(state, 'wall.json'), 'utf8').split('\n').filter((l) => /^ {4}"\d+"/.test(l)).length, 3);
  writeWallState({ songCount: 1 }, state);
  assert.deepEqual(readWallState(state).built, {});
});

test('withLock excludes a second writer, waits, and clears stale locks', async () => {
  const file = path.join(tmp, 'wall.lock');
  let inner;
  await withLock(async () => {
    await assert.rejects(withLock(async () => {}, { file }), { code: 'ELOCKED' });
    inner = withLock(async () => 'second', { file, waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
  }, { file });
  assert.equal(await inner, 'second');
  assert.ok(!fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, cmd: 'gone', at: new Date().toISOString() }));
  assert.equal(await withLock(async () => 'ok', { file }), 'ok');
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, cmd: 'old', at: '2020-01-01T00:00:00Z' }));
  assert.equal(await withLock(async () => 'ok', { file }), 'ok');
  // An empty lock is a writer caught mid-write: held while young, broken once old.
  fs.writeFileSync(file, '');
  await assert.rejects(withLock(async () => {}, { file }), { code: 'ELOCKED' });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  assert.equal(await withLock(async () => 'ok', { file }), 'ok');
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('wall.lock.')), [], 'no stray lock files');
});

test('appendPending records keys in order with cache-relative paths', () => {
  const cache = path.join(tmp, 'cache'), state = path.join(cache, 'state');
  appendPending([{ bucket: 'archive', key: 'cells/480x270/1.webp', file: path.join(cache, 'cells/480x270/1.webp') }, { key: 'wall/current.json', file: path.join(cache, 'publish/wall/current.json') }], { state, cache, songId: 1 });
  const lines = fs.readFileSync(path.join(state, 'pending-uploads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.bucket, l.key, l.file]), [['archive', 'cells/480x270/1.webp', 'cells/480x270/1.webp'], ['media', 'wall/current.json', 'publish/wall/current.json']]);
});
