// Worker "songaday-display": the gallery app (Vite build in dist/, served by Workers static
// assets) plus the /api/* crypto proxy. Static files never reach this code: the asset layer
// answers them first, with dist/_headers giving hashed /assets/* a year's cache. The Worker
// runs for /api/* (run_worker_first) and for paths no file matches, such as /embed.
import { handleApi } from './api.js';

// The embed is the same page in a chromeless mode (app/index.html decides from the path).
// Served in place, never redirected, so the rating app's iframe URL keeps working.
const EMBED = new Set(['/embed', '/embed/', '/embed.html']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, {
        fetch: (input, init) => fetch(input, init),
        cache: globalThis.caches?.default ?? null,
        kv: env.SNAPSHOTS ?? null, // optional KV namespace for the market, holders and slug snapshots
        waitUntil: (p) => ctx.waitUntil(p),
      });
    }
    if (EMBED.has(url.pathname.toLowerCase())) return serveIndex(request, env, url);
    return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

async function serveIndex(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  return env.ASSETS.fetch(new Request(new URL('/', url), { method: request.method, headers: request.headers }));
}
