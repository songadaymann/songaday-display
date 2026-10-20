// Collectors, rebuilt from the chain: ownerOf(n) for every song number through Multicall3,
// 500 tokens per eth_call (about 14 calls), every call pinned to one block. A reverted ownerOf
// means the token isn't minted (yet), so this is also the only source of minted status.
import { encodeAggregate3, decodeAggregate3, encodeOwnerOf, decodeAddress } from './abi.js';
import { pool } from './rpc.js';
import { UpstreamError } from './http.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const BATCH = 500;

// Song n came out on day n, counting 2009-01-01 as day 1 (same rule as app/src/core/dates.js).
const EPOCH = Date.UTC(2009, 0, 1);
export const latestSong = (t) => Math.floor((t - EPOCH) / 86_400_000) + 1;
// Tokens are minted when a song's auction settles, so nothing past tomorrow's song can exist.
export const maxTokenAt = (t) => latestSong(t) + 1;

export async function readHolders({ call, contract, maxToken, batch = BATCH, concurrency = 4 }) {
  const block = await call('eth_blockNumber', []);
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(block)) throw new UpstreamError('rpc eth_blockNumber: bad result');
  const ranges = [];
  for (let from = 1; from <= maxToken; from += batch) ranges.push([from, Math.min(maxToken, from + batch - 1)]);
  const owners = new Array(maxToken + 1).fill(null);
  await pool(ranges, concurrency, async ([from, to]) => {
    const calls = [];
    for (let n = from; n <= to; n++) calls.push({ target: contract, allowFailure: true, callData: encodeOwnerOf(n) });
    const results = multicallResults(await call('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, block]), calls.length);
    results.forEach((r, i) => {
      owners[from + i] = r.success ? decodeAddress(r.data) : null;
    });
  });
  return holdersFrom(owners, { contract, block: parseInt(block, 16), maxToken });
}

// Decoded aggregate3 results, checked against the number of calls sent.
export function multicallResults(hex, expected) {
  let results;
  try {
    results = decodeAggregate3(hex);
  } catch (err) {
    throw new UpstreamError(`multicall: ${err.message}`);
  }
  if (results.length !== expected) throw new UpstreamError('multicall: wrong number of results');
  return results;
}

// owners[n] = owner address or null. Holders sorted by song count, then address.
export function holdersFrom(owners, { contract, block, maxToken }) {
  const byOwner = new Map();
  const unminted = [];
  for (let n = 1; n <= maxToken; n++) {
    const a = owners[n];
    if (!a) {
      unminted.push(n);
      continue;
    }
    if (!byOwner.has(a)) byOwner.set(a, []);
    byOwner.get(a).push(n);
  }
  const holders = [...byOwner]
    .map(([address, tokens]) => ({ address, tokens }))
    .sort((a, b) => b.tokens.length - a.tokens.length || (a.address < b.address ? -1 : 1));
  return { contract, block, checked: { from: 1, to: maxToken }, minted: maxToken - unminted.length, unminted, holders };
}
