// node pipeline/gifs-azure.mjs [--from 1] [--to 5854] [--concurrency 12]
//
// Copies the old gallery's GIFs 1-5854 (no 940 or 5832) from its public Azure container into
// PUBLISH/gifs/<n>.gif, the only copy of most of them (the archive's are online-only placeholders).
// Each download must match Azure's Content-MD5 and start with a GIF header. A GIF already in
// PUBLISH/gifs with other bytes is left alone and reported: a published key never gets new bytes.
// Resumable: STATE/azure-gifs.json records each copy's MD5, so a rerun only stats the done ones.
// r2-sync uploads them afterwards like any other GIF.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PUBLISH, STATE } from './lib/env.mjs';
import { AZURE, gifHeader, gifKey, onAzure } from './lib/gifs.mjs';
import { readJson, writeAtomic } from './lib/manifest.mjs';

export const AZURE_GIFS = 'https://songadaygallery.blob.core.windows.net/dzi';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string', default: String(AZURE.from) },
    to: { type: 'string', default: String(AZURE.to) },
    concurrency: { type: 'string', default: '12' },
  },
});

const ledgerFile = path.join(STATE, 'azure-gifs.json');
const ledger = readJson(ledgerFile, { schema: 1, source: AZURE_GIFS, gifs: {} });
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('base64');
const save = () => {
  const gifs = Object.fromEntries(Object.entries(ledger.gifs).sort((a, b) => a[0] - b[0]));
  writeAtomic(ledgerFile, `${JSON.stringify({ ...ledger, gifs, savedAt: new Date().toISOString() }, null, 1)}\n`);
};

const songs = [];
for (let n = Number(args.from); n <= Math.min(Number(args.to), AZURE.to); n++) if (onAzure(n)) songs.push(n);

const done = [], kept = [], fetched = [], conflicts = [], failed = [];
let bytes = 0, sinceSave = 0;

async function copy(n) {
  const dest = path.join(PUBLISH, gifKey(n));
  const known = ledger.gifs[n];
  if (known && fs.existsSync(dest) && fs.statSync(dest).size === known.size) return done.push(n);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${AZURE_GIFS}/${n}.gif`);
      if (res.status === 404) throw Object.assign(new Error('404 on Azure'), { final: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const want = res.headers.get('content-md5');
      if (!want) throw new Error('no Content-MD5 from Azure');
      if (md5(buf) !== want) throw new Error(`MD5 mismatch (got ${md5(buf)}, Azure says ${want})`);
      if (!gifHeader(buf)) throw Object.assign(new Error('not a GIF'), { final: true });
      if (fs.existsSync(dest)) {
        if (!fs.readFileSync(dest).equals(buf)) return conflicts.push(n);
        kept.push(n);
      } else {
        writeAtomic(dest, buf);
        fetched.push(n);
        bytes += buf.length;
      }
      ledger.gifs[n] = { md5: want, size: buf.length, lastModified: res.headers.get('last-modified') };
      if (++sinceSave >= 500) {
        sinceSave = 0;
        save();
      }
      return;
    } catch (err) {
      if (err.final || attempt >= 4) return failed.push({ n, error: err.message });
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

const t0 = Date.now();
let next = 0;
const progress = setInterval(() => {
  console.log(`  ${done.length + kept.length + fetched.length + conflicts.length + failed.length}/${songs.length} (${(bytes / 1e6).toFixed(0)} MB fetched)`);
}, 15000);
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (next < songs.length) await copy(songs[next++]);
}));
clearInterval(progress);
save();

console.log(`gifs:azure ${songs.length} GIFs (${args.from}-${Math.min(Number(args.to), AZURE.to)}, without ${AZURE.missing.join(' and ')}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`  fetched ${fetched.length} (${(bytes / 1e6).toFixed(1)} MB), already copied ${done.length}, already in publish/gifs and identical ${kept.length}`);
if (conflicts.length) console.log(`  DIFFERENT from the published file, left alone (${conflicts.length}): ${conflicts.join(', ')}`);
if (failed.length) console.log(`  FAILED (${failed.length}): ${failed.map((f) => `#${f.n} ${f.error}`).join('; ')}`);
console.log(`  wrote ${ledgerFile}`);
if (conflicts.length || failed.length) process.exitCode = 1;
