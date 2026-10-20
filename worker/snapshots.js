// Snapshots of slow upstream data (the OpenSea crawl, the ownerOf multicall, ENS batches),
// shared by every visitor. Up to three tiers: this isolate's memory, the data centre's Cache API,
// and, when the Worker has a KV binding (SNAPSHOTS), KV for everything but ENS batches. The Cache
// API only works on a custom domain, so on workers.dev memory (and KV) is what keeps upstream calls
// down. Nothing here goes near the public media bucket.
//
// Memory is least-recently-used per pool. ENS batches, one entry per distinct address set (which
// any caller can vary), have a pool of their own, so they can never push the market, holders or
// slug snapshots out and force a fresh OpenSea crawl.
//
// A copy younger than `fresh` is served as is. Up to `keep` it is still served, marked stale,
// while one background refresh replaces it. Past `keep` the caller waits for a new one.

export const MEMORY_MAX = Object.freeze({ main: 64, ens: 256 });
const poolOf = (key) => (key.startsWith('ens/') ? 'ens' : 'main');
const shared = { memory: new Map(), ens: new Map(), inflight: new Map() };

export function createSnapshots({ cache, kv = null, origin, now = Date.now, waitUntil = () => {}, store = shared, log = console }) {
  const { inflight } = store;
  const keyUrl = (key) => `${origin}/__snapshots/${encodeURIComponent(key)}`;
  const memoryOf = (key) => (poolOf(key) === 'ens' ? (store.ens ??= new Map()) : store.memory);
  const durable = (key) => Boolean(kv) && poolOf(key) !== 'ens';

  // Insert, or refresh recency on a hit, then evict the least recently used past the pool's cap.
  function remember(key, entry) {
    const memory = memoryOf(key);
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > MEMORY_MAX[poolOf(key)]) memory.delete(memory.keys().next().value);
  }

  const valid = (entry) => (typeof entry?.at === 'number' && 'data' in entry ? entry : null);

  async function readKv(key) {
    if (!durable(key)) return null;
    try {
      return valid(await kv.get(`snapshots/${key}`, 'json'));
    } catch {
      return null;
    }
  }

  async function writeKv(key, body, ttlMs) {
    if (!durable(key)) return;
    try {
      await kv.put(`snapshots/${key}`, body, { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) });
    } catch (err) {
      log.warn?.(`[snapshots] KV write failed for ${key}: ${err?.name || 'error'}`);
    }
  }

  async function readCache(key) {
    if (!cache) return null;
    try {
      const res = await cache.match(keyUrl(key));
      if (!res) return null;
      return valid(await res.json());
    } catch {
      return null;
    }
  }

  async function writeCache(key, body, ttlMs) {
    if (!cache) return;
    try {
      await cache.put(keyUrl(key), new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}` },
      }));
    } catch (err) {
      log.warn?.(`[snapshots] cache write failed for ${key}: ${err?.name || 'error'}`);
    }
  }

  // One load per key per isolate at a time; everyone else waits for the same promise.
  function refresh(key, keep, load) {
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const entry = { at: now(), data: await load() };
      remember(key, entry);
      const body = JSON.stringify(entry);
      await Promise.all([writeCache(key, body, keep), writeKv(key, body, keep)]);
      return entry;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Background refresh of a stale copy. A short lock in the Cache API keeps other isolates in
  // this data centre from refreshing the same key at the same time.
  async function refreshLater(key, keep, load) {
    if (inflight.has(key)) return;
    const lock = `${key}#refreshing`;
    if (await readCache(lock)) return;
    await writeCache(lock, JSON.stringify({ at: now(), data: null }), 60_000);
    try {
      await refresh(key, keep, load);
    } catch (err) {
      log.warn?.(`[snapshots] background refresh failed for ${key}: ${err?.message || 'error'}`);
    }
  }

  async function get(key, { fresh, keep }, load) {
    const t = now();
    let entry = memoryOf(key).get(key) || null;
    if (entry) remember(key, entry);
    if (!entry || t - entry.at >= fresh) {
      for (const read of [readCache, readKv]) {
        const found = await read(key);
        if (found && (!entry || found.at > entry.at)) remember(key, (entry = found));
        if (entry && t - entry.at < fresh) break;
      }
    }
    if (entry && t - entry.at < fresh) return { ...entry, stale: false };
    if (entry && t - entry.at < keep) {
      waitUntil(refreshLater(key, keep, load));
      return { ...entry, stale: true };
    }
    return { ...(await refresh(key, keep, load)), stale: false };
  }

  return { get };
}
