import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { cardCell, cardSvg, cellFile, contiguousCount, decide, fitCell, importSongs, localFiles, markDuplicates, meanLuma, readCell } from './cells.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-cells-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A test image: left half red, right half blue, so crops and placement are easy to check.
async function image(w, h, file, format = 'png') {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [220, 30, 30] : [30, 30, 220], (y * w + x) * 3);
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  const buf = await (format === 'jpg' ? img.jpeg({ quality: 90 }) : img.png()).toBuffer();
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
  return buf;
}
const px = (raw, x, y) => [...raw.subarray((y * 480 + x) * 3, (y * 480 + x) * 3 + 3)];

test('fitCell crops near-16:9 images to fill and flags nothing', async () => {
  for (const [w, h] of [[1920, 1080], [3456, 1934], [1800, 1000]]) {
    const { raw, flags } = await fitCell(await image(w, h));
    assert.equal(raw.length, 480 * 270 * 3);
    assert.deepEqual(flags, [], `${w}x${h}`);
  }
});

test('fitCell shows portrait and odd-aspect images whole over a darkened copy', async () => {
  const p = await fitCell(await image(1080, 1920));
  assert.deepEqual(p.flags, ['portrait']);
  const centre = px(p.raw, 240 - 30, 135), edge = px(p.raw, 5, 135);
  assert.ok(centre[0] > 150, `foreground is bright: ${centre}`);
  assert.ok(Math.max(...edge) < 120, `background is darkened: ${edge}`);
  const wide = await fitCell(await image(2000, 1000));
  assert.deepEqual(wide.flags, ['aspect']);
});

test('cards render at cell size, dark with light type, and escape titles', async () => {
  assert.match(cardSvg(7, 'Rock & Roll <3'), /Rock &amp; Roll &lt;3/);
  const raw = await cardCell(6001, 'Trump vs. Elon (WHO COULD HAVE SEEN THIS COMING?) and a much longer tail to wrap');
  assert.equal(raw.length, 480 * 270 * 3);
  assert.ok(meanLuma(raw) < 30);
  assert.ok(raw.some((v) => v > 200), 'text is drawn');
});

test('meanLuma and duplicate marking', () => {
  assert.ok(Math.abs(meanLuma(Buffer.from([255, 255, 255, 0, 0, 0])) - 127.5) < 1e-6);
  const cells = { 1: { sha256: 'a', flags: ['dark'] }, 2: { sha256: 'b', flags: ['duplicate'] }, 3: { sha256: 'a', flags: [] } };
  assert.deepEqual(markDuplicates(cells), [[1, 3]]);
  assert.deepEqual(cells[1].flags, ['dark', 'duplicate']);
  assert.deepEqual(cells[2].flags, []);
});

test('decide: skip unchanged, import better or changed sources, keep when the source went offline', () => {
  const still = { kind: 'still', source: 'archive:a.jpg', mtime: 1, size: 2 };
  const e = { ...still, sha256: 'x' };
  const on = { cellExists: true };
  assert.equal(decide(e, still, on), 'skip');
  assert.equal(decide(e, { ...still, size: 3 }, on), 'import');
  assert.equal(decide(e, still, { cellExists: false }), 'import');
  assert.equal(decide(e, still, { ...on, force: true }), 'import');
  assert.equal(decide(e, { kind: 'card', source: 'card' }, { ...on, offline: true }), 'keep');
  assert.equal(decide(e, { kind: 'card', source: 'card' }, on), 'import'); // its source was disqualified
  assert.equal(decide({ kind: 'file', source: 'file:/x.jpg' }, { kind: 'card', source: 'card' }, on), 'keep');
  assert.equal(decide(e, { kind: 'card', source: 'card' }, { ...on, offline: true, force: true }), 'keep'); // --force never downgrades
  assert.equal(decide(e, { kind: 'still', source: 'archive:a.png', mtime: 1, size: 2 }, { ...on, offline: true, force: true }), 'import');
  assert.equal(decide({ kind: 'card', source: 'card', title: null }, still, on), 'import');
  assert.equal(decide({ kind: 'card', source: 'card', title: null }, { kind: 'card', source: 'card', title: 'New' }, on), 'import');
  assert.equal(decide(e, null, on), 'keep');
  assert.equal(decide({ kind: 'frame' }, null, { ...on, strict: true }), 'unavailable');
});

test('decide: a cell made with wall-add --still is pinned until --force or its file changes', () => {
  const on = { cellExists: true };
  const fix = { kind: 'file', source: 'file:/fix.jpg', mtime: 5, size: 6, sha256: 'f' };
  const master = { kind: 'master', source: 'legacy:level_7_master.jpg', mtime: 1, size: 2 };
  const still = { kind: 'still', source: 'archive:EverySongADayPNG/6000.jpg', mtime: 1, size: 2 };
  assert.equal(decide(fix, master, on), 'keep'); // a plain cells:import doesn't undo the fix
  assert.equal(decide(fix, still, on), 'keep');
  assert.equal(decide(fix, master, { ...on, force: true }), 'import');
  assert.equal(decide(fix, { ...fix }, on), 'skip');
  assert.equal(decide(fix, { ...fix, mtime: 7 }, on), 'import'); // the fix file itself changed
  assert.equal(decide(fix, master, { cellExists: false }), 'import');

  assert.equal(decide(undefined, null, { cellExists: true }), 'unavailable');
});

test('localFiles skips empty files', () => {
  const a = path.join(tmp, 'real.bin'), b = path.join(tmp, 'empty.bin');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, '');
  assert.deepEqual([...localFiles([a, b, path.join(tmp, 'nope')])], [a]);
});

test('importSongs walks the fallback chain, is incremental, and keeps cells whose source went offline', async () => {
  const archive = path.join(tmp, 'archive'), output = path.join(tmp, 'output');
  const cellsDir = path.join(tmp, 'cells'), publishDir = path.join(tmp, 'publish'), cellsFile = path.join(tmp, 'cells.json');
  const legacy = path.join(tmp, 'legacy.jsonl');
  fs.writeFileSync(legacy, `${JSON.stringify({ token_id: 19003, name: 'A Song & Its Title' })}\n`);
  Object.assign(process.env, { SONGADAY_ARCHIVE_DIR: archive, SONGADAY_TOOLKIT_OUTPUT_DIR: output, SONGADAY_LEGACY_JSONL: legacy });
  const stills = path.join(archive, 'EverySongADayPNG');
  await image(1920, 1080, path.join(stills, '19000.jpg'), 'jpg');
  await image(1080, 1920, path.join(stills, '19002.png'));
  fs.copyFileSync(path.join(stills, '19000.jpg'), path.join(stills, '19005.jpg'));
  fs.writeFileSync(path.join(stills, '19004.jpg'), ''); // an online-only placeholder
  await image(3290, 1864, path.join(output, '19001', 'image_19001.png'));
  fs.mkdirSync(path.join(output, '19004'), { recursive: true });
  const video = path.join(output, '19004', 'bluesky.mp4');
  spawnSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=2',
    '-pix_fmt', 'yuv420p', '-y', video], { stdio: 'ignore' });
  const haveVideo = fs.existsSync(video) && fs.statSync(video).size > 0; // no ffmpeg: the song falls back to a card
  // An output folder holding another song's upload (like output/6210, which is 6209's) is ignored.
  await image(1920, 1080, path.join(output, '19006', 'image_19006.png'));
  fs.writeFileSync(path.join(output, '19006', 'metadata.json'), JSON.stringify({ token_id: 19005 }));
  fs.writeFileSync(path.join(output, '19001', 'metadata.json'), JSON.stringify({ token_id: 19001 }));
  // An archive video beats the song's art: its middle frame is how the toolkit makes stills.
  await image(1920, 1080, path.join(output, '19007', 'image_19007.png'));
  if (haveVideo) {
    fs.mkdirSync(path.join(archive, 'Every Song A Day Video'), { recursive: true });
    fs.copyFileSync(video, path.join(archive, 'Every Song A Day Video', '19007.mp4'));
  }

  const songs = [19000, 19001, 19002, 19003, 19004, 19005, 19006, 19007];
  const opts = { cellsFile, cellsDir, publishDir, cardsBefore: Infinity, concurrency: 2 };
  const first = await importSongs(songs, { ...opts, cells: {} });
  const by = Object.fromEntries(first.results.map((r) => [r.n, r]));
  assert.deepEqual(songs.map((n) => by[n].status), Array(8).fill('imported'));
  assert.deepEqual(songs.map((n) => by[n].kind), ['still', 'art', 'still', 'card', haveVideo ? 'frame' : 'card', 'still', 'card', haveVideo ? 'frame' : 'art']);
  assert.deepEqual(by[19002].flags, ['portrait']);
  assert.ok(by[19003].flags.includes('card'));
  assert.equal(first.cells[19003].title, 'A Song & Its Title');
  assert.deepEqual(first.duplicates, [[19000, 19005], ...(haveVideo ? [[19004, 19007]] : [])]); // 19007 reuses 19004's video
  assert.ok(first.cells[19000].flags.includes('duplicate'));
  for (const n of songs) assert.ok(fs.existsSync(path.join(publishDir, 'stills', `${n}.webp`)));

  // The lossless master holds exactly the pixels that were fitted.
  const fitted = await fitCell(path.join(stills, '19000.jpg'));
  assert.ok((await readCell(19000, cellsDir)).equals(fitted.raw));

  const cells = JSON.parse(fs.readFileSync(cellsFile, 'utf8'));
  const again = await importSongs(songs, { ...opts, cells });
  assert.deepEqual(again.results.map((r) => r.status), Array(8).fill('unchanged'));

  // A fix from an explicit file survives a plain re-import, and its still moves to a new key.
  const fix = path.join(tmp, 'fix.png');
  await image(1920, 1080, fix);
  const before = fs.readFileSync(path.join(publishDir, 'stills', '19005.webp'));
  const fixed = await importSongs([19005], { ...opts, cells, files: { 19005: fix } });
  assert.deepEqual([fixed.results[0].status, fixed.results[0].kind, fixed.results[0].changed], ['imported', 'file', true]);
  assert.equal(cells[19005].stillRev, 1);
  assert.ok(fs.readFileSync(path.join(publishDir, 'stills', '19005.webp')).equals(before), 'the published still keeps its bytes');
  assert.ok(fs.existsSync(path.join(publishDir, 'stills', '19005-r1.webp')));
  const plain = await importSongs([19005], { ...opts, cells });
  assert.deepEqual([plain.results[0].status, cells[19005].kind], ['kept', 'file']);
  const forced = await importSongs([19005], { ...opts, cells, force: true });
  assert.deepEqual([forced.results[0].status, cells[19005].kind, cells[19005].stillRev], ['imported', 'still', 2]); // revisions only go up

  fs.writeFileSync(path.join(stills, '19000.jpg'), ''); // went online-only
  const offline = await importSongs([19000, 19003], { ...opts, cells, strict: new Set([19003]) });
  assert.deepEqual(offline.results.map((r) => r.status), ['kept', 'unavailable']);
  const forcedOffline = await importSongs([19000], { ...opts, cells, force: true });
  assert.equal(forcedOffline.results[0].status, 'kept', '--force does not turn an offline still into a card');
  assert.equal(contiguousCount({ 1: {} }, cellsDir), 0);
  assert.ok(fs.existsSync(cellFile(19000, cellsDir)));
});
