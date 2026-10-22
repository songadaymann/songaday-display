import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './tiles-cors.js';

test('tiles Worker passes responses through and always sets Access-Control-Allow-Origin: *', async (t) => {
  const seen = [];
  const replies = [
    new Response('tile', { status: 200, headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'cf-cache-status': 'HIT', ETag: '"abc"' } }),
    new Response(null, { status: 304, headers: { 'Access-Control-Allow-Origin': 'https://gallery.songaday.world', Vary: 'Origin' } }),
    new Response('gone', { status: 404 }),
  ];
  t.mock.method(globalThis, 'fetch', async (req) => {
    seen.push(req);
    return replies.shift();
  });

  const req = new Request('https://tiles.songaday.world/wall/p1/0/0_0_154.webp');
  const hit = await worker.fetch(req);
  assert.equal(seen[0], req); // the request goes on untouched
  assert.equal(hit.status, 200);
  assert.equal(await hit.text(), 'tile');
  assert.equal(hit.headers.get('access-control-allow-origin'), '*');
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(hit.headers.get('cf-cache-status'), 'HIT');
  assert.equal(hit.headers.get('etag'), '"abc"');

  const notModified = await worker.fetch(new Request('https://tiles.songaday.world/stills/1.webp', { headers: { Origin: 'https://gallery.songaday.world' } }));
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('access-control-allow-origin'), '*');
  assert.equal(notModified.headers.get('vary'), 'Origin');

  const missing = await worker.fetch(new Request('https://tiles.songaday.world/nope.webp'));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), '*');
});
