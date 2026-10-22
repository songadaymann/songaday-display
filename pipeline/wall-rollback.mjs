// Puts an earlier manifest back live: uploads the newest wall/manifests/<N>-<hash8>.json (or
// --key) as wall/current.json. Visitors see it within about a minute. Every object an earlier
// manifest names is immutable and still on R2, so nothing else is uploaded.
//
//   npm run wall:rollback -- --to N [--key wall/manifests/N-xxxxxxxx.json] [--dry-run] [--force]
//                                    [--transport auto|s3|wrangler] [--json]
//
// Local STATE keeps the newer songs. The local current.json becomes the rolled-back copy, so a
// queued sync doesn't undo it, and STATE/rollback.json records it. The next wall-add or
// wall:manifest writes a new manifest from STATE and the next r2:sync publishes it: fix the bad
// cell first (wall-add --song-id M --force).
// --force also replaces a live current.json this Mac didn't write, and allows a manifest whose
// tiles the ledger doesn't show as uploaded.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { existingTiles, tileKey } from '../shared/layout.mjs';
import { PUBLISH, STATE } from './lib/env.mjs';
import { CURRENT_KEY, readJson, withLock, writeAtomic } from './lib/manifest.mjs';
import { PUBLIC_MEDIA, client, ledgerEntry, md5hex, publicFetch, readLedger } from './lib/r2.mjs';
import { SYNC_LOCK, putItem } from './lib/sync.mjs';

const { values: args } = parseArgs({
  options: {
    to: { type: 'string' },
    key: { type: 'string' },
    transport: { type: 'string', default: 'auto' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});
const say = (msg) => args.json || console.log(msg);

// The newest copy for songCount N, by updatedAt (hash names don't sort by time).
function pick(N) {
  const dir = path.join(PUBLISH, 'wall/manifests');
  const names = fs.readdirSync(dir).filter((f) => new RegExp(`^${N}-[0-9a-f]{8}\\.json$`).test(f));
  if (!names.length) throw new Error(`no wall/manifests/${N}-*.json in ${dir}`);
  return names
    .map((f) => ({ key: `wall/manifests/${f}`, manifest: readJson(path.join(dir, f)) }))
    .sort((a, b) => String(b.manifest.updatedAt).localeCompare(String(a.manifest.updatedAt)))[0];
}

// Objects the manifest needs that the ledger doesn't show on R2: its tiles, catalog chunks, descriptor.
function missingOnR2(m, ledger) {
  const keys = [`wall/${m.pyramid}/wall.json`, ...(m.catalog ? [...m.catalog.index, ...m.catalog.detail] : [])];
  for (const { k, x, y } of existingTiles(m.songCount)) keys.push(tileKey(k, x, y, m.songCount, m.overrides));
  return keys.filter((key) => !ledgerEntry(ledger, 'media', key));
}

async function rollback() {
  const chosen = args.key
    ? { key: args.key, manifest: readJson(path.join(PUBLISH, args.key)) }
    : pick(Number(args.to));
  if (!chosen.manifest) throw new Error(`${args.key} isn't in the local publish folder`);
  const m = chosen.manifest;
  if (args.to && m.songCount !== Number(args.to)) throw new Error(`${chosen.key} has songCount ${m.songCount}, not ${args.to}`);
  const body = fs.readFileSync(path.join(PUBLISH, chosen.key));
  const ledger = readLedger();
  if (!ledgerEntry(ledger, 'media', chosen.key)) throw new Error(`${chosen.key} was never uploaded (not in the ledger); roll back only to a manifest that has been live`);
  const missing = missingOnR2(m, ledger);
  say(`wall:rollback to ${chosen.key}: songCount ${m.songCount}, updatedAt ${m.updatedAt}`);
  if (missing.length) {
    say(`  ${missing.length} objects it names aren't in the ledger: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
    if (!args.force) throw new Error('refusing: those objects may not be on R2 (--force to roll back anyway)');
  }
  const live = ledgerEntry(ledger, 'media', CURRENT_KEY);
  if (live?.md5 === md5hex(body)) return { status: 'already-live', key: chosen.key, songCount: m.songCount };
  if (args['dry-run']) return { status: 'dry-run', key: chosen.key, songCount: m.songCount };

  const c = client(args.transport);
  const peek = async () => {
    const res = await publicFetch(CURRENT_KEY);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return md5hex(Buffer.from(await res.arrayBuffer()));
  };
  const was = readJson(path.join(PUBLISH, CURRENT_KEY));
  await putItem(c, { bucket: 'media', key: CURRENT_KEY, body }, { ledger, force: args.force, peek, warn: (w) => say(`  warning: ${w}`) });
  writeAtomic(path.join(PUBLISH, CURRENT_KEY), body);
  writeAtomic(path.join(STATE, 'rollback.json'), `${JSON.stringify({ at: new Date().toISOString(), to: chosen.key, songCount: m.songCount, from: was ? { songCount: was.songCount, updatedAt: was.updatedAt } : null }, null, 2)}\n`);

  const res = await publicFetch(CURRENT_KEY);
  const got = Buffer.from(await res.arrayBuffer());
  return { status: 'rolled-back', key: chosen.key, songCount: m.songCount, from: was?.songCount ?? null, transport: c.kind, live: res.ok && got.equals(body) };
}

let result, code = 0;
try {
  if (!args.to && !args.key) throw new Error('usage: wall:rollback -- --to N [--key wall/manifests/N-xxxxxxxx.json]');
  result = await withLock(() => withLock(rollback, { waitMs: 120000, label: 'wall:rollback' }), { file: SYNC_LOCK, waitMs: 120000, label: 'wall:rollback' });
} catch (err) {
  code = 1;
  result = { status: 'failed', error: err.message };
}
if (args.json) console.log(JSON.stringify(result));
else {
  console.log(`wall:rollback ${result.status}${result.key ? `: ${result.key}` : ''}`);
  if (result.error) console.log(`  ${result.error}`);
  if (result.status === 'rolled-back') {
    console.log(`  live at ${PUBLIC_MEDIA}/${CURRENT_KEY}: ${result.live ? 'yes' : 'NOT YET (check again in a minute)'}; was songCount ${result.from}, now ${result.songCount}`);
    console.log('  STATE still holds the newer songs. Fix the bad cell (npm run wall:add -- --song-id M --force), then npm run r2:sync.');
    console.log('  Until then, any wall-add or wall:manifest run writes a newer manifest and the next r2:sync rolls forward.');
  }
}
process.exitCode = code;
