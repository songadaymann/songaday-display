import test from 'node:test';
import assert from 'node:assert/strict';
import { readHolders, holdersFrom, latestSong, maxTokenAt, MULTICALL3 } from './holders.js';
import { reverseNames, parseAddresses, cleanName } from './ens.js';
import { rpcClient, pool } from './rpc.js';
import { decodeAggregate3Calls, fakeNode } from './testing.mjs';

const C = '0x19b703f65aa7e1e775bd06c2aa0d0d08c80f1c45';
const A = '0x' + 'a1'.repeat(20);

test('song numbers by date: 2026-10-20 is #6502', () => {
  assert.equal(latestSong(Date.UTC(2009, 0, 1)), 1);
  assert.equal(latestSong(Date.UTC(2009, 0, 1, 23, 59)), 1);
  assert.equal(latestSong(Date.UTC(2026, 9, 20, 0, 0)), 6502);
  assert.equal(maxTokenAt(Date.UTC(2026, 9, 20, 23)), 6503);
});

test('holders from owners: unminted, grouping, ordering', () => {
  const owners = [null, null, A, '0x' + 'b2'.repeat(20), A, null];
  assert.deepEqual(holdersFrom(owners, { contract: C, block: 7, maxToken: 5 }), {
    contract: C,
    block: 7,
    checked: { from: 1, to: 5 },
    minted: 3,
    unminted: [1, 5],
    holders: [{ address: A, tokens: [2, 4] }, { address: '0x' + 'b2'.repeat(20), tokens: [3] }],
  });
});

test('readHolders: one aggregate3 per batch, each call is ownerOf(n) on the contract', async () => {
  const node = fakeNode({ owners: { 1: A, 7: A } });
  const call = rpcClient(node.url, { fetch: node.fetch });
  const out = await readHolders({ call, contract: C, maxToken: 7, batch: 3, concurrency: 2 });
  assert.deepEqual(out.holders, [{ address: A, tokens: [1, 7] }]);
  assert.deepEqual(out.unminted, [2, 3, 4, 5, 6]);
  const ethCalls = node.log.filter((r) => r.method === 'eth_call');
  assert.equal(ethCalls.length, 3); // 1-3, 4-6, 7
  const decoded = ethCalls.map((r) => decodeAggregate3Calls(r.params[0].data));
  assert.deepEqual(decoded.map((d) => d.length).sort(), [1, 3, 3]);
  for (const d of decoded) {
    for (const c of d) {
      assert.equal(c.target, C);
      assert.equal(c.allowFailure, true);
      assert.match(c.callData, /^0x6352211e[0-9a-f]{64}$/);
    }
  }
  assert.ok(ethCalls.every((r) => r.params[0].to === MULTICALL3 && r.params[1] === '0x1234'));
});

test('readHolders fails whole rather than returning partial owners', async () => {
  const node = fakeNode({ owners: { 1: A } });
  let n = 0;
  const secondCallFails = async (url, init) => {
    if (JSON.parse(init.body).method === 'eth_call' && ++n === 2) return new Response('', { status: 503 });
    return node.fetch(url, init);
  };
  const call = rpcClient(node.url, { fetch: secondCallFails });
  await assert.rejects(readHolders({ call, contract: C, maxToken: 9, batch: 3, concurrency: 1 }), /HTTP 503/);
});

test('rpc errors never include the URL', async () => {
  const url = 'https://rpc.example/v2/SECRET';
  const bad = [
    async () => new Response('', { status: 401 }),
    async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `rate limited at ${url}` } }),
    async () => new Response('<html>'),
    async () => {
      throw new TypeError(`fetch failed for ${url}`);
    },
  ];
  for (const fetch of bad) {
    const err = await rpcClient(url, { fetch })('eth_blockNumber', []).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes('SECRET'), err.message);
  }
});

test('pool keeps order and the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await pool([5, 1, 3, 2], 2, async (x) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, x));
    active--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(peak, 2);
});

test('ens: one getNames([a]) per address inside one aggregate3', async () => {
  const b = '0x' + 'bb'.repeat(20);
  const node = fakeNode({ names: { [A]: 'songaday.eth' } });
  const names = await reverseNames({ call: rpcClient(node.url, { fetch: node.fetch }), addresses: [A, b] });
  assert.deepEqual(names, { [A]: 'songaday.eth', [b]: null });
  assert.equal(node.log.length, 1);
  const calls = decodeAggregate3Calls(node.log[0].params[0].data);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target, '0x3671ae578e63fdf66ad4f3e12cc0c0d71ac7510c');
  assert.equal(node.log[0].params[1], 'latest');
});

test('ens address parsing and name cleaning', () => {
  assert.deepEqual(parseAddresses(` 0x${'BB'.repeat(20)},0x${'aa'.repeat(20)},0x${'bb'.repeat(20)}`), ['0x' + 'aa'.repeat(20), '0x' + 'bb'.repeat(20)]);
  assert.throws(() => parseAddresses(''), /addresses required/);
  assert.throws(() => parseAddresses('0x12'), /bad address/);
  assert.equal(cleanName('jonathanmann.eth'), 'jonathanmann.eth');
  assert.equal(cleanName('sub.name.eth'), 'sub.name.eth');
  assert.equal(cleanName('noDot'), null);
  assert.equal(cleanName('has space.eth'), null);
  assert.equal(cleanName('bad‮.eth'), null);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(300) + '.eth'), null);
});
