// Reverse ENS names through ENS's ReverseRecords contract, which checks each name forwards
// too. Each address is its own getNames([a]) call inside one Multicall3 aggregate3, so one
// resolver that reverts (an offchain name, say) costs that address its name, not the batch.
import { encodeAggregate3, encodeGetNames, decodeStringArray, isAddress } from './abi.js';
import { MULTICALL3, multicallResults } from './holders.js';
import { HttpError } from './http.js';

export const REVERSE_RECORDS = '0x3671aE578E63FdF66ad4F3E12CC0c0d71Ac7510C';
export const MAX_ADDRESSES = 50;

// ?addresses=0xa,0xb -> sorted, unique, lowercased. 400 for anything else.
export function parseAddresses(param) {
  const parts = String(param ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'addresses required');
  if (parts.length > MAX_ADDRESSES) throw new HttpError(400, `at most ${MAX_ADDRESSES} addresses`);
  if (!parts.every(isAddress)) throw new HttpError(400, 'bad address');
  return [...new Set(parts.map((a) => a.toLowerCase()))].sort();
}

// A name fit to show: printable, no spaces, has a dot, not absurdly long.
export function cleanName(s) {
  if (typeof s !== 'string' || !s || s.length > 255) return null;
  return /^[^\s\p{C}]+\.[^\s\p{C}.]+$/u.test(s) ? s : null;
}

export async function reverseNames({ call, addresses, resolver = REVERSE_RECORDS }) {
  const calls = addresses.map((a) => ({ target: resolver, allowFailure: true, callData: encodeGetNames([a]) }));
  const results = multicallResults(await call('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest']), calls.length);
  const names = {};
  addresses.forEach((a, i) => {
    let name = null;
    if (results[i]?.success) {
      try {
        name = cleanName(decodeStringArray(results[i].data)[0]);
      } catch {
        name = null;
      }
    }
    names[a] = name;
  });
  return names;
}
