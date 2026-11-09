// Worker "songaday-display": the legacy gallery and embeds, the Studio gallery build served
// through a service binding, and the read-only gallery API.
import { isEmbed } from '../app/src/core/deeplink.js';
import { handleApi } from './api.js';

// The embed is the same page in a chromeless mode (app/index.html decides from the path).
// Served in place, never redirected, so the rating app's iframe URL keeps working.
const EMBED = new Set(['/embed', '/embed/', '/embed.html']);
const LEGACY_INDEX = new Set(['/', '/index.html']);
const STUDIO_GALLERY = 'https://songaday.studio/gallery/';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const legacyIndex = LEGACY_INDEX.has(path);
    if (env.STUDIO_GALLERY_REDIRECT === 'yes' && url.hostname === 'gallery.songaday.world' &&
        (request.method === 'GET' || request.method === 'HEAD')) {
      const token = /^\/1\/(0x[0-9a-f]{40})\/([1-9]\d{0,5})\/?$/i.exec(path);
      const legacySong = token && token[1].toLowerCase() === env.SAD_CONTRACT_ADDRESS?.toLowerCase();
      if ((legacyIndex && !isEmbed(url)) || legacySong) {
        const destination = new URL(STUDIO_GALLERY);
        destination.search = url.search;
        if (legacySong) destination.searchParams.set('song', token[2]);
        return new Response(null, {
          status: 302,
          headers: { Location: destination.href, 'Cache-Control': 'no-store' },
        });
      }
    }
    if (path === '/gallery/api' || path.startsWith('/gallery/api/')) {
      // Only the route changes. Keep the Studio origin and browser headers for the API's
      // existing same-origin checks and rate limiting.
      url.pathname = path.slice('/gallery'.length);
      request = new Request(url, request);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, {
        fetch: (input, init) => fetch(input, init),
        cache: globalThis.caches?.default ?? null,
        kv: env.SNAPSHOTS ?? null, // optional KV namespace for the market, holders and slug snapshots
        waitUntil: (p) => ctx.waitUntil(p),
      });
    }
    if (EMBED.has(path.toLowerCase())) return serveIndex(request, env, url);
    if (legacyIndex || path === '/gallery/' || path.startsWith('/gallery/assets/')) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

async function serveIndex(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  return env.ASSETS.fetch(new Request(new URL('/', url), { method: request.method, headers: request.headers }));
}
