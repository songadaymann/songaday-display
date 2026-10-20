import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AZURE, copyGifs, gifHeader, gifIndex, gifRevs, onAzure, scanGifs } from './gifs.mjs';

const gif = (w, h) => {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};

test('gifHeader reads the signature and screen size', () => {
  assert.deepEqual(gifHeader(gif(320, 180)), { w: 320, h: 180 });
  assert.equal(gifHeader(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')), null);
  assert.equal(gifHeader(Buffer.alloc(0)), null);
});

test('Azure holds 1-5854 except 940 and 5832', () => {
  assert.equal(onAzure(1), true);
  assert.equal(onAzure(940), false);
  assert.equal(onAzure(5832), false);
  assert.equal(onAzure(5854), true);
  assert.equal(onAzure(5855), false);
  assert.equal(AZURE.to, 5854);
});

test('gifIndex separates local, online-only and missing songs', () => {
  const real = new Map([[5, { file: '/a/5.gif' }], [940, { file: '/a/940.gif' }], [5860, { file: '/a/5860.gif' }], [5900, { file: '/a/5900.gif' }]]);
  const scan = { real, invalid: new Map(), placeholder: [1, 2, 5856, 5857, 9999], empty: [5858], other: [] };
  const idx = gifIndex(scan, 5901);
  assert.deepEqual(idx.local, { 5: '/a/5.gif', 940: '/a/940.gif', 5860: '/a/5860.gif', 5900: '/a/5900.gif' });
  assert.deepEqual(idx.placeholder, [1, 2, 5856, 5857]);
  assert.deepEqual(idx.noGif, [5832, 5855, 5856, 5857, 5858, 5859, ...Array.from({ length: 39 }, (_, i) => 5861 + i), 5901]);
  assert.deepEqual(idx.recoverable, [5856, 5857]);
  assert.deepEqual(idx.empty, [5858]);
});

test('scanGifs never opens 0-byte files and copyGifs skips unchanged copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifs-test-'));
  try {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, '5855.gif'), gif(320, 180));
    fs.writeFileSync(path.join(src, '6001.gif'), gif(480, 270));
    fs.writeFileSync(path.join(src, '12.gif'), gif(320, 180));
    fs.writeFileSync(path.join(src, '5856.gif'), '');
    fs.writeFileSync(path.join(src, '5857.gif'), 'not a gif at all');
    fs.writeFileSync(path.join(src, 'notes.txt'), 'x');
    const scan = scanGifs(src);
    assert.deepEqual([...scan.real.keys()].sort((a, b) => a - b), [12, 5855, 6001]);
    assert.deepEqual(scan.real.get(6001).w, 480);
    assert.deepEqual(scan.empty, [5856]);
    assert.deepEqual(scan.placeholder, []);
    assert.deepEqual([...scan.invalid.keys()], [5857]);
    assert.deepEqual(scan.other, ['notes.txt']);

    const pub = path.join(dir, 'publish');
    assert.deepEqual(copyGifs(scan.real, pub, { to: 6000 }), { copied: [5855], kept: [] });
    assert.deepEqual(copyGifs(scan.real, pub, { to: 6000 }), { copied: [], kept: [5855] });
    assert.deepEqual(fs.readdirSync(path.join(pub, 'gifs')), ['5855.gif']);

    // A changed source never overwrites the published GIF: it goes to the next revision.
    fs.writeFileSync(path.join(src, '5855.gif'), Buffer.concat([gif(320, 180), Buffer.from('more frames')]));
    assert.deepEqual(copyGifs(scanGifs(src).real, pub, { to: 6000 }), { copied: [5855], kept: [] });
    assert.deepEqual(fs.readdirSync(path.join(pub, 'gifs')).sort(), ['5855-r1.gif', '5855.gif']);
    assert.ok(fs.readFileSync(path.join(pub, 'gifs', '5855.gif')).equals(gif(320, 180)));
    assert.deepEqual([...gifRevs(pub)], [[5855, 1]]);
    assert.deepEqual(copyGifs(scanGifs(src).real, pub, { to: 6000 }), { copied: [], kept: [5855] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
