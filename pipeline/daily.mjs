// The daily step, for the toolkit's hook and for cron: put songs on the wall once their inputs are
// ready, and publish them. One run at a time (CACHE/daily.lock, apart from wall-add's own lock).
// wall-add and r2-sync run as child processes on this same node binary, so it works from cron with
// no TTY and a bare PATH.
//
//   node pipeline/daily.mjs --song-id N [--json] [--dry-run] [--wait 15]
//   node pipeline/daily.mjs --catch-up [--json] [--dry-run] [--wait 15]
//
// Both modes add the songs past the wall in order, each once it's ready, or overdue a day later with
// wall-add's fallbacks (pipeline/lib/daily.mjs), then r2-sync.
// --song-id N: up to N. If N or a song before it isn't ready, the run is 'waiting' (the songs before
// the first one that isn't ready still go up). N already on the wall is passed straight to wall-add.
// --catch-up: up to the newest ready song. With nothing new it still publishes GIFs that turned up
// late and drains uploads left in the queue.
// --dry-run: says what it would do; runs nothing and writes nothing.
// A second run waits --wait seconds for the lock, then reports 'busy'.
// Prints one line (--json: {"status","songId","songCount","tilesWritten","uploaded","ms",...}) and
// saves it to STATE/daily/<n>.json and STATE/daily/last.json (busy and dry runs save nothing).
// status: added | already-current | waiting | busy | failed. Exit 0 done, 1 failed, 3 published but
// the public check failed; --song-id exits 4 when waiting and 5 when busy (catch-up exits 0).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PUBLISH, REPO, archiveDir, outputDir, toolkitOutputDir } from './lib/env.mjs';
import { loadCells, songOn } from './lib/cells.mjs';
import { CURRENT_KEY, readJson, readWallState } from './lib/manifest.mjs';
import { gifRevs } from './lib/gifs.mjs';
import { DAILY_LOCK, TIMEOUTS, acquireLock, checkInputs, daily, gifCatchUp, killActive, pendingCount, pendingSongs, runNode, writeStatus } from './lib/daily.mjs';

const USAGE = 'usage: daily --song-id N | --catch-up [--json] [--dry-run] [--wait 15]';
let args, opts, usageError = null;
try {
  ({ values: args } = parseArgs({
    options: {
      'song-id': { type: 'string' },
      'catch-up': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      wait: { type: 'string', default: '15' },
    },
  }));
  const n = args['song-id'] == null ? null : Number(args['song-id']);
  if (args['catch-up'] === (n !== null) || (n !== null && !(Number.isInteger(n) && n >= 1))) throw new Error(USAGE);
  opts = { songId: n, catchUp: args['catch-up'], dryRun: args['dry-run'] };
} catch (err) {
  usageError = err.message === USAGE ? USAGE : `${err.message}\n${USAGE}`;
  args ||= { json: process.argv.includes('--json') };
}

const outputDirs = () => {
  const dirs = [];
  for (const dir of [outputDir, toolkitOutputDir]) {
    try {
      dirs.push(path.resolve(dir()));
    } catch {}
  }
  return dirs;
};
let cells;
const deps = {
  lock: () => acquireLock(DAILY_LOCK, { waitMs: (Number(args.wait) || 0) * 1000, label: `daily ${opts.catchUp ? '--catch-up' : `--song-id ${opts.songId}`}` }),
  readWall: () => readWallState(),
  check: (n) => checkInputs(n, { archive: archiveDir(), outputDirs: outputDirs() }),
  today: () => songOn(),
  lateGifs: (songCount) => gifCatchUp({
    noGif: readJson(path.join(PUBLISH, CURRENT_KEY))?.noGif,
    songCount,
    archive: archiveDir(),
    published: gifRevs(PUBLISH),
    kindOf: (m) => (cells ||= loadCells())[m]?.kind,
  }),
  pending: () => pendingCount(),
  pendingSongs: () => pendingSongs(),
  run: (name, argv) => runNode(path.join(REPO, 'pipeline', `${name}.mjs`), argv, { timeoutMs: TIMEOUTS[name], cwd: REPO }),
  writeStatus: (line) => writeStatus(line),
};

for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.once(sig, () => {
    killActive('SIGTERM');
    process.exit(code); // the lock is released on exit
  });
}

let line, code;
if (usageError) {
  line = { status: 'failed', songId: null, songCount: null, tilesWritten: 0, uploaded: 0, ms: 0, error: usageError };
  code = 1;
} else {
  ({ line, code } = await daily(opts, deps));
}

if (args.json) console.log(JSON.stringify(line));
else {
  const who = line.mode === 'catch-up' ? `catch-up${line.songId ? ` #${line.songId}` : ''}` : `#${line.songId ?? '?'}`;
  const bits = [];
  if (line.added && (line.added.length > 1 || line.added[0] !== line.songId)) bits.push(`added ${line.added[0]}${line.added.length > 1 ? `-${line.added.at(-1)}` : ''}`);
  if (line.fallback) bits.push(`fallbacks for ${line.fallback.join(', ')}`);
  if (line.tilesWritten) bits.push(`${line.tilesWritten} tiles`);
  if (line.uploaded) bits.push(`${line.uploaded} uploaded`);
  if (line.lateGifs) bits.push(`late GIFs ${line.lateGifs.join(', ')}`);
  if (line.verified === false) bits.push('public check FAILED (npm run r2:check)');
  if (line.songCount) bits.push(`wall has ${line.songCount} songs`);
  if (line.steps) bits.push(line.steps.length ? `would run: ${line.steps.join('; ')}` : 'nothing to do');
  for (const w of line.warnings ?? []) bits.push(`warning: ${w}`);
  const why = line.error || line.reason;
  console.log(`${line.at ?? new Date().toISOString()} daily ${who}: ${line.status}${why ? ` (${why.replaceAll('\n', ' ')})` : ''}${bits.length ? `; ${bits.join(', ')}` : ''} in ${(line.ms / 1000).toFixed(1)} s`);
}
process.exitCode = code;
