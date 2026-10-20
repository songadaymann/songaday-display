// Byte-identical files shared by different songs (a re-run that copied yesterday's files, a repeated
// stand-in image, the same black frame). Only files that share a size are read: first three 256 KB
// samples, then a full hash to confirm the few that still match. WAV sizes collide a lot
// (about 1,500 files), so this reads a few hundred MB instead of 50 GB.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mapLimit } from './limit.mjs';

const CHUNK = 256 * 1024;

export const sha1File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha1');
  fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
});

// sha1 of the start, middle and end of a file; the full hash for small files.
export async function sampleHash(file, size) {
  if (size <= 3 * CHUNK) return sha1File(file);
  const fh = await fs.promises.open(file, 'r');
  try {
    const h = crypto.createHash('sha1');
    const buf = Buffer.alloc(CHUNK);
    for (const pos of [0, Math.floor(size / 2), size - CHUNK]) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      h.update(buf.subarray(0, bytesRead));
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}

const groupBy = (items, key) => {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
};

// files: [{n, path, size, placeholder}]. Placeholders and empty files are never read.
// Returns [{sha1, size, songs: [n…], original}] for every hash used by two or more different songs;
// `original` is the song whose file was written first.
export async function duplicateGroups(files, { hash = sha1File, sample = sampleHash, concurrency = 8 } = {}) {
  const real = files.filter((f) => f.size > 0 && !f.placeholder);
  const songsIn = (g) => new Set(g.map((f) => f.n)).size;
  const bySize = [...groupBy(real, (f) => f.size).values()].filter((g) => songsIn(g) > 1);
  const sized = bySize.flat();
  await mapLimit(sized, concurrency, async (f) => (f.sample ??= await sample(f.path, f.size)));
  const candidates = bySize.flatMap((g) => [...groupBy(g, (f) => f.sample).values()].filter((x) => songsIn(x) > 1));
  await mapLimit(candidates.flat(), concurrency, async (f) => (f.sha1 ??= f.size <= 3 * CHUNK ? f.sample : await hash(f.path)));
  const groups = [];
  for (const same of candidates) {
    for (const [sha1, g] of groupBy(same, (f) => f.sha1)) {
      const songs = [...new Set(g.map((f) => f.n))].sort((a, b) => a - b);
      const first = [...g].sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) || a.n - b.n)[0];
      if (songs.length > 1) groups.push({ sha1, size: g[0].size, songs, original: first.n });
    }
  }
  return groups.sort((a, b) => a.songs[0] - b.songs[0]);
}

// n → the other songs with the same bytes, and whether n holds the oldest copy.
export function duplicateIndex(groups) {
  const idx = new Map();
  for (const g of groups) {
    for (const n of g.songs) idx.set(n, { sha1: g.sha1, others: g.songs.filter((m) => m !== n), original: n === g.original, originalN: g.original });
  }
  return idx;
}
