// /api/*: a fixed list of GET routes for the gallery's crypto panels, which only wallet visitors
// load (app/src/crypto/). Keys stay here as Worker secrets. Responses come from snapshots, so
// upstream traffic follows the refresh timers below, not page views. Same-origin only.
import { json, fail, HttpError, UpstreamError } from './http.js';
import { allowRequest } from './ratelimit.js';
import { createSnapshots } from './snapshots.js';
import { openSeaClient, OPENSEA_API } from './opensea.js';
import { bestListings, marketSummary, recentSales } from './market.js';
import { rpcClient } from './rpc.js';
import { readHolders, maxTokenAt } from './holders.js';
import { parseAddresses, reverseNames, REVERSE_RECORDS } from './ens.js';
import { isAddress } from './abi.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// fresh: served as is. keep: still served (stale) while a background refresh runs.
export const TIMES = Object.freeze({
  listings: { fresh: 10 * MIN, keep: DAY },
  sales: { fresh: 5 * MIN, keep: DAY },
  slug: { fresh: DAY, keep: 7 * DAY },
  holders: { fresh: HOUR, keep: DAY },
  ens: { fresh: DAY, keep: 7 * DAY },
});

export const SALES_KEPT = 100; // the snapshot keeps this many; ?limit= takes 1..SALES_KEPT

// Only a local mock may stand in for OpenSea, since it gets the key.
function localOr(url, fallback) {
  try {
    const u = new URL(url);
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) ? url.replace(/\/+$/, '') : fallback;
  } catch {
    return fallback;
  }
}

export function readConfig(env = {}) {
  const pages = Number(env.OPENSEA_MAX_PAGES);
  return {
    contract: isAddress(env.SAD_CONTRACT_ADDRESS) ? env.SAD_CONTRACT_ADDRESS.toLowerCase() : null,
    openSeaKey: env.OPENSEA_API_KEY || null,
    rpcUrl: env.MAINNET_RPC_URL || null,
    slug: typeof env.OPENSEA_SLUG === 'string' && /^[a-z0-9-]{1,100}$/.test(env.OPENSEA_SLUG) ? env.OPENSEA_SLUG : null,
    openSeaBase: localOr(env.OPENSEA_API_BASE, OPENSEA_API),
    maxPages: Number.isInteger(pages) && pages >= 1 && pages <= 100 ? pages : 40,
    reverseRecords: isAddress(env.ENS_REVERSE_RECORDS) ? env.ENS_REVERSE_RECORDS : REVERSE_RECORDS,
  };
}

const market = (cfg) => Boolean(cfg.openSeaKey && cfg.contract);
const chain = (cfg) => Boolean(cfg.rpcUrl && cfg.contract);
const ens = (cfg) => Boolean(cfg.rpcUrl);

const stamp = (s) => ({ updatedAt: new Date(s.at).toISOString(), stale: s.stale });

async function slugOf(c, os) {
  if (c.cfg.slug) return c.cfg.slug;
  const s = await c.snaps.get(`opensea/slug/${c.cfg.contract}`, TIMES.slug, () => os.slugFor(c.cfg.contract));
  return s.data;
}

function listingsSnapshot(c) {
  return c.snaps.get(`market/listings/${c.cfg.contract}`, TIMES.listings, async () => {
    const os = c.openSea();
    const { listings, complete } = await os.allListings(await slugOf(c, os), { maxPages: c.cfg.maxPages });
    return { complete, listings: bestListings(listings, c.cfg.contract, Math.floor(c.now() / 1000)) };
  });
}

// A snapshot can be up to a day old; drop listings that have expired since.
const live = (listings, c) => listings.filter((l) => !l.expires || l.expires * 1000 > c.now());

function salesLimit(param) {
  if (param === null) return 50;
  const n = Number(param);
  if (!Number.isInteger(n) || n < 1 || n > SALES_KEPT) throw new HttpError(400, `limit must be 1-${SALES_KEPT}`);
  return n;
}

export const ROUTES = Object.freeze({
  // Which features this deployment has keys for (booleans only), so the page never shows a
  // button it can't fill.
  '/api/status': {
    ready: () => true,
    async run(c) {
      return json({ market: market(c.cfg), holders: chain(c.cfg), ens: ens(c.cfg) }, { maxAge: 300 });
    },
  },
  '/api/market/summary': {
    ready: market,
    async run(c) {
      const s = await listingsSnapshot(c);
      const listings = live(s.data.listings, c);
      return json({ contract: c.cfg.contract, ...marketSummary(listings), complete: s.data.complete, ...stamp(s) }, { maxAge: 60 });
    },
  },
  '/api/market/listings': {
    ready: market,
    async run(c) {
      const s = await listingsSnapshot(c);
      return json({ contract: c.cfg.contract, listings: live(s.data.listings, c), complete: s.data.complete, ...stamp(s) }, { maxAge: 60 });
    },
  },
  '/api/market/sales': {
    ready: market,
    async run(c) {
      const limit = salesLimit(c.url.searchParams.get('limit'));
      const s = await c.snaps.get(`market/sales/${c.cfg.contract}`, TIMES.sales, async () => {
        const os = c.openSea();
        return recentSales(await os.recentSales(await slugOf(c, os), { limit: SALES_KEPT }), c.cfg.contract);
      });
      return json({ contract: c.cfg.contract, sales: s.data.slice(0, limit), ...stamp(s) }, { maxAge: 60 });
    },
  },
  '/api/holders': {
    ready: chain,
    async run(c) {
      const s = await c.snaps.get(`chain/holders/${c.cfg.contract}`, TIMES.holders, () =>
        readHolders({ call: c.rpc(), contract: c.cfg.contract, maxToken: maxTokenAt(c.now()) }),
      );
      return json({ ...s.data, ...stamp(s) }, { maxAge: 300 });
    },
  },
  '/api/ens': {
    ready: ens,
    async run(c) {
      const addresses = parseAddresses(c.url.searchParams.get('addresses'));
      const s = await c.snaps.get(`ens/${addresses.join(',')}`, TIMES.ens, () =>
        reverseNames({ call: c.rpc(), addresses, resolver: c.cfg.reverseRecords }),
      );
      return json({ names: s.data, ...stamp(s) }, { maxAge: 3600 });
    },
  },
});

// A browser request from another site. Same-origin GETs carry no Origin header but do carry
// Sec-Fetch-Site; curl and friends carry neither (the rate limit covers those).
export function crossOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return true;
  const site = request.headers.get('Sec-Fetch-Site');
  return Boolean(site) && site !== 'same-origin' && site !== 'none';
}

// deps: { fetch, cache, kv?, waitUntil, now?, limiter?, store?, sleep?, log? }; the Worker passes the
// real ones, tests pass fakes.
export async function handleApi(request, env, deps) {
  const url = new URL(request.url);
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  if (!route) return fail(404, 'not found');
  if (request.method !== 'GET') return fail(405, 'method not allowed', { Allow: 'GET' });
  if (crossOrigin(request, url)) return fail(403, 'same-origin only');
  if (!(await allowRequest(request, env, deps.limiter))) return fail(429, 'rate limited', { 'Retry-After': '60' });

  const cfg = readConfig(env);
  if (!route.ready(cfg)) return fail(503, 'not configured');

  const now = deps.now || Date.now;
  const log = deps.log || console;
  const c = {
    url,
    cfg,
    now,
    snaps: createSnapshots({ cache: deps.cache, kv: deps.kv, origin: url.origin, now, waitUntil: deps.waitUntil, store: deps.store, log }),
    openSea: () => openSeaClient({ apiKey: cfg.openSeaKey, fetch: deps.fetch, base: cfg.openSeaBase, sleep: deps.sleep }),
    rpc: () => rpcClient(cfg.rpcUrl, { fetch: deps.fetch }),
  };
  try {
    return await route.run(c);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message, err.headers);
    // UpstreamError messages are written to be safe to log; anything else logs its type only.
    log.error?.(`[api] ${url.pathname}: ${err instanceof UpstreamError ? err.message : err?.name || 'error'}`);
    return fail(502, 'upstream unavailable');
  }
}
