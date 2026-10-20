// The Worker's /api/* routes (worker/api.js), memoized per page. Every call resolves, never
// rejects: { ok, status, data }. A failure is remembered for a minute so a broken route isn't
// asked again on every hover. Nothing here runs until init() does.
const MIN = 60_000;
const memo = new Map(); // path -> { at, ttl, promise }

export function getApi(path, ttl = 5 * MIN) {
  const hit = memo.get(path);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const entry = { at: Date.now(), ttl, promise: null };
  entry.promise = fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then(async (res) => ({ ok: res.ok, status: res.status, data: res.ok ? await res.json() : null }))
    .catch(() => ({ ok: false, status: 0, data: null }))
    .then((r) => {
      if (!r.ok) entry.ttl = Math.min(ttl, MIN);
      return r;
    });
  memo.set(path, entry);
  return entry.promise;
}

// 503 means the Worker has no key for it: that feature is off for this deployment.
export const notConfigured = (r) => r.status === 503;

// Reverse ENS names, at most 50 addresses a request, remembered for the page's life.
const names = new Map(); // address -> name or null

export async function lookupNames(addresses) {
  const want = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))].filter((a) => !names.has(a)).sort();
  for (let i = 0; i < want.length; i += 50) {
    const batch = want.slice(i, i + 50);
    const r = await getApi(`/api/ens?addresses=${batch.join(',')}`, 24 * 60 * MIN);
    if (!r.ok) return;
    for (const a of batch) names.set(a, r.data?.names?.[a] || null);
  }
}

export const nameOf = (address) => (address && names.get(address.toLowerCase())) || null;
