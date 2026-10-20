import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits, formatPrice, shortAddress, timeAgo, updatedAgo, plural, openSeaItem, indexHolders } from './format.js';

test('formatUnits rounds exactly with BigInt', () => {
  assert.equal(formatUnits('50000000000000000', 18, 4), '0.05');
  assert.equal(formatUnits('1234567890000000000', 18, 4), '1.2346');
  assert.equal(formatUnits('999990000000000000', 18, 4), '1');
  assert.equal(formatUnits('12000000000000000000000', 18, 4), '12,000');
  assert.equal(formatUnits('1', 18, 4), '0');
  assert.equal(formatUnits('1500000', 6, 2), '1.5');
  assert.equal(formatUnits('7', 0, 4), '7');
});

test('formatPrice', () => {
  assert.equal(formatPrice({ value: '50000000000000000', decimals: 18, currency: 'ETH' }), '0.05 ETH');
  assert.equal(formatPrice({ value: '20000000000000', decimals: 18, currency: 'WETH' }), '<0.0001 WETH');
  assert.equal(formatPrice({ value: '0', decimals: 18, currency: 'ETH' }), '0 ETH');
  assert.equal(formatPrice({ value: '123456789', decimals: 6, currency: 'USDC' }), '123.46 USDC');
  assert.equal(formatPrice(null), '');
  assert.equal(formatPrice({ value: 'x' }), '');
});

test('shortAddress, plural, links', () => {
  assert.equal(shortAddress('0x19b703f65aa7e1e775bd06c2aa0d0d08c80f1c45'), '0x19b7…1c45');
  assert.equal(shortAddress('abc'), 'abc');
  assert.equal(plural(1, 'song'), '1 song');
  assert.equal(plural(1234, 'song'), '1,234 songs');
  assert.equal(openSeaItem('0xabc', 6501), 'https://opensea.io/assets/ethereum/0xabc/6501');
});

test('timeAgo', () => {
  const now = 1_760_000_000_000;
  const s = now / 1000;
  assert.equal(timeAgo(s, now), 'just now');
  assert.equal(timeAgo(s + 100, now), 'just now'); // clock skew
  assert.equal(timeAgo(s - 5 * 60, now), '5m ago');
  assert.equal(timeAgo(s - 3 * 3600, now), '3h ago');
  assert.equal(timeAgo(s - 3 * 86400, now), '3d ago');
  assert.equal(timeAgo(s - 70 * 86400, now), '2mo ago');
  assert.equal(timeAgo(s - 800 * 86400, now), '2y ago');
  assert.equal(updatedAgo(new Date(now - 4 * 60_000).toISOString(), now), 'updated 4m ago');
  assert.equal(updatedAgo('nope', now), '');
});

test('indexHolders: owners, counts, minted', () => {
  const A = '0xaa';
  const h = indexHolders({ contract: '0xc', checked: { from: 1, to: 10 }, minted: 3, unminted: [1, 4, 5, 6, 7, 8, 9], holders: [{ address: A, tokens: [2, 3] }, { address: '0xbb', tokens: [10] }] });
  assert.equal(h.owner(3), A);
  assert.equal(h.owner(4), null);
  assert.equal(h.count(A), 2);
  assert.deepEqual(h.tokensOf('0xbb'), [10]);
  assert.equal(h.isMinted(2), true);
  assert.equal(h.isMinted(1), false);
  assert.equal(h.isMinted(11), false); // never checked
  assert.equal(h.minted, 3);
  const empty = indexHolders(null);
  assert.equal(empty.isMinted(1), false);
  assert.equal(empty.owner(1), null);
});
