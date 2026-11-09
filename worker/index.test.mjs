import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { HEADERS } from './assets-headers.mjs';

const assets = {
  requests: [],
  async fetch(req) {
    this.requests.push(req);
    const path = new URL(req.url).pathname;
    if (path === '/' || path === '/gallery/') {
      return new Response('<!doctype html>gallery', { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/gallery/assets/index-test.js') return new Response('/* studio build */');
    return new Response(null, { status: 404 });
  },
};
const ctx = { waitUntil() {} };
const call = (path, init, env, origin = 'https://gallery.songaday.world') =>
  worker.fetch(new Request(origin + path, init), { ASSETS: assets, ...env }, ctx);

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

test('Studio service requests can load the mounted build and its same-origin API', async () => {
  const studio = 'https://songaday.studio';
  assert.equal((await call('/gallery/', {}, {}, studio)).status, 200);
  assert.equal(await (await call('/gallery/assets/index-test.js', {}, {}, studio)).text(), '/* studio build */');
  const headers = { Origin: studio, 'Sec-Fetch-Site': 'same-origin' };
  const status = await call('/gallery/api/status', { headers }, {}, studio);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { market: false, holders: false, ens: false });
  headers.Origin = 'https://example.org';
  assert.equal((await call('/gallery/api/status', { headers }, {}, studio)).status, 403);
});

test('the old gallery redirects song and view queries once enabled, while embeds stay put', async () => {
  const env = { STUDIO_GALLERY_REDIRECT: 'yes' };
  const query = '?song=%231&date=2009-01-01&bounds=0,0,1,1&embed=0';
  assert.equal((await call('/' + query)).status, 200, 'redirect is off by default');
  for (const path of ['/', '/index.html']) {
    const res = await call(path + query, { method: 'HEAD' }, env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://songaday.studio/gallery/' + query);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  for (const path of ['/embed?embed=1', '/embed/?zoom=3', '/embed.html', '/?embed', '/?embed=1']) {
    assert.equal((await call(path, {}, env)).status, 200, path);
  }
  assert.equal((await call('/?song=1', {}, env, 'https://songaday-display.example.workers.dev')).status, 200);
});

test('old Song A Day NFT links redirect to the song number with the original view options', async () => {
  const contract = '0x19b703f65aA7E1E775BD06c2aa0D0d08c80f1C45';
  const env = { STUDIO_GALLERY_REDIRECT: 'yes', SAD_CONTRACT_ADDRESS: contract };
  const path = `/1/${contract.toLowerCase()}/42?zoom=3&song=5`;
  const res = await call(path, {}, env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://songaday.studio/gallery/?zoom=3&song=42');
  assert.equal((await call(path)).status, 404, 'redirect is off by default');
  for (const invalid of [`/1/${contract}/0`, `/2/${contract}/42`, `/1/${contract.replace('19b7', '19b6')}/42`]) {
    assert.equal((await call(invalid, {}, env)).status, 404);
  }
});

test('hashed assets get a year of cache; nothing blocks framing (the embed)', () => {
  assert.match(HEADERS, /^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.match(HEADERS, /^\/gallery\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.doesNotMatch(HEADERS, /X-Frame-Options|frame-ancestors/i);
});
