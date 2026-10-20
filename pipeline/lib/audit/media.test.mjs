import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { imageStats, is169, parseLength, lumaStats } from './media.mjs';
import { masterCells } from './master.mjs';
import { WALL } from '../../../shared/layout.mjs';

test('parseLength, is169 and lumaStats', () => {
  assert.equal(parseLength('2:36'), 156);
  assert.equal(parseLength('1:02:03'), 3723);
  assert.equal(parseLength('n/a'), null);
  assert.ok(is169(1920, 1080) && is169(320, 180) && !is169(320, 569) && !is169(1080, 1920));
  assert.deepEqual(lumaStats(Buffer.from([10, 10, 10])), { mean: 10, sd: 0 });
});

test('imageStats measures a black frame and a picture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-media-'));
  const black = path.join(dir, 'black.png');
  const pic = path.join(dir, 'pic.jpg');
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#000' } }).png().toFile(black);
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#000' } })
    .composite([{ input: { create: { width: 80, height: 90, channels: 3, background: '#fff' } }, left: 0, top: 0 }])
    .jpeg().toFile(pic);
  const b = await imageStats(black);
  assert.deepEqual([b.width, b.height, Math.round(b.luma), Math.round(b.sd)], [160, 90, 0, 0]);
  const p = await imageStats(pic);
  assert.ok(p.luma > 100 && p.sd > 100);
  await assert.rejects(imageStats(path.join(dir, 'nope.jpg')));
  fs.rmSync(dir, { recursive: true });
});

test('masterCells reads each cell of a one-row master', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-master-'));
  const file = path.join(dir, 'master.jpg');
  const W = WALL.cols * WALL.cellW, H = WALL.cellH;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
    .composite([{ input: { create: { width: WALL.cellW, height: H, channels: 3, background: '#fff' } }, left: WALL.cellW * 2, top: 0 }])
    .jpeg({ quality: 90 }).toFile(file);
  const m = await masterCells(file);
  assert.equal(m.count, WALL.cols);
  assert.ok(m.luma[1] < 2 && m.sd[1] < 2);
  assert.ok(m.luma[3] > 250);
  assert.ok(m.luma[4] < 2);
  fs.rmSync(dir, { recursive: true });
});
