// The daily step behind pipeline/daily.mjs: decide which songs go up, run wall-add and r2-sync as
// child processes, and record the result for the toolkit in STATE/daily/<n>.json and last.json.
//
// Songs past the wall go up in order, in both modes, each once its inputs are ready: a real still
// (EverySongADayPNG/<n>.jpg or .png, not empty, not a Dropbox placeholder), an initial-metadata.json
// that parses and names the song and its date, and a YouTube URL in it, or a still at least 2 hours
// old (the upload failed or was skipped). A song still not ready a day later is overdue and goes up
// anyway, with wall-add's fallbacks (catchUpPlan), so one song can't hold up the wall for good.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CACHE, REPO, STATE } from './env.mjs';
import { RANK, STILLS_DIR, localFiles } from './cells.mjs';
import { cleanText, dateOf, youtubeId } from './catalog.mjs';
import { AZURE, GIF_DIR, gifHeader, readHead } from './gifs.mjs';
import { writeAtomic } from './manifest.mjs';
import { QUEUE } from './sync.mjs';

export const DAILY_LOCK = path.join(CACHE, 'daily.lock');
export const LOCK_STALE_MS = 30 * 60 * 1000; // longer than both child timeouts together
export const YOUTUBE_GRACE_MS = 2 * 60 * 60 * 1000;
export const FALLBACK_AFTER_MS = 24 * 60 * 60 * 1000;
export const TIMEOUTS = Object.freeze({ 'wall-add': 5 * 60 * 1000, 'r2-sync': 10 * 60 * 1000 });
export const statusDir = (state = STATE) => path.join(state, 'daily');
const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Inputs ----

const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

// The toolkit rewrites initial-metadata.json in place, so a read can catch it half written.
async function readMeta(file, { attempts, retryMs }) {
  for (let i = 1; ; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object') return j;
    } catch {}
    if (i >= attempts) return null;
    await sleep(retryMs);
  }
}

// { n, ready, seen, overdue, reason?, youtube? }. `seen`: some input for n exists, usable or not.
// `overdue`: FALLBACK_AFTER_MS has passed since its first input turned up or, with none, since its
// date ended.
export async function checkInputs(n, { archive, outputDirs = [], now = Date.now(), isLocal = localFiles, attempts = 3, retryMs = 1000 }) {
  const stills = ['jpg', 'png'].map((ext) => path.join(archive, STILLS_DIR, `${n}.${ext}`));
  const metas = [...new Set(outputDirs.map((d) => path.join(d, String(n), 'initial-metadata.json')))];
  const exists = (files) => files.some((f) => mtimeOf(f) != null);
  const times = [...stills, ...metas].map(mtimeOf).filter((t) => t != null);
  const seen = times.length > 0;
  const overdue = now - (seen ? Math.min(...times) : Date.parse(dateOf(n)) + DAY_MS) > FALLBACK_AFTER_MS;
  const wait = (reason) => ({ n, ready: false, seen, overdue, reason });
  const local = isLocal([...stills, ...metas]);

  const still = stills.find((f) => local.has(f));
  if (!still) return wait(exists(stills) ? 'still is empty or online-only' : 'no still yet');
  const files = metas.filter((f) => local.has(f));
  if (!files.length) return wait(exists(metas) ? 'initial-metadata.json is empty or online-only' : 'no initial-metadata.json yet');
  // Like wall-add's toolkitRecords: the first file that parses and names this song and its date.
  let json = null, why = null;
  for (const file of files) {
    const j = await readMeta(file, { attempts, retryMs });
    const date = j && cleanText(j.date);
    if (!j) why ??= 'initial-metadata.json does not parse (being rewritten?)';
    else if (j.songNbr != null && Number(j.songNbr) !== n) why ??= `initial-metadata.json is for #${j.songNbr}`;
    else if (date && date !== dateOf(n)) why ??= `initial-metadata.json has date ${date}, not ${dateOf(n)}`;
    else {
      json = j;
      break;
    }
  }
  if (!json) return wait(why);
  const youtube = Boolean(youtubeId(json.youtubeUrl || json.videoUrl));
  const age = now - fs.statSync(still).mtimeMs;
  if (!youtube && age < YOUTUBE_GRACE_MS) return wait(`no YouTube URL yet (still is ${Math.max(0, Math.round(age / 60000))} min old; goes up without one at 2 h)`);
  return { n, ready: true, seen, overdue, youtube };
}

// The plan for the checks of songCount+1, songCount+2, ... in order, the same in both modes: up to the
// newest song that is ready (or seen and overdue), cut short before the first one under it that is
// neither ready nor overdue (the wall has no holes). An overdue song that was never seen goes up only
// to fill a hole under a later one. `fallback` lists the songs going up without being ready.
export function catchUpPlan(checks) {
  const go = (c) => c.ready || c.overdue;
  const r = checks.findLastIndex((c) => c.ready || (c.seen && c.overdue));
  if (r < 0) {
    const w = checks.find((c) => c.seen);
    return w ? { action: 'wait', songId: w.n, reason: w.reason } : { action: 'none' };
  }
  const f = checks.findIndex((c) => !go(c));
  if (f === 0) return { action: 'wait', songId: checks[0].n, reason: checks[0].reason, newestReady: checks[r].n };
  const end = f > 0 && f < r ? f - 1 : r;
  const take = checks.slice(0, end + 1);
  const fallback = take.filter((c) => !c.ready).map((c) => c.n);
  return {
    action: 'add',
    songId: take.at(-1).n,
    songs: take.map((c) => c.n),
    ...(fallback.length ? { fallback } : {}),
    ...(end < r ? { blockedBy: { n: checks[f].n, reason: checks[f].reason } } : {}),
  };
}

// GIFs that turned up after their song went on the wall without one (noGif past the Azure copy),
// and a song with a real still to run wall-add on: its already-current path publishes them. A GIF
// already in PUBLISH/gifs (`published`: gifRevs) would be a no-op there, so it's listed in `stale`
// instead: the manifest needs rewriting (wall:manifest) and an upload.
export function gifCatchUp({ noGif = [], songCount, archive, published = new Map(), kindOf = () => null, isLocal = localFiles }) {
  const late = noGif.filter((m) => m > AZURE.to && m <= songCount);
  const stale = late.filter((m) => published.has(m));
  const files = new Map(late.filter((m) => !published.has(m)).map((m) => [path.join(archive, GIF_DIR, `${m}.gif`), m]));
  const local = files.size ? isLocal([...files.keys()]) : new Set();
  const gifs = [];
  for (const [file, m] of files) {
    try {
      if (local.has(file) && gifHeader(readHead(file))) gifs.push(m);
    } catch {}
  }
  if (!gifs.length) return stale.length ? { gifs, song: null, stale } : null;
  const song = [...gifs].sort((a, b) => b - a).concat(songCount).find((m) => RANK[kindOf(m)] === 0) ?? null;
  return { gifs, song, ...(stale.length ? { stale } : {}) };
}

const queueLines = (state) => {
  try {
    return fs.readFileSync(path.join(state, QUEUE), 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
};

export const pendingCount = (state = STATE) => queueLines(state).length;

// The songs the queued uploads belong to (wall-add tags each line with its --song-id).
export function pendingSongs(state = STATE) {
  const songs = new Set();
  for (const line of queueLines(state)) {
    try {
      const n = JSON.parse(line).songId;
      if (Number.isInteger(n)) songs.add(n);
    } catch {}
  }
  return [...songs].sort((a, b) => a - b);
}

// ---- Child processes ----

const active = new Set();
export const killActive = (signal = 'SIGTERM') => {
  for (const c of active) c.kill(signal);
};

const lastJson = (text) => {
  for (const line of text.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
};

// Runs `node script ...args` on this same node binary (also first on the child's PATH, for wrangler's
// `#!/usr/bin/env node` under cron). Never rejects: { code, signal, timedOut, json, stderrTail, ms },
// json being the last JSON line on stdout. A timeout sends SIGTERM, then SIGKILL after killGraceMs.
export function runNode(script, args = [], { timeoutMs = 0, cwd = REPO, env = process.env, execPath = process.execPath, killGraceMs = 10000, tailBytes = 4000 } = {}) {
  const t0 = Date.now();
  const PATH = [path.dirname(execPath), env.PATH || '/usr/bin:/bin'].join(path.delimiter);
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, settled = false, kill = null;
    const child = spawn(execPath, [script, ...args], { cwd, env: { ...env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d) => {
      err = (err + d).slice(-tailBytes);
    });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs) : null;
    const done = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(kill);
      active.delete(child);
      resolve({ code, signal, timedOut, json: lastJson(out), stderrTail: (error ? error.message : err).trim(), ms: Date.now() - t0 });
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal));
  });
}

// ---- Lock ----

function lockHolder(file, staleMs) {
  let st, text;
  try {
    st = fs.statSync(file);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // released meanwhile
  }
  let held = {};
  try {
    held = JSON.parse(text) || {};
  } catch {}
  let alive = Number.isInteger(held.pid) && held.pid > 0;
  if (alive) {
    try {
      process.kill(held.pid, 0);
    } catch (err) {
      alive = err.code === 'EPERM';
    }
  }
  const at = Date.parse(held.at) || st.mtimeMs;
  return { ...held, ino: st.ino, text, stale: !alive || Date.now() - at > staleMs };
}

// Moves the judged lock aside and puts it back if it turns out another one replaced it meanwhile.
function breakLock(file, judged) {
  const aside = `${file}.stale-${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return;
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

// Like the wall lock (linked into place whole, names its pid), but stale only once its process is
// gone or after staleMs: a daily run can outlast the wall lock's 10 minutes. Waits up to waitMs, then
// returns { busy: true, holder } instead of throwing.
export async function acquireLock(file = DAILY_LOCK, { waitMs = 0, staleMs = LOCK_STALE_MS, label = 'daily', pollMs = 250 } = {}) {
  const until = Date.now() + waitMs;
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    const tmp = `${file}.new-${token}`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, cmd: label, at: new Date().toISOString(), token }));
    try {
      fs.linkSync(tmp, file);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const held = lockHolder(file, staleMs);
    if (!held) continue;
    if (held.stale) {
      breakLock(file, held);
      continue;
    }
    if (Date.now() >= until) return { busy: true, holder: held };
    await sleep(pollMs);
  }
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file);
    } catch {}
  };
  process.once('exit', release);
  return {
    busy: false,
    release: () => {
      release();
      process.off('exit', release);
    },
  };
}

// ---- The run ----

function why(name, r) {
  if (r.timedOut) return `${name} timed out after ${Math.round(r.ms / 1000)} s`;
  const lines = r.stderrTail.split('\n').map((l) => l.trim()).filter(Boolean);
  const msg = r.json?.error || r.json?.errors?.[0] || lines.findLast((l) => /^(\w*Error\b|error:)/i.test(l)) || lines.at(-1) || `exited with ${r.code ?? r.signal}`;
  return `${name}: ${msg}`;
}

function fail(out, name, r) {
  const stderr = r.stderrTail.split('\n').slice(-20).join('\n').slice(-2000);
  return Object.assign(out, { status: 'failed', error: why(name, r), ...(stderr ? { stderr } : {}) });
}

// deps: readWall() -> { songCount } | null, check(n) -> checkInputs result, today() -> today's song
// number, lateGifs(songCount) -> gifCatchUp result, pending() -> queued uploads, pendingSongs() ->
// the songs they belong to, run(name, args) -> runNode result for 'wall-add' or 'r2-sync'.
export async function runDaily({ songId = null, catchUp = false, dryRun = false }, deps) {
  const wall = deps.readWall();
  if (!wall) throw new Error('no wall yet: run npm run cells:import, then npm run wall:build');
  const S = wall.songCount;
  const out = { status: 'already-current', songId: catchUp ? null : songId, songCount: S, tilesWritten: 0, uploaded: 0 };
  const warn = (msg) => (out.warnings ||= []).push(msg);
  let run = null, fallback = false, late = null, checks = null;

  if (catchUp || songId > S) {
    // --song-id N plans like catch-up, only as far as N.
    checks = [];
    for (let m = S + 1; m <= (catchUp ? deps.today() + 1 : songId); m++) checks.push(await deps.check(m));
    const p = catchUpPlan(checks);
    if (p.action === 'add') {
      run = p.songId;
      const head = checks[p.songs.length - 1];
      fallback = !head.ready || Boolean(head.overdue);
      if (p.fallback) {
        out.fallback = p.fallback;
        for (const n of p.fallback) warn(`#${n} went up with wall-add's fallbacks after waiting a day: ${checks[n - S - 1].reason}`);
      }
    }
    if (catchUp) {
      if (p.action === 'add') Object.assign(out, { songId: p.songId }, p.blockedBy ? { blockedBy: p.blockedBy } : {});
      else if (p.action === 'wait') Object.assign(out, { status: 'waiting', songId: p.songId, reason: p.reason });
    } else if (run !== songId) {
      // N isn't going up yet, though a ready run of songs before it may.
      const next = checks[p.songs?.length ?? 0];
      Object.assign(out, { status: 'waiting', reason: next.n === songId ? next.reason : `#${next.n} isn't ready: ${next.reason}` });
      if (next.n !== songId) out.blockedBy = { n: next.n, reason: next.reason };
    }
  } else run = songId;

  if (catchUp && !run) {
    late = deps.lateGifs(S);
    if (late?.stale) warn(`GIFs for ${late.stale.join(', ')} are in the publish folder, but the manifest still lists them in noGif: run npm run wall:manifest, then npm run r2:sync -- --all`);
    if (late?.song) run = late.song;
    else if (late?.gifs.length) warn(`GIFs for ${late.gifs.join(', ')} turned up, but no song on the wall has a real still to run wall-add on`);
    if (!run) late = null;
  }
  // --song-id N waiting with nothing added: leave the queue to the next catch-up.
  const idle = () => !catchUp && out.status === 'waiting' && !out.added;

  if (dryRun) {
    const pending = deps.pending();
    const steps = [];
    if (run) steps.push(`wall-add --song-id ${run}${fallback ? ' --fallback' : ''}${late ? ` (late GIFs ${late.gifs.join(', ')})` : ''}`);
    if (run || (!idle() && pending)) steps.push(run ? 'r2-sync, if anything is queued' : `r2-sync (${pending} queued)`);
    return { ...out, status: 'dry-run', steps, pending, ...(checks ? { checks } : {}) };
  }

  if (run) {
    const r = await deps.run('wall-add', ['--song-id', String(run), '--json', ...(fallback ? ['--fallback'] : [])]);
    const j = r.json ?? {};
    out.wallAdd = j;
    if (r.code === 0 && (j.status === 'added' || j.status === 'already-current')) {
      out.tilesWritten = j.tilesWritten ?? 0;
      out.songCount = j.songCount ?? S;
      if (late) {
        if (j.lateGifs) out.lateGifs = j.lateGifs;
      } else {
        if (j.status === 'added') out.added = j.added ?? [run];
        if (out.status !== 'waiting') out.status = j.status;
      }
    } else if (r.code === 2 && late) {
      warn(`wall-add #${run} for late GIFs: ${j.error || 'input unavailable'}`);
    } else if (r.code === 2) {
      Object.assign(out, { status: 'waiting', reason: j.error || 'wall-add: input unavailable' });
    } else return fail(out, 'wall-add', r);
  }

  if (out.added || (!idle() && deps.pending() > 0)) {
    const songs = deps.pendingSongs();
    const r = await deps.run('r2-sync', ['--json']);
    out.sync = r.json ?? {};
    out.uploaded = r.json?.uploaded ?? 0;
    if (r.code !== 0 && r.code !== 3) return fail(out, 'r2-sync', r);
    if (r.code === 3) out.verified = false;
    if (songs.length) out.published = songs;
  }
  return out;
}

const HEAD = ['status', 'songId', 'songCount', 'tilesWritten', 'uploaded', 'ms', 'error'];

// 0 done, 1 failed, 3 published but the public check failed. --song-id N exits 4 while N is waiting
// and 5 when busy, since N isn't on the wall yet; catch-up exits 0 for both.
export const exitCode = (line) => {
  if (line.status === 'failed') return 1;
  if (line.mode === 'song' && (line.status === 'waiting' || line.status === 'busy')) return line.status === 'waiting' ? 4 : 5;
  return line.verified === false ? 3 : 0;
};

const readRecord = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const isLive = (rec) => Boolean(rec?.publishedAt) || rec?.status === 'added';

// STATE/daily/<n>.json for each song the line is about, and STATE/daily/last.json. A published song's
// record stays: a later run that finds it already there, waiting or failing only sets `lastRun`. The
// songs whose queued uploads this run published (`published`), and the songs their run added, are
// marked published.
export function writeStatus(line, dir = statusDir()) {
  const file = (n) => path.join(dir, `${n}.json`);
  const put = (n, rec) => writeAtomic(file(n), `${JSON.stringify(rec, null, 2)}\n`);
  const own = new Map((line.added ?? []).map((n) => [n, line.status === 'failed' ? 'failed' : 'added']));
  if (line.songId && !own.has(line.songId)) own.set(line.songId, line.status);

  for (const [n, status] of own) {
    const prev = readRecord(file(n));
    if (status !== 'added' && isLive(prev)) {
      const why = line.error || line.reason;
      put(n, { ...prev, lastRun: { status, at: line.at, mode: line.mode, ...(why ? { reason: why } : {}) } });
      continue;
    }
    const rec = { ...line, status, songId: n };
    if (status !== line.status) {
      delete rec.reason;
      delete rec.blockedBy;
    }
    if (status === 'added') rec.publishedAt = line.at;
    put(n, rec);
  }

  for (const head of line.published ?? []) {
    const prev = own.has(head) ? null : readRecord(file(head));
    if (!prev || isLive(prev)) continue;
    for (const n of new Set([...(prev.added ?? []), head])) {
      const rec = n === head ? prev : readRecord(file(n));
      if (!rec || isLive(rec) || own.has(n)) continue;
      const { error, stderr, reason, ...rest } = rec;
      put(n, {
        ...rest,
        status: rec.wallAdd?.status === 'already-current' ? 'already-current' : 'added',
        publishedAt: line.at,
        ...(line.verified === false ? { verified: false } : {}),
      });
    }
  }
  writeAtomic(path.join(dir, 'last.json'), `${JSON.stringify(line, null, 2)}\n`);
}

// The whole run under the daily lock: { line, code }. deps adds lock() -> acquireLock result and
// writeStatus(line). A busy run and a dry run write no status file.
export async function daily(opts, deps) {
  const t0 = Date.now();
  const mode = opts.catchUp ? 'catch-up' : 'song';
  const finish = (out) => {
    const line = {
      status: out.status,
      songId: out.songId ?? null,
      songCount: out.songCount ?? null,
      tilesWritten: out.tilesWritten ?? 0,
      uploaded: out.uploaded ?? 0,
      ms: Date.now() - t0,
      ...(out.error ? { error: out.error } : {}),
      mode,
      at: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(out)) if (!HEAD.includes(k)) line[k] = v;
    return line;
  };

  const lock = opts.dryRun ? null : await deps.lock();
  if (lock?.busy) {
    const h = lock.holder;
    const line = finish({ status: 'busy', songId: opts.songId ?? null, reason: `another run holds daily.lock: ${h.cmd ?? 'unknown'}, pid ${h.pid ?? '?'}, since ${h.at ?? '?'}` });
    return { line, code: exitCode(line) };
  }
  try {
    let out;
    try {
      out = await runDaily(opts, deps);
    } catch (err) {
      out = { status: 'failed', songId: opts.songId ?? null, error: err.message };
    }
    const line = finish(out);
    if (!opts.dryRun) {
      try {
        deps.writeStatus(line);
      } catch (err) {
        line.warnings = [...(line.warnings || []), `status file not written: ${err.message}`];
      }
    }
    return { line, code: exitCode(line) };
  } finally {
    lock?.release();
  }
}
