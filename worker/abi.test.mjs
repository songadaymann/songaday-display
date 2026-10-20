import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTORS,
  encodeOwnerOf,
  encodeAggregate3,
  decodeAggregate3,
  encodeGetNames,
  decodeStringArray,
  decodeAddress,
} from './abi.js';

// Keccak-256 (the pre-SHA-3 padding Ethereum uses), slow and small, only to check selectors.
function keccak256(text) {
  const M = (1n << 64n) - 1n;
  const rotl = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M : v);
  const lfsr = (t) => {
    let r = 1;
    for (let i = 0; i < t % 255; i++) {
      r <<= 1;
      if (r & 0x100) r ^= 0x171;
    }
    return r & 1;
  };
  const RC = Array.from({ length: 24 }, (_, i) => {
    let rc = 0n;
    for (let j = 0; j < 7; j++) if (lfsr(j + 7 * i)) rc |= 1n << BigInt(2 ** j - 1);
    return rc;
  });
  const ROT = Array(25).fill(0);
  for (let t = 0, x = 1, y = 0; t < 24; t++) {
    ROT[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  const rate = 136;
  const msg = [...new TextEncoder().encode(text)];
  msg.push(0x01);
  while (msg.length % rate) msg.push(0);
  msg[msg.length - 1] |= 0x80;
  const A = Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      A[i] ^= lane;
    }
    for (let round = 0; round < 24; round++) {
      const C = Array.from({ length: 5 }, (_, x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
      }
      const B = Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= RC[round];
    }
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += ((A[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return out;
}

const W = (n) => BigInt(n).toString(16).padStart(64, '0');
const A1 = '0x19b703f65aA7E1E775BD06c2aa0D0d08c80f1C45';
const A2 = '0x00000000000000000000000000000000000000aa';

test('the keccak helper matches known vectors', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('transfer(address,uint256)').slice(0, 8), 'a9059cbb');
});

test('selectors are keccak256 of their signatures', () => {
  assert.equal(SELECTORS.aggregate3, keccak256('aggregate3((address,bool,bytes)[])').slice(0, 8));
  assert.equal(SELECTORS.ownerOf, keccak256('ownerOf(uint256)').slice(0, 8));
  assert.equal(SELECTORS.getNames, keccak256('getNames(address[])').slice(0, 8));
});

test('ownerOf call data is selector plus one word', () => {
  assert.equal(encodeOwnerOf(6501), `0x6352211e${W(6501)}`);
  assert.equal(encodeOwnerOf(1).length, 2 + 8 + 64);
});

test('aggregate3 encodes dynamic tuples with element-relative offsets', () => {
  const callData = encodeOwnerOf(7);
  const hex = encodeAggregate3([
    { target: A1, callData },
    { target: A2, allowFailure: false, callData: '0x' },
  ]);
  const elem1 = A1.slice(2).toLowerCase().padStart(64, '0') + W(1) + W(96) + W(36) + callData.slice(2) + '0'.repeat(56);
  const elem2 = A2.slice(2).padStart(64, '0') + W(0) + W(96) + W(0);
  const expected = '0x82ad56cb' + W(32) + W(2) + W(64) + W(64 + elem1.length / 2) + elem1 + elem2;
  assert.equal(hex, expected);
  assert.equal((hex.length - 10) % 64, 0);
});

test('aggregate3 rejects bad input', () => {
  assert.throws(() => encodeAggregate3([{ target: '0x123', callData: '0x' }]));
  assert.throws(() => encodeAggregate3([{ target: A1, callData: '0xabc' }]));
});

// Builds (bool success, bytes returnData)[] the way a node returns it.
function encodeResults(results) {
  let offset = results.length * 32;
  const heads = [];
  const tails = [];
  for (const { success, data } of results) {
    const d = data.slice(2);
    const tail = W(success ? 1 : 0) + W(64) + W(d.length / 2) + d + '0'.repeat((64 - (d.length % 64)) % 64);
    heads.push(W(offset));
    tails.push(tail);
    offset += tail.length / 2;
  }
  return '0x' + W(32) + W(results.length) + heads.join('') + tails.join('');
}

test('aggregate3 results decode, including reverts and empty data', () => {
  const owner = '0x' + W(BigInt(A1));
  const revert = '0x08c379a0' + W(32) + W(5) + Buffer.from('nope!').toString('hex').padEnd(64, '0');
  const out = decodeAggregate3(encodeResults([
    { success: true, data: owner },
    { success: false, data: revert },
    { success: false, data: '0x' },
  ]));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { success: true, data: owner });
  assert.equal(out[1].success, false);
  assert.equal(out[1].data, revert);
  assert.deepEqual(out[2], { success: false, data: '0x' });
  assert.equal(decodeAddress(out[0].data), A1.toLowerCase());
});

test('aggregate3 decoding refuses truncated or absurd data', () => {
  const good = encodeResults([{ success: true, data: '0x' + W(1) }]);
  assert.throws(() => decodeAggregate3(good.slice(0, -64)));
  assert.throws(() => decodeAggregate3('0x' + W(32) + W(1_000_000)));
  assert.throws(() => decodeAggregate3('0xzz'));
  assert.deepEqual(decodeAggregate3('0x' + W(32) + W(0)), []);
});

test('decodeAddress takes clean address words only', () => {
  assert.equal(decodeAddress('0x' + W(0xaa)), A2);
  assert.equal(decodeAddress('0x' + W(0)), null);
  assert.equal(decodeAddress('0x' + 'f'.repeat(64)), null); // dirty upper bytes
  assert.equal(decodeAddress('0x1234'), null);
  assert.equal(decodeAddress(undefined), null);
});

test('getNames encodes a static address array', () => {
  assert.equal(encodeGetNames([A1, A2]), '0xcbf8b66c' + W(32) + W(2) + W(BigInt(A1)) + W(0xaa));
  assert.throws(() => encodeGetNames(['nope']));
});

test('string arrays decode as UTF-8', () => {
  const enc = (s) => {
    const b = Buffer.from(s, 'utf8').toString('hex');
    return W(b.length / 2) + b + '0'.repeat((64 - (b.length % 64)) % 64);
  };
  const parts = ['jonathanmann.eth', '', 'ünïcode.eth'].map(enc);
  let offset = parts.length * 32;
  const heads = parts.map((p) => {
    const h = W(offset);
    offset += p.length / 2;
    return h;
  });
  const hex = '0x' + W(32) + W(parts.length) + heads.join('') + parts.join('');
  assert.deepEqual(decodeStringArray(hex), ['jonathanmann.eth', '', 'ünïcode.eth']);
});
