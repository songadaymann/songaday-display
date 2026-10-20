// Just enough Solidity ABI for the Worker's eth_calls, by hand so the Worker needs no ethers:
// Multicall3 aggregate3, ERC-721 ownerOf and ENS ReverseRecords getNames. Hex strings in and
// out carry a 0x prefix; offsets and lengths below are in bytes.

// First 4 bytes of keccak256 of each signature (checked against a keccak in abi.test.mjs).
export const SELECTORS = Object.freeze({
  aggregate3: '82ad56cb', // aggregate3((address,bool,bytes)[])
  ownerOf: '6352211e', // ownerOf(uint256)
  getNames: 'cbf8b66c', // getNames(address[])
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s) => typeof s === 'string' && ADDRESS.test(s);

const strip = (hex) => (hex.startsWith('0x') ? hex.slice(2) : hex);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const padRight = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);

function addressWord(addr) {
  if (!isAddress(addr)) throw new TypeError(`not an address: ${addr}`);
  return strip(addr).toLowerCase().padStart(64, '0');
}

export const encodeOwnerOf = (tokenId) => `0x${SELECTORS.ownerOf}${word(tokenId)}`;

export const encodeGetNames = (addresses) =>
  `0x${SELECTORS.getNames}${word(32)}${word(addresses.length)}${addresses.map(addressWord).join('')}`;

// aggregate3(calls): each call is { target, allowFailure = true, callData }. The array's
// elements are dynamic tuples, so heads hold offsets from the start of the element area.
export function encodeAggregate3(calls) {
  const heads = [];
  const tails = [];
  let offset = calls.length * 32;
  for (const { target, allowFailure = true, callData } of calls) {
    const data = strip(callData);
    if (data.length % 2 || /[^0-9a-fA-F]/.test(data)) throw new TypeError('callData must be hex bytes');
    const tail = addressWord(target) + word(allowFailure ? 1 : 0) + word(96) + word(data.length / 2) + padRight(data);
    heads.push(word(offset));
    tails.push(tail);
    offset += tail.length / 2;
  }
  return `0x${SELECTORS.aggregate3}${word(32)}${word(calls.length)}${heads.join('')}${tails.join('')}`;
}

// Bounds-checked reads from a hex blob. Anything malformed throws rather than guessing.
function reader(hex) {
  const h = strip(String(hex ?? ''));
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('ABI: not hex');
  const size = h.length / 2;
  const need = (at, len) => {
    if (!(at >= 0 && len >= 0 && at + len <= size)) throw new Error('ABI: read past the end');
  };
  return {
    size,
    uint(at) {
      need(at, 32);
      const v = BigInt(`0x${h.slice(at * 2, at * 2 + 64)}`);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ABI: number too large');
      return Number(v);
    },
    bytes(at, len) {
      need(at, len);
      return h.slice(at * 2, (at + len) * 2);
    },
  };
}

// Dynamic array of dynamic elements at the top level: calls read(r, elementStart) per element.
function decodeArray(hex, read) {
  const r = reader(hex);
  const base = r.uint(0);
  const len = r.uint(base);
  const start = base + 32;
  if (len > (r.size - start) / 32) throw new Error('ABI: bad array length');
  return Array.from({ length: len }, (_, i) => read(r, start + r.uint(start + i * 32)));
}

// Returns [{ success, data }] for aggregate3's (bool success, bytes returnData)[].
export const decodeAggregate3 = (hex) =>
  decodeArray(hex, (r, at) => {
    const success = r.uint(at) === 1;
    const dataAt = at + r.uint(at + 32);
    return { success, data: `0x${r.bytes(dataAt + 32, r.uint(dataAt))}` };
  });

const utf8 = new TextDecoder();
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));

export const decodeStringArray = (hex) =>
  decodeArray(hex, (r, at) => utf8.decode(fromHex(r.bytes(at + 32, r.uint(at)))));

// An ABI-encoded address (one word, top 12 bytes zero), lowercased. null for anything else,
// including the zero address.
export function decodeAddress(hex) {
  const h = strip(String(hex ?? ''));
  if (h.length !== 64 || !/^0{24}[0-9a-fA-F]{40}$/.test(h)) return null;
  const addr = `0x${h.slice(24).toLowerCase()}`;
  return /^0x0{40}$/.test(addr) ? null : addr;
}
