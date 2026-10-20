// The offline archive audit: scan every folder once, check each song's pieces, then decode or
// probe a sample of the local files (all of them with deep). Read-only; placeholders are never opened.
import os from 'node:os';
import path from 'node:path';
import { dateOf, songOn, youtubeId } from '../catalog.mjs';
import { FOLDERS, PIECES, DEPENDS, ERA, LIMITS, SAMPLE, RECENT } from './config.mjs';
import { scanSongFiles, scanOutputDirs, statOne } from './scan.mjs';
import { fileStatus } from './status.mjs';
import { findCatalog, loadCatalog, loadRepairCandidates, loadJsonl } from './sources.mjs';
import { loadYouTubeCache } from './youtube.mjs';
import { masterCells } from './master.mjs';
import { imageStats, probe } from './media.mjs';
import { duplicateGroups, duplicateIndex } from './dupes.mjs';
import { mapLimit } from './limit.mjs';
import * as P from './pieces.mjs';

const JSON_NAME = /^0*(\d+)\.json$/i;
const PATTERNS = { thumb: /^0*(\d+)_standardized\.jpe?g$/i, meta: JSON_NAME };
const IMAGE = new Set(['still', 'thumb', 'gif', 'art']);
const MEDIA = new Set(['wav', 'mp3', 'video']);

// The pieces to check, plus what they depend on. Online pieces only when asked for.
export function expandPieces(list, { online = false } = {}) {
  const all = Object.keys(PIECES).filter((p) => online || !PIECES[p].online);
  const unknown = (list || []).filter((p) => !all.includes(p));
  if (unknown.length) throw new Error(`unknown piece ${unknown.join(', ')}; pieces are ${all.join(', ')}`);
  const want = new Set(list?.length ? list : all);
  const add = (p) => (DEPENDS[p] || []).forEach((d) => !want.has(d) && (want.add(d), add(d)));
  [...want].forEach(add);
  return Object.keys(PIECES).filter((p) => want.has(p));
}

const tryPath = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export const localToday = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// env: {archiveDir, toolkitDir, toolkitOutputDir, legacyMaster, legacyJsonl} (pipeline/lib/env.mjs).
export async function runAudit(opts, env, log = () => {}) {
  const started = Date.now();
  const timings = {};
  let last = started;
  const lap = (name) => {
    const now = Date.now();
    timings[name] = now - last;
    timings.total = now - started;
    last = now;
  };
  const pieces = expandPieces(opts.pieces, { online: opts.online });
  const has = (p) => pieces.includes(p);

  const roots = {
    SONGADAY_ARCHIVE_DIR: env.archiveDir(),
    SONGADAY_TOOLKIT_DIR: tryPath(env.toolkitDir),
    SONGADAY_TOOLKIT_OUTPUT_DIR: tryPath(env.toolkitOutputDir), // art, metadata.json, CIDs, the description audit
    SONGADAY_LEGACY_MASTER: tryPath(env.legacyMaster),
    SONGADAY_LEGACY_JSONL: tryPath(env.legacyJsonl),
  };
  const archive = roots.SONGADAY_ARCHIVE_DIR;

  // 1. One scan per folder.
  log('scanning folders');
  const scans = {};
  const scanKeys = ['wav', ...pieces.filter((p) => FOLDERS[p] && p !== 'wav' && p !== 'meta')];
  if (has('meta')) scanKeys.push('meta');
  await Promise.all(scanKeys.map(async (k) => {
    scans[k] = await scanSongFiles(path.join(archive, FOLDERS[k]), PATTERNS[k] ? { pattern: PATTERNS[k] } : {});
  }));
  const output = has('meta') || has('art') ? await scanOutputDirs(roots.SONGADAY_TOOLKIT_OUTPUT_DIR) : new Map();
  const allMeta = has('meta') && roots.SONGADAY_TOOLKIT_DIR
    ? await scanSongFiles(path.join(roots.SONGADAY_TOOLKIT_DIR, 'all-metadata'), { pattern: JSON_NAME })
    : null;
  lap('scan');

  // 2. Which songs exist: the highest WAV, cross-checked against the date.
  const wavNs = [...scans.wav.byN.entries()].filter(([, rs]) => rs.some((r) => r.ext === 'wav')).map(([n]) => n);
  const highest = wavNs.length ? Math.max(...wavNs) : 0;
  const today = localToday(opts.now);
  const todayN = songOn(today);
  const from = Math.max(1, opts.from ?? 1);
  const to = opts.to ?? highest;

  // 3. Local catalog and metadata sources.
  log('reading local catalog and metadata');
  const catalogFile = has('catalog') || has('youtube') || has('meta') || has('wav') ? findCatalog(roots.SONGADAY_TOOLKIT_OUTPUT_DIR, opts.catalog) : null;
  const catalog = catalogFile ? loadCatalog(catalogFile) : null;
  const auditDir = catalogFile && path.dirname(catalogFile);
  const ytCache = has('youtube') && auditDir ? loadYouTubeCache(path.join(auditDir, 'youtube-api-cache.json')) : null;
  const repair = has('youtube') && auditDir ? loadRepairCandidates(path.join(auditDir, 'youtube-repair-candidates.json')) : new Map();
  const jsonlStat = has('meta') ? await statOne(roots.SONGADAY_LEGACY_JSONL) : null;
  const jsonl = jsonlStat && fileStatus(jsonlStat) === 'ok' ? loadJsonl(jsonlStat.path) : { songs: new Map(), bad: [] };
  const idUse = new Map();
  for (const row of catalog?.songs.values() || []) {
    const id = youtubeId(row.youtubeUrl || row.videoId);
    if (!id) continue;
    if (!idUse.has(id)) idUse.set(id, []);
    idUse.get(id).push(row.n);
  }
  lap('sources');

  // 4. The old master, decoded once.
  let master = null;
  if (has('cell')) {
    const st = await statOne(roots.SONGADAY_LEGACY_MASTER);
    const status = fileStatus(st);
    master = { status, path: st?.path, size: st?.size, detail: status === 'ok' ? '' : `legacy master is ${status}` };
    if (status === 'ok') {
      log('measuring the old master’s cells');
      try {
        Object.assign(master, await masterCells(st.path));
      } catch (e) {
        Object.assign(master, { status: 'bad', detail: `legacy master: ${e.message}` });
      }
    }
    lap('master');
  }
  const masterCount = master?.count ?? ERA.masterSongs;

  const ctx = { catalog, ytCache, repair, idUse, output, allMeta, archMeta: scans.meta, jsonl: jsonl.songs };

  // 5. Per-song checks that need only the scans and small JSON files.
  log(`checking songs ${from}-${to}`);
  const songs = [];
  for (let n = from; n <= to; n++) {
    const p = {};
    if (has('catalog')) p.catalog = P.catalogPiece(n, catalog);
    if (has('meta')) p.meta = P.metaPiece(n, ctx);
    if (has('youtube')) p.youtube = P.youtubePiece(n, ctx, p.meta);
    for (const k of ['wav', 'mp3', 'video', 'gif']) if (has(k)) p[k] = P.filePiece(n, scans[k], k);
    if (has('still')) p.still = P.filePiece(n, scans.still, 'still', { from: ERA.stillFrom });
    if (has('thumb')) p.thumb = P.filePiece(n, scans.thumb, 'thumb', { to: ERA.thumbTo });
    if (has('cell')) p.cell = P.cellPiece(n, master);
    if (has('art')) p.art = P.artPiece(n, ctx);
    if (has('wav') && p.wav.file && p.wav.status === 'ok' && p.wav.file.size < LIMITS.tinyWav) {
      p.wav.status = 'suspect';
      p.wav.detail = [p.wav.detail, `only ${(p.wav.file.size / 1e6).toFixed(1)} MB`].filter(Boolean).join('; ');
    }
    const title = catalog?.songs.get(n)?.title || p.meta?.name || '';
    songs.push({ n, date: dateOf(n), title, p });
  }
  lap('songs');

  // 6. Byte-identical files across songs (whole folders, so a twin outside the range still counts).
  log('looking for byte-identical files across songs');
  const dupGroups = {};
  const recsOf = (scan) => (scan ? [...scan.byN.values()].flat() : []);
  const artRecs = [...output.values()].flatMap((m) => [...m.values()].filter((f) => /^image_\d+\.(png|jpe?g)$/i.test(f.name) || f.name === 'thumbnail.jpg'));
  for (const [k, recs] of [...['wav', 'mp3', 'video', 'gif', 'still', 'thumb'].map((k) => [k, recsOf(scans[k])]), ['art', artRecs]]) {
    if (!has(k)) continue;
    dupGroups[k] = await duplicateGroups(recs);
    const idx = duplicateIndex(dupGroups[k]);
    for (const s of songs) if (idx.has(s.n)) P.applyDuplicate(s.p[k], idx.get(s.n));
  }
  lap('dupes');

  // 7. Decode and probe: the gallery's own inputs, a sample of the rest, everything with deep.
  const step = Math.max(1, Math.round(1 / (opts.sample ?? SAMPLE)));
  const dupSongs = new Set(Object.values(dupGroups).flat().flatMap((g) => g.songs));
  const critical = {
    still: (n) => n > masterCount,
    gif: (n) => n > ERA.azureGifTo,
    art: () => true,
    thumb: (n, f) => f.size < LIMITS.tinyThumb,
    wav: (n, f) => f.size < LIMITS.tinyWav || dupSongs.has(n) || dupSongs.has(n - 1) || dupSongs.has(n + 1),
  };
  const tasks = [];
  for (const s of songs) {
    for (const [k, r] of Object.entries(s.p)) {
      if (!(IMAGE.has(k) || MEDIA.has(k)) || !r.file || fileStatus(r.file) !== 'ok') continue;
      const pick = opts.deep || s.n % step === 0 || s.n > to - RECENT || critical[k]?.(s.n, r.file);
      if (pick) tasks.push({ s, k, r });
    }
  }
  const counts = tasks.reduce((m, t) => ((m[t.k] = (m[t.k] || 0) + 1), m), {});
  log(`decoding/probing ${tasks.length} files (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  let done = 0;
  const results = await mapLimit(tasks, opts.concurrency ?? Math.min(8, os.availableParallelism()), async (t) => {
    let out;
    try {
      out = { value: IMAGE.has(t.k) ? await imageStats(t.r.file.path) : await probe(t.r.file.path) };
    } catch (error) {
      out = { error };
    }
    if (++done % 250 === 0) log(`  ${done}/${tasks.length}`);
    return out;
  });
  const order = (t) => (t.k === 'mp3' ? 1 : 0); // MP3s compare against the WAV's duration
  tasks.map((t, i) => ({ t, res: results[i] })).sort((a, b) => order(a.t) - order(b.t)).forEach(({ t, res }) => {
    if (IMAGE.has(t.k)) P.applyImage(t.k, t.r, res.value, res.error);
    else P.applyProbe(t.k, t.r, res.value, res.error, { sheetSeconds: P.sheetSeconds(ctx, t.s.n), wavSeconds: t.s.p.wav?.duration });
  });
  P.crossCheck(songs, ctx);
  lap('decode');

  // 8. The wall's cell source per song.
  if (has('mosaic')) for (const s of songs) s.p.mosaic = P.mosaicPiece(s.p);

  return {
    opts: { ...opts, pieces },
    roots,
    today,
    todayN,
    highest,
    from,
    to,
    pieces,
    scans,
    allMeta,
    output,
    catalog,
    ytCache,
    jsonl,
    master,
    masterCount,
    dupGroups,
    songs,
    decoded: counts,
    sampleStep: step,
    timings,
  };
}
