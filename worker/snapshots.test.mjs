import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshots } from './snapshots.js';
import { fakeCache } from './testing.mjs';

const T = { fresh: 1000, keep: 10_000 };

function setup({ cache = fakeCache(), store = { memory: new Map(), inflight: new Map() } } = {}) {
  let t = 1_000_000;
  const waits = [];
  const snaps = createSnapshots({ cache, origin: 'https://g.example', now: () => t, waitUntil: (p) => waits.push(p), store, log: { warn() {} } });
  return { snaps, cache, store, waits, tick: (ms) => (t += ms) };
}

test('loads once, then serves fresh copies from memory', async () => {
  const s = setup();
  let loads = 0;
  const load = async () => ++loads;
  assert.deepEqual(await s.snaps.get('k', T, load), { at: 1_000_000, data: 1, stale: false });
  s.tick(999);
  assert.equal((await s.snaps.get('k', T, load)).data, 1);
  assert.equal(loads, 1);
  assert.ok(s.cache.entries.has('https://g.example/__snapshots/k'));
});

test('a stale copy is served while one background refresh runs', async () => {
  const s = setup();
  let loads = 0;
  const load = async () => ++loads;
  await s.snaps.get('k', T, load);
  s.tick(1500);
  const r = await s.snaps.get('k', T, load);
  assert.deepEqual([r.data, r.stale], [1, true]);
  await s.snaps.get('k', T, load); // still stale; the refresh is already running or locked
  await Promise.all(s.waits);
  assert.equal(loads, 2);
  assert.deepEqual([(await s.snaps.get('k', T, load)).data, (await s.snaps.get('k', T, load)).stale], [2, false]);
});

test('past keep, the caller waits for a new copy', async () => {
  const s = setup();
  let loads = 0;
  await s.snaps.get('k', T, async () => ++loads);
  s.tick(10_001);
  const r = await s.snaps.get('k', T, async () => ++loads);
  assert.deepEqual([r.data, r.stale], [2, false]);
  assert.equal(s.waits.length, 0);
});

test('concurrent misses share one load', async () => {
  const s = setup();
  let loads = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const load = async () => (await gate, ++loads);
  const all = Promise.all([s.snaps.get('k', T, load), s.snaps.get('k', T, load), s.snaps.get('k', T, load)]);
  release();
  assert.deepEqual((await all).map((r) => r.data), [1, 1, 1]);
  assert.equal(loads, 1);
});

test('another isolate (empty memory) picks the copy up from the Cache API', async () => {
  const cache = fakeCache();
  const a = setup({ cache });
  await a.snaps.get('k', T, async () => 'from-a');
  const b = setup({ cache });
  assert.equal((await b.snaps.get('k', T, async () => 'from-b')).data, 'from-a');
});

test('a failed load is not cached; a failed background refresh keeps the stale copy', async () => {
  const s = setup();
  await assert.rejects(s.snaps.get('k', T, async () => {
    throw new Error('down');
  }));
  assert.equal((await s.snaps.get('k', T, async () => 'ok')).data, 'ok');
  s.tick(1500);
  const r = await s.snaps.get('k', T, async () => {
    throw new Error('down again');
  });
  assert.deepEqual([r.data, r.stale], ['ok', true]);
  await Promise.all(s.waits);
  assert.equal((await s.snaps.get('k', T, async () => 'unused')).data, 'ok');
});

test('works with no Cache API at all (workers.dev)', async () => {
  const s = setup({ cache: null });
  let loads = 0;
  await s.snaps.get('k', T, async () => ++loads);
  await s.snaps.get('k', T, async () => ++loads);
  assert.equal(loads, 1);
});

test('ENS batches have their own pool and can never evict the market snapshot', async () => {
  const s = setup({ cache: null });
  let crawls = 0;
  await s.snaps.get('market/listings/c', T, async () => ++crawls);
  for (let i = 0; i < 300; i++) await s.snaps.get(`ens/0x${i}`, T, async () => i);
  assert.equal((await s.snaps.get('market/listings/c', T, async () => ++crawls)).data, 1);
  assert.equal(crawls, 1);
  assert.equal(s.store.memory.size, 1);
  assert.equal(s.store.ens.size, 256);
});

test('memory is least-recently-used: a hit keeps an entry', async () => {
  const s = setup({ cache: null });
  let loads = 0;
  const load = async () => ++loads;
  await s.snaps.get('market/a', T, load);
  for (let i = 0; i < 63; i++) await s.snaps.get(`chain/${i}`, T, load);
  await s.snaps.get('market/a', T, load); // touched: now the most recent
  await s.snaps.get('chain/new', T, load); // evicts chain/0, the oldest
  assert.equal(loads, 65);
  await s.snaps.get('market/a', T, load);
  assert.equal(loads, 65);
  await s.snaps.get('chain/0', T, load);
  assert.equal(loads, 66);
});

test('a KV binding keeps snapshots across isolates, but not ENS batches', async () => {
  const data = new Map();
  const kv = {
    async get(key, type) {
      return data.has(key) ? (type === 'json' ? JSON.parse(data.get(key)) : data.get(key)) : null;
    },
    async put(key, value, opts) {
      assert.ok(opts.expirationTtl >= 60);
      data.set(key, value);
    },
  };
  const make = () => createSnapshots({ cache: null, kv, origin: 'https://g.example', now: () => 1_000_000, store: { memory: new Map(), inflight: new Map() }, log: { warn() {} } });
  await make().get('market/listings/c', T, async () => 'crawled');
  await make().get('ens/0xabc', T, async () => 'names');
  assert.deepEqual([...data.keys()], ['snapshots/market/listings/c']);
  assert.equal((await make().get('market/listings/c', T, async () => 'crawled again')).data, 'crawled');
});
