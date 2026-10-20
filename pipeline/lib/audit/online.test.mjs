import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadOrder, planOnline, runOnline, classifyResponse, mergeOnline } from './online.mjs';

const endpoints = { gateway: 'https://gw.test/ipfs', audio: 'https://audio.test/api/audio', oembed: 'https://yt.test/oembed' };
const song = (n, extra = {}) => ({
  n,
  p: {
    meta: { ipfs: { image: `ipfs://QmX2ZdS13khEYqpC8Jz4nm7Ub3He3g5Ws22z3QhunC2k58/${n}` } },
    youtube: { id: 'v6Lk_OP4ZKc' },
    ...extra,
  },
});

test('spreadOrder is a permutation whose prefixes spread over the range', () => {
  const o = spreadOrder(10);
  assert.deepEqual([...o].sort((a, b) => a - b), [...Array(10).keys()]);
  assert.deepEqual(o.slice(0, 2), [0, 8]);
});

test('planOnline asks the songaday gateway, the audio endpoint and oEmbed, newest songs first', () => {
  const plan = planOnline([song(1), song(2), song(3)], { endpoints });
  assert.equal(plan[0].n, 3);
  assert.ok(plan.some((r) => r.url === 'https://gw.test/ipfs/QmX2ZdS13khEYqpC8Jz4nm7Ub3He3g5Ws22z3QhunC2k58/1'));
  assert.ok(plan.some((r) => r.url === 'https://audio.test/api/audio/2' && r.method === 'HEAD'));
  assert.ok(plan.some((r) => r.piece === 'ytlive' && r.url.startsWith('https://yt.test/oembed?format=json&url=')));
  assert.ok(plan.every((r) => !/ipfs\.io|dweb\.link|w3s\.link/.test(r.url)));
});

test('runOnline never makes more requests than the budget, retries included', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { status: calls % 2 ? 503 : 200, headers: new Map() };
  };
  const plan = planOnline([song(1), song(2), song(3), song(4)], { endpoints });
  const out = await runOnline(plan, { budget: 5, fetch, sleep: async () => {}, rps: 1e6, concurrency: 3 });
  assert.equal(calls, 5);
  assert.equal(out.used, 5);
  assert.ok(out.skipped > 0);
  await assert.rejects(runOnline(plan, { budget: undefined, fetch }), /budget/);
});

test('classifyResponse maps gateway, R2 and oEmbed answers', () => {
  const h = (len) => ({ get: (k) => (k === 'content-length' ? String(len) : null) });
  assert.equal(classifyResponse({ piece: 'ipfs', field: 'image' }, { status: 403, headers: h(0) }).status, 'bad');
  assert.equal(classifyResponse({ piece: 'ipfs', field: 'image' }, { status: 200, headers: h(9) }).length, 9);
  assert.equal(classifyResponse({ piece: 'r2' }, { status: 404, headers: h(0) }).status, 'missing');
  assert.equal(classifyResponse({ piece: 'ytlive' }, { status: 401, headers: h(0) }).status, 'suspect');
  assert.equal(classifyResponse({ piece: 'ytlive' }, { status: 404, headers: h(0) }).status, 'bad');
  assert.equal(classifyResponse({ piece: 'r2' }, null, Object.assign(new Error('x'), { name: 'TimeoutError' })).detail, 'unreachable (timeout)');
});

test('mergeOnline compares the R2 length with the local MP3', () => {
  const s = song(7, { mp3: { status: 'ok', file: { size: 100, placeholder: false } } });
  mergeOnline([s], [{ n: 7, piece: 'r2', status: 'ok', length: 99 }, { n: 7, piece: 'ipfs', status: 'bad', detail: 'image not pinned (403)' }]);
  assert.equal(s.p.r2.status, 'suspect');
  assert.equal(s.p.ipfs.status, 'bad');
});
