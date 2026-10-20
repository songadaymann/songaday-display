// node pipeline/gifs-index.mjs [--song-count <n>] [--no-copy]
//
// Scans the archive's GIF folder without opening online-only files, writes STATE/gifs.json, and
// copies real GIFs for songs after the Azure range (5855+) into PUBLISH/gifs/<n>.gif.
// Song count: --song-count, else STATE/catalog.json, else the highest GIF number found.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PUBLISH, STATE, archiveDir } from './lib/env.mjs';
import { AZURE, GIF_DIR, copyGifs, gifIndex, onAzure, scanGifs } from './lib/gifs.mjs';
import { writeAtomic } from './lib/catalog.mjs';

const { values: args } = parseArgs({
  options: { 'song-count': { type: 'string' }, 'no-copy': { type: 'boolean', default: false } },
});

function songCountFrom(scan) {
  if (args['song-count']) return Number(args['song-count']);
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, 'catalog.json'), 'utf8')).songCount;
  } catch {
    return Math.max(0, ...scan.real.keys(), ...scan.placeholder);
  }
}

const ranges = (ns) => {
  const out = [];
  for (const n of ns) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ') || 'none';
};

const dir = path.join(archiveDir(), GIF_DIR);
const scan = scanGifs(dir);
const songCount = songCountFrom(scan);
const index = { ...gifIndex(scan, songCount), builtAt: new Date().toISOString() };
writeAtomic(path.join(STATE, 'gifs.json'), `${JSON.stringify(index, null, 1)}\n`);

const sizes = {};
for (const g of scan.real.values()) sizes[`${g.w}x${g.h}`] = (sizes[`${g.w}x${g.h}`] || 0) + 1;
const after = [...scan.real.keys()].filter((n) => n > AZURE.to);
const bytes = after.reduce((s, n) => s + scan.real.get(n).size, 0);

console.log(`GIFs for songs 1-${songCount} in ${GIF_DIR}/`);
const azureOnly = Array.from({ length: Math.min(songCount, AZURE.to) }, (_, i) => i + 1).filter((n) => !scan.real.has(n) && onAzure(n));
console.log(`  real local   ${scan.real.size}: ${scan.real.size - after.length} at or below ${AZURE.to}, ${after.length} after; sizes ${JSON.stringify(sizes)}`);
console.log(`  placeholder  ${index.placeholder.length} online-only, ${index.placeholder.filter((n) => n > AZURE.to).length} of them after ${AZURE.to}: ${ranges(index.placeholder.filter((n) => n > AZURE.to))}`);
console.log(`  empty ${index.empty.length}, not a GIF ${index.invalid.length}, other names ${scan.other.length}`);
console.log(`  Azure copy only (no real local file): ${azureOnly.length}`);
console.log(`  noGif ${index.noGif.length}: ${ranges(index.noGif)}`);
console.log(`  recoverable by making them available offline: ${index.recoverable.length}`);

if (!args['no-copy']) {
  const { copied, kept } = copyGifs(scan.real, PUBLISH, { to: songCount });
  console.log(`  copied ${copied.length}, unchanged ${kept.length} of ${after.length} real GIFs after ${AZURE.to} (${(bytes / 1e6).toFixed(1)} MB) to ${path.join(PUBLISH, 'gifs')}`);
}
console.log(`  wrote ${path.join(STATE, 'gifs.json')}`);
