import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { HEADERS } from './assets-headers.mjs';

// The asset binding: only "/" (index.html) exists in this fake.
const assets = {
  requests: [],
  async fetch(req) {
    this.requests.push(req);
    const path = new URL(req.url).pathname;
    return path === '/' ? new Response('<!doctype html>gallery', { headers: { 'Content-Type': 'text/html' } }) : new Response(null, { status: 404 });
  },
};
const ctx = { waitUntil() {} };
const call = (path, init) => worker.fetch(new Request('https://gallery.example' + path, init), { ASSETS: assets }, ctx);

test('/embed, /embed/ and /embed.html serve index.html in place', async () => {
  for (const path of ['/embed', '/embed/', '/embed.html', '/EMBED', '/embed?embed=1&bounds=0,0,1,1']) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), '<!doctype html>gallery');
  }
  assert.ok(assets.requests.every((r) => new URL(r.url).pathname === '/'));
  assert.equal((await call('/embed', { method: 'HEAD' })).status, 200);
  assert.equal((await call('/embed', { method: 'POST' })).status, 405);
});

test('anything else that reached the Worker is a 404', async () => {
  for (const path of ['/nope', '/embed/x', '/calendar', '/index']) assert.equal((await call(path)).status, 404, path);
});

test('/api/* goes to the API (here: not configured)', async () => {
  const res = await call('/api/market/summary');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'not configured' });
  assert.equal((await call('/api/whatever')).status, 404);
});

test('hashed assets get a year of cache; nothing blocks framing (the embed)', () => {
  assert.match(HEADERS, /^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.doesNotMatch(HEADERS, /X-Frame-Options|frame-ancestors/i);
});
