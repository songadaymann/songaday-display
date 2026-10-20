import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filePiece, catalogPiece, cellPiece, applyImage, applyProbe, applyDuplicate, mosaicPiece, crossCheck,
} from './pieces.mjs';

const rec = (n, name, size, placeholder = false) => ({ n, name, ext: name.split('.').pop().toLowerCase(), size, placeholder, path: `/x/${name}` });
const scanOf = (...recs) => {
  const byN = new Map();
  for (const r of recs) byN.set(r.n, [...(byN.get(r.n) || []), r]);
  return { byN };
};

test('filePiece: present, placeholder, missing, outside its era', () => {
  const s = scanOf(rec(1, '1.gif', 9), rec(2, '2.gif', 0, true));
  assert.equal(filePiece(1, s, 'gif').status, 'ok');
  assert.equal(filePiece(2, s, 'gif').status, 'placeholder');
  assert.equal(filePiece(3, s, 'gif').status, 'missing');
  assert.equal(filePiece(3, s, 'still', { from: 4996 }).status, 'n/a');
  assert.equal(filePiece(5000, s, 'still', { from: 4996 }).status, 'missing');
});

test('filePiece: two video versions are suspect, a stray audio format is noted', () => {
  const v = filePiece(4977, scanOf(rec(4977, '4977.mp4', 5), rec(4977, '4977.MOV', 9)), 'video');
  assert.equal(v.status, 'suspect');
  assert.match(v.detail, /two versions: 4977.MOV/);
  const w = filePiece(3591, scanOf(rec(3591, '3591.wav', 5), rec(3591, '3591.m4a', 9)), 'wav');
  assert.equal(w.status, 'ok');
  assert.match(w.detail, /also: 3591.m4a/);
  assert.equal(filePiece(9, scanOf(rec(9, '9.m4a', 9)), 'wav').status, 'suspect');
});

test('catalogPiece checks the date and knows the snapshot date', () => {
  const cat = {
    asOfDate: '2026-10-18',
    songs: new Map([
      [1, { title: 'In the Time of the Gods', isoDate: '2009-01-01', issues: [] }],
      [2, { title: 'Hands', isoDate: '2009-01-03', issues: [] }],
      [3, { title: ' ', isoDate: '2009-01-03', issues: [] }],
    ]),
  };
  assert.equal(catalogPiece(1, cat).status, 'ok');
  assert.equal(catalogPiece(2, cat).status, 'bad');
  assert.equal(catalogPiece(3, cat).status, 'bad');
  assert.equal(catalogPiece(4, cat).status, 'missing');
  assert.equal(catalogPiece(6501, cat).status, 'n/a');
  assert.equal(catalogPiece(1, null).status, 'n/a');
});

test('applyImage: flat black is bad, dark is suspect, portrait is suspect', () => {
  const black = applyImage('still', { status: 'ok' }, { width: 1920, height: 1080, luma: 0, sd: 0, frames: 1 });
  assert.equal(black.status, 'bad');
  const dark = applyImage('still', { status: 'ok' }, { width: 1920, height: 1080, luma: 10.9, sd: 8.6, frames: 1 });
  assert.equal(dark.status, 'suspect');
  const tall = applyImage('gif', { status: 'ok' }, { width: 320, height: 569, luma: 90, sd: 40, frames: 10 });
  assert.match(tall.detail, /not 16:9/);
  assert.equal(applyImage('gif', { status: 'ok' }, { width: 320, height: 180, luma: 90, sd: 40, frames: 10 }).status, 'ok');
  assert.equal(applyImage('still', { status: 'ok' }, null, new Error('VipsJpeg: premature end')).status, 'bad');
});

test('applyProbe: failures, missing streams, short files and length mismatches', () => {
  const audio = (duration) => ({ duration, audio: { codec: 'pcm' }, video: null, warnings: [] });
  assert.equal(applyProbe('wav', { status: 'ok' }, null, new Error('Invalid data')).status, 'bad');
  assert.equal(applyProbe('wav', { status: 'ok' }, audio(156)).status, 'ok');
  assert.equal(applyProbe('wav', { status: 'ok' }, audio(4.7)).status, 'suspect');
  assert.match(applyProbe('wav', { status: 'ok' }, audio(120), null, { sheetSeconds: 152 }).detail, /sheet says 2:32/);
  assert.equal(applyProbe('wav', { status: 'ok' }, audio(140), null, { sheetSeconds: 152 }).status, 'ok', 'hand-typed lengths get slack');
  assert.equal(applyProbe('video', { status: 'ok' }, audio(100)).status, 'bad');
  assert.equal(applyProbe('mp3', { status: 'ok' }, audio(100), null, { wavSeconds: 140 }).status, 'suspect');
});

test('applyDuplicate keeps the oldest copy for review and marks later copies bad', () => {
  const orig = applyDuplicate({ status: 'ok' }, { sha1: 'h', others: [5994], original: true, originalN: 5993 });
  const copy = applyDuplicate({ status: 'ok' }, { sha1: 'h', others: [5993], original: false, originalN: 5993 });
  assert.equal(orig.status, 'suspect');
  assert.equal(copy.status, 'bad');
  assert.match(copy.detail, /later copy of #5993/);
  assert.equal(applyDuplicate({ status: 'placeholder' }, { others: [1] }).status, 'placeholder');
});

test('cellPiece flags dark cells and knows the master range', () => {
  const master = { status: 'ok', count: 3, luma: [0, 80, 5, 3], sd: [0, 40, 10, 0] };
  assert.equal(cellPiece(1, master).status, 'ok');
  assert.match(cellPiece(2, master).detail, /dark cell/);
  assert.match(cellPiece(3, master).detail, /black cell/);
  assert.equal(cellPiece(4, master).status, 'n/a');
  assert.equal(cellPiece(10, { status: 'placeholder', detail: 'x' }).status, 'placeholder');
});

test('mosaicPiece follows design A: master, still, thumb, art, card', () => {
  const ok = { status: 'ok' };
  assert.equal(mosaicPiece({ cell: ok, still: ok }).source, 'master');
  assert.equal(mosaicPiece({ cell: { status: 'n/a' }, still: ok }).source, 'still');
  const ph = mosaicPiece({ cell: { status: 'n/a' }, still: { status: 'placeholder', file: { path: '/p' } } });
  assert.equal(ph.status, 'placeholder');
  const art = mosaicPiece({ cell: { status: 'n/a' }, still: { status: 'missing' }, art: { status: 'ok', detail: 'image_6000.png' } });
  assert.equal(art.source, 'art');
  assert.equal(art.status, 'suspect');
  const card = mosaicPiece({ cell: { status: 'n/a' }, still: { status: 'bad', detail: 'a later copy of #6208' }, art: { status: 'n/a' } });
  assert.equal(card.status, 'missing');
  assert.equal(card.source, 'card');
  assert.match(card.detail, /later copy/);
});

test('crossCheck names the neighbour a WAV belongs to and distrusts a mismatched original', () => {
  const ctx = { catalog: { songs: new Map([[6208, { duration: '3:30' }], [6209, { duration: '4:18' }], [6210, { duration: '2:13' }]]) } };
  const audio = (duration) => ({ duration, audio: { codec: 'pcm' }, video: null, warnings: [] });
  const s6208 = { n: 6208, p: { wav: applyProbe('wav', { status: 'ok' }, audio(133.1), null, { sheetSeconds: 210 }), still: { status: 'ok' } } };
  applyDuplicate(s6208.p.still, { sha1: 'h', others: [6209], original: true, originalN: 6208 });
  assert.equal(s6208.p.still.status, 'suspect');
  crossCheck([s6208], ctx);
  assert.match(s6208.p.wav.detail, /matches the sheet's #6210/);
  assert.equal(s6208.p.still.status, 'bad');
});
