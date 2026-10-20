// Output files: status.csv (song x piece), gaps.csv (the to-do list), summary.json, summary.md,
// songs.jsonl (every detail) and mosaic-sources.json (the cell source per song).
// Paths are written relative to their env var ($SONGADAY_ARCHIVE_DIR/…), never as /Users/… paths.
import fs from 'node:fs';
import path from 'node:path';
import { dateOf } from '../catalog.mjs';
import { FOLDERS, PIECES, ERA } from './config.mjs';
import { STATUSES, isProblem } from './status.mjs';
import { sizeEstimator, formatBytes } from './estimate.mjs';
import { PRIORITIES, priority, isGap, suggestFix } from './fixes.mjs';

export function relPath(file, roots) {
  if (!file) return '';
  let best = null;
  for (const [name, root] of Object.entries(roots)) {
    if (!root) continue;
    const r = path.resolve(root);
    if ((file === r || file.startsWith(r + path.sep)) && (!best || r.length > best.r.length)) best = { name, r };
  }
  return best ? `$${best.name}${file.slice(best.r.length)}` : file;
}

// [1,2,3,5,7,8] → "1-3, 5, 7-8"
export function ranges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(', ');
}

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';

const yearOf = (n) => Number(dateOf(n).slice(0, 4));

export function buildGaps(res) {
  const gaps = [];
  for (const s of res.songs) {
    for (const piece of res.pieces) {
      const r = s.p[piece];
      if (!r || !isGap(piece, r.status, s.n)) continue;
      gaps.push({
        n: s.n,
        date: s.date,
        title: s.title,
        piece,
        status: r.status,
        priority: priority(piece, r.status, s.n),
        detail: r.detail || '',
        path: relPath(r.file?.path, res.roots),
        fix: suggestFix(piece, r, s.n),
      });
    }
  }
  const pi = (p) => PRIORITIES.indexOf(p);
  const po = Object.keys(PIECES);
  return gaps.sort((a, b) => pi(a.priority) - pi(b.priority) || a.n - b.n || po.indexOf(a.piece) - po.indexOf(b.piece));
}

// Placeholders by folder, with an estimated download size. `pick` decides which ones count.
function offlineNeeds(res, pick) {
  const est = {};
  const byFolder = new Map();
  for (const s of res.songs) {
    for (const piece of res.pieces) {
      const r = s.p[piece];
      if (!r?.file?.placeholder || !pick(piece, s.n, r)) continue;
      const scanKey = FOLDERS[piece] ? piece : piece === 'mosaic' ? r.source : null;
      const key = path.dirname(r.file.path);
      if (!est[scanKey] && res.scans[scanKey]) {
        est[scanKey] = sizeEstimator([...res.scans[scanKey].byN.values()].flat().filter((f) => !f.placeholder), yearOf);
      }
      const bytes = est[scanKey] ? est[scanKey](s.n) : 0;
      const f = byFolder.get(key) || { folder: relPath(key, res.roots), files: 0, estBytes: 0, songs: [] };
      f.files++;
      f.estBytes += bytes;
      f.songs.push(s.n);
      byFolder.set(key, f);
    }
  }
  const folders = [...byFolder.values()].map((f) => ({ ...f, estBytes: Math.round(f.estBytes), songs: ranges(f.songs) }));
  return {
    files: folders.reduce((a, f) => a + f.files, 0),
    estBytes: folders.reduce((a, f) => a + f.estBytes, 0),
    folders: folders.sort((a, b) => b.estBytes - a.estBytes),
  };
}

function folderContinuity(res) {
  const out = {};
  for (const [k, scan] of Object.entries(res.scans)) {
    const ns = [...scan.byN.keys()].sort((a, b) => a - b);
    const lo = k === 'still' ? ERA.stillFrom : 1;
    const hi = Math.min(res.highest, k === 'thumb' ? ERA.thumbTo : Infinity);
    const have = new Set(ns);
    const holes = [];
    for (let n = lo; n <= hi; n++) if (!have.has(n)) holes.push(n);
    out[k] = {
      folder: relPath(scan.dir, res.roots),
      songs: ns.length,
      min: ns[0] ?? null,
      max: ns.at(-1) ?? null,
      expected: `${lo}-${hi}`,
      holes: ranges(holes),
      holeCount: holes.length,
      beyondHighest: ns.filter((n) => n > res.highest),
      otherFiles: scan.other.length,
    };
  }
  return out;
}

export function buildSummary(res, gaps, { finishedAt = new Date() } = {}) {
  const pieces = {};
  for (const piece of res.pieces) {
    const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let localFiles = 0, localBytes = 0;
    for (const s of res.songs) {
      const r = s.p[piece];
      if (!r) continue;
      c[r.status]++;
      if (r.file && !r.file.placeholder && r.file.size > 0 && piece !== 'mosaic') {
        localFiles++;
        localBytes += r.file.size;
      }
    }
    pieces[piece] = { label: PIECES[piece].label, ...c, localFiles, localBytes };
  }

  const core = res.pieces.filter((p) => PIECES[p].core);
  const missingCore = {};
  const anyMissing = new Set();
  for (const p of core) {
    const ns = res.songs.filter((s) => isProblem(s.p[p]?.status)).map((s) => s.n);
    if (ns.length) missingCore[p] = ranges(ns);
    ns.forEach((n) => anyMissing.add(n));
  }

  const yt = { missing: [], malformed: [], sheetBlank: [], notPublic: [], notEmbeddable: [], sharedId: [], disagree: [], malformedCopy: [], unknown: [] };
  for (const s of res.songs) {
    const r = s.p.youtube;
    if (!r) continue;
    if (r.status === 'missing') yt.missing.push(s.n);
    for (const f of r.flags || []) yt[f]?.push(s.n);
  }

  const cat = res.catalog;
  const catNs = cat ? [...cat.songs.keys()].sort((a, b) => a - b) : [];
  const catHoles = [];
  for (let n = 1; n <= (catNs.at(-1) || 0); n++) if (!cat.songs.has(n)) catHoles.push(n);

  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, gaps.filter((g) => g.priority === p).length]));
  const galleryNeed = (piece, n, r) => piece === 'mosaic' || (piece === 'gif' && n > ERA.azureGifTo);

  return {
    schema: 1,
    generatedAt: finishedAt.toISOString(),
    mode: res.opts.deep ? 'deep' : `sample (every ${res.sampleStep}th song, the newest songs and the gallery's inputs)`,
    online: res.online || false,
    range: { from: res.from, to: res.to },
    highestWav: res.highest,
    today: res.today,
    todaySong: res.todayN,
    behindDays: res.todayN - 1 - res.highest,
    pieces,
    gaps: { total: gaps.length, byPriority },
    songsWithMissingCorePiece: { count: anyMissing.size, songs: ranges([...anyMissing]), byPiece: missingCore },
    offline: {
      note: 'Placeholders carry no size; bytes are estimated from local files of the same piece and year.',
      forGallery: offlineNeeds(res, galleryNeed),
      everything: offlineNeeds(res, (piece) => piece !== 'mosaic'),
    },
    continuity: {
      catalog: cat && {
        file: relPath(cat.file, res.roots),
        asOfDate: cat.asOfDate,
        songs: cat.songs.size,
        max: catNs.at(-1) ?? null,
        holes: ranges(catHoles),
        duplicateNumbers: cat.duplicates,
        dateMismatches: res.songs.filter((s) => /sheet date/.test(s.p.catalog?.detail || '')).map((s) => s.n),
        sheetIssues: cat.issues,
      },
      folders: folderContinuity(res),
    },
    duplicates: Object.fromEntries(Object.entries(res.dupGroups).map(([k, g]) => [k, g.map((x) => ({ songs: x.songs, oldest: x.original, size: x.size, sha1: x.sha1 }))])),
    wavLengthMismatches: res.songs.filter((s) => s.p.wav?.lengthMismatch).length,
    wavLooksLikeNeighbour: res.songs
      .map((s) => ({ n: s.n, m: /matches the sheet's (#[\d, #]+)/.exec(s.p.wav?.detail || '') }))
      .filter((x) => x.m)
      .map((x) => ({ n: x.n, sheetOf: x.m[1].split(', ').map((v) => Number(v.slice(1))) })),
    darkCells: res.songs.filter((s) => s.p.cell?.status === 'suspect').map((s) => ({ n: s.n, luma: Math.round(s.p.cell.luma * 10) / 10 })),
    youtube: { ...Object.fromEntries(Object.entries(yt).map(([k, v]) => [k, v])), apiSnapshot: res.ytCache?.fetchedAt || null },
    master: res.master && { path: relPath(res.master.path, res.roots), status: res.master.status, size: res.master.size, width: res.master.width, height: res.master.height, songs: res.master.count, detail: res.master.detail || undefined },
    legacyJsonl: { songs: res.jsonl.songs.size, unparsedLines: res.jsonl.bad.length },
    decoded: res.decoded,
    timingsMs: res.timings,
  };
}

const fmtList = (ns, max = 40) => (Array.isArray(ns) ? (ns.length > max ? `${ranges(ns.slice(0, max))} … (${ns.length})` : ranges(ns)) : ns) || 'none';

export function renderMarkdown(sum, gaps) {
  const L = [];
  L.push(`# Archive audit, songs ${sum.range.from}-${sum.range.to}`, '');
  L.push(`Generated ${sum.generatedAt} (${sum.mode}, offline only). Highest WAV is #${sum.highestWav}; today (${sum.today}) is song #${sum.todaySong}.`, '');
  L.push('| Piece | ok | suspect | placeholder | missing | empty | bad | n/a | local |', '|---|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const [k, c] of Object.entries(sum.pieces)) {
    L.push(`| ${k} | ${c.ok} | ${c.suspect} | ${c.placeholder} | ${c.missing} | ${c.empty} | ${c.bad} | ${c['n/a']} | ${c.localFiles ? formatBytes(c.localBytes) : ''} |`);
  }
  L.push('', `**To-do list (gaps.csv):** ${sum.gaps.total} rows: ${Object.entries(sum.gaps.byPriority).map(([k, v]) => `${v} ${k}`).join(', ')}.`, '');
  const g = sum.offline.forGallery;
  L.push(`**Make available offline for the wall:** ${g.files} files, about ${formatBytes(g.estBytes)}.`);
  for (const f of g.folders) L.push(`- \`${f.folder}\`: ${f.files} files, about ${formatBytes(f.estBytes)} (${f.songs})`);
  const e = sum.offline.everything;
  L.push('', `**Everything online-only in range:** ${e.files} files, about ${formatBytes(e.estBytes)} (estimated).`);
  for (const f of e.folders) L.push(`- \`${f.folder}\`: ${f.files} files, about ${formatBytes(f.estBytes)}`);
  L.push('', `**Songs missing a core piece (missing, empty or bad):** ${sum.songsWithMissingCorePiece.count}.`);
  for (const [p, r] of Object.entries(sum.songsWithMissingCorePiece.byPiece)) L.push(`- ${p}: ${r}`);
  const mosaicGaps = gaps.filter((x) => x.piece === 'mosaic' && x.status !== 'suspect');
  if (mosaicGaps.length) L.push('', `**No usable wall image:** ${mosaicGaps.map((x) => `#${x.n} (${x.status})`).join(', ')}.`);
  const art = gaps.filter((x) => x.piece === 'mosaic' && /generated art/.test(x.detail)).map((x) => x.n);
  if (art.length) L.push(`**Wall image is toolkit art, needs approval:** ${ranges(art)}.`);
  if (sum.wavLooksLikeNeighbour.length) {
    L.push('', `**WAVs whose length is a neighbour's sheet length (swapped or shifted files?):** ${sum.wavLooksLikeNeighbour.map((x) => `#${x.n} ≈ #${x.sheetOf.join('/#')}`).join(', ')}. ${sum.wavLengthMismatches} WAVs differ from the sheet Length by more than 20 s in all (only probed files are compared).`);
  }
  if (sum.darkCells.length) L.push('', `**Dark cells in the old master (< 12/255):** ${sum.darkCells.length}: ${sum.darkCells.map((c) => `${c.n} (${c.luma})`).join(', ')}.`);
  const dup = Object.entries(sum.duplicates).filter(([, v]) => v.length);
  if (dup.length) {
    L.push('', '**Byte-identical files across songs:**');
    for (const [k, groups] of dup) L.push(`- ${k}: ${groups.map((x) => `[${x.songs.join(' = ')}${x.songs.length > 2 || x.oldest !== x.songs[0] ? `, oldest #${x.oldest}` : ''}]`).join(' ')}`);
  }
  const y = sum.youtube;
  L.push('', `**YouTube** (API snapshot ${y.apiSnapshot || 'not found'}):`);
  L.push(`- malformed in the sheet: ${fmtList(y.malformed)}; blank: ${fmtList([...y.missing, ...y.sheetBlank])}`);
  L.push(`- not public or removed: ${fmtList(y.notPublic)}; embedding disabled: ${fmtList(y.notEmbeddable)}`);
  L.push(`- one video for two songs: ${fmtList(y.sharedId)}; metadata disagrees with the sheet: ${fmtList(y.disagree)}; malformed in metadata only: ${fmtList(y.malformedCopy)}`);
  const c = sum.continuity.catalog;
  if (c) L.push('', `**Catalog** (\`${c.file}\`, as of ${c.asOfDate}): ${c.songs} rows, max #${c.max}, holes ${c.holes || 'none'}, duplicate numbers ${c.duplicateNumbers.length ? c.duplicateNumbers.join(', ') : 'none'}, date mismatches ${fmtList(c.dateMismatches)}.`);
  L.push('', '**Folder continuity:**');
  for (const [k, f] of Object.entries(sum.continuity.folders)) {
    L.push(`- ${k} \`${f.folder}\`: ${f.songs} songs, ${f.min}-${f.max}; holes in ${f.expected}: ${f.holeCount ? `${f.holeCount} (${f.holes.length > 200 ? `${f.holes.slice(0, 200)}…` : f.holes})` : 'none'}${f.beyondHighest.length ? `; beyond #${sum.highestWav}: ${f.beyondHighest.join(', ')}` : ''}`);
  }
  L.push('', `Decoded or probed: ${Object.entries(sum.decoded).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}. Took ${((sum.timingsMs.total ?? 0) / 1000).toFixed(1)} s.`, '');
  return L.join('\n');
}

export function mosaicSources(res) {
  const songs = {};
  for (const s of res.songs) {
    const m = s.p.mosaic;
    if (!m) continue;
    const src = m.source === 'master' ? null : s.p[m.source === 'card' ? 'none' : m.source];
    songs[s.n] = {
      source: m.source,
      status: m.status,
      path: m.source === 'master' ? relPath(res.master?.path, res.roots) : relPath(m.file?.path, res.roots),
      ...(src?.width ? { width: src.width, height: src.height, luma: src.luma } : {}),
      ...(m.source === 'master' ? { luma: Math.round((s.p.cell?.luma ?? 0) * 10) / 10 } : {}),
      ...(src?.sha1 ? { sha1: src.sha1 } : {}),
      ...(m.detail ? { detail: m.detail } : {}),
    };
  }
  return { schema: 1, generatedAt: new Date().toISOString(), masterSongs: res.masterCount, songs };
}

function songLine(s, roots) {
  const pieces = {};
  for (const [k, r] of Object.entries(s.p)) {
    const { file, youtube, ipfs, ...rest } = r;
    pieces[k] = { ...rest, ...(file ? { path: relPath(file.path, roots), size: file.size } : {}), ...(ipfs && Object.keys(ipfs).length ? { ipfs } : {}) };
  }
  return JSON.stringify({ n: s.n, date: s.date, title: s.title, pieces });
}

const writeAtomic = (file, text) => {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};

export function writeReports(res, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const gaps = buildGaps(res);
  const summary = buildSummary(res, gaps);
  const head = ['n', 'date', 'title', ...res.pieces, ...(res.pieces.includes('mosaic') ? ['mosaic_source'] : [])];
  const rows = res.songs.map((s) => [s.n, s.date, s.title, ...res.pieces.map((p) => s.p[p]?.status ?? ''), ...(s.p.mosaic ? [s.p.mosaic.source] : [])]);
  writeAtomic(path.join(outDir, 'status.csv'), toCsv([head, ...rows]));
  writeAtomic(path.join(outDir, 'gaps.csv'), toCsv([
    ['n', 'date', 'title', 'piece', 'status', 'priority', 'detail', 'path', 'suggested_fix'],
    ...gaps.map((g) => [g.n, g.date, g.title, g.piece, g.status, g.priority, g.detail, g.path, g.fix]),
  ]));
  writeAtomic(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeAtomic(path.join(outDir, 'summary.md'), renderMarkdown(summary, gaps));
  writeAtomic(path.join(outDir, 'songs.jsonl'), res.songs.map((s) => songLine(s, res.roots)).join('\n') + '\n');
  if (res.pieces.includes('mosaic')) writeAtomic(path.join(outDir, 'mosaic-sources.json'), `${JSON.stringify(mosaicSources(res), null, 1)}\n`);
  return { gaps, summary };
}
