import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildIndex, search } from './search.js';

const songs = [
  { n: 1, t: 'In the Time of the Gods', d: '2009-01-01', a: { Location: 'Los Angeles', Topic: 'Poetic', Instrument: ['Baritone Ukulele'], Mood: 'Pensive' } },
  { n: 12, t: 'Twelve Days', d: '2009-01-12', a: { Topic: 'Holiday', Instrument: ['Guitar'] } },
  { n: 120, t: 'Café Olé', d: '2009-04-30', a: { Location: 'Brooklyn', Instrument: ['Piano', 'Guitar'] } },
  { n: 300, t: 'Internetis a Playground', d: '2009-10-27', a: {} },
  { n: 301, t: 'The Internet Is Dead', d: '2009-10-28', a: {} },
  { n: 2015, t: 'Time Machine', d: '2014-07-08', a: { Mood: 'Happy' } },
  { n: 2400, t: 'Gods and Monsters', d: '2015-07-27', a: { Topic: 'Myth' } },
  { n: 6502, t: 'The Time of Day', d: '2026-10-20', a: { Location: 'Los Angeles', Instrument: ['Piano'] } },
];
const index = buildIndex(songs);
const ns = (q, opts) => search(index, q, opts).map((h) => h.n);

test('normalize folds case, accents and punctuation', () => {
  assert.equal(normalize('  Café, Olé!  '), 'cafe ole');
  assert.equal(normalize("Don't Stop"), 'dont stop');
  assert.equal(normalize(null), '');
});

test('a number finds that song first', () => {
  assert.equal(ns('12')[0], 12);
  assert.equal(ns('#120')[0], 120);
  assert.equal(ns('song 6502')[0], 6502);
});

test('a year finds that song number first, then the songs from that year', () => {
  const hits = ns('2015');
  assert.equal(hits[0], 2015);
  assert.ok(hits.includes(2400));
});

test('a date finds its song', () => {
  assert.equal(ns('2026-10-20')[0], 6502);
});

test('titles: exact, prefix, phrase, then words in any order', () => {
  assert.deepEqual(ns('time machine'), [2015]);
  assert.deepEqual(ns('gods'), [2400, 1], 'starts-with beats contains');
  const time = ns('time');
  assert.equal(time[0], 2015, 'title starting with the word');
  assert.deepEqual(time.slice(1), [6502, 1], 'ties go to the newer song');
  assert.deepEqual(ns('gods time'), [1]);
  assert.deepEqual(ns('cafe'), [120], 'accent-insensitive');
  assert.deepEqual(ns('internet'), [301, 300], 'a whole word beats the start of a longer word');
});

test('traits match too, below titles', () => {
  assert.deepEqual(ns('los angeles'), [6502, 1]);
  assert.deepEqual(ns('piano'), [6502, 120]);
  assert.deepEqual(ns('guitar brooklyn'), [120]);
  assert.deepEqual(ns('baritone'), [1]);
});

test('limit and empty queries', () => {
  assert.equal(search(index, 'guitar', { limit: 1 }).length, 1);
  assert.deepEqual(ns(''), []);
  assert.deepEqual(ns('   '), []);
  assert.deepEqual(ns('!!!'), []);
  assert.deepEqual(ns('zzzz'), []);
});
