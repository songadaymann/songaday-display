// OpenSea API v2, server-side only (the key is the OPENSEA_API_KEY secret). Pagination uses the
// `next` query parameter; the old gallery sent `cursor`, which OpenSea ignores, so its 65-page
// "crawl" re-read page one.
import { UpstreamError } from './http.js';

export const OPENSEA_API = 'https://api.opensea.io/api/v2';
const PAGE = 200; // OpenSea's maximum for listings and events

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openSeaClient({ apiKey, fetch, base = OPENSEA_API, sleep = wait, retries = 3, timeout = 15_000 }) {
  async function get(path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res = null;
      try {
        res = await fetch(url, { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
      } catch (err) {
        if (attempt >= retries) throw new UpstreamError(`opensea ${path}: ${err?.name || 'network error'}`);
      }
      if (res && res.ok) {
        try {
          return await res.json();
        } catch {
          throw new UpstreamError(`opensea ${path}: not JSON`);
        }
      }
      if (res && res.status !== 429 && res.status < 500) throw new UpstreamError(`opensea ${path}: HTTP ${res.status}`);
      if (attempt >= retries) throw new UpstreamError(`opensea ${path}: HTTP ${res?.status}`);
      const after = Number(res?.headers.get('Retry-After'));
      await sleep(after > 0 ? Math.min(after, 5) * 1000 : 500 * 2 ** attempt);
    }
  }

  return {
    // The collection slug OpenSea files this contract under.
    async slugFor(contract) {
      const d = await get(`/chain/ethereum/contract/${contract}`);
      if (typeof d?.collection !== 'string' || !d.collection) throw new UpstreamError('opensea contract: no collection');
      return d.collection;
    },

    // Every active listing in the collection, page by page. `complete` is false if maxPages ran
    // out before OpenSea did. Each page is one subrequest (Workers Free allows 50 in all).
    async allListings(slug, { maxPages = 40 } = {}) {
      const listings = [];
      let next = null;
      let pages = 0;
      do {
        const d = await get(`/listings/collection/${encodeURIComponent(slug)}/all`, { limit: PAGE, next });
        if (Array.isArray(d?.listings)) listings.push(...d.listings);
        const cursor = typeof d?.next === 'string' && d.next ? d.next : null;
        next = cursor && cursor !== next ? cursor : null;
        pages++;
      } while (next && pages < maxPages);
      return { listings, complete: !next, pages };
    },

    // The newest sale events, one page.
    async recentSales(slug, { limit = 100 } = {}) {
      const d = await get(`/events/collection/${encodeURIComponent(slug)}`, { event_type: 'sale', limit: Math.min(limit, PAGE) });
      return Array.isArray(d?.asset_events) ? d.asset_events : [];
    },
  };
}
