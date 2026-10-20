import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addTrait, appendSongs, chunkFile, chunkOf, chunkSongs, cleanDescription, dateOf, fromD1, fromInitial, fromTokenMetadata,
  hash8, isBoilerplate, mergeSong, orderTraits, refile, sharedDescriptions, songOn, traitName, unifyCase, writeCatalogState, writeChunks, youtubeId,
} from './catalog.mjs';

test('dates follow the song number', () => {
  assert.equal(dateOf(1), '2009-01-01');
  assert.equal(dateOf(366), '2010-01-01');
  assert.equal(dateOf(6501), '2026-10-19');
  assert.equal(songOn('2026-10-20'), 6502);
  for (const n of [1, 59, 60, 1155, 6502]) assert.equal(songOn(dateOf(n)), n);
});

test('youtubeId reads every URL form and rejects malformed IDs', () => {
  const id = 'v6Lk_OP4ZKc';
  for (const s of [
    id, ` ${id} `,
    `https://youtu.be/${id}`, `https://youtu.be/${id}?si=abc&t=3`, `youtu.be/${id}`,
    `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&feature=youtu.be`,
    `https://m.youtube.com/watch?feature=share&v=${id}`, `http://music.youtube.com/watch?v=${id}`,
    `www.youtube.com/watch?v=${id}`, `https://www.youtube.com/embed/${id}?rel=0`,
    `https://www.youtube-nocookie.com/embed/${id}`, `https://youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube.com/v/${id}`,
    `https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3D${id}%26feature%3Dshare`,
  ]) assert.equal(youtubeId(s), id, s);
  for (const s of [
    null, undefined, '', '   ', 'n/a',
    'https://www.youtube.com/watch?v=78c_0FolkyyI', // 12 characters
    'https://youtu.be/X0EL7MmYRF', // 10 characters
    'https://vimeo.com/v6Lk_OP4ZKc', 'https://www.youtube.com/channel/UCvj5S3f10rO6CoibatfRGzg',
    'https://www.youtube.com/watch?list=PL123', 'https://evil.com/watch?v=v6Lk_OP4ZKc', 'not a url at all',
  ]) assert.equal(youtubeId(s), null, String(s));
});

test('trait names map every source to one display name and drop lyrics, dates and crypto', () => {
  const cases = {
    Location: 'Location', location: 'Location', instruments: 'Instrument', otherInstruments: 'Instrument',
    styles_json: 'Style', otherStyles: 'Style', length_label: 'Length', inKey: 'Key', song_key: 'Key', Key: 'Key',
    tempo: 'Tempo', proper_noun: 'Proper Noun', properNoun: 'Proper Noun', 'Proper Noun': 'Proper Noun', Year: 'Year',
    'Some New Trait': 'Some New Trait',
  };
  for (const [raw, name] of Object.entries(cases)) assert.equal(traitName(raw), name, raw);
  for (const raw of ['Date', 'Song A Day', 'Lyrics', 'lyrics', 'Sound.xyz Edition Contract', 'Token ID', 'contract_address', 'OpenSea', 'Owner']) {
    assert.equal(traitName(raw), null, raw);
  }
});

test('trait values are cleaned, split when multi-valued and kept as strings otherwise', () => {
  const t = new Map();
  addTrait(t, 'Instrument', '4-String Acoustic Guitar,');
  addTrait(t, 'otherInstruments', 'Samples, Synths;  Suno | samples');
  addTrait(t, 'Style', ['Wistful', ' wistful ', '']);
  addTrait(t, 'Location', 'Hartford, CT Studio 4');
  addTrait(t, 'Proper Noun', 'Israel, Palestine');
  addTrait(t, 'tempo', 120);
  addTrait(t, 'Length', '02:36');
  addTrait(t, 'Mood', '-');
  addTrait(t, 'Beard', null);
  addTrait(t, 'Topic', '0x19b703f65aA7E1E775BD06c2aa0D0d08c80f1C45');
  addTrait(t, 'Lyrics', 'la la la');
  assert.deepEqual(orderTraits(t), {
    Location: 'Hartford, CT Studio 4',
    Instrument: ['4-String Acoustic Guitar', 'Samples', 'Synths', 'Suno'],
    Style: ['Wistful'],
    Length: '2:36',
    Tempo: '120',
    'Proper Noun': ['Israel', 'Palestine'],
  });
});

test('comma lists in Noun, Proper Noun and Topic split, and links or addresses inside them are dropped', () => {
  const t = new Map();
  addTrait(t, 'noun', 'Fox, Bird, Chicken');
  addTrait(t, 'proper_noun', 'NES, Zelda, https://gallery.manifold.xyz/0xcddb80313b09915e0c520d107a92d9b4c3fbabfe/6, Ethereum');
  addTrait(t, 'topic', 'Poetic, Kickstarter');
  addTrait(t, 'Location', 'Jupiter, FL');
  assert.deepEqual(orderTraits(t), {
    Location: 'Jupiter, FL',
    Topic: ['Poetic', 'Kickstarter'],
    Noun: ['Fox', 'Bird', 'Chicken'],
    'Proper Noun': ['NES', 'Zelda', 'Ethereum'],
  });
  const u = new Map();
  addTrait(u, 'Proper Noun', 'mint at 0x19b703f65aA7E1E775BD06c2aa0D0d08c80f1C45 now');
  addTrait(u, 'Noun', 'see ipfs://bafy/1');
  assert.deepEqual(orderTraits(u), {});
});

test('traits come out in display order regardless of insertion order', () => {
  const a = new Map(), b = new Map();
  const pairs = [['Zebra', 'x'], ['Year', '2009'], ['Mood', 'Sad'], ['Location', 'LA'], ['Alpha', 'y'], ['Instrument', 'Bass']];
  for (const [k, v] of pairs) addTrait(a, k, v);
  for (const [k, v] of [...pairs].reverse()) addTrait(b, k, v);
  assert.deepEqual(Object.keys(orderTraits(a)), ['Location', 'Instrument', 'Mood', 'Year', 'Alpha', 'Zebra']);
  assert.equal(JSON.stringify(orderTraits(a)), JSON.stringify(orderTraits(b)));
});

test('unifyCase picks the most common well-cased spelling', () => {
  const songs = [
    { a: { Mood: 'Pensive', Instrument: ['djembe', 'Bass'] } },
    { a: { Mood: 'pensive', Instrument: ['Djembe'] } },
    { a: { Mood: 'Pensive', Topic: 'LIfe' } },
    { a: { Topic: 'LIfe', Instrument: ['TUBA', 'tuba'] } },
    { a: { Topic: 'Life', Instrument: ['Tuba'] } },
  ];
  const merged = unifyCase(songs);
  assert.deepEqual(songs.map((s) => s.a), [
    { Mood: 'Pensive', Instrument: ['Djembe', 'Bass'] },
    { Mood: 'Pensive', Instrument: ['Djembe'] },
    { Mood: 'Pensive', Topic: 'Life' },
    { Topic: 'Life', Instrument: ['Tuba'] },
    { Topic: 'Life', Instrument: ['Tuba'] },
  ]);
  assert.deepEqual(merged, { Mood: { pensive: 'Pensive' }, Instrument: { djembe: 'Djembe', TUBA: 'Tuba', tuba: 'Tuba' }, Topic: { LIfe: 'Life' } });
});

const legacy = fromTokenMetadata('legacy', {
  name: 'In the Time of the Gods',
  description: 'In the Time of the Gods" tells the story of an ant.',
  token_id: 1,
  image: 'ipfs://Qm/1',
  youtube_url: 'https://youtu.be/v6Lk_OP4ZKc',
  attributes: [
    { trait_type: 'Date', value: '2009-01-01' }, { trait_type: 'Location', value: 'Los Angeles' },
    { trait_type: 'Instrument', value: 'Baritone Ukulele' }, { trait_type: 'Song A Day', value: '1' },
    { trait_type: 'Year', value: '2009' }, { trait_type: 'Style', value: 'Narrative' }, { trait_type: 'Style', value: 'Myth' },
    { trait_type: 'Key', value: 'C' },
  ],
});

test('mergeSong prefers D1, fills gaps from other sources and derives date and Year', () => {
  const d1 = fromD1({
    id: 1, date: '2009-01-01', title: 'In The Time Of The Gods', location: 'Los Angeles', topic: 'Poetic', mood: 'Pensive',
    genre: 'Folk', beard: 'Clean', length_label: '2:36', song_key: null, tempo: 61, video_url: 'https://youtu.be/XXXXXXXXXXXX',
    youtube_id: 'v6Lk_OP4ZKc', proper_noun: null, noun: null, instruments_json: '["Baritone Ukulele"]', styles_json: '["Delicate","Narrative"]',
  });
  const { song, detail } = mergeSong(1, [legacy, d1]);
  assert.deepEqual(song, {
    n: 1, t: 'In The Time Of The Gods', d: '2009-01-01', yt: 'v6Lk_OP4ZKc',
    a: {
      Location: 'Los Angeles', Topic: ['Poetic'], Instrument: ['Baritone Ukulele'], Mood: 'Pensive', Beard: 'Clean',
      Genre: 'Folk', Style: ['Delicate', 'Narrative'], Length: '2:36', Key: 'C', Tempo: '61', Year: '2009',
    },
  });
  assert.equal(detail.description, '"In the Time of the Gods" tells the story of an ant.');
  assert.deepEqual(Object.keys(song), ['n', 't', 'd', 'yt', 'a']);
});

test('mergeSong takes the first valid YouTube ID and never a source date', () => {
  const bad = fromTokenMetadata('legacy', { name: 'X', youtube_url: 'https://youtu.be/BassE45R51bs', attributes: [{ trait_type: 'Date', value: '1999-01-01' }] }, 2579);
  assert.equal(mergeSong(2579, [bad]).song.yt, null);
  assert.equal(mergeSong(2579, [bad]).song.d, '2016-01-23');
  const initial = fromInitial({ songNbr: '6501', title: 'The Internet Is Dead Dead Dead', youtubeUrl: 'https://youtube.com/watch?v=q_LPX64qdZ8',
    instrument: 'Novox', otherInstruments: 'Samples, Synths, Suno', style: 'Fun', otherStyles: 'Funny, Wistful', lyrics: 'secret words', description: 'THE INTERNET IS DEAD!' });
  const { song, detail } = mergeSong(6501, [initial]);
  assert.equal(song.yt, 'q_LPX64qdZ8');
  assert.deepEqual(song.a, { Instrument: ['Novox', 'Samples', 'Synths', 'Suno'], Style: ['Fun', 'Funny', 'Wistful'], Year: '2026' });
  assert.equal(detail.description, 'THE INTERNET IS DEAD!');
  assert.ok(!JSON.stringify(song).includes('secret words'));
});

test('spreadsheet artifacts fall through to the next source', () => {
  const row = (id, extra) => ({ id, title: null, instruments_json: '[]', styles_json: '[]', ...extra });
  const legacyOf = (n, name, attributes = []) => fromTokenMetadata('legacy', { name, attributes }, n);
  assert.equal(mergeSong(204, [fromD1(row(204, { title: 'http://commondreams.org' })), legacyOf(204, 'Commondreams.org')]).song.t, 'Commondreams.org');
  assert.equal(mergeSong(5117, [fromD1(row(5117, { title: 'Sat Dec 30 1899 06:11:00 GMT-0500 (Eastern Standard Time)' })), legacyOf(5117, '11:11')]).song.t, '11:11');
  assert.equal(mergeSong(1, [fromD1(row(1, { title: 'http://www.kickstarter.com/' }))]).song.t, 'kickstarter.com');
  const { song } = mergeSong(771, [
    fromD1(row(771, { proper_noun: 'https://www.youtube.com/watch?v=g6IY19RM2Fo', song_key: 'Fri Dec 29 1899 21:46:00 GMT-0500 (Eastern Standard Time)', length_label: ':50', tempo: null })),
    legacyOf(771, 'X', [{ trait_type: 'Proper Noun', value: 'Red Panda' }, { trait_type: 'Tempo', value: '168.369' }, { trait_type: 'Key', value: 'С' }]),
  ]);
  assert.deepEqual(song.a, { Length: '0:50', Key: 'C', Tempo: '168', Year: '2011', 'Proper Noun': ['Red Panda'] });
});

test('refile moves records saved under the wrong number and drops duplicates', () => {
  const rec = (src, n, t, date) => ({ ...fromInitial({ title: t, date }, n), src });
  const titles = new Map([[4759, 'Melatonin'], [5172, 'Say Pizza To Drugs'], [5173, 'No Squeezy Baby'], [5854, "Everybody's Coming"], [5855, 'A Little Bit of Context']]);
  const sources = {
    legacy: new Map([
      [4759, rec('legacy', 4759, 'Melatonin', '2022-01-12')], // date typo only: stays
      [5172, rec('legacy', 5172, 'No Squeezy Baby', '2023-03-01')], // 5173's data, 5173 has its own: dropped
      [5173, rec('legacy', 5173, 'No Squeezy Baby', '2023-03-01')],
    ]),
    initial: new Map([[5854, rec('initial', 5854, 'A Little Bit of Context', '2025-01-11')]]), // moves to 5855
  };
  const moves = refile(sources, titles);
  assert.deepEqual(moves.map(({ src, from, to }) => [src, from, to]), [['legacy', 5172, null], ['initial', 5854, 5855]]);
  assert.deepEqual([...sources.legacy.keys()], [4759, 5173]);
  assert.deepEqual([...sources.initial.keys()], [5855]);
  assert.equal(sources.initial.get(5855).n, 5855);
  assert.deepEqual(refile({ legacy: new Map([[5172, rec('legacy', 5172, 'X', '2023-03-01')]]) }, new Map()), []);
});

test('the NFT boilerplate and descriptions many songs share are never published', () => {
  const stock = 'A new song, everyday, forever. Song A Day is an ever-growing collection of unique songs created by Jonathan Mann.';
  assert.ok(isBoilerplate(stock));
  assert.ok(!isBoilerplate('A new song about forever.'));
  const legacyOf = (n, description) => fromTokenMetadata('legacy', { name: `Song ${n}`, description }, n);
  const merged = mergeSong(5, [legacyOf(5, stock)]);
  assert.equal(merged.detail.description, null);
  assert.deepEqual(merged.droppedDescriptions, ['legacy']);
  const initial = fromInitial({ title: 'Song 6502', description: 'The real one.' }, 6502);
  const both = mergeSong(6502, [legacyOf(6502, stock), initial]);
  assert.deepEqual([both.detail.description, both.descriptionSrc, both.droppedDescriptions], ['The real one.', 'initial', ['legacy']]);
  const legacy = new Map([1, 2, 3, 4, 5].map((n) => [n, legacyOf(n, n < 5 ? 'Same words.' : 'Own words.')]));
  const shared = sharedDescriptions({ legacy });
  assert.deepEqual([...shared], ['Same words.']);
  const skip = (t) => isBoilerplate(t) || shared.has(t);
  assert.equal(mergeSong(1, [legacy.get(1)], { skipDescription: skip }).detail.description, null);
  assert.equal(mergeSong(5, [legacy.get(5)], { skipDescription: skip }).detail.description, 'Own words.');
  assert.equal(sharedDescriptions({ legacy: new Map([...legacy].slice(0, 3)) }).size, 0, 'up to 3 songs may share one');
});

test('appendSongs adds the daily song to the last chunk pair, and opens a new chunk at 501', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-append-'));
  try {
    const entry = (n) => mergeSong(n, [fromInitial({ title: `Song ${n}`, description: `About ${n}` }, n)]);
    const items = Array.from({ length: 499 }, (_, i) => entry(i + 1));
    const first = writeChunks(items.map((x) => x.song), items.map((x) => x.detail), dir);
    const state = { schema: 1, chunkSize: 500, index: first.index, detail: first.detail, songCount: 499 };
    const a = appendSongs(dir, state, [entry(500), entry(501)]);
    assert.equal(a.songCount, 501);
    assert.equal(a.index.length, 2);
    assert.notEqual(a.index[0], state.index[0]);
    assert.deepEqual(a.written.length, 4);
    const full = writeChunks([...items, entry(500), entry(501)].map((x) => x.song), [...items, entry(500), entry(501)].map((x) => x.detail), dir);
    assert.deepEqual([a.index, a.detail], [full.index, full.detail], 'same bytes as a full build');
    assert.throws(() => appendSongs(dir, state, [entry(501)]), /expected song 500/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a song with no sources still gets a dense entry', () => {
  const { song, detail } = mergeSong(5846, []);
  assert.deepEqual(song, { n: 5846, t: null, d: '2025-01-02', yt: null, a: { Year: '2025' } });
  assert.deepEqual(detail, { n: 5846, description: null });
});

test('cleanDescription undoes CSV quoting', () => {
  assert.equal(cleanDescription('"I said ""hi"" today.\n"', 'T'), 'I said "hi" today.');
  assert.equal(cleanDescription('"Just a quote."', 'T'), '"Just a quote."');
  assert.equal(cleanDescription('  ', 'T'), null);
  assert.equal(cleanDescription(null, 'T'), null);
});

test('chunks cover i*500+1 .. (i+1)*500', () => {
  assert.equal(chunkOf(1), 0);
  assert.equal(chunkOf(500), 0);
  assert.equal(chunkOf(501), 1);
  assert.equal(chunkOf(6502), 13);
  const songs = Array.from({ length: 1203 }, (_, i) => ({ n: i + 1 }));
  const chunks = chunkSongs(songs);
  assert.deepEqual(chunks.map(({ i, from, to, songs: s }) => [i, from, to, s.length]), [[0, 1, 500, 500], [1, 501, 1000, 500], [2, 1001, 1203, 203]]);
  assert.deepEqual(chunkSongs(songs, 1000).map((c) => [c.from, c.to]), [[1, 1000], [1001, 1203]]);
});

test('chunk keys hash the exact bytes and are stable', () => {
  const songs = [mergeSong(1, [legacy]).song];
  const a = chunkFile('index', { i: 0, from: 1, to: 1, songs });
  const b = chunkFile('index', { i: 0, from: 1, to: 1, songs: structuredClone(songs) });
  assert.equal(a.key, b.key);
  assert.equal(a.text, b.text);
  assert.match(a.key, /^meta\/index-0-[0-9a-f]{8}\.json$/);
  assert.equal(a.key, `meta/index-0-${hash8(a.text)}.json`);
  assert.equal(hash8('abc'), 'ba7816bf');
  assert.deepEqual(Object.keys(JSON.parse(a.text)), ['schema', 'from', 'to', 'songs']);
  const changed = chunkFile('index', { i: 0, from: 1, to: 1, songs: [{ ...songs[0], t: 'Other' }] });
  assert.notEqual(changed.key, a.key);
});

test('writeChunks rewrites only changed chunks and the state keeps builtAt when nothing changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  try {
    const songs = Array.from({ length: 1001 }, (_, i) => ({ n: i + 1, t: `Song ${i + 1}`, d: dateOf(i + 1), yt: null, a: {} }));
    const details = songs.map(({ n }) => ({ n, description: null }));
    const first = writeChunks(songs, details, dir);
    assert.equal(first.written.length, 6);
    assert.equal(writeChunks(songs, details, dir).written.length, 0);
    songs[1000].t = 'Changed';
    const third = writeChunks(songs, details, dir);
    assert.deepEqual(third.written, [third.index[2]]);
    assert.deepEqual(third.index.slice(0, 2), first.index.slice(0, 2));
    const stateFile = path.join(dir, 'state/catalog.json');
    const s1 = writeCatalogState(stateFile, { ...third, songCount: 1001 }, new Date('2026-10-20T00:00:00Z'));
    const s2 = writeCatalogState(stateFile, { ...third, songCount: 1001 }, new Date('2026-10-21T00:00:00Z'));
    assert.equal(s1.changed, true);
    assert.equal(s2.changed, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {
      schema: 1, chunkSize: 500, index: third.index, detail: third.detail, songCount: 1001, builtAt: '2026-10-20T00:00:00.000Z',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
