// Checks the published wall from the outside, through tiles.songaday.world.
//
//   node pipeline/r2-check.mjs                HEADs every object the live manifest lets the viewer
//                                             request (tiles, descriptor, catalog, stills, GIFs):
//                                             each must answer 200 with Access-Control-Allow-Origin
//   node pipeline/r2-check.mjs --cors         the M3 gate: a test object fetched first without an
//                                             Origin header (so the edge caches a copy that has
//                                             none), then with one; the cached copy must carry the CORS header
//   node pipeline/r2-check.mjs --conditional  does R2 honour If-Match / If-None-Match on PUT? (S3 token;
//                                             uses test/conditional-check.json in the private bucket)
//
// Every request but the deliberate first two of --cors sends Origin: https://gallery.songaday.world.
// Exit 0 pass, 1 fail.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { existingTiles, tileKey } from '../shared/layout.mjs';
import { PUBLISH } from './lib/env.mjs';
import { CURRENT_KEY } from './lib/manifest.mjs';
import { stillKey } from './lib/cells.mjs';
import { gifKey } from './lib/gifs.mjs';
import { BUCKETS, ORIGIN, PUBLIC_MEDIA, client, encodeKey, md5hex, publicFetch, readLedger, s3Client } from './lib/r2.mjs';
import { putItem } from './lib/sync.mjs';

const { values: args } = parseArgs({
  options: {
    cors: { type: 'boolean', default: false },
    conditional: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '32' },
    runs: { type: 'string', default: '8' },
    transport: { type: 'string', default: 'auto' },
    json: { type: 'boolean', default: false },
  },
});
const say = (msg) => args.json || console.log(msg);
const pick = (res) => ({
  status: res.status,
  cors: res.headers.get('access-control-allow-origin'),
  cache: res.headers.get('cf-cache-status'),
  cacheControl: res.headers.get('cache-control'),
  age: res.headers.get('age'),
});

// ---- --cors ----

export const CORS_TEST_KEY = 'test/cors-check.webp';

// Measured 2026-10-20, before the Transform Rule: after a request without Origin, a request with
// one was sometimes a cache HIT on the copy without the CORS header (the pitfall) and sometimes a
// MISS (the edge keeping a separate copy for `Vary: Origin`), depending on the URL and client. So
// the test doesn't rely on hitting that case. It passes when every response, with or without an
// Origin, carries Access-Control-Allow-Origin: * and at least one of them was a cache HIT on a copy
// stored without one: only the zone's Transform Rule can add the header there.
async function corsTest() {
  // A real 480x270 still, at a key nothing else uses. Each run adds a fresh query string, so it
  // gets its own edge cache entry (R2 ignores the query; Cloudflare's cache key includes it).
  const body = fs.readFileSync(path.join(PUBLISH, stillKey(1)));
  await putItem(client(args.transport), { bucket: 'media', key: CORS_TEST_KEY, body }, { ledger: readLedger() });
  const runs = [];
  for (let r = 0; r < Number(args.runs); r++) {
    const url = `${PUBLIC_MEDIA}/${encodeKey(CORS_TEST_KEY)}?cors-test=${Date.now().toString(36)}-${r}`;
    const get = async (step, headers) => {
      const res = await fetch(url, { headers });
      return { step, origin: headers.Origin ?? null, ...pick(res), bodyMatches: md5hex(Buffer.from(await res.arrayBuffer())) === md5hex(body) };
    };
    const steps = [await get('1 no Origin (seeds the cache)', {})];
    // The second header-less request should come from the cache: the copy without a CORS header.
    for (let i = 0; i < 3; i++) {
      const s = await get(`2 no Origin again`, {});
      steps.push(s);
      if (s.cache === 'HIT') break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    steps.push(await get('3 with Origin', { Origin: ORIGIN }));
    steps.push(await get('4 with another Origin', { Origin: 'https://example.com' }));
    runs.push({ url, steps, seeded: steps.some((s) => !s.origin && s.cache === 'HIT') });
  }
  const all = runs.flatMap((r) => r.steps);
  const good = all.every((s) => s.status === 200 && s.cors === '*' && s.bodyMatches);
  // A cached copy that R2 stored without the header, served with it.
  const fixedInCache = all.filter((s) => !s.origin && s.cache === 'HIT' && s.cors === '*').length;
  // The pitfall itself: step 3 is the first request with an Origin for its URL, so a HIT there
  // came from the copy cached without Origin.
  const exercised = runs.filter((r) => r.seeded && r.steps.find((s) => s.step.startsWith('3'))?.cache === 'HIT').length;
  const missing = all.filter((s) => s.cors !== '*').map((s) => `${s.step}${s.origin ? '' : ' (no Origin)'}`);
  return { status: !good ? 'fail' : fixedInCache ? 'pass' : 'inconclusive', runs, fixedInCache, exercised, missingCors: missing.length };
}

// ---- --conditional ----

async function conditionalTest() {
  const c = s3Client({ accountId: process.env.R2_ACCOUNT_ID, accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY });
  const key = 'test/conditional-check.json', bucket = BUCKETS.archive;
  const opts = (text) => ({ body: Buffer.from(text), contentType: 'application/json', cacheControl: 'no-store' });
  const attempt = async (name, text, cond) => {
    try {
      const { etag } = await c.put(bucket, key, { ...opts(text), ...cond });
      return { name, status: 200, etag };
    } catch (err) {
      return { name, status: err.status ?? err.message };
    }
  };
  const before = await c.head(bucket, key);
  const runs = [];
  const seed = `{"at":"${new Date().toISOString()}"}\n`;
  runs.push(await attempt('seed (If-Match current etag, or If-None-Match * when absent)', seed, before ? { ifMatch: before.etag } : { ifNoneMatch: '*' }));
  runs.push(await attempt('If-None-Match * on an existing key (expect 412)', '{"x":1}\n', { ifNoneMatch: '*' }));
  runs.push(await attempt('If-Match a wrong etag (expect 412)', '{"x":2}\n', { ifMatch: '00000000000000000000000000000000' }));
  runs.push(await attempt('If-Match the right etag (expect 200)', '{"x":3}\n', { ifMatch: md5hex(Buffer.from(seed)) }));
  const after = await c.head(bucket, key);
  const pass = runs[0].status === 200 && runs[1].status === 412 && runs[2].status === 412 && runs[3].status === 200 && after?.etag === md5hex(Buffer.from('{"x":3}\n'));
  return { status: pass ? 'pass' : 'fail', runs };
}

// ---- live wall ----

async function liveCheck() {
  const res = await publicFetch(CURRENT_KEY);
  if (!res.ok) return { status: 'fail', error: `${PUBLIC_MEDIA}/${CURRENT_KEY}: HTTP ${res.status}` };
  const m = await res.json();
  const keys = [{ key: `wall/${m.pyramid}/wall.json`, kind: 'descriptor' }];
  for (const { k, x, y } of existingTiles(m.songCount)) keys.push({ key: tileKey(k, x, y, m.songCount, m.overrides), kind: 'tile' });
  for (const key of [...(m.catalog?.index || []), ...(m.catalog?.detail || [])]) keys.push({ key, kind: 'catalog' });
  const noGif = new Set(m.noGif);
  for (let n = 1; n <= m.songCount; n++) {
    keys.push({ key: stillKey(n, m.stillRev?.[n] || 0), kind: 'still' });
    if (!noGif.has(n)) keys.push({ key: gifKey(n, m.gifRev?.[n] || 0), kind: 'gif' });
  }
  const tally = {}, bad = [];
  let next = 0, done = 0, last = Date.now();
  await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
    while (next < keys.length) {
      const it = keys[next++];
      let r;
      // A 5xx or a request that never got an answer (this machine's network) is tried again,
      // backing off for up to about a minute, so a short outage isn't reported as missing objects.
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt) await new Promise((res) => setTimeout(res, 2000 * 2 ** (attempt - 1)));
        try {
          r = pick(await publicFetch(it.key, { method: 'HEAD' }));
          if (r.status < 500) break;
        } catch (err) {
          r = { status: `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}` };
        }
      }
      const t = (tally[it.kind] ||= { n: 0, ok: 0, cache: {} });
      t.n++;
      t.cache[r.cache] = (t.cache[r.cache] || 0) + 1;
      if (r.status === 200 && r.cors === '*') t.ok++;
      else bad.push({ ...it, ...r });
      if (++done % 2000 === 0 || Date.now() - last > 15000) {
        last = Date.now();
        say(`  ${done}/${keys.length}`);
      }
    }
  }));
  return { status: bad.length ? 'fail' : 'pass', songCount: m.songCount, updatedAt: m.updatedAt, objects: keys.length, tally, bad: bad.slice(0, 50), badCount: bad.length };
}

let result;
try {
  result = args.cors ? await corsTest() : args.conditional ? await conditionalTest() : await liveCheck();
} catch (err) {
  result = { status: 'fail', error: err.message };
}
if (args.json) console.log(JSON.stringify(result));
else {
  const what = args.cors ? 'CORS gate' : args.conditional ? 'conditional PUT' : 'live wall';
  console.log(`r2:check ${what}: ${result.status.toUpperCase()}`);
  if (result.error) console.log(`  ${result.error}`);
  for (const run of result.runs || []) {
    if (!run.steps) continue;
    console.log(`  ${run.url}`);
    for (const s of run.steps) console.log(`    ${s.step.padEnd(30)} HTTP ${s.status}  ACAO ${s.cors ?? '-'}  cf-cache-status ${s.cache ?? '-'}${s.bodyMatches ? '' : '  BODY DIFFERS'}`);
  }
  if (args.cors && result.exercised != null) {
    console.log(`  responses without the CORS header: ${result.missingCors}`);
    console.log(`  cache HITs on a copy stored without Origin that still carried it: ${result.fixedInCache}`);
    console.log(`  runs where the Origin request itself was served from that copy: ${result.exercised} of ${result.runs.length}`);
    if (result.status === 'inconclusive') console.log('  every response had the header, but none was a cache HIT on a copy stored without Origin; rerun');
  }
  for (const r of result.runs || []) if (r.name) console.log(`  ${r.name}: ${r.status}`);
  if (result.tally) {
    console.log(`  songCount ${result.songCount} (manifest ${result.updatedAt}): ${result.objects} objects`);
    for (const [kind, t] of Object.entries(result.tally)) console.log(`  ${kind.padEnd(10)} ${t.ok}/${t.n} ok  cache ${JSON.stringify(t.cache)}`);
    for (const b of result.bad) console.log(`  BAD ${b.key}: HTTP ${b.status}, ACAO ${b.cors ?? 'missing'}`);
    if (result.badCount > result.bad.length) console.log(`  … and ${result.badCount - result.bad.length} more`);
  }
}
process.exitCode = result.status === 'pass' ? 0 : 1;
