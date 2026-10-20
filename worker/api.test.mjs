import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi, ROUTES, readConfig, crossOrigin, TIMES } from './api.js';
import { memoryLimiter } from './ratelimit.js';
import { fakeCache, fakeNode, fakeOpenSea, fetchBoth, listing, sale } from './testing.mjs';

const ORIGIN = 'https://gallery.example';
const CONTRACT = '0x19b703f65aa7e1e775bd06c2aa0d0d08c80f1c45';
const NOW = Date.UTC(2026, 9, 20, 12); // song 6502's day
const RPC = 'https://rpc.example/v2/SECRET-RPC-KEY';
const ENV = { SAD_CONTRACT_ADDRESS: '0x19b703f65aA7E1E775BD06c2aa0D0d08c80f1C45', OPENSEA_API_KEY: 'SECRET-OS-KEY', MAINNET_RPC_URL: RPC };

function setup({ env = ENV, node = fakeNode({ url: RPC }), openSea = fakeOpenSea(), now = () => NOW, limiter } = {}) {
  const waits = [];
  const logs = [];
  const deps = {
    fetch: fetchBoth(node, openSea),
    cache: fakeCache(),
    now,
    waitUntil: (p) => waits.push(p),
    store: { memory: new Map(), inflight: new Map() },
    limiter: limiter || memoryLimiter({ now }),
    sleep: async () => {},
    log: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
  };
  const call = (path, init = {}) => handleApi(new Request(ORIGIN + path, init), env, deps);
  const get = async (path, headers = {}) => {
    const res = await call(path, { headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } });
    return { res, body: await res.json() };
  };
  return { call, get, deps, waits, logs, node, openSea };
}

test('only the five routes exist', async () => {
  assert.deepEqual(Object.keys(ROUTES).sort(), ['/api/ens', '/api/holders', '/api/market/listings', '/api/market/sales', '/api/market/summary']);
  const { get } = setup();
  for (const path of ['/api', '/api/', '/api/market', '/api/market/summary/', '/api/holders/x', '/api/opensea/listings', '/api/__proto__', '/api/constructor', '/api/toString']) {
    const { res, body } = await get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(body, { error: 'not found' });
  }
});

test('GET only', async () => {
  const { call } = setup();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const res = await call('/api/market/summary', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'GET');
  }
});

test('same-origin only, and never any CORS headers', async () => {
  const { get } = setup({ env: {} });
  assert.equal((await get('/api/holders', { Origin: 'https://evil.example' })).res.status, 403);
  assert.equal((await get('/api/holders', { 'Sec-Fetch-Site': 'cross-site' })).res.status, 403);
  assert.equal((await get('/api/holders', { 'Sec-Fetch-Site': 'same-site' })).res.status, 403);
  const ok = await get('/api/holders', { Origin: ORIGIN });
  assert.equal(ok.res.status, 503); // got past the origin check
  assert.equal(ok.res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(ok.res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  const url = new URL(ORIGIN);
  assert.equal(crossOrigin(new Request(ORIGIN + '/api/ens'), url), false); // curl: no headers
  assert.equal(crossOrigin(new Request(ORIGIN + '/api/ens', { headers: { 'Sec-Fetch-Site': 'none' } }), url), false);
});

test('missing secrets: every route answers 503 not configured, with no upstream call', async () => {
  const cases = [
    [{}, Object.keys(ROUTES)],
    [{ SAD_CONTRACT_ADDRESS: ENV.SAD_CONTRACT_ADDRESS }, Object.keys(ROUTES)],
    [{ ...ENV, OPENSEA_API_KEY: '' }, ['/api/market/summary', '/api/market/listings', '/api/market/sales']],
    [{ ...ENV, MAINNET_RPC_URL: undefined }, ['/api/holders', '/api/ens']],
    [{ ...ENV, SAD_CONTRACT_ADDRESS: 'not-an-address' }, ['/api/market/summary', '/api/holders']],
  ];
  for (const [env, paths] of cases) {
    const s = setup({ env });
    for (const path of paths) {
      const q = path === '/api/ens' ? '?addresses=0x' + '11'.repeat(20) : '';
      const { res, body } = await s.get(path + q);
      assert.equal(res.status, 503, `${path} ${JSON.stringify(env)}`);
      assert.deepEqual(body, { error: 'not configured' });
    }
    assert.equal(s.node.log.length + s.openSea.log.length, 0);
  }
});

test('ENS without a contract still works (it only needs the RPC)', async () => {
  const a = '0x' + 'aa'.repeat(20);
  const s = setup({ env: { MAINNET_RPC_URL: RPC }, node: fakeNode({ url: RPC, names: { [a]: 'song.eth' } }) });
  const { res, body } = await s.get(`/api/ens?addresses=${a}`);
  assert.equal(res.status, 200);
  assert.equal(body.names[a], 'song.eth');
});

test('rate limit: 429 past the per-IP limit, counted per IP', async () => {
  const limiter = memoryLimiter({ limit: 3, window: 60_000, now: () => NOW });
  const s = setup({ env: {}, limiter });
  const as = (ip) => s.get('/api/holders', { 'CF-Connecting-IP': ip });
  for (let i = 0; i < 3; i++) assert.equal((await as('1.1.1.1')).res.status, 503);
  const blocked = await as('1.1.1.1');
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.res.headers.get('Retry-After'), '60');
  assert.equal((await as('2.2.2.2')).res.status, 503);
});

test('rate limit uses the binding when present', async () => {
  const keys = [];
  const env = { API_RATE_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: false }) } };
  const s = setup({ env });
  assert.equal((await s.get('/api/holders', { 'CF-Connecting-IP': '9.9.9.9' })).res.status, 429);
  assert.deepEqual(keys, ['9.9.9.9']);
});

test('market: summary, listings and sales from one crawl, cached', async () => {
  const other = '0x' + '99'.repeat(20);
  const openSea = fakeOpenSea({
    pages: [
      [listing(10, 5e16, { contract: CONTRACT }), listing(11, 2e16, { contract: CONTRACT }), listing(10, 3e16, { contract: CONTRACT })],
      [listing(12, 1e18, { contract: CONTRACT, currency: 'USDC' }), listing(13, 1e15, { contract: other }), listing(14, 1e15, { contract: CONTRACT, endTime: '100' })],
    ],
    events: [sale(10, 4e16, 1_760_000_000, { contract: CONTRACT }), sale(11, 1, 1_760_000_500, { contract: CONTRACT, type: 'transfer' }), sale(12, 7e16, 1_760_000_900, { contract: CONTRACT })],
  });
  const s = setup({ openSea });
  const sum = await s.get('/api/market/summary');
  assert.equal(sum.res.status, 200);
  assert.equal(sum.body.listed, 3);
  assert.deepEqual(sum.body.tokens, [10, 11, 12]);
  assert.deepEqual(sum.body.floor, { value: '20000000000000000', decimals: 18, currency: 'ETH' });
  assert.equal(sum.body.complete, true);
  assert.equal(sum.body.stale, false);
  assert.equal(sum.body.contract, CONTRACT);
  assert.equal(sum.res.headers.get('Cache-Control'), 'public, max-age=60');

  const list = await s.get('/api/market/listings');
  assert.deepEqual(list.body.listings.map((l) => [l.n, l.price.value]), [[11, '20000000000000000'], [10, '30000000000000000'], [12, '1000000000000000000']]);
  // one slug lookup and two listing pages for both calls
  const paths = s.openSea.log.map((l) => l.url.pathname + (l.url.searchParams.get('next') || ''));
  assert.deepEqual(paths, [`/api/v2/chain/ethereum/contract/${CONTRACT}`, '/api/v2/listings/collection/song-a-day/all', '/api/v2/listings/collection/song-a-day/allp1']);
  assert.ok(s.openSea.log.every((l) => l.key === 'SECRET-OS-KEY'));
  assert.equal(s.openSea.log[1].url.searchParams.get('limit'), '200');

  const sales = await s.get('/api/market/sales?limit=5');
  assert.deepEqual(sales.body.sales.map((x) => x.n), [12, 10]); // newest first, transfers dropped
  assert.equal(s.openSea.log.at(-1).url.searchParams.get('event_type'), 'sale');
  assert.equal((await s.get('/api/market/sales?limit=1')).body.sales.length, 1);
  assert.equal(s.openSea.log.filter((l) => l.url.pathname.includes('/events/')).length, 1);
  assert.equal((await s.get('/api/market/sales?limit=0')).res.status, 400);
  assert.equal((await s.get('/api/market/sales?limit=abc')).res.status, 400);
});

test('stale snapshots are served at once and refreshed in the background', async () => {
  let t = NOW;
  const openSea = fakeOpenSea({ pages: [[listing(10, 5e16, { contract: CONTRACT })]] });
  const s = setup({ openSea, now: () => t });
  await s.get('/api/market/summary');
  const crawls = () => s.openSea.log.filter((l) => l.url.pathname.endsWith('/all')).length;
  assert.equal(crawls(), 1);
  t += TIMES.listings.fresh + 1;
  const stale = await s.get('/api/market/summary');
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.updatedAt, new Date(NOW).toISOString());
  assert.equal(s.waits.length, 1);
  await Promise.all(s.waits);
  assert.equal(crawls(), 2);
  assert.equal((await s.get('/api/market/summary')).body.stale, false);
});

test('upstream failures are a 502 with nothing secret in the body or the logs', async () => {
  const s = setup({ openSea: fakeOpenSea({ status: 500 }), node: fakeNode({ url: RPC, fail: () => new Response('boom ' + RPC, { status: 500 }) }) });
  for (const path of ['/api/market/summary', '/api/holders', `/api/ens?addresses=0x${'11'.repeat(20)}`]) {
    const { res, body } = await s.get(path);
    assert.equal(res.status, 502, path);
    assert.deepEqual(body, { error: 'upstream unavailable' });
  }
  const text = s.logs.join('\n');
  assert.ok(s.logs.length >= 3);
  assert.ok(!text.includes('SECRET'), text);
  // OpenSea 5xx is retried, then given up on
  assert.equal(s.openSea.log.length, 4);
});

test('OpenSea 4xx is not retried', async () => {
  const s = setup({ openSea: fakeOpenSea({ status: 401 }) });
  assert.equal((await s.get('/api/market/listings')).res.status, 502);
  assert.equal(s.openSea.log.length, 1);
});

test('holders: ownerOf for 1..tomorrow, batched, one block, cached an hour', async () => {
  const A = '0x' + 'a1'.repeat(20);
  const B = '0x' + 'b2'.repeat(20);
  const node = fakeNode({ url: RPC, owners: { 2: A, 3: B, 4: A, 501: A, 6502: B } });
  const s = setup({ node });
  const { res, body } = await s.get('/api/holders');
  assert.equal(res.status, 200);
  assert.equal(body.checked.to, 6503);
  assert.equal(body.minted, 5);
  assert.equal(body.unminted.length, 6503 - 5);
  assert.ok(body.unminted.includes(1) && body.unminted.includes(6503) && !body.unminted.includes(501));
  assert.deepEqual(body.holders, [{ address: A, tokens: [2, 4, 501] }, { address: B, tokens: [3, 6502] }]);
  assert.equal(body.block, 0x1234);
  assert.equal(body.contract, CONTRACT);
  const calls = node.log.filter((r) => r.method === 'eth_call');
  assert.equal(calls.length, 14); // ceil(6503 / 500)
  assert.ok(calls.every((r) => r.params[1] === '0x1234' && r.params[0].to === '0xcA11bde05977b3631167028862bE2a173976CA11'));
  await s.get('/api/holders');
  assert.equal(node.log.filter((r) => r.method === 'eth_call').length, 14);
});

test('ens: validates, caps at 50, verifies names, survives a reverting resolver', async () => {
  const a = '0x' + 'aa'.repeat(20);
  const b = '0x' + 'bb'.repeat(20);
  const c = '0x' + 'cc'.repeat(20);
  const node = fakeNode({ url: RPC, names: { [a]: 'jonathanmann.eth', [b]: 'bad name with spaces' }, reverting: [c] });
  const s = setup({ node });
  const { res, body } = await s.get(`/api/ens?addresses=${c.toUpperCase().replace('0X', '0x')}, ${a},${b},${a}`);
  assert.equal(res.status, 200);
  assert.deepEqual(body.names, { [a]: 'jonathanmann.eth', [b]: null, [c]: null });
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
  // same set in another order: cache hit
  await s.get(`/api/ens?addresses=${b},${c},${a}`);
  assert.equal(node.log.length, 1);

  const many = Array.from({ length: 51 }, (_, i) => '0x' + i.toString(16).padStart(40, '0')).join(',');
  for (const q of ['', '?addresses=', `?addresses=${many}`, '?addresses=0x123', '?addresses=vitalik.eth']) {
    const r = await s.get('/api/ens' + q);
    assert.equal(r.res.status, 400, q);
  }
});

test('config: OpenSea base may only be swapped for a local mock', () => {
  assert.equal(readConfig({ OPENSEA_API_BASE: 'http://127.0.0.1:8788/api/v2/' }).openSeaBase, 'http://127.0.0.1:8788/api/v2');
  assert.equal(readConfig({ OPENSEA_API_BASE: 'https://evil.example/api/v2' }).openSeaBase, 'https://api.opensea.io/api/v2');
  assert.equal(readConfig({ OPENSEA_SLUG: '../x' }).slug, null);
  assert.equal(readConfig({ OPENSEA_MAX_PAGES: '999' }).maxPages, 40);
});
