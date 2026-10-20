import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { duplicateGroups, duplicateIndex } from './dupes.mjs';

const KB = 1024;

test('duplicateGroups finds byte-identical files across songs and names the oldest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dupes-'));
  const big = Buffer.alloc(1024 * KB, 7);
  const twin = Buffer.from(big);
  const nearTwin = Buffer.from(big);
  nearTwin[300 * KB] = 8; // outside the three sampled chunks, so only the full hash tells them apart
  const files = [
    [10, 'a.bin', Buffer.from('same')],
    [11, 'b.bin', Buffer.from('same')],
    [12, 'c.bin', Buffer.from('diff')],
    [20, 'big20.bin', big],
    [21, 'big21.bin', twin],
    [22, 'big22.bin', nearTwin],
  ].map(([n, name, data], i) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, data);
    fs.utimesSync(p, 1000 + (n === 21 ? -500 : i), 1000 + (n === 21 ? -500 : i));
    return { n, path: p, size: data.length, mtimeMs: fs.statSync(p).mtimeMs, placeholder: false };
  });
  files.push({ n: 30, path: path.join(dir, 'never-read'), size: 0, placeholder: true });

  const groups = await duplicateGroups(files);
  assert.deepEqual(groups.map((g) => g.songs), [[10, 11], [20, 21]]);
  assert.equal(groups[1].original, 21, 'the older file is the original');
  const idx = duplicateIndex(groups);
  assert.deepEqual(idx.get(10).others, [11]);
  assert.equal(idx.get(21).original, true);
  assert.equal(idx.get(20).originalN, 21);
  assert.equal(idx.has(22), false);
  fs.rmSync(dir, { recursive: true });
});

test('files of one song never count as duplicates of each other', async () => {
  const hash = () => 'h';
  const groups = await duplicateGroups([
    { n: 1, path: 'x.mp4', size: 5, placeholder: false },
    { n: 1, path: 'x.mov', size: 5, placeholder: false },
  ], { hash, sample: hash });
  assert.deepEqual(groups, []);
});
