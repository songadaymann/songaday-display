// Animated previews: which songs have a GIF, where it is, and which have none.
//
// The toolkit writes `Every Song A Day Gif/<n>.gif` (320x180, 1 s, 10 fps) into the archive each day.
// Most of that folder is Dropbox online-only: 0-byte placeholders that download when opened, so we
// stat them and read their xattrs but never open them. The old gallery's Azure copy holds 1-5854
// except 940 and 5832; it is backed up separately, so only newer songs are copied from the archive.
// A published GIF key never gets new bytes (it is cached for a year): a changed GIF goes to
// gifs/<n>-r<rev>.gif, and the manifest's gifRev names the current one.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const GIF_DIR = 'Every Song A Day Gif';
export const AZURE = Object.freeze({ from: 1, to: 5854, missing: Object.freeze([940, 5832]) });
export const onAzure = (n) => n >= AZURE.from && n <= AZURE.to && !AZURE.missing.includes(n);

// GIF signature and logical screen size, or null if the bytes aren't a GIF.
export function gifHeader(buf) {
  if (!buf || buf.length < 10) return null;
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

export function readHead(file, bytes = 10) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0));
  } finally {
    fs.closeSync(fd);
  }
}

// The files among these that carry Dropbox's placeholder xattr (reads metadata only).
export function dropboxPlaceholders(files) {
  const out = new Set();
  for (let i = 0; i < files.length; i += 400) {
    const batch = files.slice(i, i + 400);
    let text = '';
    try {
      text = execFileSync('xattr', batch, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      text = err.stdout || '';
    }
    for (const line of text.split('\n')) {
      if (batch.length === 1 && line === 'com.dropbox.placeholder') out.add(batch[0]);
      const m = line.match(/^(.*): com\.dropbox\.placeholder$/);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

// One pass over the GIF folder. Real files get their header checked; nothing else is opened.
// A file with a size but no allocated blocks is a dataless (File Provider) placeholder.
export function scanGifs(dir) {
  const real = new Map(), invalid = new Map(), zero = [], dataless = [], other = [];
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^(\d+)\.gif$/i);
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    if (!m || !st.isFile()) {
      other.push(name);
      continue;
    }
    const n = Number(m[1]);
    if (st.size === 0) zero.push({ n, file });
    else if (st.blocks === 0) dataless.push(n);
    else {
      const head = gifHeader(readHead(file));
      if (head) real.set(n, { file, size: st.size, mtimeMs: st.mtimeMs, ...head });
      else invalid.set(n, file);
    }
  }
  const marked = dropboxPlaceholders(zero.map((z) => z.file));
  return {
    real,
    invalid,
    placeholder: [...zero.filter((z) => marked.has(z.file)).map((z) => z.n), ...dataless].sort((a, b) => a - b),
    empty: zero.filter((z) => !marked.has(z.file)).map((z) => z.n).sort((a, b) => a - b),
    other,
  };
}

// STATE/gifs.json. noGif: songs with no GIF we can publish today (no real local file, not on Azure);
// recoverable: the noGif songs whose archive file is only online-only (make it available offline).
export function gifIndex(scan, songCount) {
  const local = {};
  const noGif = [], recoverable = [];
  const placeholder = new Set(scan.placeholder);
  for (let n = 1; n <= songCount; n++) {
    if (scan.real.has(n)) local[n] = scan.real.get(n).file;
    else if (!onAzure(n)) {
      noGif.push(n);
      if (placeholder.has(n)) recoverable.push(n);
    }
  }
  return {
    schema: 1,
    songCount,
    local,
    placeholder: scan.placeholder.filter((n) => n <= songCount),
    noGif,
    recoverable,
    empty: scan.empty.filter((n) => n <= songCount),
    invalid: [...scan.invalid.keys()].filter((n) => n <= songCount).sort((a, b) => a - b),
    azure: AZURE,
  };
}

export const gifKey = (n, rev = 0) => `gifs/${n}${rev ? `-r${rev}` : ''}.gif`;

// The newest published revision of each song's GIF in publish/gifs: Map n -> rev (0 is <n>.gif).
export function gifRevs(publish) {
  const revs = new Map();
  let names = [];
  try {
    names = fs.readdirSync(path.join(publish, 'gifs'));
  } catch {}
  for (const name of names) {
    const m = name.match(/^(\d+)(?:-r(\d+))?\.gif$/);
    if (m) revs.set(Number(m[1]), Math.max(revs.get(Number(m[1])) ?? 0, Number(m[2] || 0)));
  }
  return revs;
}

const sameFile = (file, src) => {
  const st = fs.statSync(file);
  if (st.size !== src.size) return false;
  return Math.abs(st.mtimeMs - src.mtimeMs) < 2 || fs.readFileSync(file).equals(fs.readFileSync(src.file));
};

// Publishes src { file, size, mtimeMs } as song n's GIF at the first revision from `rev` that is
// free or already holds it. A copy keeps the source's mtime, so an unchanged source costs a stat.
// Returns { key, rev, copied }.
export function publishGif(publish, n, src, rev = 0) {
  for (;;) {
    const dest = path.join(publish, gifKey(n, rev));
    if (!fs.existsSync(dest)) break;
    if (sameFile(dest, src)) return { key: gifKey(n, rev), rev, copied: false };
    rev++;
  }
  const dest = path.join(publish, gifKey(n, rev));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.copyFileSync(src.file, tmp);
  fs.utimesSync(tmp, new Date(), new Date(src.mtimeMs));
  fs.renameSync(tmp, dest);
  return { key: gifKey(n, rev), rev, copied: true };
}

// Copies real local GIFs newer than the Azure range into publish/gifs.
export function copyGifs(real, publish, { from = AZURE.to + 1, to = Infinity } = {}) {
  fs.mkdirSync(path.join(publish, 'gifs'), { recursive: true });
  const revs = gifRevs(publish);
  const copied = [], kept = [];
  for (const [n, g] of [...real].sort((a, b) => a[0] - b[0])) {
    if (n < from || n > to) continue;
    const r = publishGif(publish, n, g, revs.get(n) ?? 0);
    (r.copied ? copied : kept).push(n);
  }
  return { copied, kept };
}
