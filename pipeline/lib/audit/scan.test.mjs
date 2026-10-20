import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSongFiles, scanOutputDirs, placeholderSet } from './scan.mjs';

const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/xattr');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-scan-'));
  fs.writeFileSync(path.join(dir, '1.wav'), 'RIFF');
  fs.writeFileSync(path.join(dir, '2.wav'), '');
  fs.writeFileSync(path.join(dir, '3.wav'), '');
  fs.writeFileSync(path.join(dir, '0004.wav'), 'x');
  fs.writeFileSync(path.join(dir, '4.m4a'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  if (mac) execFileSync('/usr/bin/xattr', ['-w', 'com.dropbox.placeholder', 'x', path.join(dir, '3.wav')]);
  return dir;
}

test('scanSongFiles groups files by song number and marks placeholders', async () => {
  const dir = fixture();
  const scan = await scanSongFiles(dir);
  assert.deepEqual([...scan.byN.keys()].sort(), [1, 2, 3, 4]);
  assert.deepEqual(scan.other, ['notes.txt']);
  assert.equal(scan.byN.get(4).length, 2);
  const two = scan.byN.get(2)[0];
  const three = scan.byN.get(3)[0];
  assert.equal(two.size, 0);
  if (mac) {
    assert.equal(two.placeholder, false, 'a 0-byte file without the xattr is empty, not a placeholder');
    assert.equal(three.placeholder, true);
  }
  assert.equal(scan.byN.get(1)[0].placeholder, false);
  fs.rmSync(dir, { recursive: true });
});

test('placeholderSet never lists real files', { skip: !mac }, async () => {
  const dir = fixture();
  const set = await placeholderSet(dir);
  assert.deepEqual([...set].map((p) => path.basename(p)), ['3.wav']);
  fs.rmSync(dir, { recursive: true });
});

test('scanOutputDirs reads output/<n>/ folders only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-out-'));
  fs.mkdirSync(path.join(root, '6000'));
  fs.writeFileSync(path.join(root, '6000', 'metadata.json'), '{}');
  fs.mkdirSync(path.join(root, 'run-logs'));
  const out = await scanOutputDirs(root);
  assert.deepEqual([...out.keys()], [6000]);
  assert.equal(out.get(6000).get('metadata.json').size, 2);
  assert.equal((await scanOutputDirs(path.join(root, 'nope'))).size, 0);
  fs.rmSync(root, { recursive: true });
});
