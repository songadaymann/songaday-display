import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GIF_DIR } from './gifs.mjs';
import { STILLS_DIR } from './cells.mjs';
import { dateOf } from './catalog.mjs';
import { FALLBACK_AFTER_MS, YOUTUBE_GRACE_MS, acquireLock, catchUpPlan, checkInputs, daily, exitCode, gifCatchUp, pendingSongs, runNode, writeStatus } from './daily.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-daily-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const fresh = (name) => {
  const dir = path.join(tmp, `${name}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const YT = 'https://youtube.com/watch?v=PlQqrw-Kn0g';

function archiveFor(n, { still = 'jpeg bytes', meta, meta2 } = {}) {
  const root = fresh('in');
  const archive = path.join(root, 'archive'), out = path.join(root, 'output'), out2 = path.join(root, 'output2');
  const json = (m) => (typeof m === 'string' ? m : JSON.stringify(m));
  if (still != null) write(path.join(archive, STILLS_DIR, `${n}.jpg`), still);
  if (meta !== undefined) write(path.join(out, String(n), 'initial-metadata.json'), json(meta));
  if (meta2 !== undefined) write(path.join(out2, String(n), 'initial-metadata.json'), json(meta2));
  return { archive, outputDirs: [out, out2] };
}
const stillMtime = (dirs, n) => fs.statSync(path.join(dirs.archive, STILLS_DIR, `${n}.jpg`)).mtimeMs;

test('ready: a real still, metadata that parses, and a YouTube URL', async () => {
  const dirs = archiveFor(6504, { meta: { songNbr: 6504, title: 'x', youtubeUrl: YT } });
  assert.deepEqual(await checkInputs(6504, dirs), { n: 6504, ready: true, seen: true, overdue: false, youtube: true });
});

test('waiting: no still, or a 0-byte Dropbox placeholder', async () => {
  const none = await checkInputs(6504, archiveFor(6504, { still: null }));
  assert.deepEqual([none.ready, none.seen, none.reason], [false, false, 'no still yet']);
  const placeholder = await checkInputs(6504, archiveFor(6504, { still: '', meta: { songNbr: 6504, youtubeUrl: YT } }));
  assert.deepEqual([placeholder.ready, placeholder.seen], [false, true]);
  assert.match(placeholder.reason, /still is empty or online-only/);
});

test('waiting: initial-metadata.json missing, a placeholder, unparseable, or another song\'s', async () => {
  const missing = await checkInputs(6504, archiveFor(6504));
  assert.deepEqual([missing.ready, missing.seen, missing.reason], [false, true, 'no initial-metadata.json yet']);
  const empty = await checkInputs(6504, archiveFor(6504, { meta: '' }));
  assert.match(empty.reason, /initial-metadata.json is empty or online-only/);
  const half = await checkInputs(6504, { ...archiveFor(6504, { meta: '{"songNbr": 6504, "tit' }), attempts: 2, retryMs: 1 });
  assert.equal(half.ready, false);
  assert.match(half.reason, /does not parse/);
  const other = await checkInputs(6504, archiveFor(6504, { meta: { songNbr: 6503, youtubeUrl: YT } }));
  assert.match(other.reason, /is for #6503/);
});

test('waiting: initial-metadata.json with another date, which wall-add would skip; a good copy elsewhere counts', async () => {
  assert.equal(dateOf(6504), '2026-10-22');
  const typo = await checkInputs(6504, archiveFor(6504, { meta: { songNbr: 6504, date: '2026-10-23', title: 'x', youtubeUrl: YT } }));
  assert.deepEqual([typo.ready, typo.reason], [false, 'initial-metadata.json has date 2026-10-23, not 2026-10-22']);
  const same = await checkInputs(6504, archiveFor(6504, { meta: { songNbr: 6504, date: ' 2026-10-22 ', youtubeUrl: YT } }));
  assert.equal(same.ready, true);
  // Like wall-add's toolkitRecords: the first file that names the song and its date.
  const second = await checkInputs(6504, archiveFor(6504, {
    meta: { songNbr: 6504, date: '2026-10-23', youtubeUrl: YT },
    meta2: { songNbr: 6504, date: '2026-10-22', youtubeUrl: YT },
  }));
  assert.deepEqual([second.ready, second.youtube], [true, true]);
});

test('overdue: a day after the first input turned up, or with none, a day after the date ended', async () => {
  const dirs = archiveFor(6504); // a manual add: a still, no initial-metadata.json
  const t = stillMtime(dirs, 6504);
  const fresh = await checkInputs(6504, { ...dirs, now: t + FALLBACK_AFTER_MS - 1000 });
  assert.deepEqual([fresh.ready, fresh.overdue, fresh.reason], [false, false, 'no initial-metadata.json yet']);
  const old = await checkInputs(6504, { ...dirs, now: t + FALLBACK_AFTER_MS + 1000 });
  assert.deepEqual([old.ready, old.seen, old.overdue], [false, true, true]);
  // Ready and old: still flagged, so wall-add gets --fallback in case the still doesn't decode.
  const ready = archiveFor(6504, { meta: { songNbr: 6504, youtubeUrl: YT } });
  assert.equal((await checkInputs(6504, { ...ready, now: stillMtime(ready, 6504) + FALLBACK_AFTER_MS + 1000 })).overdue, true);
  // Never seen: overdue a day after its date ended (2026-10-24T00:00Z for 6504).
  const none = archiveFor(6504, { still: null });
  const dayEnd = Date.parse('2026-10-23T00:00:00Z');
  assert.equal((await checkInputs(6504, { ...none, now: dayEnd + FALLBACK_AFTER_MS - 1000 })).overdue, false);
  const gone = await checkInputs(6504, { ...none, now: dayEnd + FALLBACK_AFTER_MS + 1000 });
  assert.deepEqual([gone.ready, gone.seen, gone.overdue], [false, false, true]);
});

test('no YouTube URL: waiting while the still is under 2 hours old, ready after', async () => {
  const dirs = archiveFor(6504, { meta: { songNbr: 6504, youtubeUrl: '', videoUrl: '' } });
  const t = stillMtime(dirs, 6504);
  const young = await checkInputs(6504, { ...dirs, now: t + 30 * 60 * 1000 });
  assert.equal(young.ready, false);
  assert.match(young.reason, /no YouTube URL yet \(still is 30 min old/);
  const old = await checkInputs(6504, { ...dirs, now: t + YOUTUBE_GRACE_MS + 1000 });
  assert.deepEqual(old, { n: 6504, ready: true, seen: true, overdue: false, youtube: false });
  // Not a YouTube link doesn't count.
  const bad = archiveFor(6504, { meta: { songNbr: 6504, youtubeUrl: 'https://example.com/x' } });
  assert.equal((await checkInputs(6504, { ...bad, now: stillMtime(bad, 6504) + 1000 })).ready, false);
});

const R = (n) => ({ n, ready: true, seen: true });
const W = (n, reason = 'no YouTube URL yet') => ({ n, ready: false, seen: true, reason });
const U = (n) => ({ n, ready: false, seen: false, reason: 'no still yet' });
const late = (c) => ({ ...c, overdue: true });

test('catch-up targets the newest ready song, never past one that is not ready', () => {
  assert.deepEqual(catchUpPlan([]), { action: 'none' });
  assert.deepEqual(catchUpPlan([U(6504), U(6505)]), { action: 'none' });
  assert.deepEqual(catchUpPlan([R(6504), U(6505)]), { action: 'add', songId: 6504, songs: [6504] });
  assert.deepEqual(catchUpPlan([R(6504), R(6505), R(6506), U(6507)]), { action: 'add', songId: 6506, songs: [6504, 6505, 6506] });
  assert.deepEqual(catchUpPlan([W(6504), U(6505)]), { action: 'wait', songId: 6504, reason: 'no YouTube URL yet' });
  assert.deepEqual(catchUpPlan([U(6504), W(6505)]), { action: 'wait', songId: 6505, reason: 'no YouTube URL yet' });
  assert.deepEqual(catchUpPlan([W(6504), R(6505)]), { action: 'wait', songId: 6504, reason: 'no YouTube URL yet', newestReady: 6505 });
  assert.deepEqual(catchUpPlan([U(6504), R(6505)]), { action: 'wait', songId: 6504, reason: 'no still yet', newestReady: 6505 });
  assert.deepEqual(catchUpPlan([R(6504), W(6505), R(6506)]), { action: 'add', songId: 6504, songs: [6504], blockedBy: { n: 6505, reason: 'no YouTube URL yet' } });
});

test('catch-up stops waiting on an overdue song: it goes up with fallbacks, and an unseen one only to fill a hole', () => {
  const manual = late(W(6504, 'no initial-metadata.json yet'));
  assert.deepEqual(catchUpPlan([manual, U(6505)]), { action: 'add', songId: 6504, songs: [6504], fallback: [6504] });
  assert.deepEqual(catchUpPlan([manual, R(6505), R(6506)]), { action: 'add', songId: 6506, songs: [6504, 6505, 6506], fallback: [6504] });
  assert.deepEqual(catchUpPlan([late(U(6504)), R(6505)]), { action: 'add', songId: 6505, songs: [6504, 6505], fallback: [6504] });
  assert.deepEqual(catchUpPlan([late(U(6504)), U(6505)]), { action: 'none' });
  assert.deepEqual(catchUpPlan([R(6504), late(U(6505))]), { action: 'add', songId: 6504, songs: [6504] });
  assert.deepEqual(catchUpPlan([R(6504), late(R(6505))]), { action: 'add', songId: 6505, songs: [6504, 6505] });
  assert.deepEqual(catchUpPlan([manual, W(6505), R(6506)]), { action: 'add', songId: 6504, songs: [6504], fallback: [6504], blockedBy: { n: 6505, reason: 'no YouTube URL yet' } });
});

test('late GIFs: only real GIFs past the Azure copy, run on a song with a real still', () => {
  const archive = path.join(fresh('gifs'), 'archive');
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([64, 1, 180, 0]), Buffer.alloc(20)]);
  write(path.join(archive, GIF_DIR, '5000.gif'), gif); // on Azure: not ours
  write(path.join(archive, GIF_DIR, '6001.gif'), gif);
  write(path.join(archive, GIF_DIR, '6004.gif'), ''); // placeholder
  write(path.join(archive, GIF_DIR, '6006.gif'), 'not a gif at all');
  const kinds = { 6001: 'art', 6503: 'still' };
  const kindOf = (m) => kinds[m];
  assert.deepEqual(gifCatchUp({ noGif: [5000, 6001, 6004, 6006, 6007], songCount: 6503, archive, kindOf }), { gifs: [6001], song: 6503 });
  kinds[6001] = 'still';
  assert.deepEqual(gifCatchUp({ noGif: [6001], songCount: 6503, archive, kindOf }), { gifs: [6001], song: 6001 });
  assert.deepEqual(gifCatchUp({ noGif: [6001], songCount: 6503, archive, kindOf: () => 'card' }), { gifs: [6001], song: null });
  assert.equal(gifCatchUp({ noGif: [6004, 6006], songCount: 6503, archive, kindOf }), null);
  assert.equal(gifCatchUp({ noGif: [], songCount: 6503, archive, kindOf }), null);
  // Already in PUBLISH/gifs (gifs-index copied it): wall-add would do nothing, so it's stale instead.
  const published = new Map([[6001, 0]]);
  assert.deepEqual(gifCatchUp({ noGif: [6001, 6004], songCount: 6503, archive, published, kindOf }), { gifs: [], song: null, stale: [6001] });
  write(path.join(archive, GIF_DIR, '6007.gif'), gif);
  assert.deepEqual(gifCatchUp({ noGif: [6001, 6007], songCount: 6503, archive, published, kindOf }), { gifs: [6007], song: 6503, stale: [6001] });
});

// ---- The run, with fake children ----

const child = (code, json, extra = {}) => ({ code, signal: null, timedOut: false, json, stderrTail: '', ms: 5, ...extra });

function fakeDeps({ songCount = 6503, ready = {}, today = 6504, pending = 0, pendingFor = [], gifs = null, wallAdd, sync, dir = fresh('run') } = {}) {
  const calls = [];
  let queued = pending;
  const songs = new Set(pendingFor);
  const deps = {
    dir,
    calls,
    checked: [],
    lock: () => acquireLock(path.join(dir, 'daily.lock'), { waitMs: 0 }),
    readWall: () => (songCount ? { songCount } : null),
    check: async (n) => {
      deps.checked.push(n);
      return ready[n] ?? U(n);
    },
    today: () => today,
    lateGifs: () => gifs,
    pending: () => queued,
    pendingSongs: () => [...songs].sort((a, b) => a - b),
    run: async (name, args) => {
      calls.push([name, ...args]);
      if (name === 'wall-add') {
        const r = typeof wallAdd === 'function' ? wallAdd(args) : wallAdd;
        if (r.code === 0 && r.json?.queued) {
          queued += r.json.queued;
          songs.add(Number(args[1]));
        }
        return r;
      }
      const r = typeof sync === 'function' ? sync() : sync ?? child(0, { status: 'synced', uploaded: queued });
      if (r.code === 0 || r.code === 3) {
        queued = 0;
        songs.clear();
      }
      return r;
    },
    writeStatus: (line) => writeStatus(line, path.join(dir, 'daily')),
  };
  return deps;
}
const statusFile = (deps, name) => JSON.parse(fs.readFileSync(path.join(deps.dir, 'daily', `${name}.json`), 'utf8'));
const added = (n, extra = {}) => child(0, { status: 'added', songId: n, tilesWritten: 8, ms: 600, songCount: n, queued: 15, ...extra });

test('--song-id N ready: wall-add, then r2-sync; status file written; exit 0', async () => {
  const deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: added(6504) });
  const { line, code } = await daily({ songId: 6504 }, deps);
  assert.equal(code, 0);
  assert.deepEqual(deps.calls, [['wall-add', '--song-id', '6504', '--json'], ['r2-sync', '--json']]);
  assert.deepEqual(Object.keys(line).slice(0, 6), ['status', 'songId', 'songCount', 'tilesWritten', 'uploaded', 'ms']);
  assert.deepEqual([line.status, line.songId, line.songCount, line.tilesWritten, line.uploaded], ['added', 6504, 6504, 8, 15]);
  assert.equal(line.wallAdd.status, 'added');
  assert.equal(line.sync.status, 'synced');
  assert.equal(statusFile(deps, 6504).status, 'added');
  assert.equal(statusFile(deps, 'last').songId, 6504);
  assert.equal(fs.existsSync(path.join(deps.dir, 'daily.lock')), false, 'lock released');
});

test('--song-id N not ready: waiting, exit 4, nothing run', async () => {
  const deps = fakeDeps({ ready: { 6504: W(6504) }, pending: 3 });
  const { line, code } = await daily({ songId: 6504 }, deps);
  assert.equal(code, 4);
  assert.deepEqual([line.status, line.songId, line.reason], ['waiting', 6504, 'no YouTube URL yet']);
  assert.deepEqual(deps.calls, []);
  assert.equal(statusFile(deps, 6504).status, 'waiting');
});

test('--song-id N: wall-add exit 2 is waiting (exit 4); exit 1 and timeouts fail with exit 1', async () => {
  let deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: child(2, { status: 'input-unavailable', songId: 6504, error: 'no usable still for #6504' }) });
  let r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.reason], [4, 'waiting', 'no usable still for #6504']);
  assert.deepEqual(deps.calls.map((c) => c[0]), ['wall-add']);

  deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: child(1, { status: 'failed', error: 'boom' }, { stderrTail: 'trace line 1\ntrace line 2' }) });
  r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.error], [1, 'failed', 'wall-add: boom']);
  assert.match(r.line.stderr, /trace line 2/);
  assert.equal(exitCode(statusFile(deps, 6504)), 1);

  deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: child(null, null, { signal: 'SIGTERM', timedOut: true, ms: 300000 }) });
  r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, r.line.error], [1, 'wall-add timed out after 300 s']);

  deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: child(1, null, { stderrTail: 'node:internal/x:1\n\nError: Cannot find module x\n    at y\n\nNode.js v22.23.4' }) });
  r = await daily({ songId: 6504 }, deps);
  assert.equal(r.line.error, 'wall-add: Error: Cannot find module x');
});

test('r2-sync failing is exit 1; uploaded but the public check failing is exit 3', async () => {
  let deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: added(6504), sync: child(1, { status: 'failed', uploaded: 3, errors: ['media/wall/p1/0/1_2_6504.webp: HTTP 500'] }) });
  let r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.songCount], [1, 'failed', 6504]);
  assert.match(r.line.error, /^r2-sync: media\/wall/);

  deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: added(6504), sync: child(3, { status: 'synced', uploaded: 15, verify: { ok: false } }) });
  r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.verified, r.line.uploaded], [3, 'added', false, 15]);
});

test('already-current syncs only when uploads are still queued; N on the wall needs no readiness', async () => {
  const current = child(0, { status: 'already-current', songId: 6503, tilesWritten: 0, songCount: 6503 });
  let deps = fakeDeps({ wallAdd: current, ready: { 6503: W(6503) } });
  let r = await daily({ songId: 6503 }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.uploaded], [0, 'already-current', 0]);
  assert.deepEqual(deps.calls.map((c) => c[0]), ['wall-add']);

  deps = fakeDeps({ wallAdd: current, pending: 4 });
  r = await daily({ songId: 6503 }, deps);
  assert.deepEqual(deps.calls.map((c) => c[0]), ['wall-add', 'r2-sync']);
  assert.equal(r.line.status, 'already-current');
});

test('--catch-up adds up to the newest ready song in one wall-add, then syncs', async () => {
  const deps = fakeDeps({
    songCount: 6501,
    today: 6504,
    ready: { 6502: R(6502), 6503: R(6503), 6504: W(6504) },
    wallAdd: added(6503, { added: [6502, 6503] }),
  });
  const { line, code } = await daily({ catchUp: true }, deps);
  assert.equal(code, 0);
  assert.deepEqual(deps.calls, [['wall-add', '--song-id', '6503', '--json'], ['r2-sync', '--json']]);
  assert.deepEqual([line.status, line.songId, line.added, line.mode], ['added', 6503, [6502, 6503], 'catch-up']);
  assert.equal(statusFile(deps, 6502).status, 'added');
  assert.equal(statusFile(deps, 6503).status, 'added');
});

test('--catch-up with nothing new: quiet, exit 0; still drains the queue and picks up late GIFs', async () => {
  let deps = fakeDeps();
  let r = await daily({ catchUp: true }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.songId, r.line.songCount], [0, 'already-current', null, 6503]);
  assert.deepEqual(deps.calls, []);
  assert.equal(statusFile(deps, 'last').status, 'already-current');

  deps = fakeDeps({ pending: 2, ready: { 6504: W(6504) } });
  r = await daily({ catchUp: true }, deps);
  assert.deepEqual(deps.calls.map((c) => c[0]), ['r2-sync']);
  assert.deepEqual([r.code, r.line.status, r.line.songId], [0, 'waiting', 6504]);

  deps = fakeDeps({ gifs: { gifs: [6501], song: 6501 }, wallAdd: child(0, { status: 'already-current', songId: 6501, tilesWritten: 0, songCount: 6503, lateGifs: ['gifs/6501.gif'], queued: 3 }) });
  r = await daily({ catchUp: true }, deps);
  assert.deepEqual(deps.calls, [['wall-add', '--song-id', '6501', '--json'], ['r2-sync', '--json']]);
  assert.deepEqual([r.code, r.line.status, r.line.songId, r.line.lateGifs], [0, 'already-current', null, ['gifs/6501.gif']]);

  // wall-add can't use that song after all: a warning, not a failure.
  deps = fakeDeps({ gifs: { gifs: [6501], song: 6501 }, wallAdd: child(2, { status: 'input-unavailable', error: 'no usable still' }) });
  r = await daily({ catchUp: true }, deps);
  assert.deepEqual([r.code, r.line.status], [0, 'already-current']);
  assert.match(r.line.warnings[0], /late GIFs: no usable still/);
});

test('--song-id N checks every song between the wall and N, with the same plan as catch-up', async () => {
  // The song before N isn't ready: nothing goes up, N is waiting on it.
  let deps = fakeDeps({ ready: { 6504: W(6504, 'still is empty or online-only'), 6505: R(6505) } });
  let r = await daily({ songId: 6505 }, deps);
  assert.deepEqual(deps.checked, [6504, 6505]);
  assert.deepEqual(deps.calls, []);
  assert.deepEqual([r.code, r.line.status, r.line.songId, r.line.reason], [4, 'waiting', 6505, "#6504 isn't ready: still is empty or online-only"]);
  assert.deepEqual(r.line.blockedBy, { n: 6504, reason: 'still is empty or online-only' });
  assert.equal(statusFile(deps, 6505).status, 'waiting');
  assert.equal(fs.existsSync(path.join(deps.dir, 'daily', '6504.json')), false);

  // Everything up to N ready: one wall-add N fills the gap.
  deps = fakeDeps({ ready: { 6504: R(6504), 6505: R(6505) }, wallAdd: added(6505, { added: [6504, 6505] }) });
  r = await daily({ songId: 6505 }, deps);
  assert.deepEqual(deps.calls, [['wall-add', '--song-id', '6505', '--json'], ['r2-sync', '--json']]);
  assert.deepEqual([r.code, r.line.status, r.line.added], [0, 'added', [6504, 6505]]);

  // N not ready, the song before it is: that one goes up; N is waiting.
  deps = fakeDeps({ ready: { 6504: R(6504), 6505: W(6505) }, wallAdd: added(6504) });
  r = await daily({ songId: 6505 }, deps);
  assert.deepEqual(deps.calls, [['wall-add', '--song-id', '6504', '--json'], ['r2-sync', '--json']]);
  assert.deepEqual([r.code, r.line.status, r.line.songId, r.line.added, r.line.reason], [4, 'waiting', 6505, [6504], 'no YouTube URL yet']);
  assert.deepEqual([statusFile(deps, 6504).status, statusFile(deps, 6504).songId, statusFile(deps, 6504).reason], ['added', 6504, undefined]);
  assert.ok(statusFile(deps, 6504).publishedAt);
  assert.equal(statusFile(deps, 6505).status, 'waiting');
});

test('an overdue song goes up with fallbacks: --fallback when it is the head, a warning either way', async () => {
  const manual = late(W(6504, 'no initial-metadata.json yet'));
  let deps = fakeDeps({ today: 6506, ready: { 6504: manual, 6505: R(6505), 6506: R(6506) }, wallAdd: added(6506, { added: [6504, 6505, 6506] }) });
  let r = await daily({ catchUp: true }, deps);
  assert.deepEqual(deps.calls[0], ['wall-add', '--song-id', '6506', '--json']);
  assert.deepEqual([r.code, r.line.status, r.line.fallback], [0, 'added', [6504]]);
  assert.match(r.line.warnings[0], /^#6504 went up with wall-add's fallbacks after waiting a day: no initial-metadata.json yet/);

  // The hook's song past an overdue gap song: the same.
  deps = fakeDeps({ ready: { 6504: late(U(6504)), 6505: R(6505) }, wallAdd: added(6505, { added: [6504, 6505] }) });
  r = await daily({ songId: 6505 }, deps);
  assert.deepEqual([r.code, r.line.status, r.line.fallback], [0, 'added', [6504]]);

  // The overdue song is the head (or ready but old, its still perhaps undecodable): --fallback.
  deps = fakeDeps({ ready: { 6504: manual }, wallAdd: added(6504) });
  r = await daily({ catchUp: true }, deps);
  assert.deepEqual(deps.calls[0], ['wall-add', '--song-id', '6504', '--json', '--fallback']);
  deps = fakeDeps({ ready: { 6504: late(R(6504)) }, wallAdd: added(6504) });
  await daily({ catchUp: true }, deps);
  assert.deepEqual(deps.calls[0], ['wall-add', '--song-id', '6504', '--json', '--fallback']);
  const dry = await daily({ catchUp: true, dryRun: true }, fakeDeps({ ready: { 6504: manual } }));
  assert.equal(dry.line.steps[0], 'wall-add --song-id 6504 --fallback');
});

test('status files: a later sync marks earlier songs published; a published song is never downgraded', async () => {
  // The hook adds 6504, r2-sync fails; the next catch-up drains the queue.
  const dir = fresh('status');
  let deps = fakeDeps({ dir, ready: { 6504: R(6504) }, wallAdd: added(6504), sync: child(1, { status: 'failed', uploaded: 3, errors: ['network'] }) });
  let r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, statusFile(deps, 6504).status], [1, 'failed']);
  deps = fakeDeps({ dir, songCount: 6504, pending: 15, pendingFor: [6504] });
  r = await daily({ catchUp: true }, deps);
  assert.deepEqual([r.code, r.line.songId, r.line.uploaded, r.line.published], [0, null, 15, [6504]]);
  let rec = statusFile(deps, 6504);
  assert.deepEqual([rec.status, rec.error, rec.stderr, rec.songId], ['added', undefined, undefined, 6504]);
  assert.equal(rec.publishedAt, r.line.at);

  // Catch-up adds 6504; then the hook for 6504 finds it already there.
  const dir2 = fresh('status');
  deps = fakeDeps({ dir: dir2, ready: { 6504: R(6504) }, wallAdd: added(6504) });
  r = await daily({ catchUp: true }, deps);
  assert.deepEqual([statusFile(deps, 6504).status, statusFile(deps, 6504).tilesWritten, statusFile(deps, 6504).uploaded], ['added', 8, 15]);
  deps = fakeDeps({ dir: dir2, songCount: 6504, wallAdd: child(0, { status: 'already-current', songId: 6504, tilesWritten: 0, songCount: 6504 }) });
  r = await daily({ songId: 6504 }, deps);
  assert.deepEqual([r.code, r.line.status], [0, 'already-current']);
  rec = statusFile(deps, 6504);
  assert.deepEqual([rec.status, rec.tilesWritten, rec.uploaded, rec.mode], ['added', 8, 15, 'catch-up']);
  assert.deepEqual([rec.lastRun.status, rec.lastRun.mode], ['already-current', 'song']);
  assert.equal(statusFile(deps, 'last').status, 'already-current');

  // A gap fill whose upload failed: the drained queue names only the head, its record names both.
  const dir3 = fresh('status');
  deps = fakeDeps({ dir: dir3, ready: { 6504: R(6504), 6505: R(6505) }, wallAdd: added(6505, { added: [6504, 6505] }), sync: child(1, { status: 'failed', errors: ['x'] }) });
  await daily({ songId: 6505 }, deps);
  writeStatus({ status: 'already-current', songId: null, mode: 'catch-up', at: '2026-10-22T20:00:00.000Z', published: [6505], uploaded: 15 }, path.join(dir3, 'daily'));
  assert.deepEqual([6504, 6505].map((n) => [statusFile(deps, n).status, statusFile(deps, n).publishedAt]), [['added', '2026-10-22T20:00:00.000Z'], ['added', '2026-10-22T20:00:00.000Z']]);
});

test('pendingSongs reads the songs off the upload queue', () => {
  const state = fresh('state');
  assert.deepEqual(pendingSongs(state), []);
  write(path.join(state, 'pending-uploads.jsonl'), [
    { songId: 6505, key: 'a' }, { songId: 6504, key: 'b' }, { songId: 6505, key: 'c' }, { songId: null, key: 'd' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.deepEqual(pendingSongs(state), [6504, 6505]);
});

test('late GIFs already in the publish folder are reported, not retried through a no-op wall-add', async () => {
  const deps = fakeDeps({ gifs: { gifs: [], song: null, stale: [5856, 5857] } });
  const r = await daily({ catchUp: true }, deps);
  assert.deepEqual(deps.calls, []);
  assert.deepEqual([r.code, r.line.status], [0, 'already-current']);
  assert.match(r.line.warnings[0], /GIFs for 5856, 5857 are in the publish folder.*npm run wall:manifest/);
});

test('exit codes: what --song-id N means for N; catch-up waiting or busy is not an error', () => {
  const at = (status, mode, extra = {}) => exitCode({ status, mode, ...extra });
  assert.deepEqual(['added', 'already-current', 'waiting', 'busy', 'failed', 'dry-run'].map((s) => at(s, 'song')), [0, 0, 4, 5, 1, 0]);
  assert.deepEqual(['added', 'already-current', 'waiting', 'busy', 'failed'].map((s) => at(s, 'catch-up')), [0, 0, 0, 0, 1]);
  assert.equal(at('added', 'song', { verified: false }), 3);
  assert.equal(at('already-current', 'catch-up', { verified: false }), 3);
});

test('--dry-run plans without running or writing anything', async () => {
  const deps = fakeDeps({ ready: { 6504: R(6504) }, pending: 0 });
  const { line, code } = await daily({ catchUp: true, dryRun: true }, deps);
  assert.equal(code, 0);
  assert.deepEqual([line.status, line.songId, line.steps], ['dry-run', 6504, ['wall-add --song-id 6504', 'r2-sync, if anything is queued']]);
  assert.deepEqual(line.checks.map((c) => c.n), [6504, 6505]);
  assert.deepEqual(deps.calls, []);
  assert.equal(fs.existsSync(path.join(deps.dir, 'daily')), false);
  assert.equal(fs.existsSync(path.join(deps.dir, 'daily.lock')), false);
});

test('no wall yet is a failure, exit 1', async () => {
  const { line, code } = await daily({ catchUp: true }, fakeDeps({ songCount: 0 }));
  assert.deepEqual([code, line.status], [1, 'failed']);
  assert.match(line.error, /no wall yet/);
});

// ---- Lock ----

test('a second run finds the lock held: busy, exit 5 for --song-id (0 for catch-up), nothing run or written', async () => {
  const deps = fakeDeps({ ready: { 6504: R(6504) }, wallAdd: added(6504) });
  const held = await acquireLock(path.join(deps.dir, 'daily.lock'), { label: 'daily --catch-up' });
  deps.lock = () => acquireLock(path.join(deps.dir, 'daily.lock'), { waitMs: 300, pollMs: 50 });
  const t0 = Date.now();
  const { line, code } = await daily({ songId: 6504 }, deps);
  assert.ok(Date.now() - t0 >= 250, 'waited briefly first');
  assert.equal(code, 5);
  assert.deepEqual([line.status, line.songId], ['busy', 6504]);
  assert.match(line.reason, /daily --catch-up, pid \d+/);
  assert.deepEqual(deps.calls, []);
  assert.equal(fs.existsSync(path.join(deps.dir, 'daily')), false);
  deps.lock = () => acquireLock(path.join(deps.dir, 'daily.lock'), { waitMs: 0 });
  assert.deepEqual(await daily({ catchUp: true }, deps).then((r) => [r.code, r.line.status]), [0, 'busy']);
  held.release();
  assert.equal((await daily({ songId: 6504 }, deps)).line.status, 'added');
});

test('a lock left by a dead process is taken over', async () => {
  const file = path.join(fresh('lock'), 'daily.lock');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(file, JSON.stringify({ pid: dead, cmd: 'daily', at: new Date().toISOString(), token: 'x' }));
  const lock = await acquireLock(file, { waitMs: 0 });
  assert.equal(lock.busy, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  lock.release();
  assert.equal(fs.existsSync(file), false);
  // A live holder past staleMs counts as stale too.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, cmd: 'daily', at: new Date(Date.now() - 60000).toISOString(), token: 'y' }));
  const again = await acquireLock(file, { staleMs: 1000 });
  assert.equal(again.busy, false);
  again.release();
});

// ---- Real child processes ----

test('runNode: same node binary first on a bare PATH, last JSON line, stderr tail, exit code', async () => {
  const script = write(path.join(fresh('child'), 'child.mjs'), [
    "console.log('not json');",
    "console.log(JSON.stringify({ step: 1 }));",
    "console.log(JSON.stringify({ status: 'added', path0: process.env.PATH.split(':')[0], cwd: process.cwd() }));",
    "console.error('warning: something');",
    'process.exitCode = 3;',
  ].join('\n'));
  const r = await runNode(script, ['--json'], { env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, cwd: tmp, timeoutMs: 10000 });
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.json.status, 'added');
  assert.equal(r.json.path0, path.dirname(process.execPath));
  assert.equal(fs.realpathSync(r.json.cwd), fs.realpathSync(tmp));
  assert.equal(r.stderrTail, 'warning: something');
});

test('runNode: a child past its timeout is killed and reported', async () => {
  const script = write(path.join(fresh('child'), 'hang.mjs'), 'setInterval(() => {}, 1000);');
  const r = await runNode(script, [], { timeoutMs: 200, killGraceMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.json, null);
});
