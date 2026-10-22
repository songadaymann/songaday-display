// Uploads the local wall to R2: drains STATE/pending-uploads.jsonl (what wall-add queued), or with
// --all everything in the cache, in commit order. wall/current.json goes last, only when every
// other object went up, and only over the copy this Mac published last. Resumable: the ledger
// (STATE/r2-uploaded.jsonl) records each object, so a rerun skips what is already up.
//
//   node pipeline/r2-sync.mjs [--all] [--transport auto|s3|api|wrangler] [--concurrency N]
//                             [--dry-run] [--no-verify] [--force] [--json]
//
// Transport (--transport, default auto): s3 when R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and
// R2_SECRET_ACCESS_KEY are set (~/.config/songaday-display/.env), the fastest; else api, the
// Cloudflare API with wrangler's login, about 3.5 objects a second (the API's rate limit; a full
// upload of ~22k objects takes about 1 h 45 min); wrangler spawns `wrangler r2 object put` per
// object, slow and CPU-heavy, as a last resort. With S3, --all first lists both buckets, so
// objects already there (same MD5) aren't sent again; the other two rely on the ledger.
// After current.json, it fetches it and HEADs the new tiles through tiles.songaday.world, with the
// Origin header like every pipeline request.
// Exit 0 synced (or nothing to do), 1 something failed (current.json not written), 3 uploaded but
// the public check failed.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PUBLISH } from './lib/env.mjs';
import { CURRENT_KEY, withLock } from './lib/manifest.mjs';
import { PUBLIC_MEDIA, client, isMutable, ledgerEntry, md5hex, planAll, planQueue, publicFetch, readLedger } from './lib/r2.mjs';
import { SYNC_LOCK, readQueue, reconcile, rewriteQueue, runPhases } from './lib/sync.mjs';

const { values: args } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    transport: { type: 'string', default: 'auto' },
    concurrency: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    wait: { type: 'string', default: '120' },
  },
});
const t0 = performance.now();
const say = (msg) => args.json || console.log(msg);
const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  say(`  warning: ${msg}`);
};

// The queue, current.json's bytes and (with --all) the file list, read together under the wall
// lock, so current.json never names an object the plan doesn't cover.
const snapshotUnderLock = () => withLock(() => {
  const queue = readQueue();
  const currentFile = path.join(PUBLISH, CURRENT_KEY);
  const current = fs.existsSync(currentFile) ? fs.readFileSync(currentFile) : null;
  return { queue, current, tree: args.all ? planAll() : null };
}, { waitMs: Number(args.wait) * 1000, label: 'r2-sync' });

function buildPhases(snap) {
  let phases;
  if (!snap.tree) phases = planQueue(snap.queue.items);
  else {
    phases = snap.tree.phases;
    const inTree = new Set(phases.flatMap((p) => p.items.map((it) => `${it.bucket}/${it.key}`)));
    const extra = planQueue(snap.queue.items.filter((it) => !inTree.has(`${it.bucket}/${it.key}`))).flatMap((p) => p.items);
    if (extra.length) phases.splice(phases.findIndex((p) => p.name === 'manifests'), 0, { name: 'queued', items: extra });
  }
  // current.json goes up as it was in the snapshot, whatever happens to the file meanwhile.
  for (const p of phases) for (const it of p.items) if (it.bucket === 'media' && it.key === CURRENT_KEY) {
    if (!snap.current) throw new Error(`${CURRENT_KEY} is queued but missing locally`);
    it.body = snap.current;
  }
  return phases;
}

// Fetch the live manifest and HEAD the newest tiles of this run through the public host.
async function verify(snap, uploaded) {
  const out = { manifest: null, tiles: [] };
  try {
    const res = await publicFetch(CURRENT_KEY);
    const body = Buffer.from(await res.arrayBuffer());
    out.manifest = { status: res.status, matches: res.ok && md5hex(body) === md5hex(snap.current), cors: res.headers.get('access-control-allow-origin') };
  } catch (err) {
    out.manifest = { error: err.message };
  }
  const tiles = uploaded.filter((it) => it.key.startsWith('wall/p1/') && it.key.endsWith('.webp')).slice(-8);
  for (const it of tiles) {
    try {
      const res = await publicFetch(it.key, { method: 'HEAD' });
      out.tiles.push({ key: it.key, status: res.status, cors: res.headers.get('access-control-allow-origin'), cache: res.headers.get('cf-cache-status') });
    } catch (err) {
      out.tiles.push({ key: it.key, error: err.message });
    }
  }
  out.ok = Boolean(out.manifest?.matches && out.manifest.cors === '*' && out.tiles.every((t) => t.status === 200 && t.cors === '*'));
  return out;
}

async function sync() {
  const snap = await snapshotUnderLock();
  const phases = buildPhases(snap);
  const total = phases.reduce((s, p) => s + p.items.length, 0);
  if (snap.tree?.skipped.length) warn(`not uploaded, names don't fit a published key: ${snap.tree.skipped.join(', ')}`);
  say(`r2:sync ${args.all ? 'everything in the cache' : `${snap.queue.items.length} queued lines`}: ${total} objects in ${phases.length} phases`);
  for (const p of phases) say(`  ${p.name.padEnd(10)} ${p.items.length}`);
  if (args['dry-run'] || !total) return { status: total ? 'dry-run' : 'nothing-queued', objects: total };

  const c = client(args.transport);
  const concurrency = Number(args.concurrency) || { s3: 16, api: 8 }[c.kind] || 4;
  const ledger = readLedger();
  say(`  transport ${c.kind}, ${concurrency} at a time`);
  if (args.all && c.list) {
    const r = await reconcile(c, phases.flatMap((p) => p.items), { ledger });
    say(`  already on R2 (matched by MD5): ${r.matched}`);
    if (r.conflicts.length) throw new Error(`R2 holds other bytes for ${r.conflicts.length} immutable keys: ${r.conflicts.slice(0, 5).join('; ')}${r.conflicts.length > 5 ? ' …' : ''}`);
  }
  const todo = phases.reduce((s, p) => s + p.items.filter((it) => !ledgerEntry(ledger, it.bucket, it.key) || isMutable(it.key)).length, 0);
  say(`  to upload: about ${todo}`);

  let last = Date.now();
  const peek = async () => {
    const res = await publicFetch(CURRENT_KEY);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return md5hex(Buffer.from(await res.arrayBuffer()));
  };
  const result = await runPhases(c, phases, {
    concurrency,
    ledger,
    force: args.force,
    peek,
    warn,
    onProgress: (phase, n, out) => {
      if (Date.now() - last < 10000 && n !== phase.items.length) return;
      last = Date.now();
      say(`  ${phase.name} ${n}/${phase.items.length}; uploaded ${out.uploaded.length} (${(out.bytes / 1e6).toFixed(1)} MB), failed ${out.failed.length}`);
    },
  });

  // Done: the ledger has the key (current.json: with the bytes just published).
  const currentMd5 = snap.current ? md5hex(snap.current) : null;
  const isDone = (it) => {
    const e = ledgerEntry(ledger, it.bucket, it.key);
    return Boolean(e) && (!isMutable(it.key) || e.md5 === currentMd5);
  };
  const q = await withLock(() => rewriteQueue({ snapshot: snap.queue, isDone }), { waitMs: Number(args.wait) * 1000, label: 'r2-sync' });
  if (q.note) warn(q.note);

  const currentUp = result.uploaded.some((it) => it.key === CURRENT_KEY);
  const verified = currentUp && !args['no-verify'] ? await verify(snap, result.uploaded) : null;
  return {
    status: result.failed.length ? 'failed' : 'synced',
    transport: c.kind,
    uploaded: result.uploaded.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    mb: Number((result.bytes / 1e6).toFixed(1)),
    current: currentUp ? 'published' : result.skippedPhases.includes('current') ? 'held back' : 'unchanged',
    ...(result.failed.length ? { errors: result.failed.slice(0, 20).map((f) => `${f.it.bucket}/${f.it.key}: ${f.error}`) } : {}),
    ...(q.kept != null ? { queueLeft: q.kept + q.appended } : {}),
    ...(verified ? { verify: verified } : {}),
  };
}

let result, code = 0;
try {
  result = await withLock(sync, { file: SYNC_LOCK, waitMs: Number(args.wait) * 1000, label: 'r2-sync' });
  if (result.status === 'failed') code = 1;
  else if (result.verify && !result.verify.ok) code = 3;
} catch (err) {
  code = 1;
  result = { status: 'failed', error: err.message };
}
const line = { ...result, ms: Math.round(performance.now() - t0), ...(warnings.length ? { warnings } : {}) };
if (args.json) console.log(JSON.stringify(line));
else {
  console.log(`r2:sync ${line.status}${line.uploaded != null ? `: ${line.uploaded} uploaded (${line.mb} MB), ${line.skipped} already up, ${line.failed} failed` : ''} in ${(line.ms / 1000).toFixed(1)} s`);
  if (line.error) console.log(`  ${line.error}`);
  if (line.current) console.log(`  wall/current.json: ${line.current}${line.current === 'held back' ? ' until the failed objects are up (rerun npm run r2:sync)' : ''}`);
  for (const e of line.errors || []) console.log(`  ${e}`);
  if (line.queueLeft) console.log(`  ${line.queueLeft} lines left in STATE/pending-uploads.jsonl`);
  if (line.verify) {
    const m = line.verify.manifest;
    console.log(`  ${PUBLIC_MEDIA}/${CURRENT_KEY}: ${m.error || `HTTP ${m.status}, ${m.matches ? 'matches' : 'DIFFERS from'} what was uploaded, CORS ${m.cors ?? 'missing'}`}`);
    for (const t of line.verify.tiles) console.log(`  ${t.key}: ${t.error || `HTTP ${t.status}, CORS ${t.cors ?? 'missing'}, cache ${t.cache}`}`);
    if (!line.verify.ok) console.log('  the public check failed: see above (npm run r2:check for the full picture)');
  }
}
process.exitCode = code;
