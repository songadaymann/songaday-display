// Offline stand-ins for the Worker tests: a Cache API, a JSON-RPC node that understands our
// Multicall3 calls (decoded here independently of abi.js), and an OpenSea API. Not a test file.

const W = (n) => BigInt(n).toString(16).padStart(64, '0');
const padHex = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);

export function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async match(key) {
      const v = entries.get(String(key));
      return v === undefined ? undefined : new Response(v);
    },
    async put(key, res) {
      entries.set(String(key), await res.text());
    },
  };
}

// aggregate3 call data -> [{ target, allowFailure, callData }]
export function decodeAggregate3Calls(data) {
  const h = data.slice(2);
  if (h.slice(0, 8) !== '82ad56cb') throw new Error('not aggregate3');
  const body = h.slice(8);
  const at = (byte) => Number(BigInt('0x' + body.slice(byte * 2, byte * 2 + 64)));
  const base = at(0);
  const len = at(base);
  const start = base + 32;
  const calls = [];
  for (let i = 0; i < len; i++) {
    const el = start + at(start + i * 32);
    const target = '0x' + body.slice(el * 2 + 24, el * 2 + 64);
    const allowFailure = at(el + 32) === 1;
    const dataAt = el + at(el + 64);
    const size = at(dataAt);
    calls.push({ target, allowFailure, callData: '0x' + body.slice((dataAt + 32) * 2, (dataAt + 32 + size) * 2) });
  }
  return calls;
}

export function encodeResults(results) {
  let offset = results.length * 32;
  const heads = [];
  const tails = [];
  for (const { success, data } of results) {
    const d = data.replace(/^0x/, '');
    const tail = W(success ? 1 : 0) + W(64) + W(d.length / 2) + padHex(d);
    heads.push(W(offset));
    tails.push(tail);
    offset += tail.length / 2;
  }
  return '0x' + W(32) + W(results.length) + heads.join('') + tails.join('');
}

const encodeString = (s) => {
  const b = Buffer.from(s, 'utf8').toString('hex');
  return W(b.length / 2) + padHex(b);
};
const encodeStringArray = (list) => {
  const parts = list.map(encodeString);
  let offset = parts.length * 32;
  const heads = parts.map((p) => {
    const h = W(offset);
    offset += p.length / 2;
    return h;
  });
  return '0x' + W(32) + W(list.length) + heads.join('') + parts.join('');
};
const REVERT = '0x08c379a0' + W(32) + W(19) + padHex(Buffer.from('nonexistent token!!').toString('hex'));

// A JSON-RPC node. owners: token -> address (others revert). names: address -> name; an
// address in `reverting` makes its getNames call revert. Records every request in `log`.
export function fakeNode({ url = 'https://rpc.example/v2/SECRET', owners = {}, names = {}, reverting = [], block = '0x1234', fail = null } = {}) {
  const log = [];
  async function fetch(input, init) {
    assert(String(input) === url, `unexpected RPC url ${input}`);
    const req = JSON.parse(init.body);
    log.push(req);
    if (fail) return fail(req);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    if (req.method === 'eth_blockNumber') return reply(block);
    if (req.method !== 'eth_call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `no ${url}` } }));
    const calls = decodeAggregate3Calls(req.params[0].data);
    const results = calls.map(({ callData }) => {
      const sel = callData.slice(2, 10);
      if (sel === '6352211e') {
        const n = Number(BigInt('0x' + callData.slice(10)));
        return owners[n] ? { success: true, data: '0x' + W(BigInt(owners[n])) } : { success: false, data: REVERT };
      }
      if (sel === 'cbf8b66c') {
        const addr = '0x' + callData.slice(10 + 128 + 24, 10 + 192);
        if (reverting.includes(addr)) return { success: false, data: '0x' };
        return { success: true, data: encodeStringArray([names[addr] || '']) };
      }
      return { success: false, data: '0x' };
    });
    return reply(encodeResults(results));
  }
  return { fetch, log, url };
}

// OpenSea v2: contract -> slug, paged listings (`next`), sale events.
export function fakeOpenSea({ slug = 'song-a-day', pages = [[]], events = [], status = null } = {}) {
  const log = [];
  async function fetch(input, init) {
    const url = new URL(String(input));
    log.push({ url, key: init?.headers?.['X-API-KEY'] });
    if (status) return new Response('{}', { status });
    let m;
    if ((m = /^\/api\/v2\/chain\/ethereum\/contract\/(0x[0-9a-f]{40})$/i.exec(url.pathname))) return Response.json({ collection: slug, address: m[1] });
    if (url.pathname === `/api/v2/listings/collection/${slug}/all`) {
      const i = url.searchParams.has('next') ? Number(url.searchParams.get('next').slice(1)) : 0;
      return Response.json({ listings: pages[i] || [], next: i + 1 < pages.length ? `p${i + 1}` : null });
    }
    if (url.pathname === `/api/v2/events/collection/${slug}`) return Response.json({ asset_events: events, next: null });
    return new Response('not found', { status: 404 });
  }
  return { fetch, log };
}

// Routes to the node or OpenSea by URL.
export function fetchBoth(node, openSea) {
  return (input, init) => (String(input).startsWith(node.url) ? node.fetch(input, init) : openSea.fetch(input, init));
}

export function listing(n, wei, { contract, currency = 'ETH', status, endTime = '9999999999', offerer = '0x' + 'ab'.repeat(20) } = {}) {
  return {
    status,
    price: { current: { currency, decimals: 18, value: String(wei) } },
    protocol_data: { parameters: { offerer, endTime, offer: [{ token: contract, identifierOrCriteria: String(n) }] } },
  };
}

export function sale(n, wei, time, { contract, type = 'sale' } = {}) {
  return {
    event_type: type,
    nft: { identifier: String(n), contract },
    payment: { quantity: String(wei), decimals: 18, symbol: 'ETH' },
    seller: '0x' + '11'.repeat(20),
    buyer: '0x' + '22'.repeat(20),
    closing_date: time,
    transaction: '0x' + 'cd'.repeat(32),
  };
}

function assert(ok, msg) {
  if (!ok) throw new Error(msg);
}
