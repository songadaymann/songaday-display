import test from 'node:test';
import assert from 'node:assert/strict';
import { bestListings, marketSummary, normalizeListing, normalizeSale, recentSales, comparePrices, tokenNumber } from './market.js';
import { openSeaClient } from './opensea.js';
import { listing, sale } from './testing.mjs';

const C = '0x19b703f65aa7e1e775bd06c2aa0d0d08c80f1c45';
const NOW = 1_760_000_000;

test('token numbers are positive integers', () => {
  assert.equal(tokenNumber('6501'), 6501);
  assert.equal(tokenNumber(42), 42);
  for (const bad of ['0', '-1', '1.5', '', null, '1e3', '12345678', 'abc']) assert.equal(tokenNumber(bad), null, String(bad));
});

test('prices: ETH and WETH by value, other currencies after', () => {
  const p = (value, currency = 'ETH') => ({ value: String(value), decimals: 18, currency });
  const sorted = [p(5), p(1, 'USDC'), p(3, 'WETH'), p(4)].sort(comparePrices);
  assert.deepEqual(sorted.map((x) => x.currency + x.value), ['WETH3', 'ETH4', 'ETH5', 'USDC1']);
  // bigger than a double can hold exactly
  assert.ok(comparePrices(p('100000000000000000001'), p('100000000000000000000')) > 0);
});

test('a listing normalizes from protocol_data or asset', () => {
  const l = listing(77, 123, { contract: C });
  assert.deepEqual(normalizeListing(l, C, NOW), {
    n: 77,
    price: { value: '123', decimals: 18, currency: 'ETH' },
    maker: '0x' + 'ab'.repeat(20),
    expires: 9999999999,
  });
  const viaAsset = { asset: { contract: C.toUpperCase().replace('0X', '0x'), identifier: '78' }, price: { current: { value: '5', decimals: 18, currency: 'ETH' } } };
  assert.equal(normalizeListing(viaAsset, C, NOW).n, 78);
  assert.equal(normalizeListing({ ...l, status: 'CANCELLED' }, C, NOW), null);
  assert.equal(normalizeListing(listing(77, 1, { contract: C, endTime: String(NOW) }), C, NOW), null);
  assert.equal(normalizeListing(listing(77, 1, { contract: '0x' + '00'.repeat(20) }), C, NOW), null);
  assert.equal(normalizeListing({ price: { current: { value: '1' } } }, C, NOW), null);
  assert.equal(normalizeListing(listing(77, 'NaN', { contract: C }), C, NOW), null);
});

test('one cheapest listing per song, cheapest first; summary counts songs', () => {
  const raw = [
    listing(3, 9e16, { contract: C }),
    listing(1, 5e16, { contract: C }),
    listing(3, 2e16, { contract: C }),
    listing(2, 5e16, { contract: C }),
    listing(4, 1, { contract: C, currency: 'USDC' }),
  ];
  const best = bestListings(raw, C, NOW);
  assert.deepEqual(best.map((l) => [l.n, l.price.value]), [[3, '20000000000000000'], [1, '50000000000000000'], [2, '50000000000000000'], [4, '1']]);
  const sum = marketSummary(best);
  assert.equal(sum.listed, 4);
  assert.deepEqual(sum.tokens, [1, 2, 3, 4]);
  assert.equal(sum.floor.value, '20000000000000000');
  assert.deepEqual(marketSummary([]), { listed: 0, tokens: [], floor: null });
});

test('sales: event_type sale only, this contract only, newest first', () => {
  const events = [
    sale(5, 1e16, 100, { contract: C }),
    sale(6, 2e16, 300, { contract: C }),
    sale(7, 3e16, 200, { contract: C, type: 'transfer' }),
    sale(8, 3e16, 400, { contract: '0x' + '00'.repeat(20) }),
    { event_type: 'sale', nft: null },
  ];
  const out = recentSales(events, C);
  assert.deepEqual(out.map((s) => s.n), [6, 5]);
  assert.deepEqual(normalizeSale(events[0], C), {
    n: 5,
    price: { value: '10000000000000000', decimals: 18, currency: 'ETH' },
    seller: '0x' + '11'.repeat(20),
    buyer: '0x' + '22'.repeat(20),
    time: 100,
    tx: '0x' + 'cd'.repeat(32),
  });
});

test('the listings crawl follows `next` and stops at maxPages', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(new URL(url).searchParams.get('next'));
    const i = seen.length;
    return Response.json({ listings: [{ i }], next: `c${i}` }); // never ends
  };
  const os = openSeaClient({ apiKey: 'k', fetch, sleep: async () => {} });
  const r = await os.allListings('song-a-day', { maxPages: 3 });
  assert.equal(r.listings.length, 3);
  assert.equal(r.complete, false);
  assert.deepEqual(seen, [null, 'c1', 'c2']);
});

test('the crawl stops if OpenSea repeats a cursor', async () => {
  let calls = 0;
  const fetch = async () => (calls++, Response.json({ listings: [{}], next: 'same' }));
  const os = openSeaClient({ apiKey: 'k', fetch, sleep: async () => {} });
  const r = await os.allListings('x', { maxPages: 10 });
  assert.equal(calls, 2);
  assert.equal(r.complete, true);
});

test('429 is retried with Retry-After (capped), then succeeds', async () => {
  const sleeps = [];
  let calls = 0;
  const fetch = async () => (++calls < 3 ? new Response('', { status: 429, headers: { 'Retry-After': calls === 1 ? '30' : '' } }) : Response.json({ asset_events: [] }));
  const os = openSeaClient({ apiKey: 'k', fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(await os.recentSales('x'), []);
  assert.deepEqual(sleeps, [5000, 1000]);
});
