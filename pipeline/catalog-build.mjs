// npm run catalog:build [-- --d1=live|cache|off] [--d1-dir <rating app>] [--output-dir <dir>]... [--max <n>] [--prune]
//
// Builds the song catalog chunks into PUBLISH/meta/ and the chunk list into STATE/catalog.json,
// then writes a report to output/catalog-report.json. Read-only everywhere else: the only cloud
// call is one SELECT of song columns from D1, run through the rating app's wrangler login.
// D1 is the editorial source, so when it can't be read and there's no cached copy the build stops
// (exit 1) and leaves the published catalog alone; --d1=off builds without it on purpose.
// initial-metadata.json comes from SONGADAY_OUTPUT_DIR, metadata.json from the toolkit's output/.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CACHE, PUBLISH, REPO, STATE, isPlaceholder, legacyJsonl, outputDir, toolkitDir, toolkitOutputDir } from './lib/env.mjs';
import {
  CHUNK_SIZE, MULTI, SHARED_MAX, SOURCE_ORDER, d1SongsSql, dateOf, fromD1, isBoilerplate, isJunk, mergeSong, queryD1, readLegacy,
  readOutputDirs, pruneChunks, refile, sharedDescriptions, songOn, unifyCase, writeAtomic, writeCatalogState, writeChunks, youtubeId,
} from './lib/catalog.mjs';

const { values: args } = parseArgs({
  options: {
    d1: { type: 'string', default: 'live' },
    'd1-dir': { type: 'string' },
    'output-dir': { type: 'string', multiple: true, default: [] },
    max: { type: 'string' },
    prune: { type: 'boolean', default: false },
    report: { type: 'string', default: path.join(REPO, 'output/catalog-report.json') },
  },
});

const D1_CACHE = path.join(CACHE, 'sources/d1-songs.json');
const log = (...a) => console.log(...a);

async function loadD1() {
  if (args.d1 === 'off') return { rows: [], how: 'off' };
  const cached = () => {
    try {
      const c = JSON.parse(fs.readFileSync(D1_CACHE, 'utf8'));
      return { rows: c.rows, how: `cache from ${c.fetchedAt}` };
    } catch {
      return null;
    }
  };
  if (args.d1 === 'cache') return cached() || { rows: [], how: 'no cache' };
  const cwd = args['d1-dir'] || path.join(path.dirname(toolkitDir()), 'song-a-day-rating-app');
  const sql = d1SongsSql();
  try {
    if (!['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((f) => fs.existsSync(path.join(cwd, f)))) {
      throw new Error(`no wrangler config in ${cwd}`);
    }
    const rows = await queryD1(sql, { cwd });
    writeAtomic(D1_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), sql, rows }));
    return { rows, how: 'live' };
  } catch (err) {
    const why = String(err.stderr || err.message).split('\n').find((l) => /error|✘|login|auth/i.test(l)) || err.message;
    log(`D1 query failed: ${why.slice(0, 200)}`);
    const c = cached();
    return c ? { ...c, how: `${c.how} (live query failed)`, error: why.slice(0, 200) } : { rows: [], how: 'failed', error: why.slice(0, 200) };
  }
}

const top = (counts, k = 10) => [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, k);
const range = (m) => (m.size ? [Math.min(...m.keys()), Math.max(...m.keys())] : null);
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function main() {
  const today = songOn(new Date().toLocaleDateString('en-CA'));
  const max = Math.min(today, args.max ? Number(args.max) : Infinity);

  const d1 = await loadD1();
  if (d1.how === 'failed' || d1.how === 'no cache') {
    console.error(d1.how === 'failed'
      ? `D1 could not be read (${d1.error}), and there is no cached copy at ${D1_CACHE}.`
      : `--d1=cache, but there is no cached copy at ${D1_CACHE}.`);
    console.error('  Nothing was written; the published catalog stays as it is. Fix the wrangler login (in the rating app) and rerun,');
    console.error('  or pass --d1=off to build from the local sources alone on purpose.');
    process.exitCode = 1;
    return;
  }
  const sources = {
    d1: new Map(d1.rows.map((row) => [Number(row.id), fromD1(row)])),
    legacy: isPlaceholder(legacyJsonl()) ? new Map() : readLegacy(legacyJsonl()),
  };
  if (!sources.legacy.size) log(`legacy jsonl is online-only or empty, skipped: ${legacyJsonl()}`);
  const dirs = [...new Set([outputDir(), toolkitOutputDir(), ...args['output-dir']].map((d) => path.resolve(d)))];
  const out = readOutputDirs(dirs, isPlaceholder);
  sources.initial = out.initial;
  sources.metadata = out.metadata;

  const report = {
    builtAt: new Date().toISOString(),
    d1: d1.how, d1Error: d1.error || null,
    outputDirs: dirs.length, placeholdersSkipped: out.placeholders.length, unreadable: out.unreadable,
    sources: {}, refiled: [], dropped: [], gaps: [], dateMismatches: [], youtube: {}, titleConflicts: [], provenance: {}, traits: {},
    droppedDescriptions: [],
  };
  report.refiled = refile(sources, new Map([...sources.d1].map(([n, r]) => [n, r.t])));
  for (const [name, m] of Object.entries(sources)) {
    for (const n of m.keys()) if (n > max) { report.dropped.push({ src: name, n }); m.delete(n); }
    report.sources[name] = { songs: m.size, range: range(m) };
  }

  const songCount = Math.max(0, ...Object.values(sources).flatMap((m) => [...m.keys()]));
  // Stock NFT text, and any text more than SHARED_MAX songs share, says nothing about the song.
  const shared = sharedDescriptions(sources);
  const skipDescription = (text) => isBoilerplate(text) || shared.has(text);
  const songs = [], details = [];
  const prov = { t: new Map(), yt: new Map(), description: new Map() };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const ytBad = {};
  const traitSrc = {}, traitConflicts = {};
  let ytConflicts = 0;
  const ytConflictSample = [];

  for (let n = 1; n <= songCount; n++) {
    const recs = SOURCE_ORDER.map((k) => sources[k].get(n)).filter(Boolean);
    if (!recs.length) report.gaps.push(n);
    const { song, detail, descriptionSrc, droppedDescriptions } = mergeSong(n, recs, { skipDescription });
    songs.push(song);
    details.push(detail);
    if (droppedDescriptions.length) report.droppedDescriptions.push({ n, src: droppedDescriptions, replacedBy: descriptionSrc });

    for (const r of recs) {
      if (r.date && r.date !== song.d) report.dateMismatches.push({ n, src: r.src, date: r.date, expected: song.d });
      if (r.ytRaw && String(r.ytRaw).trim() && !youtubeId(r.ytRaw)) (ytBad[r.src] ||= []).push({ n, value: String(r.ytRaw).slice(0, 80) });
    }
    const ids = new Set(recs.map((r) => youtubeId(r.ytRaw)).filter(Boolean));
    if (ids.size > 1) {
      ytConflicts++;
      if (ytConflictSample.length < 15) ytConflictSample.push({ n, chosen: song.yt, ids: Object.fromEntries(recs.map((r) => [r.src, youtubeId(r.ytRaw)])) });
    }
    const titles = recs.filter((r) => r.t);
    if (new Set(titles.map((r) => norm(r.t))).size > 1) report.titleConflicts.push({ n, chosen: song.t, ...Object.fromEntries(titles.map((r) => [r.src, r.t])) });
    for (const name of Object.keys(song.a)) {
      if (name === 'Year') continue;
      const [best, ...rest] = recs.filter((r) => r.traits.has(name));
      bump(traitSrc[name] ||= new Map(), best.src);
      const other = rest.find((r) => r.src !== best.src);
      const key = (r) => r.traits.get(name).map((x) => x.toLowerCase()).sort().join('|');
      if (best.src === 'd1' && other && key(best) !== key(other)) {
        const c = (traitConflicts[name] ||= { count: 0, sample: [] });
        c.count++;
        if (c.sample.length < 8) c.sample.push({ n, d1: best.traits.get(name), [other.src]: other.traits.get(name) });
      }
    }
    bump(prov.t, (recs.find((r) => r.t && !isJunk(r.t)) || recs.find((r) => r.t))?.src || 'none');
    bump(prov.yt, recs.find((r) => youtubeId(r.ytRaw))?.src || 'none');
    bump(prov.description, descriptionSrc || 'none');
  }

  report.caseMerges = unifyCase(songs);
  report.youtube = {
    missing: songs.filter((s) => !s.yt).map((s) => s.n),
    malformedBySource: ytBad,
    conflicts: ytConflicts,
    conflictSample: ytConflictSample,
  };
  report.provenance = Object.fromEntries(Object.entries(prov).map(([k, m]) => [k, Object.fromEntries(m)]));
  report.noDescription = details.filter((d) => !d.description).map((d) => d.n);
  report.traitSources = Object.fromEntries(Object.entries(traitSrc).map(([k, m]) => [k, Object.fromEntries(m)]));
  report.traitConflicts = traitConflicts;

  const traitCounts = new Map();
  for (const s of songs) for (const [name, v] of Object.entries(s.a)) {
    const t = traitCounts.get(name) || traitCounts.set(name, { songs: 0, values: new Map() }).get(name);
    t.songs++;
    for (const x of [].concat(v)) t.values.set(x, (t.values.get(x) || 0) + 1);
  }
  for (const [name, t] of traitCounts) {
    report.traits[name] = { songs: t.songs, multi: MULTI.has(name), distinct: t.values.size, top: top(t.values) };
  }

  const written = writeChunks(songs, details, PUBLISH, CHUNK_SIZE);
  const { state, changed } = writeCatalogState(path.join(STATE, 'catalog.json'), { index: written.index, detail: written.detail, songCount });
  const pruned = args.prune ? pruneChunks(PUBLISH, [...written.index, ...written.detail]) : [];
  report.chunks = { written: written.written, pruned, bytes: written.bytes, stateChanged: changed, builtAt: state.builtAt };
  report.songCount = songCount;
  report.lastDate = dateOf(songCount);
  writeAtomic(args.report, `${JSON.stringify(report, null, 2)}\n`);

  log(`songs 1-${songCount} (${report.lastDate}); D1: ${d1.how}`);
  for (const [k, v] of Object.entries(report.sources)) log(`  ${k.padEnd(8)} ${String(v.songs).padStart(5)} songs  ${v.range ? v.range.join('-') : '-'}`);
  log(`  gaps (no source): ${report.gaps.length ? report.gaps.join(', ') : 'none'}; dropped future: ${report.dropped.length}`);
  log(`  refiled: ${report.refiled.map((r) => `${r.src} ${r.from}->${r.to ?? 'dropped'}`).join(', ') || 'none'}`);
  log(`  date mismatches left: ${report.dateMismatches.map((d) => `${d.src} ${d.n} says ${d.date}`).join(', ') || 'none'}; title conflicts: ${report.titleConflicts.length}`);
  log(`  youtube: ${report.youtube.missing.length} without a valid ID; malformed per source ${JSON.stringify(Object.fromEntries(Object.entries(ytBad).map(([k, v]) => [k, v.length])))}; ${ytConflicts} songs with differing IDs`);
  log(`  provenance ${JSON.stringify(report.provenance)}`);
  log(`  no description: ${report.noDescription.length}; stock or shared (> ${SHARED_MAX} songs) descriptions dropped: ${report.droppedDescriptions.length}${report.droppedDescriptions.length ? ` (${report.droppedDescriptions.map((d) => d.n).join(', ')})` : ''}`);
  log(`  D1 vs next source, songs whose trait differs: ${JSON.stringify(Object.fromEntries(Object.entries(traitConflicts).map(([k, c]) => [k, c.count])))}`);
  log('  traits:');
  for (const [name, t] of Object.entries(report.traits)) log(`    ${name.padEnd(12)} ${String(t.songs).padStart(5)} songs ${String(t.distinct).padStart(5)} values  ${t.top.slice(0, 5).map(([v, c]) => `${v} ${c}`).join(', ')}`);
  const sizes = Object.values(written.bytes);
  log(`  chunks: ${written.index.length} index + ${written.detail.length} detail, ${written.written.length} written, ${pruned.length} pruned, ${(sizes.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)} MB total`);
  log(`  state ${changed ? 'updated' : 'unchanged'}: ${path.join(STATE, 'catalog.json')}`);
  log(`  report: ${args.report}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
