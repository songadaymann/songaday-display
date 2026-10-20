// Cell masters: one lossless 480x270 WebP per song at CELLS/<n>.webp, described in STATE/cells.json
// as { "<n>": { source, kind, mtime, size, sha256, luma, flags, stillRev? } }. The public still
// PUBLISH/stills/<n>[-r<stillRev>].webp is the same cell at the tile codec's quality. A still key,
// like a tile key, never gets new bytes once written: a changed cell's still goes to the next rev.
//
// Sources, best first: the old mosaic master for songs 1..5852, cut on the cell grid with no
// resampling; the toolkit still EverySongADayPNG/<n>.jpg|png; the middle frame of the archive video
// (how the toolkit makes stills); the song's art output/<n>/image_<n>.png, or a frame of a video in
// output/<n>/; a generated card. Dropbox online-only placeholders are never opened, and a cell whose
// source has gone online-only is kept rather than downgraded. A cell made from an explicit file
// (wall-add --still) is pinned: only --force or a change to that file replaces it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { WALL, cellOf } from '../../shared/layout.mjs';
import { CACHE, CELLS, PUBLISH, STATE, archiveDir, legacyJsonl, legacyMaster, toolkitOutputDir } from './env.mjs';
import { CELL_BYTES, CODEC, pool } from './tiles.mjs';

const run = promisify(execFile);
const { cellW: CW, cellH: CH, cols: COLS } = WALL;
const RAW = { raw: { width: CW, height: CH, channels: 3 } };

export const LEGACY_LAST = 5852; // the old mosaic: 77 x 76 cells
export const DARK = 12; // mean luma (0-255) under which a cell is flagged 'dark'
export const ASPECT_SLACK = 0.02; // within 2% of 16:9 is cropped to fill
export const RANK = Object.freeze({ master: 0, file: 0, still: 0, frame: 1, art: 1, card: 2 });
export const STILLS_DIR = 'EverySongADayPNG';
export const VIDEO_DIR = 'Every Song A Day Video';
export const CELLS_JSON = path.join(STATE, 'cells.json');
export const CARD_BG = '#0b0b0f';

export const cellFile = (n, dir = CELLS) => path.join(dir, `${n}.webp`);
export const stillKey = (n, rev = 0) => `stills/${n}${rev ? `-r${rev}` : ''}.webp`;
export const cellKey = (n) => `cells/${CW}x${CH}/${n}.webp`; // key in the private archive bucket

// Song number for a UTC date (song 1 is 2009-01-01).
export const songOn = (ms = Date.now()) => Math.floor((ms - Date.UTC(2009, 0, 1)) / 86400000) + 1;

// ---- cells.json ----

export function loadCells(file = CELLS_JSON) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// One song per line, in song order.
export function saveCells(cells, file = CELLS_JSON) {
  const ns = Object.keys(cells).map(Number).sort((a, b) => a - b);
  const text = `{\n${ns.map((n) => ` "${n}": ${JSON.stringify(cells[n])}`).join(',\n')}\n}\n`;
  writeAtomic(file, text);
}

export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Highest N such that songs 1..N all have a cell.
export function contiguousCount(cells, dir = CELLS) {
  let n = 0;
  while (cells[n + 1] && fs.existsSync(cellFile(n + 1, dir))) n++;
  return n;
}

export const holes = (cells, upTo, dir = CELLS) =>
  Array.from({ length: upTo }, (_, i) => i + 1).filter((n) => !cells[n] || !fs.existsSync(cellFile(n, dir)));

export const flagged = (cells, flag) =>
  Object.keys(cells).map(Number).filter((n) => cells[n].flags?.includes(flag)).sort((a, b) => a - b);

// Flags every song whose cell bytes match another song's. Returns the groups.
export function markDuplicates(cells) {
  const bySha = new Map();
  for (const [n, e] of Object.entries(cells)) {
    if (!bySha.has(e.sha256)) bySha.set(e.sha256, []);
    bySha.get(e.sha256).push(Number(n));
  }
  for (const e of Object.values(cells)) {
    const flags = (e.flags || []).filter((f) => f !== 'duplicate');
    if (bySha.get(e.sha256).length > 1) flags.push('duplicate');
    e.flags = flags;
  }
  return [...bySha.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b));
}

// ---- Reading cells ----

export async function readCell(n, dir = CELLS) {
  let buf;
  try {
    buf = await fs.promises.readFile(cellFile(n, dir));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== CW || info.height !== CH) throw new Error(`cell ${n} is ${info.width}x${info.height}`);
  return data;
}

export const cellReader = (dir = CELLS) => (n) => readCell(n, dir);

// ---- Local files ----

// The files among these that can be read without downloading anything: regular, non-empty, with
// blocks on disk (a File Provider dataless file has none) and no com.dropbox.placeholder xattr.
export function localFiles(files) {
  const sized = [];
  for (const f of new Set(files)) {
    try {
      const st = fs.statSync(f);
      if (st.isFile() && st.size > 0 && st.blocks > 0) sized.push(f);
    } catch {}
  }
  const marked = new Set();
  for (let i = 0; i < sized.length; i += 400) {
    const batch = sized.slice(i, i + 400);
    let text = '';
    try {
      text = execFileSync('xattr', batch, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      text = err.stdout || ''; // exit 1 when some file has no xattrs; ENOENT off macOS
    }
    for (const line of text.split('\n')) {
      if (batch.length === 1 && line === 'com.dropbox.placeholder') marked.add(batch[0]);
      const m = line.match(/^(.*): com\.dropbox\.placeholder$/);
      if (m) marked.add(m[1]);
    }
  }
  return new Set(sized.filter((f) => !marked.has(f)));
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// ---- Pixels ----

export function meanLuma(raw) {
  let s = 0;
  for (let i = 0; i < raw.length; i += 3) s += 0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2];
  return s / (raw.length / 3);
}

function cropMaster(M, mw, n) {
  const { col, row } = cellOf(n);
  const out = Buffer.alloc(CELL_BYTES);
  for (let y = 0; y < CH; y++) {
    const s = ((row * CH + y) * mw + col * CW) * 3;
    M.copy(out, y * CW * 3, s, s + CW * 3);
  }
  return out;
}

// Any image to a cell. Within 2% of 16:9 it is cropped to fill; anything else (portrait phone video,
// odd-shaped art) is shown whole over a blurred, darkened copy of itself.
export async function fitCell(input) {
  const { data, info } = await sharp(input, { failOn: 'error' })
    .autoOrient().flatten({ background: '#000000' }).toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`decoded to ${info.channels} channels`);
  const src = () => sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } });
  const off = (info.width / info.height) / (CW / CH) - 1;
  if (Math.abs(off) <= ASPECT_SLACK) {
    return { raw: await src().resize(CW, CH, { fit: 'cover', kernel: 'lanczos3' }).raw().toBuffer(), flags: [], w: info.width, h: info.height };
  }
  const raw = await src().resize(CW, CH, { fit: 'cover', kernel: 'lanczos3' }).blur(12).linear(0.45, 0).raw().toBuffer();
  const fg = await src().resize(CW, CH, { fit: 'inside', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  const { width: fw, height: fh } = fg.info, left = (CW - fw) >> 1, top = (CH - fh) >> 1;
  for (let y = 0; y < fh; y++) fg.data.copy(raw, ((top + y) * CW + left) * 3, y * fw * 3, (y + 1) * fw * 3);
  return { raw, flags: [info.height > info.width ? 'portrait' : 'aspect'], w: info.width, h: info.height };
}

const xml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function wrap(text, max = 40, lines = 3) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = word.length > max ? `${word.slice(0, max - 1)}…` : word;
    if (line && `${line} ${w}`.length > max) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1].slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  }
  return out;
}

// The stand-in for a song with no image, in the old mosaic's card style: white type on near-black.
export function cardSvg(n, title) {
  const lines = title ? wrap(title) : [];
  const top = 135 - (lines.length * 24) / 2 - 4;
  const font = 'font-family="Helvetica Neue, Helvetica, Arial, sans-serif" text-anchor="middle"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">`
    + `<rect width="${CW}" height="${CH}" fill="${CARD_BG}"/>`
    + `<text x="${CW / 2}" y="${top}" ${font} font-weight="700" font-size="24" fill="#ffffff">Song A Day #${n}</text>`
    + lines.map((l, i) => `<text x="${CW / 2}" y="${top + 34 + i * 24}" ${font} font-size="17" fill="#c8c8cc">${xml(l)}</text>`).join('')
    + '</svg>';
}

export async function cardCell(n, title) {
  const { data, info } = await sharp(Buffer.from(cardSvg(n, title)), { density: 72 })
    .flatten({ background: CARD_BG }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.width !== CW || info.height !== CH || info.channels !== 3) throw new Error(`card rendered ${info.width}x${info.height}x${info.channels}`);
  return data;
}

// One frame from the middle of a video, as PNG bytes. Temp frames live under CACHE/tmp.
export async function videoFrame(file, tag = 'frame') {
  const ffprobe = process.env.FFPROBE || 'ffprobe', ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const mid = Math.max(0, (Number.parseFloat(stdout) || 0) / 2);
  const dir = path.join(CACHE, 'tmp');
  await fs.promises.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.png`);
  try {
    await run(ffmpeg, ['-v', 'error', '-ss', mid.toFixed(3), '-i', file, '-frames:v', '1', '-y', out]);
    return await fs.promises.readFile(out);
  } finally {
    await fs.promises.rm(out, { force: true });
  }
}

// ---- Titles (for cards) ----

function loadTitles() {
  const titles = new Map();
  try {
    const file = legacyJsonl();
    if (localFiles([file]).has(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const j = JSON.parse(line);
          if (Number(j.token_id) > 0 && j.name) titles.set(Number(j.token_id), String(j.name).trim());
        } catch {}
      }
    }
  } catch {}
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(STATE, 'catalog.json'), 'utf8'));
    for (const key of catalog.index || []) {
      const chunk = JSON.parse(fs.readFileSync(path.join(PUBLISH, key), 'utf8'));
      for (const s of chunk.songs || []) if (s.t) titles.set(s.n, s.t);
    }
  } catch {}
  return titles;
}

let titleMap;
export const titleOf = (n) => (titleMap ||= loadTitles()).get(n) ?? null;

// ---- Sources ----

function sourceRoots() {
  const roots = {};
  try {
    roots.archive = archiveDir();
  } catch {}
  try {
    roots.output = toolkitOutputDir();
  } catch {}
  return roots;
}

const idOf = (roots, root, file) => `${root}:${path.relative(roots[root], file)}`;

// The toolkit's output/<n>/ sometimes holds another song's upload (output/6210 is 6209's). Returns the
// songs whose folder is someone else's: its metadata.json names another token_id.
function foreignOutputs(songs, roots) {
  if (!roots.output) return new Set();
  const metas = new Map(songs.filter((n) => n > LEGACY_LAST).map((n) => [path.join(roots.output, String(n), 'metadata.json'), n]));
  const foreign = new Set();
  for (const file of localFiles([...metas.keys()])) {
    try {
      const id = Number(JSON.parse(fs.readFileSync(file, 'utf8')).token_id);
      if (id && id !== metas.get(file)) foreign.add(metas.get(file));
    } catch {}
  }
  return foreign;
}

// Every file that could make song n's cell, best first: [{ kind, source, file }].
function candidatesFor(n, roots, videos, foreign) {
  if (n <= LEGACY_LAST) {
    const file = legacyMaster();
    return [{ kind: 'master', source: `legacy:${path.basename(file)}`, file }];
  }
  const out = [];
  if (roots.archive) {
    for (const ext of ['jpg', 'png']) {
      const file = path.join(roots.archive, STILLS_DIR, `${n}.${ext}`);
      out.push({ kind: 'still', source: idOf(roots, 'archive', file), file });
    }
  }
  // The archive video's middle frame is what the toolkit's still would have been, so it beats the art.
  for (const file of videos.get(n) || []) out.push({ kind: 'frame', source: idOf(roots, 'archive', file), file });
  const dir = roots.output && path.join(roots.output, String(n));
  if (dir && !foreign.has(n) && fs.existsSync(dir)) {
    const file = path.join(dir, `image_${n}.png`);
    out.push({ kind: 'art', source: idOf(roots, 'output', file), file });
    for (const name of listDir(dir).filter((f) => /\.mp4$/i.test(f)).sort()) {
      const file = path.join(dir, name);
      out.push({ kind: 'frame', source: idOf(roots, 'output', file), file });
    }
  }
  return out;
}

function videoIndex(roots) {
  const videos = new Map();
  if (!roots.archive) return videos;
  const dir = path.join(roots.archive, VIDEO_DIR);
  for (const name of listDir(dir).sort()) {
    const m = name.match(/^(\d+)\.(mp4|mov|m4v)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!videos.has(n)) videos.set(n, []);
    videos.get(n).push(path.join(dir, name));
  }
  return videos;
}

// Newest song with any trace in the archive (a still, a video, or an output folder holding art or
// video), but never past today's number.
export function latestSong({ today = songOn() } = {}) {
  const roots = sourceRoots();
  let max = 0;
  const bump = (n) => {
    if (Number.isInteger(n) && n <= today && n > max) max = n;
  };
  if (roots.archive) {
    for (const name of listDir(path.join(roots.archive, STILLS_DIR))) bump(Number(name.match(/^(\d+)\.(jpe?g|png)$/i)?.[1]));
    for (const name of listDir(path.join(roots.archive, VIDEO_DIR))) bump(Number(name.match(/^(\d+)\.(mp4|mov|m4v)$/i)?.[1]));
  }
  if (roots.output) {
    for (const name of listDir(roots.output)) {
      if (!/^\d+$/.test(name) || Number(name) <= max) continue;
      if (listDir(path.join(roots.output, name)).some((f) => f === `image_${name}.png` || /\.mp4$/i.test(f))) bump(Number(name));
    }
  }
  return max;
}

// What to do with song n, given its existing entry and its best available source. `offline` means
// the entry's source is still one of the song's sources but can't be read now (online-only or gone).
export function decide(e, first, { cellExists, force = false, strict = false, offline = false }) {
  if (!first) return e && cellExists && (!strict || RANK[e.kind] === 0) ? 'keep' : 'unavailable';
  if (!e || !cellExists) return 'import';
  const same = first.source === e.source;
  // Never downgrade a cell whose better source just went offline, or a pinned one, not even with --force.
  if (!same && RANK[first.kind] > RANK[e.kind] && (offline || e.kind === 'file')) return 'keep';
  if (force) return 'import';
  if (same) {
    if (first.kind === 'card') return first.title === (e.title ?? null) ? 'skip' : 'import';
    return first.mtime === e.mtime && first.size === e.size ? 'skip' : 'import';
  }
  // A cell made from an explicit file (wall-add --still) is pinned: nothing else replaces it unasked.
  return e.kind === 'file' ? 'keep' : 'import';
}

// ---- Import ----

async function encodeCell(raw) {
  const master = await sharp(raw, RAW).webp({ lossless: true, effort: 4 }).toBuffer();
  const { quality, effort, smartSubsample } = CODEC;
  const still = await sharp(raw, RAW).webp({ quality, effort, smartSubsample }).toBuffer();
  return { master, still };
}

async function writeFileAtomic(file, buf) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, file);
}

const readOrNull = (file) => fs.promises.readFile(file).catch((err) => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

// Writes song n's public still at the first revision from `rev` that is free or already holds these
// bytes, and returns that revision. Published stills are cached for a year, so a key never changes.
export async function writeStill(n, still, rev = 0, publishDir = PUBLISH) {
  for (;;) {
    const file = path.join(publishDir, stillKey(n, rev));
    const old = await readOrNull(file);
    if (!old) {
      await writeFileAtomic(file, still);
      return rev;
    }
    if (old.equals(still)) return rev;
    rev++;
  }
}

// Import (or confirm) the cells for `songs`. Mutates `cells`, saves it to `cellsFile` unless that is
// null, and returns one result per song: { n, status, changed, kind, source, flags, error? } where
// status is imported | unchanged | kept | unavailable | failed.
//   files:  { n: path } explicit stills (wall-add --still), used instead of the archive
//   strict: songs that must come from a real still (or `files`), never a fallback
//   cardsBefore: cards are allowed only for songs before this number (today's song gets a day's grace)
export async function importSongs(songs, opts = {}) {
  const {
    cells = loadCells(),
    cellsFile = CELLS_JSON,
    cellsDir = CELLS,
    publishDir = PUBLISH,
    force = false,
    files = {},
    strict = new Set(),
    cardsBefore = songOn(),
    concurrency = os.availableParallelism(),
    log = () => {},
  } = opts;
  const roots = sourceRoots();
  const videos = songs.some((n) => n > LEGACY_LAST) ? videoIndex(roots) : new Map();
  const foreign = foreignOutputs(songs, roots);

  // Candidate files per song, then one placeholder check for all of them.
  const cands = new Map();
  for (const n of songs) {
    const explicit = files[n] && path.resolve(files[n]);
    cands.set(n, explicit ? [{ kind: 'file', source: `file:${explicit}`, file: explicit }] : candidatesFor(n, roots, videos, foreign));
  }
  const local = localFiles([...cands.values()].flat().map((c) => c.file));

  const plan = [];
  for (const n of songs) {
    const isStrict = strict.has(n) || Boolean(files[n]);
    let avail = cands.get(n).filter((c) => local.has(c.file));
    if (isStrict) avail = avail.filter((c) => RANK[c.kind] === 0);
    for (const c of avail) {
      const st = fs.statSync(c.file);
      Object.assign(c, { mtime: Math.round(st.mtimeMs), size: st.size });
    }
    if (!isStrict && n < cardsBefore) avail.push({ kind: 'card', source: 'card', file: null, mtime: 0, size: 0 });
    if (avail[0]?.kind === 'card') avail[0].title = titleOf(n);
    const e = cells[n];
    const cellExists = fs.existsSync(cellFile(n, cellsDir));
    const offline = Boolean(e) && cands.get(n).some((c) => c.source === e.source && !local.has(c.file));
    const action = decide(e, avail[0], { cellExists, force, strict: isStrict, offline });
    const stillMissing = cellExists && !fs.existsSync(path.join(publishDir, stillKey(n, e?.stillRev)));
    plan.push({ n, action, avail, e, stillMissing });
  }

  // The legacy master is decoded once, only if a song needs it.
  let M = null, mw = 0;
  const needMaster = plan.some((p) => p.action === 'import' && p.avail[0]?.kind === 'master');
  const timings = { masterDecodeMs: 0, importMs: 0 };
  if (needMaster) {
    const t0 = performance.now();
    const { data, info } = await sharp(legacyMaster(), { limitInputPixels: false, failOn: 'error' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== COLS * CW || info.height < cellOf(LEGACY_LAST).row * CH + CH) {
      throw new Error(`legacy master is ${info.width}x${info.height}, expected ${COLS * CW} wide and ${(cellOf(LEGACY_LAST).row + 1) * CH} tall`);
    }
    M = data;
    mw = info.width;
    timings.masterDecodeMs = performance.now() - t0;
    log(`  decoded legacy master ${info.width}x${info.height} in ${(timings.masterDecodeMs / 1000).toFixed(1)} s`);
  }

  const make = async (c, n) => {
    if (c.kind === 'master') return { raw: cropMaster(M, mw, n), flags: [] };
    if (c.kind === 'frame') return fitCell(await videoFrame(c.file, `frame-${n}`));
    if (c.kind === 'card') return { raw: await cardCell(n, c.title), flags: ['card'] };
    return fitCell(c.file);
  };

  const t0 = performance.now();
  let done = 0;
  const results = await pool(plan, concurrency, async ({ n, action, avail, e, stillMissing }) => {
    if (action !== 'import') {
      const status = { skip: 'unchanged', keep: 'kept', unavailable: 'unavailable' }[action];
      if (stillMissing) {
        const raw = await readCell(n, cellsDir);
        const { still } = await encodeCell(raw);
        const stillRev = await writeStill(n, still, e?.stillRev ?? 0, publishDir);
        if (e && stillRev !== (e.stillRev ?? 0)) e.stillRev = stillRev;
      }
      return { n, status, changed: false, kind: e?.kind, source: e?.source, flags: e?.flags ?? [] };
    }
    const errors = [];
    for (const c of avail) {
      try {
        const { raw, flags } = await make(c, n);
        const { master, still } = await encodeCell(raw);
        await writeFileAtomic(cellFile(n, cellsDir), master);
        const stillRev = await writeStill(n, still, e?.stillRev ?? 0, publishDir);
        const luma = meanLuma(raw);
        const entry = {
          source: c.source,
          kind: c.kind,
          mtime: c.mtime,
          size: c.size,
          sha256: crypto.createHash('sha256').update(master).digest('hex'),
          luma: Math.round(luma * 10) / 10,
          flags: [...flags, ...(luma < DARK ? ['dark'] : [])],
          ...(c.kind === 'card' ? { title: c.title } : {}),
          ...(errors.length ? { skipped: errors } : {}),
          ...(stillRev ? { stillRev } : {}),
        };
        cells[n] = entry;
        if (++done % 500 === 0) {
          if (cellsFile) saveCells(cells, cellsFile);
          log(`  ${done} cells written`);
        }
        return { n, status: 'imported', changed: !e || e.sha256 !== entry.sha256, kind: c.kind, source: c.source, flags: entry.flags };
      } catch (err) {
        errors.push(`${c.source}: ${err.message.split('\n')[0]}`);
      }
    }
    return { n, status: 'failed', changed: false, error: errors.join('; ') || 'no usable source' };
  });
  timings.importMs = performance.now() - t0;
  M = null;

  const duplicates = markDuplicates(cells);
  for (const r of results) if (cells[r.n]) r.flags = cells[r.n].flags;
  if (cellsFile) saveCells(cells, cellsFile);
  return { results, cells, duplicates, timings };
}
