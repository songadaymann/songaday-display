import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO } from './env.mjs';
import { BUCKETS, CACHE_CURRENT, CACHE_IMMUTABLE, cacheControlFor, contentTypeFor, encodeKey, md5hex, planAll, planQueue, readLedger, recordUpload, signV4 } from './r2.mjs';
import { ConflictError, putItem, readQueue, rewriteQueue, runPhases } from './sync.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-r2-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The worked examples in AWS's "Signature Version 4 for Amazon S3" (header-based auth). These are
// AWS's published example credentials, not real ones; the ID is split so secret scanners skip it.
const AWS = {
  accessKeyId: 'AKIA' + 'IOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  date: new Date('2013-05-24T00:00:00Z'),
  host: 'examplebucket.s3.amazonaws.com',
};

test('signV4 matches the AWS GET Object example', () => {
  const h = signV4({ ...AWS, method: 'GET', uri: '/test.txt', headers: { Range: 'bytes=0-9' } });
  assert.equal(h.authorization, `AWS4-HMAC-SHA256 Credential=${AWS.accessKeyId}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
  assert.equal(h['x-amz-date'], '20130524T000000Z');
});

test('signV4 matches the AWS ListObjects example (query string)', () => {
  const h = signV4({ ...AWS, method: 'GET', uri: '/', query: { prefix: 'J', 'max-keys': '2' } });
  assert.match(h.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

test('keys are encoded per segment, RFC 3986 style', () => {
  assert.equal(encodeKey('wall/p1/0/16_42_6502-r1.webp'), 'wall/p1/0/16_42_6502-r1.webp');
  assert.equal(encodeKey("test/a b!(x)*'.gif"), 'test/a%20b%21%28x%29%2A%27.gif');
});

test('cache headers and types follow shared/README.md', () => {
  assert.equal(cacheControlFor('wall/current.json'), CACHE_CURRENT);
  for (const key of ['wall/p1/0/0_0_154.webp', 'wall/manifests/6502-cb9b7be8.json', 'stills/1.webp', 'gifs/1.gif', 'meta/index-0-3f2a9c1b.json', 'wall/p1/wall.json']) {
    assert.equal(cacheControlFor(key), CACHE_IMMUTABLE, key);
  }
  const readme = fs.readFileSync(path.join(REPO, 'shared/README.md'), 'utf8');
  assert.ok(readme.includes(`\`${CACHE_CURRENT}\``) && readme.includes(`\`${CACHE_IMMUTABLE}\``), 'shared/README.md names both Cache-Control values');
  assert.equal(contentTypeFor('gifs/1.gif'), 'image/gif');
  assert.equal(contentTypeFor('wall/current.json'), 'application/json');
  assert.throws(() => contentTypeFor('x/readme.txt'));
});

test('planQueue: each key once, history manifests after objects, current.json last and once', () => {
  const q = [
    { bucket: 'archive', key: 'cells/480x270/6501.webp' },
    { bucket: 'media', key: 'wall/p1/0/16_42_6501.webp' },
    { bucket: 'media', key: 'wall/manifests/6501-aaaaaaaa.json' },
    { bucket: 'media', key: 'wall/current.json' },
    { bucket: 'media', key: 'gifs/6000.gif' },
    { bucket: 'media', key: 'wall/manifests/6501-bbbbbbbb.json' },
    { bucket: 'media', key: 'wall/current.json' },
    { bucket: 'media', key: 'gifs/6000.gif' },
  ];
  const plan = planQueue(q);
  assert.deepEqual(plan.map((p) => p.name), ['objects', 'manifests', 'current']);
  assert.deepEqual(plan[0].items.map((i) => i.key), ['cells/480x270/6501.webp', 'wall/p1/0/16_42_6501.webp', 'gifs/6000.gif']);
  assert.equal(plan[1].items.length, 2);
  assert.equal(plan[2].items.length, 1);
});

test('planAll: commit order over the cache, unknown names skipped', () => {
  const cache = path.join(tmp, 'cache'), publish = path.join(cache, 'publish');
  const put = (rel) => {
    fs.mkdirSync(path.dirname(path.join(cache, rel)), { recursive: true });
    fs.writeFileSync(path.join(cache, rel), rel);
  };
  ['cells/480x270/10.webp', 'cells/480x270/9.webp', 'publish/stills/1.webp', 'publish/gifs/1.gif', 'publish/gifs/1-r1.gif', 'publish/gifs/1.gif.tmp-9',
    'publish/meta/index-0-3f2a9c1b.json', 'publish/wall/p1/1/0_0_154.webp', 'publish/wall/p1/0/0_0_154.webp', 'publish/wall/p1/wall.json',
    'publish/wall/manifests/154-cb9b7be8.json', 'publish/wall/manifests/154.json', 'publish/wall/current.json'].forEach(put);
  const { phases, skipped } = planAll({ cache, publish });
  assert.deepEqual(phases.map((p) => p.name), ['cells', 'stills', 'gifs', 'meta', 'tiles k0', 'tiles k1', 'wall.json', 'manifests', 'current']);
  assert.deepEqual(phases[0].items.map((i) => [i.bucket, i.key]), [['archive', 'cells/480x270/9.webp'], ['archive', 'cells/480x270/10.webp']]);
  assert.ok(phases.slice(1).every((p) => p.items.every((i) => i.bucket === 'media')));
  assert.deepEqual(skipped.sort(), ['gifs/1.gif.tmp-9', 'wall/manifests/154.json']);
  assert.equal(phases.at(-1).items[0].key, 'wall/current.json');
});

test('apiClient: wrangler token, refetched when it expires (400 code 9106); a dropped connection and a 429 wait and retry', async (t) => {
  const bin = path.join(tmp, 'fake-wrangler');
  const count = path.join(tmp, 'token-count');
  // Each `auth token --json` hands out a new token: t1, t2, ...
  fs.writeFileSync(bin, `#!/bin/sh\nn=$(($(cat "${count}" 2>/dev/null || echo 0) + 1)); echo $n > "${count}"; echo "{\\"type\\":\\"oauth\\",\\"token\\":\\"t$n\\"}"\n`, { mode: 0o755 });
  const { apiClient } = await import('./r2.mjs');
  const seen = [];
  const replies = [
    () => new Response('{"success":false,"errors":[{"code":9106,"message":"Missing X-Auth-Key, X-Auth-Email or Authorization headers"}]}', { status: 400 }),
    () => { throw new TypeError('fetch failed'); },
    () => new Response('', { status: 429, headers: { 'retry-after': '0.01' } }),
    () => new Response(JSON.stringify({ success: true, result: { etag: md5hex(Buffer.from('x')) } }), { status: 200 }),
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, cc: init.headers['cache-control'] });
    return replies.shift()();
  });
  const c = apiClient({ accountId: 'acct', bin, rate: 1000 });
  const r = await c.put('songaday-display-media', 'wall/p1/0/0_0_154.webp', { body: Buffer.from('x'), contentType: 'image/webp', cacheControl: CACHE_IMMUTABLE });
  assert.equal(r.etag, md5hex(Buffer.from('x')));
  assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/songaday-display-media/objects/wall/p1/0/0_0_154.webp');
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer t1', 'Bearer t2', 'Bearer t2', 'Bearer t2']);
  assert.equal(seen[3].cc, CACHE_IMMUTABLE);
});

test('readLedger keeps the last entry per key and skips a line cut short', () => {
  const state = path.join(tmp, 'ledger');
  const ledger = readLedger(state);
  recordUpload(ledger, { bucket: 'media', key: 'a.webp', md5: '1' }, state);
  recordUpload(ledger, { bucket: 'media', key: 'wall/current.json', md5: '2' }, state);
  recordUpload(ledger, { bucket: 'media', key: 'wall/current.json', md5: '3' }, state);
  fs.appendFileSync(path.join(state, 'r2-uploaded.jsonl'), '{"bucket":"media","key":"b.we');
  const again = readLedger(state);
  assert.equal(again.size, 2);
  assert.equal(again.get('media/wall/current.json').md5, '3');
});

// An in-memory R2 that honours If-Match / If-None-Match, with keys that can be made to fail.
function fakeR2() {
  const store = new Map(), puts = [], failing = new Set();
  return {
    kind: 'fake', store, puts, failing,
    async put(bucket, key, { body, ifMatch, ifNoneMatch }) {
      const id = `${bucket}/${key}`;
      if (failing.has(key)) throw Object.assign(new Error('boom'), { retryable: false });
      const cur = store.get(id);
      if (ifNoneMatch === '*' && cur) throw Object.assign(new Error('412'), { status: 412, retryable: false });
      if (ifMatch && (!cur || md5hex(cur) !== ifMatch)) throw Object.assign(new Error('412'), { status: 412, retryable: false });
      store.set(id, Buffer.from(body));
      puts.push(key);
      return { etag: md5hex(body) };
    },
    async head(bucket, key) {
      const cur = store.get(`${bucket}/${key}`);
      return cur ? { etag: md5hex(cur), size: cur.length } : null;
    },
  };
}

test('runPhases: a failure holds back the manifests; a rerun resumes and puts current.json last', async () => {
  const state = path.join(tmp, 'run');
  fs.mkdirSync(state, { recursive: true });
  const file = (name, text) => {
    const f = path.join(state, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const phases = () => [
    { name: 'objects', items: [{ bucket: 'media', key: 'wall/p1/0/0_0_1.webp', file: file('t.webp', 'tile') }, { bucket: 'media', key: 'gifs/1.gif', file: file('g.gif', 'gif') }] },
    { name: 'manifests', items: [{ bucket: 'media', key: 'wall/manifests/1-aaaaaaaa.json', file: file('h.json', 'm1') }] },
    { name: 'current', items: [{ bucket: 'media', key: 'wall/current.json', body: Buffer.from('m1') }] },
  ];
  const r2 = fakeR2();
  const ledger = readLedger(state);
  r2.failing.add('gifs/1.gif');
  const first = await runPhases(r2, phases(), { ledger, state, delayMs: 1 });
  assert.equal(first.failed.length, 1);
  assert.deepEqual(first.skippedPhases, ['manifests', 'current']);
  assert.ok(!r2.store.has(`${BUCKETS.media}/wall/current.json`));

  r2.failing.clear();
  const second = await runPhases(r2, phases(), { ledger: readLedger(state), state, delayMs: 1 });
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.length, 1); // the tile, from the ledger
  assert.equal(r2.puts.at(-1), 'wall/current.json');
  assert.deepEqual(r2.puts, ['wall/p1/0/0_0_1.webp', 'gifs/1.gif', 'wall/manifests/1-aaaaaaaa.json', 'wall/current.json']);
});

test('putItem refuses new bytes for a published key, and a current.json someone else wrote', async () => {
  const state = path.join(tmp, 'conflict');
  fs.mkdirSync(state, { recursive: true });
  const r2 = fakeR2();
  const ledger = readLedger(state);
  const f = path.join(state, 'x.webp');
  fs.writeFileSync(f, 'one');
  await putItem(r2, { bucket: 'media', key: 'stills/1.webp', file: f }, { ledger, state });
  fs.writeFileSync(f, 'two');
  await assert.rejects(putItem(r2, { bucket: 'media', key: 'stills/1.webp', file: f }, { ledger, state }), ConflictError);

  await putItem(r2, { bucket: 'media', key: 'wall/current.json', body: Buffer.from('v1') }, { ledger, state });
  r2.store.set(`${BUCKETS.media}/wall/current.json`, Buffer.from('someone else'));
  await assert.rejects(putItem(r2, { bucket: 'media', key: 'wall/current.json', body: Buffer.from('v2') }, { ledger, state }), /someone else published/);
  const forced = await putItem(r2, { bucket: 'media', key: 'wall/current.json', body: Buffer.from('v2') }, { ledger, state, force: true });
  assert.equal(forced.status, 'uploaded');
  // Already live with these bytes: nothing to send.
  assert.equal((await putItem(r2, { bucket: 'media', key: 'wall/current.json', body: Buffer.from('v2') }, { ledger, state })).status, 'skipped');
});

test('rewriteQueue keeps what failed plus what was appended meanwhile', () => {
  const state = path.join(tmp, 'queue'), cache = path.join(tmp, 'qcache');
  fs.mkdirSync(state, { recursive: true });
  const line = (key) => JSON.stringify({ at: 't', songId: 1, bucket: 'media', key, file: `publish/${key}` });
  fs.writeFileSync(path.join(state, 'pending-uploads.jsonl'), `${line('a.webp')}\n${line('b.webp')}\n`);
  const snapshot = readQueue(state, cache);
  assert.equal(snapshot.items[0].file, path.join(cache, 'publish/a.webp'));
  fs.appendFileSync(path.join(state, 'pending-uploads.jsonl'), `${line('c.webp')}\n`);
  const r = rewriteQueue({ state, snapshot, isDone: (it) => it.key === 'a.webp' });
  assert.deepEqual(r, { kept: 1, appended: 1 });
  assert.equal(fs.readFileSync(path.join(state, 'pending-uploads.jsonl'), 'utf8'), `${line('b.webp')}\n${line('c.webp')}\n`);
});
