# Worker

`songaday-display` is one Cloudflare Worker: the gallery app (the Vite build in `dist/`, served by Workers static assets) plus `/api/*`, a small read-only proxy for the gallery's crypto panels. Config is `../wrangler.jsonc`. **Not deployed yet**; no routes or custom domains until cutover (`docs/PLAN.md` M8).

## What serves what

| Request | Who answers | Cache |
| --- | --- | --- |
| `/`, `/?embed=1`, files in `dist/` | Static-asset layer, without running the Worker | `/assets/*` (content-hashed): `public, max-age=31536000, immutable` from `dist/_headers`. `index.html`: the default `max-age=0, must-revalidate`. |
| `/embed`, `/embed/`, `/embed.html` (any case) | Worker → `index.html`, in place (200, no redirect) | as `index.html` |
| `/api/*` | Worker (`run_worker_first`) | see below |
| anything else | Worker: 404 (other names stay free for future displays) | |

`dist/_headers` is written by `worker/assets-headers.mjs`, which wrangler runs as its custom build before every `wrangler dev` and `wrangler deploy`. It refuses to run if `dist/index.html` is missing, so run `npm run build` first.

## `/api/*`

A fixed list of routes. GET only (405 otherwise). Same-origin only: no CORS headers, `Cross-Origin-Resource-Policy: same-origin`, and a 403 for any request whose `Origin` is another site or whose `Sec-Fetch-Site` isn't `same-origin`/`none`. 120 requests a minute per IP (the `API_RATE_LIMIT` binding; an in-memory count per isolate if the binding is missing), then 429. Unknown query parameters are ignored, so they can't bypass the cache.

| Route | Needs | Source | Fresh for | Response |
| --- | --- | --- | --- | --- |
| `/api/market/summary` | `OPENSEA_API_KEY` | OpenSea `listings/collection/{slug}/all`, every page (200 a page, `next` cursor, up to `OPENSEA_MAX_PAGES`), cheapest listing per song | 10 min | `{ contract, listed, tokens[], floor, complete, updatedAt, stale }` |
| `/api/market/listings` | `OPENSEA_API_KEY` | the same snapshot | 10 min | `{ contract, listings: [{ n, price: { value, decimals, currency }, maker, expires }], complete, updatedAt, stale }`, cheapest first |
| `/api/market/sales?limit=1..100` (default 50) | `OPENSEA_API_KEY` | OpenSea `events/collection/{slug}?event_type=sale`, then kept only if `event_type === 'sale'` and this contract | 5 min | `{ contract, sales: [{ n, price, seller, buyer, time, tx }], updatedAt, stale }`, newest first |
| `/api/holders` | `MAINNET_RPC_URL` | `ownerOf(n)` for n = 1 … tomorrow's song, through Multicall3 `aggregate3`, 500 a call (14 calls), all at one block. A revert means not minted. | 1 h | `{ contract, block, checked: { from, to }, minted, unminted[], holders: [{ address, tokens[] }], updatedAt, stale }`, biggest holder first |
| `/api/ens?addresses=0x…,0x…` (1–50) | `MAINNET_RPC_URL` | ENS ReverseRecords `getNames([a])` per address inside one `aggregate3` (forward-verified; a reverting resolver only loses that one name) | 1 day | `{ names: { "0x…": "name.eth" \| null }, updatedAt, stale }` |

- The collection slug comes from OpenSea's `chain/ethereum/contract/{address}` (cached a day) unless `OPENSEA_SLUG` is set.
- **Snapshots** (`snapshots.js`): each response is built from a snapshot held in this isolate's memory, in the data centre's Cache API and, if the Worker has a `SNAPSHOTS` KV binding, in KV (everything but ENS batches). Past "fresh" it is still served, with `stale: true`, while one background refresh replaces it (up to a day, a week for ENS). So upstream calls follow these timers, not page views. Memory is least-recently-used, and ENS batches (one per address set, which any caller can vary) have their own pool, so they can't evict the listings snapshot and force a new crawl. The Cache API only works on a custom domain, so on `workers.dev` only memory and KV help. Nothing goes to the public media bucket.
- **Errors**: missing secret → **503 `{"error":"not configured"}`** before any upstream call (the gallery then hides that button). Upstream failure → 502 `{"error":"upstream unavailable"}`. Bodies and logs never include upstream text, the RPC URL or a key.
- The address-to-ABI encoding is by hand (`abi.js`); `abi.test.mjs` checks every selector against an independent keccak-256.

## Configuration

| Name | Kind | Where |
| --- | --- | --- |
| `OPENSEA_API_KEY` | secret | `npx wrangler secret put OPENSEA_API_KEY` |
| `MAINNET_RPC_URL` | secret (it usually carries the provider key) | `npx wrangler secret put MAINNET_RPC_URL` |
| `SAD_CONTRACT_ADDRESS` | var, public | `wrangler.jsonc` |
| `OPENSEA_SLUG` | optional var | skips the slug lookup |
| `OPENSEA_MAX_PAGES` | optional var, 1–100, default 40 | caps the listings crawl. Each page is a subrequest: keep it under 45 on Workers Free (50-subrequest limit). |
| `ENS_REVERSE_RECORDS` | optional var | ReverseRecords address, default `0x3671aE578E63FdF66ad4F3E12CC0c0d71Ac7510C` |
| `OPENSEA_API_BASE` | optional, tests only | accepted only for `localhost`/`127.0.0.1`, since it receives the key |
| `SNAPSHOTS` | optional KV binding | durable tier for the market, holders and slug snapshots (see `wrangler.jsonc`) |

Never put any of these in a `VITE_` variable.

## Run it locally

```sh
npm run build                 # dist/
npm run dev:worker            # vite build && wrangler dev → http://localhost:8787
npm test                      # includes worker/*.test.mjs (offline, mocked fetch and Cache API)
npx wrangler deploy --dry-run # bundles and checks the config without uploading
```

For real data in `wrangler dev`, put `OPENSEA_API_KEY=` and `MAINNET_RPC_URL=` in `.dev.vars` (gitignored). Without them every `/api/*` route answers 503 and the gallery shows no crypto parts. A build reads its media from `VITE_MEDIA_BASE`, or from `https://tiles.songaday.world` when that isn't set, so `wrangler dev` shows the public wall; for the wall in your local cache use `npm run dev` (which serves `/media` from it) and proxy `/api` to `wrangler dev`.

## Files

| File | What |
| --- | --- |
| `index.js` | Entry: `/api/*`, `/embed`, 404 |
| `api.js` | Route table, origin check, rate limit, config, snapshot timings |
| `opensea.js`, `market.js` | OpenSea client (retries 429/5xx, `next` pagination); listing and sale normalising |
| `rpc.js`, `abi.js`, `holders.js`, `ens.js` | JSON-RPC, hand-written ABI, the `ownerOf` multicall, reverse ENS |
| `snapshots.js`, `ratelimit.js`, `http.js` | Two-tier snapshot cache, per-IP limit, JSON responses |
| `assets-headers.mjs` | wrangler custom build: writes `dist/_headers` |
| `testing.mjs` | Offline fakes for the tests: Cache API, a JSON-RPC node that decodes our multicalls, OpenSea |
