// Per-IP limit on /api/*. Uses the Workers rate-limiting binding (API_RATE_LIMIT in
// wrangler.jsonc) when it's there; otherwise a fixed window in this isolate's memory, which is
// rougher (each isolate counts on its own) but still stops a single client hammering one.

export const LIMIT = 120; // requests
export const WINDOW = 60_000; // ms; keep in step with API_RATE_LIMIT in wrangler.jsonc

export function memoryLimiter({ limit = LIMIT, window = WINDOW, now = Date.now, max = 10_000 } = {}) {
  const hits = new Map(); // key -> { start, count }
  return function allow(key) {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.start >= window) {
      if (hits.size >= max) for (const [k, v] of hits) if (t - v.start >= window) hits.delete(k);
      if (hits.size >= max) hits.clear();
      h = { start: t, count: 0 };
      hits.set(key, h);
    }
    return ++h.count <= limit;
  };
}

const fallback = memoryLimiter();

export async function allowRequest(request, env, local = fallback) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (typeof env?.API_RATE_LIMIT?.limit === 'function') {
    try {
      const { success } = await env.API_RATE_LIMIT.limit({ key });
      return Boolean(success);
    } catch {
      // binding hiccup: fall through to the local count rather than failing open or closed
    }
  }
  return local(key);
}
