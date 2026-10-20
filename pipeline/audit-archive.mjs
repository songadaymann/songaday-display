#!/usr/bin/env node
// Read-only audit of the Song A Day archive (spec: docs/research/04-song-archive.md §6).
// Offline by default: it stats every file, never opens a Dropbox placeholder, and decodes or
// probes a sample (everything with --deep). Reports go to output/audit/ (git-ignored).
import path from 'node:path';
import * as env from './lib/env.mjs';
import { USAGE, parseCli } from './lib/audit/args.mjs';
import { runAudit } from './lib/audit/audit.mjs';
import { writeReports } from './lib/audit/report.mjs';
import { formatBytes } from './lib/audit/estimate.mjs';
import { ONLINE_PIECES, planOnline, runOnline, mergeOnline, onlineEndpoints } from './lib/audit/online.mjs';

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  const log = opts.quiet ? () => {} : (m) => console.error(`[audit] ${m}`);

  const res = await runAudit(opts, env, log);

  const online = res.pieces.filter((p) => ONLINE_PIECES.includes(p));
  if (opts.online && online.length) {
    const plan = planOnline(res.songs, { endpoints: onlineEndpoints(), pieces: online });
    log(`online: ${plan.length} requests planned, budget ${opts.budget}`);
    const { results, used, skipped } = await runOnline(plan, { budget: opts.budget });
    mergeOnline(res.songs, results);
    for (const s of res.songs) for (const p of online) s.p[p] ||= { status: 'n/a', detail: 'not checked (budget)' };
    res.online = { planned: plan.length, used, skipped };
  }

  const out = path.resolve(opts.out || path.join(env.REPO, 'output/audit'));
  const { summary, gaps } = writeReports(res, out);

  const pad = (s, w) => String(s).padStart(w);
  console.log(`\nSongs ${summary.range.from}-${summary.range.to} (highest WAV #${summary.highestWav}; today is #${summary.todaySong}), ${summary.mode}`);
  console.log(`${'piece'.padEnd(8)} ${['ok', 'suspect', 'placeh.', 'missing', 'empty', 'bad', 'n/a'].map((h) => pad(h, 7)).join(' ')}`);
  for (const [k, c] of Object.entries(summary.pieces)) {
    console.log(`${k.padEnd(8)} ${[c.ok, c.suspect, c.placeholder, c.missing, c.empty, c.bad, c['n/a']].map((v) => pad(v, 7)).join(' ')}`);
  }
  const g = summary.offline.forGallery;
  const e = summary.offline.everything;
  console.log(`\nGaps: ${summary.gaps.total} (${Object.entries(summary.gaps.byPriority).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  console.log(`Songs missing a core piece: ${summary.songsWithMissingCorePiece.count}`);
  console.log(`Make available offline for the wall: ${g.files} files, ~${formatBytes(g.estBytes)}; everything online-only: ${e.files} files, ~${formatBytes(e.estBytes)}`);
  console.log(`Reports: ${out}/{summary.md,summary.json,status.csv,gaps.csv,songs.jsonl,mosaic-sources.json} (${(summary.timingsMs.total / 1000).toFixed(1)} s)`);

  if (opts.strict && gaps.some((x) => x.priority === 'gallery')) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`audit-archive: ${e.message}`);
  process.exitCode = 1;
});
