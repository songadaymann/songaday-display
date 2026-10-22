// The upload engine behind r2-sync and wall:rollback: put objects phase by phase, record each in
// the ledger, never give an immutable key new bytes, and write wall/current.json only after every
// object it could reference is up, and only over the copy this Mac wrote last.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, STATE } from './env.mjs';
import { CURRENT_KEY, writeAtomic } from './manifest.mjs';
import { BUCKETS, cacheControlFor, contentTypeFor, isMutable, ledgerEntry, md5hex, recordUpload } from './r2.mjs';

export const QUEUE = 'pending-uploads.jsonl';
// One sync (or rollback) at a time; held for the whole run. The wall lock is taken only briefly.
export const SYNC_LOCK = path.join(CACHE, 'r2-sync.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.retryable = false;
  }
}

async function retry(fn, { retries, delayMs }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.retryable === false || attempt >= retries) throw err;
      await sleep(delayMs * 2 ** attempt);
    }
  }
}

// The live current.json's MD5: from a HEAD on the S3 API, else from `peek` (a GET through the public
// host), else undefined when it can't be known.
async function remoteMd5(c, peek) {
  try {
    if (c.head) return (await c.head(BUCKETS.media, CURRENT_KEY))?.etag ?? null;
    if (peek) return await peek();
  } catch {}
  return undefined;
}

// Uploads one item { bucket, key, file | body }. Skips it when the ledger already has these bytes.
// Returns { status: 'uploaded' | 'skipped', md5, size }.
export async function putItem(c, it, { ledger, state = STATE, force = false, retries = 3, delayMs = 1000, peek = null, warn = () => {} }) {
  const body = it.body ?? fs.readFileSync(it.file);
  const md5 = md5hex(body);
  const prev = ledgerEntry(ledger, it.bucket, it.key);
  if (prev?.md5 === md5) return { status: 'skipped', md5, size: body.length };
  if (prev && !isMutable(it.key)) {
    throw new ConflictError(`${it.bucket}/${it.key} is already on R2 with other bytes (ledger ${prev.md5}, local ${md5}); a published key never changes, so give it a new -r<rev> key`);
  }
  const put = { body, file: it.body ? null : it.file, contentType: contentTypeFor(it.key), cacheControl: cacheControlFor(it.key) };
  if (it.bucket === 'media' && it.key === CURRENT_KEY) {
    const live = await remoteMd5(c, peek);
    if (live === md5) {
      recordUpload(ledger, { bucket: it.bucket, key: it.key, size: body.length, md5, via: 'already-live' }, state);
      return { status: 'skipped', md5, size: body.length };
    }
    if (live === undefined) warn('could not read the live wall/current.json; writing it anyway (the sync lock is the only guard)');
    else if (live && live !== prev?.md5 && !force) {
      throw new ConflictError(`the live wall/current.json (${live}) is not the one this Mac wrote last (${prev?.md5 ?? 'none recorded'}); someone else published. Rerun with --force to replace it`);
    }
    if (c.head && live !== undefined) Object.assign(put, live ? { ifMatch: live } : { ifNoneMatch: '*' });
  }
  const { etag } = await retry(() => c.put(BUCKETS[it.bucket], it.key, put), { retries, delayMs });
  if (etag && etag !== md5) throw new Error(`${it.bucket}/${it.key}: R2 stored ETag ${etag}, expected MD5 ${md5}`);
  recordUpload(ledger, { bucket: it.bucket, key: it.key, size: body.length, md5, via: c.kind, ...(it.songId ? { songId: it.songId } : {}) }, state);
  return { status: 'uploaded', md5, size: body.length };
}

async function pool(items, concurrency, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

const GATED = new Set(['manifests', 'current']);

// Uploads phases in order, each phase's items in parallel. After any failure, the manifest phases
// are skipped, so nothing live can point at an object that isn't up.
export async function runPhases(c, phases, { concurrency = 8, onProgress = () => {}, ...opts }) {
  const out = { uploaded: [], skipped: [], failed: [], skippedPhases: [], bytes: 0 };
  for (const phase of phases) {
    if (GATED.has(phase.name) && out.failed.length) {
      out.skippedPhases.push(phase.name);
      continue;
    }
    let n = 0;
    await pool(phase.items, concurrency, async (it) => {
      try {
        const r = await putItem(c, it, opts);
        (r.status === 'uploaded' ? out.uploaded : out.skipped).push(it);
        if (r.status === 'uploaded') out.bytes += r.size;
      } catch (err) {
        out.failed.push({ it, error: err.message });
      }
      onProgress(phase, ++n, out);
    });
  }
  return out;
}

// Fills the ledger from a bucket listing: an object already on R2 with the same MD5 counts as
// uploaded. A different MD5 on an immutable key is a conflict. Needs the S3 client.
export async function reconcile(c, items, { ledger, state = STATE }) {
  const out = { matched: 0, conflicts: [] };
  const want = items.filter((it) => !isMutable(it.key) && !ledgerEntry(ledger, it.bucket, it.key));
  for (const bucket of new Set(want.map((it) => it.bucket))) {
    const remote = new Map();
    for await (const o of c.list(BUCKETS[bucket])) remote.set(o.key, o);
    for (const it of want.filter((x) => x.bucket === bucket)) {
      const r = remote.get(it.key);
      if (!r) continue;
      const body = it.body ?? fs.readFileSync(it.file);
      const md5 = md5hex(body);
      if (r.etag === md5) {
        recordUpload(ledger, { bucket, key: it.key, size: body.length, md5, via: 'reconcile' }, state);
        out.matched++;
      } else out.conflicts.push(`${bucket}/${it.key} (R2 ${r.etag}, local ${md5})`);
    }
  }
  return out;
}

// ---- The upload queue (STATE/pending-uploads.jsonl, appended by wall-add) ----

export function readQueue(state = STATE, cache = CACHE) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(state, QUEUE), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const items = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    items.push({ bucket: e.bucket, key: e.key, file: path.resolve(cache, e.file), songId: e.songId ?? null, line });
  }
  return { text, items };
}

// After a sync: drops the snapshot's lines that are done and keeps the rest, plus anything appended
// since the snapshot was read. Call with the wall lock held.
export function rewriteQueue({ state = STATE, snapshot, isDone }) {
  const file = path.join(state, QUEUE);
  let now = '';
  try {
    now = fs.readFileSync(file, 'utf8');
  } catch {}
  if (!now.startsWith(snapshot.text)) return { kept: null, note: 'queue changed under us; left as is (a rerun skips what is up)' };
  const kept = snapshot.items.filter((it) => !isDone(it)).map((it) => it.line);
  const rest = now.slice(snapshot.text.length);
  writeAtomic(file, kept.length ? `${kept.join('\n')}\n${rest}` : rest);
  return { kept: kept.length, appended: rest.split('\n').filter(Boolean).length };
}
