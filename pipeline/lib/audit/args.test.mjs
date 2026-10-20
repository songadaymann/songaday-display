import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli } from './args.mjs';
import { expandPieces } from './audit.mjs';

test('defaults are offline, sampled and budgeted', () => {
  const o = parseCli([]);
  assert.equal(o.online, false);
  assert.equal(o.deep, false);
  assert.equal(o.pieces, undefined);
  assert.equal(o.budget, 200);
});

test('flags parse and bad values are refused', () => {
  const o = parseCli(['--from', '6000', '--to', '6010', '--pieces', 'gif, mosaic', '--deep', '--out', '/tmp/x', '--sample', '0.1']);
  assert.deepEqual([o.from, o.to, o.pieces, o.deep, o.out, o.sample], [6000, 6010, ['gif', 'mosaic'], true, '/tmp/x', 0.1]);
  assert.throws(() => parseCli(['--from', '10', '--to', '2']), /after/);
  assert.throws(() => parseCli(['--to', 'x']), /whole number/);
  assert.throws(() => parseCli(['--sample', '2']), /sample/);
  assert.throws(() => parseCli(['--bogus']));
});

test('expandPieces adds dependencies and keeps online pieces behind --online', () => {
  assert.deepEqual(expandPieces(['mosaic']), ['still', 'thumb', 'cell', 'art', 'mosaic']);
  assert.deepEqual(expandPieces(['youtube']), ['catalog', 'meta', 'youtube']);
  assert.ok(!expandPieces().includes('ipfs'));
  assert.throws(() => expandPieces(['ipfs']), /unknown piece/);
  assert.deepEqual(expandPieces(['ytlive'], { online: true }), ['catalog', 'meta', 'youtube', 'ytlive']);
});
