// Uploads to R2: the S3 API with a bucket-scoped R2 token (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY in ~/.config/songaday-display/.env), or wrangler's own login as a slower
// fallback. Also the upload plan, the ledger of what is already up, and requests to the public host.
//
// Every object but wall/current.json is immutable: once a key is up it never gets other bytes, so
// the ledger (STATE/r2-uploaded.jsonl) lets a rerun skip it and refuses a changed one.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, PUBLISH, REPO, STATE } from './env.mjs';
import { CURRENT_KEY } from './manifest.mjs';

export const BUCKETS = Object.freeze({
  media: process.env.R2_MEDIA_BUCKET || 'songaday-display-media',
  archive: process.env.R2_ARCHIVE_BUCKET || 'songaday-display-archive',
});
export const PUBLIC_MEDIA = (process.env.SONGADAY_MEDIA_PUBLIC || 'https://tiles.songaday.world').replace(/\/+$/, '');
// Sent on every request to the public host, so the pipeline never seeds the edge cache with a copy
// that lacks the CORS header (docs/PLAN.md, "Names and hosting").
export const ORIGIN = 'https://gallery.songaday.world';

// Cache-Control, as listed in shared/README.md "Media layout".
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_CURRENT = 'public, max-age=60';
export const isMutable = (key) => key === CURRENT_KEY;
export const cacheControlFor = (key) => (isMutable(key) ? CACHE_CURRENT : CACHE_IMMUTABLE);

const TYPES = { '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.png': 'image/png' };
export function contentTypeFor(key) {
  const type = TYPES[path.extname(key).toLowerCase()];
  if (!type) throw new Error(`no content type for ${key}`);
  return type;
}

export const md5hex = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const EMPTY_SHA256 = sha256hex('');

// ---- Requests to the public host ----

export function publicFetch(key, { method = 'GET', query = '', base = PUBLIC_MEDIA, headers = {} } = {}) {
  return fetch(`${base}/${encodeKey(key)}${query ? `?${query}` : ''}`, { method, headers: { Origin: ORIGIN, ...headers } });
}

// ---- S3 API (AWS Signature Version 4) ----

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key) => key.split('/').map(rfc3986).join('/');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const canonicalQuery = (query) => Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');

// Signs one request. Returns the headers to send, including host, x-amz-date, x-amz-content-sha256
// and authorization. `uri` is already encoded.
export function signV4({ method, host, uri, query = {}, headers = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [name, value] of Object.entries(headers)) if (value != null) all[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(';');
  const canonical = [method, uri, canonicalQuery(query), names.map((n) => `${n}:${all[n]}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    // Auth, precondition and other 4xx answers won't change on a retry.
    this.retryable = status >= 500 || status === 408 || status === 429;
  }
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const unquote = (etag) => (etag ? etag.replace(/^W\//, '').replace(/^"|"$/g, '') : null);

export function s3Client({ accountId, accessKeyId, secretAccessKey } = {}) {
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  async function request(method, bucket, key, { query = {}, headers = {}, body } = {}) {
    const uri = `/${bucket}${key ? `/${encodeKey(key)}` : ''}`;
    const { host: _, ...signed } = signV4({ method, host, uri, query, headers, payloadHash: body ? sha256hex(body) : EMPTY_SHA256, accessKeyId, secretAccessKey });
    const qs = canonicalQuery(query);
    return fetch(`https://${host}${uri}${qs ? `?${qs}` : ''}`, { method, headers: signed, body });
  }
  const fail = async (res, what) => {
    const text = await res.text().catch(() => '');
    const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1];
    return new HttpError(res.status, `${what}: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  };
  return {
    kind: 's3',
    // { body, contentType, cacheControl, ifMatch, ifNoneMatch } -> { etag }
    async put(bucket, key, { body, contentType, cacheControl, ifMatch, ifNoneMatch }) {
      const headers = {
        'content-type': contentType,
        'cache-control': cacheControl,
        'content-md5': crypto.createHash('md5').update(body).digest('base64'),
        ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}),
        ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
      };
      const res = await request('PUT', bucket, key, { headers, body });
      if (!res.ok) throw await fail(res, `PUT ${bucket}/${key}`);
      await res.arrayBuffer();
      return { etag: unquote(res.headers.get('etag')) };
    },
    // -> null when absent, else { etag, size, cacheControl, contentType }
    async head(bucket, key) {
      const res = await request('HEAD', bucket, key);
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status, `HEAD ${bucket}/${key}: HTTP ${res.status}`);
      return { etag: unquote(res.headers.get('etag')), size: Number(res.headers.get('content-length')), cacheControl: res.headers.get('cache-control'), contentType: res.headers.get('content-type') };
    },
    // Yields { key, etag, size } for every object under prefix (ListObjectsV2, 1,000 a page).
    async *list(bucket, prefix = '') {
      let token = null;
      do {
        const query = { 'list-type': '2', 'max-keys': '1000', ...(prefix ? { prefix } : {}), ...(token ? { 'continuation-token': token } : {}) };
        const res = await request('GET', bucket, '', { query });
        if (!res.ok) throw await fail(res, `LIST ${bucket}/${prefix}`);
        const xml = await res.text();
        for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          yield {
            key: xmlText(item.match(/<Key>([\s\S]*?)<\/Key>/)[1]),
            etag: unquote(xmlText(item.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] || '')),
            size: Number(item.match(/<Size>(\d+)<\/Size>/)?.[1]),
          };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)[1]) : null;
      } while (token);
    },
  };
}

// ---- wrangler fallback (its OAuth login; no conditional writes, no listing) ----

export function wranglerClient({ bin = path.join(REPO, 'node_modules/.bin/wrangler'), tmp = path.join(CACHE, 'tmp') } = {}) {
  const run = (argv) => new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd: REPO, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const msg = out.match(/\[ERROR\][^\n]*\n?[^\n]*/)?.[0]?.replace(/\x1b\[[0-9;]*m/g, '').trim() || `exit ${code}`;
      const err = new Error(`wrangler: ${msg}`);
      err.retryable = !/not authenticated|login|10000|Authentication/i.test(out);
      reject(err);
    });
  });
  return {
    kind: 'wrangler',
    async put(bucket, key, { body, file, contentType, cacheControl }) {
      let src = file, temp = null;
      if (!src) {
        fs.mkdirSync(tmp, { recursive: true });
        temp = src = path.join(tmp, `put-${process.pid}-${crypto.randomUUID().slice(0, 8)}${path.extname(key)}`);
        fs.writeFileSync(temp, body);
      }
      try {
        await run(['r2', 'object', 'put', `${bucket}/${key}`, '--file', src, '--content-type', contentType, '--cache-control', cacheControl, '--remote']);
      } finally {
        if (temp) fs.rmSync(temp, { force: true });
      }
      return { etag: null };
    },
    head: null,
    list: null,
  };
}

// ---- Cloudflare API with wrangler's login (no R2 token; one process, not one per object) ----

// The request `wrangler r2 object put` makes (PUT /accounts/:id/r2/buckets/:b/objects/:key), sent
// from here with the token `wrangler auth token` hands out, fetched again on a 401 (wrangler
// refreshes it). Paced under the API's 1,200 requests per 5 minutes; a 429 waits and tries again.
export const API_RATE = 3.5; // requests a second
const AUTH_CODES = new Set([9106, 9109, 10000]);

export function apiClient({ accountId, bin = path.join(REPO, 'node_modules/.bin/wrangler'), rate = API_RATE, base = 'https://api.cloudflare.com/client/v4' } = {}) {
  if (!accountId) throw new Error('set R2_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID) for the api transport');
  let token = null, next = 0;
  const fetchToken = () => new Promise((resolve, reject) => {
    const child = spawn(bin, ['auth', 'token', '--json'], { cwd: REPO, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const t = JSON.parse(out.slice(out.indexOf('{'))).token;
        if (code === 0 && t) return resolve(t);
      } catch {}
      reject(Object.assign(new Error('wrangler auth token failed: run `npx wrangler login`'), { retryable: false }));
    });
  });
  const slot = async () => {
    const now = Date.now(), at = Math.max(now, next);
    next = at + 1000 / rate;
    if (at > now) await sleep(at - now);
  };
  return {
    kind: 'api',
    async put(bucket, key, { body, contentType, cacheControl }) {
      let authRetries = 0, netRetries = 0;
      for (let attempt = 0; ; attempt++) {
        token ||= await fetchToken();
        await slot();
        let res;
        try {
          res = await fetch(`${base}/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeKey(key)}`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'cache-control': cacheControl, 'cf-r2-data-catalog-check': 'true' },
            body,
          });
        } catch (err) {
          // A dropped connection or DNS blip: wait it out (2 s, 4 s ... about a minute in all).
          if (netRetries++ < 5) {
            await sleep(2000 * 2 ** (netRetries - 1));
            continue;
          }
          throw err;
        }
        const text = await res.text().catch(() => '');
        if (res.ok) {
          let etag = null;
          try {
            etag = unquote(JSON.parse(text).result?.etag ?? null);
          } catch {}
          return { etag };
        }
        const code = Number(text.match(/"code":\s*(\d+)/)?.[1]) || null;
        // An expired token comes back as a 401, or as a 400 with code 9106 (no valid authorization)
        // or 10000. wrangler refreshes it when asked again.
        if ((res.status === 401 || AUTH_CODES.has(code)) && authRetries++ < 2) {
          token = null;
          continue;
        }
        if (res.status === 429 && attempt < 8) {
          await sleep(Number(res.headers.get('retry-after')) * 1000 || 5000 * (attempt + 1));
          continue;
        }
        throw new HttpError(res.status, `PUT ${bucket}/${key}: HTTP ${res.status}${code ? ` (code ${code})` : ''}`);
      }
    },
    head: null,
    list: null,
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r2Env = () => ({ accountId: process.env.R2_ACCOUNT_ID, accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY });
const accountId = () => process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
export const hasToken = () => Object.values(r2Env()).every(Boolean);

// 'auto' picks the S3 API when the R2 token is set, else the Cloudflare API with wrangler's login
// (given an account ID), else wrangler itself.
export function client(transport = 'auto') {
  if (transport === 's3' || (transport === 'auto' && hasToken())) return s3Client(r2Env());
  if (transport === 'api' || (transport === 'auto' && accountId())) return apiClient({ accountId: accountId() });
  if (transport === 'wrangler' || transport === 'auto') return wranglerClient();
  throw new Error(`unknown transport ${transport} (auto, s3, api or wrangler)`);
}

// ---- Ledger: STATE/r2-uploaded.jsonl, one line per object put ----

export const LEDGER = 'r2-uploaded.jsonl';
const id = (bucket, key) => `${bucket}/${key}`;

export function readLedger(state = STATE) {
  const map = new Map();
  let text = '';
  try {
    text = fs.readFileSync(path.join(state, LEDGER), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      map.set(id(e.bucket, e.key), e);
    } catch {} // a line cut short by a crash
  }
  return map;
}

export function recordUpload(ledger, entry, state = STATE) {
  const e = { at: new Date().toISOString(), ...entry };
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, LEDGER), `${JSON.stringify(e)}\n`);
  ledger.set(id(e.bucket, e.key), e);
}

export const ledgerEntry = (ledger, bucket, key) => ledger.get(id(bucket, key));

// ---- Upload plan ----

// Items are { bucket: 'media' | 'archive', key, file } with file absolute. A plan is a list of
// phases uploaded in order, each phase's objects in parallel. Manifests come after everything else,
// and wall/current.json last, once.

const isHistory = (key) => key.startsWith('wall/manifests/');

// The upload queue as phases: objects (queue order, each key once), history manifests, current.json.
export function planQueue(items) {
  const seen = new Set(), objects = [], manifests = [];
  let current = null;
  for (const it of items) {
    if (it.bucket === 'media' && it.key === CURRENT_KEY) {
      current = it;
      continue;
    }
    if (seen.has(id(it.bucket, it.key))) continue;
    seen.add(id(it.bucket, it.key));
    (it.bucket === 'media' && isHistory(it.key) ? manifests : objects).push(it);
  }
  return [
    { name: 'objects', items: objects },
    { name: 'manifests', items: manifests },
    { name: 'current', items: current ? [current] : [] },
  ].filter((p) => p.items.length);
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// Everything in the local cache, in commit order: cell masters (private bucket), stills, GIFs,
// catalog chunks, tiles finest level first, the pyramid descriptor, manifests, current.json last.
// Files whose names don't fit a published key are returned in `skipped`, not uploaded.
export function planAll({ cache = CACHE, publish = PUBLISH } = {}) {
  const skipped = [];
  const take = (bucket, dir, prefix, re) => listDir(dir).sort(byNumber).flatMap((name) => {
    if (!re.test(name)) {
      skipped.push(`${prefix}${name}`);
      return [];
    }
    return [{ bucket, key: `${prefix}${name}`, file: path.join(dir, name) }];
  });
  const phases = [
    { name: 'cells', items: take('archive', path.join(cache, 'cells/480x270'), 'cells/480x270/', /^\d+\.webp$/) },
    { name: 'stills', items: take('media', path.join(publish, 'stills'), 'stills/', /^\d+(-r\d+)?\.webp$/) },
    { name: 'gifs', items: take('media', path.join(publish, 'gifs'), 'gifs/', /^\d+(-r\d+)?\.gif$/) },
    { name: 'meta', items: take('media', path.join(publish, 'meta'), 'meta/', /^(index|detail)-\d+-[0-9a-f]{8}\.json$/) },
  ];
  const pyramid = path.join(publish, 'wall/p1');
  for (const k of listDir(pyramid).filter((d) => /^\d+$/.test(d)).sort((a, b) => a - b)) {
    phases.push({ name: `tiles k${k}`, items: take('media', path.join(pyramid, k), `wall/p1/${k}/`, /^\d+_\d+_\d+(-r\d+)?\.webp$/) });
  }
  if (fs.existsSync(path.join(pyramid, 'wall.json'))) phases.push({ name: 'wall.json', items: [{ bucket: 'media', key: 'wall/p1/wall.json', file: path.join(pyramid, 'wall.json') }] });
  phases.push({ name: 'manifests', items: take('media', path.join(publish, 'wall/manifests'), 'wall/manifests/', /^\d+-[0-9a-f]{8}\.json$/) });
  if (fs.existsSync(path.join(publish, CURRENT_KEY))) phases.push({ name: 'current', items: [{ bucket: 'media', key: CURRENT_KEY, file: path.join(publish, CURRENT_KEY) }] });
  return { phases: phases.filter((p) => p.items.length), skipped };
}
