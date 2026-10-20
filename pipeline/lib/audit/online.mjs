// Online checks: designed, off by default. They run only with --online, and every request
// (retries included) counts against --budget, so a run can't fan out past it. Read-only:
// HEADs and one small GET per song, no credentials.
//
//   ipfs    HEAD each CID in the song's local token metadata through the songaday Pinata gateway
//           (ipfs.io, dweb.link and w3s.link answer scripts with 429). 200 ok, 403 not pinned.
//   r2      HEAD <audio base>/<n>, the R2 MP3 behind songaday.fan; its length vs the local MP3.
//   ytlive  YouTube oEmbed: 200 public and embeddable, 401 embedding off, 404 private or gone.
import { mapLimit, sleep as wait } from './limit.mjs';
import { worse } from './status.mjs';
import { RECENT } from './config.mjs';

export const ONLINE_PIECES = ['ipfs', 'r2', 'ytlive'];
export const ONLINE_DEFAULTS = { budget: 200, rps: 4, concurrency: 4, timeoutMs: 15_000, retries: 2 };

export function onlineEndpoints(env = process.env) {
  return {
    gateway: (env.SONGADAY_IPFS_GATEWAY || 'https://songaday.mypinata.cloud/ipfs').replace(/\/+$/, ''),
    audio: (env.SONGADAY_AUDIO_BASE_URL || 'https://songaday.fan/api/audio').replace(/\/+$/, ''),
    oembed: 'https://www.youtube.com/oembed',
  };
}

// 0..len-1 in bit-reversed order, so any prefix is spread evenly over the range.
export function spreadOrder(len) {
  let bits = 0;
  while (1 << bits < len) bits++;
  const out = [];
  for (let i = 0; i < 1 << bits; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    if (r < len) out.push(r);
  }
  return out;
}

// Every request the songs could need, newest songs first, then spread across the range.
export function planOnline(songs, { endpoints = onlineEndpoints(), pieces = ONLINE_PIECES } = {}) {
  const sorted = [...songs].sort((a, b) => a.n - b.n);
  const recent = sorted.slice(-RECENT).reverse();
  const rest = sorted.slice(0, Math.max(0, sorted.length - RECENT));
  const ordered = [...recent, ...spreadOrder(rest.length).map((i) => rest[i])];
  const seen = new Set();
  const plan = [];
  const add = (req) => {
    if (seen.has(req.url)) return;
    seen.add(req.url);
    plan.push(req);
  };
  for (const s of ordered) {
    if (pieces.includes('ipfs')) {
      for (const [field, uri] of Object.entries(s.p.meta?.ipfs || {})) {
        const m = /^ipfs:\/\/([^\s'"]+)$/.exec(uri);
        if (m) add({ n: s.n, piece: 'ipfs', field, method: 'HEAD', url: `${endpoints.gateway}/${m[1]}` });
      }
    }
    if (pieces.includes('r2')) add({ n: s.n, piece: 'r2', method: 'HEAD', url: `${endpoints.audio}/${s.n}` });
    const id = s.p.youtube?.id;
    if (pieces.includes('ytlive') && id) {
      add({ n: s.n, piece: 'ytlive', method: 'GET', url: `${endpoints.oembed}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}` });
    }
  }
  return plan;
}

export function classifyResponse(req, res, error) {
  if (error) return { status: 'suspect', detail: `unreachable (${error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message})` };
  const code = res.status;
  const len = Number(res.headers?.get?.('content-length')) || null;
  const type = res.headers?.get?.('content-type') || null;
  if (code === 429) return { status: 'suspect', detail: 'rate limited (429)' };
  if (code >= 500) return { status: 'suspect', detail: `unreachable (${code})` };
  if (req.piece === 'ipfs') {
    if (code === 200) return { status: 'ok', length: len, type };
    if (code === 403) return { status: 'bad', detail: `${req.field} not pinned (403)` };
    if (code === 404) return { status: 'missing', detail: `${req.field} not found (404)` };
  }
  if (req.piece === 'r2') {
    if (code === 200) return { status: 'ok', length: len };
    if (code === 404) return { status: 'missing', detail: 'no R2 MP3 (404)' };
  }
  if (req.piece === 'ytlive') {
    if (code === 200) return { status: 'ok' };
    if (code === 401 || code === 403) return { status: 'suspect', detail: `embedding disabled (${code})` };
    if (code === 404) return { status: 'bad', detail: 'private or removed (oEmbed 404)' };
    if (code === 400) return { status: 'bad', detail: 'malformed id (oEmbed 400)' };
  }
  return { status: 'suspect', detail: `unexpected ${code}` };
}

// Runs the plan in order until the budget is spent. Requests past the budget come back skipped.
export async function runOnline(plan, opts = {}) {
  const { budget, rps, concurrency, timeoutMs, retries } = { ...ONLINE_DEFAULTS, ...opts };
  const fetchImpl = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || wait;
  if (!(budget >= 0)) throw new Error('runOnline needs a request budget');
  let used = 0;
  let nextSlot = 0;
  const slot = async () => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + 1000 / rps;
    if (at > now) await sleep(at - now);
  };
  const results = await mapLimit(plan, concurrency, async (req) => {
    for (let attempt = 0; ; attempt++) {
      if (used >= budget) return { ...req, skipped: true };
      used++;
      await slot();
      let res, error;
      try {
        res = await fetchImpl(req.url, {
          method: req.method,
          redirect: 'follow',
          headers: { 'user-agent': 'songaday-display-audit (read-only)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        error = e;
      }
      const retryable = error || res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries && used < budget) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return { ...req, ...classifyResponse(req, res, error) };
    }
  });
  return { results, used, skipped: results.filter((r) => r.skipped).length };
}

// Fold results into the songs as pieces ipfs / r2 / ytlive; checks the R2 length against the local MP3.
export function mergeOnline(songs, results) {
  const byN = new Map(songs.map((s) => [s.n, s]));
  for (const r of results) {
    if (r.skipped) continue;
    const s = byN.get(r.n);
    const p = (s.p[r.piece] ||= { status: 'n/a', detail: '' });
    let status = r.status;
    let detail = r.detail || '';
    if (r.piece === 'r2' && r.status === 'ok') {
      const local = s.p.mp3?.file;
      if (local && !local.placeholder && local.size > 0 && r.length && r.length !== local.size) {
        status = 'suspect';
        detail = `R2 is ${r.length} bytes, local MP3 is ${local.size}`;
      }
    }
    p.status = p.status === 'n/a' ? status : worse(p.status, status);
    if (detail) p.detail = p.detail ? `${p.detail}; ${detail}` : detail;
  }
  return songs;
}
