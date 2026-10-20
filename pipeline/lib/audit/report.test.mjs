import test from 'node:test';
import assert from 'node:assert/strict';
import { ranges, toCsv, relPath, buildGaps, buildSummary, renderMarkdown } from './report.mjs';
import { priority, isGap } from './fixes.mjs';
import { sizeEstimator, formatBytes } from './estimate.mjs';

test('ranges compresses runs', () => {
  assert.equal(ranges([6007, 6000, 6001, 6004, 6006, 6210]), '6000-6001, 6004, 6006-6007, 6210');
  assert.equal(ranges([]), '');
});

test('toCsv quotes commas, quotes and newlines', () => {
  assert.equal(toCsv([['a', 'b,c', 'say "hi"', 'x\ny', 3]]), 'a,"b,c","say ""hi""","x\ny",3\n');
});

test('relPath names the env var instead of the machine path', () => {
  const roots = { SONGADAY_ARCHIVE_DIR: '/data/archive', SONGADAY_TOOLKIT_DIR: '/data/archive/toolkit' };
  assert.equal(relPath('/data/archive/Every Song A Day Gif/1.gif', roots), '$SONGADAY_ARCHIVE_DIR/Every Song A Day Gif/1.gif');
  assert.equal(relPath('/data/archive/toolkit/all-metadata/1.json', roots), '$SONGADAY_TOOLKIT_DIR/all-metadata/1.json');
  assert.equal(relPath('/elsewhere/x', roots), '/elsewhere/x');
});

test('placeholders are gaps only where a build needs the bytes', () => {
  assert.equal(isGap('gif', 'placeholder', 100), false, 'old GIFs come from the Azure copy');
  assert.equal(isGap('gif', 'placeholder', 5860), true);
  assert.equal(isGap('video', 'placeholder', 5860), false);
  assert.equal(isGap('mosaic', 'placeholder', 6100), true);
  assert.equal(isGap('wav', 'ok', 1), false);
  assert.equal(priority('mosaic', 'missing', 6210), 'gallery');
  assert.equal(priority('gif', 'missing', 940), 'archive');
  assert.equal(priority('youtube', 'bad', 2163), 'catalog');
  assert.equal(priority('mosaic', 'suspect', 1), 'review');
});

test('buildGaps sorts by priority, then song', () => {
  const res = {
    roots: {},
    pieces: ['youtube', 'gif', 'mosaic'],
    songs: [
      { n: 2163, date: '2014-12-03', title: 't', p: { youtube: { status: 'bad', flags: ['malformed'], detail: 'malformed link in sheet: x' }, gif: { status: 'placeholder' }, mosaic: { status: 'ok' } } },
      { n: 6210, date: '2026-01-01', title: 'Game A Day', p: { youtube: { status: 'ok' }, gif: { status: 'missing' }, mosaic: { status: 'missing', source: 'card' } } },
    ],
  };
  const gaps = buildGaps(res);
  assert.deepEqual(gaps.map((g) => `${g.priority}:${g.n}:${g.piece}`), ['gallery:6210:gif', 'gallery:6210:mosaic', 'catalog:2163:youtube']);
  assert.match(gaps[2].fix, /column T/);
});

test('sizeEstimator uses the same year, else the nearest year with data', () => {
  const year = (n) => 2009 + Math.floor((n - 1) / 365);
  const est = sizeEstimator([{ n: 1, size: 100 }, { n: 2, size: 300 }, { n: 365 * 10, size: 1000 }, { n: 5, size: 0 }], year);
  assert.equal(est(3), 200);
  assert.equal(est(365 * 9 + 1), 1000);
  assert.equal(est(365 * 3), 200);
  assert.equal(formatBytes(6_300_000), '6.3 MB');
});

test('summary and markdown render from a small run without holes', () => {
  const file = (n, size, placeholder = false) => ({ n, path: `/a/Every Song A Day Gif/${n}.gif`, size, placeholder, mtimeMs: 0 });
  const gifScan = { dir: '/a/Every Song A Day Gif', byN: new Map([[5856, [file(5856, 0, true)]], [5906, [file(5906, 130_000)]]]), other: [] };
  const res = {
    opts: { deep: false }, sampleStep: 50, from: 5855, to: 5906, highest: 5906, today: '2026-10-20', todayN: 6502,
    pieces: ['gif', 'mosaic'], roots: { SONGADAY_ARCHIVE_DIR: '/a' }, scans: { gif: gifScan }, catalog: null, ytCache: null,
    master: null, masterCount: 5852, jsonl: { songs: new Map(), bad: [] }, decoded: { gif: 1 }, timings: { total: 1200 },
    dupGroups: { gif: [{ songs: [5993, 5994], original: 5993, size: 1, sha1: 'x' }] },
    songs: [
      { n: 5855, date: '2025-01-11', title: 'a', p: { gif: { status: 'missing' }, mosaic: { status: 'ok', source: 'still' } } },
      { n: 5856, date: '2025-01-12', title: 'b', p: { gif: { status: 'placeholder', file: file(5856, 0, true) }, mosaic: { status: 'missing', source: 'card', detail: 'no usable image' } } },
      { n: 5906, date: '2025-03-03', title: 'c', p: { gif: { status: 'ok', file: file(5906, 130_000) }, mosaic: { status: 'ok', source: 'still' } } },
    ],
  };
  const gaps = buildGaps(res);
  const sum = buildSummary(res, gaps);
  assert.equal(sum.offline.forGallery.files, 1);
  assert.equal(sum.offline.forGallery.estBytes, 130_000);
  assert.equal(sum.offline.forGallery.folders[0].folder, '$SONGADAY_ARCHIVE_DIR/Every Song A Day Gif');
  assert.deepEqual(sum.songsWithMissingCorePiece.byPiece, { gif: '5855', mosaic: '5856' });
  const md = renderMarkdown(sum, gaps);
  assert.doesNotMatch(md, /undefined|NaN/);
  assert.match(md, /\[5993 = 5994\]/);
});
