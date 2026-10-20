import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacets, evaluate, isActive } from './filters.js';

const songs = [
  { n: 1, d: '2009-01-01', a: { Genre: 'Folk', Mood: 'Happy', Instrument: ['Guitar', 'Voice'], 'Song A Day': '1', Year: '2009' } },
  { n: 2, d: '2009-01-02', a: { Genre: 'Rock', Mood: 'Happy', Instrument: ['Guitar'] } },
  { n: 3, d: '2010-05-05', a: { Genre: 'Folk', Mood: 'Sad', Instrument: ['Piano'] } },
  { n: 4, d: '2010-05-06', a: { Genre: 'Pop', Mood: 'Sad', Instrument: ['Piano', 'Guitar'] } },
  { n: 5, d: '2026-10-20', a: { Genre: 'Folk', Instrument: [] } },
];
const facets = buildFacets(songs);
const trait = (name) => facets.traits.find((t) => t.name === name);
const sel = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));
const counts = (r, name) => Object.fromEntries(r.counts.get(name));

test('facets come from the catalog, plus Year from the date', () => {
  assert.deepEqual(facets.traits.map((t) => t.name), ['Genre', 'Mood', 'Instrument', 'Year']);
  assert.deepEqual(trait('Genre').values, [
    { value: 'Folk', total: 3 },
    { value: 'Pop', total: 1 },
    { value: 'Rock', total: 1 },
  ]);
  assert.deepEqual(trait('Year').values.map((v) => v.value), ['2026', '2010', '2009']);
  assert.equal(trait('Song A Day'), undefined);
  assert.equal(facets.minDate, '2009-01-01');
  assert.equal(facets.maxDate, '2026-10-20');
});

test('nothing selected: no mask, counts are totals', () => {
  const r = evaluate(facets, new Map());
  assert.equal(r.matches, null);
  assert.deepEqual(counts(r, 'Instrument'), { Guitar: 3, Voice: 1, Piano: 2 });
  assert.equal(isActive(new Map()), false);
  assert.equal(isActive(new Map([['Genre', new Set()]])), false);
});

test('OR within a trait, and its own counts ignore its own selection', () => {
  const r = evaluate(facets, sel({ Genre: ['Folk', 'Rock'] }));
  assert.deepEqual([...r.matches].sort(), [1, 2, 3, 5]);
  assert.deepEqual(counts(r, 'Genre'), { Folk: 3, Rock: 1, Pop: 1 }, 'picking Folk does not hide Pop or Rock');
  assert.deepEqual(counts(r, 'Mood'), { Happy: 2, Sad: 1 });
});

test('AND across traits, with disjunctive counts', () => {
  const r = evaluate(facets, sel({ Genre: ['Folk'], Instrument: ['Guitar'] }));
  assert.deepEqual([...r.matches], [1]);
  assert.deepEqual(counts(r, 'Genre'), { Folk: 1, Rock: 1, Pop: 1 }, 'songs with Guitar, by genre');
  assert.deepEqual(counts(r, 'Instrument'), { Guitar: 1, Voice: 1, Piano: 1 }, 'Folk songs, by instrument');
  assert.deepEqual(counts(r, 'Mood'), { Happy: 1 });
});

test('counts are exact against brute force', () => {
  const selections = [{ Mood: ['Sad'] }, { Mood: ['Happy', 'Sad'], Genre: ['Pop'] }, { Year: ['2010'], Instrument: ['Guitar', 'Voice'] }];
  for (const s of selections) {
    const r = evaluate(facets, sel(s));
    for (const t of facets.traits) {
      for (const { value } of t.values) {
        const others = Object.entries(s).filter(([k]) => k !== t.name);
        const expect = facets.rows.filter((row) =>
          (row.values.get(t.name) || []).includes(value) &&
          others.every(([k, vs]) => (row.values.get(k) || []).some((v) => vs.includes(v))),
        ).length;
        assert.equal(r.counts.get(t.name).get(value) || 0, expect, `${JSON.stringify(s)} ${t.name}=${value}`);
      }
    }
  }
});

test('date range narrows everything, inclusive', () => {
  const r = evaluate(facets, new Map(), { from: '2009-01-02', to: '2010-05-05' });
  assert.deepEqual([...r.matches], [2, 3]);
  assert.deepEqual(counts(r, 'Genre'), { Rock: 1, Folk: 1 });
  assert.deepEqual([...evaluate(facets, new Map(), { from: '2010-05-06' }).matches], [4, 5]);
});

test('no 1,000-match cap', () => {
  const many = Array.from({ length: 6502 }, (_, i) => ({ n: i + 1, d: '', a: { Mood: i % 2 ? 'Happy' : 'Sad' } }));
  const r = evaluate(buildFacets(many), sel({ Mood: ['Happy'] }));
  assert.equal(r.matches.size, 3251);
});

test('long numeric traits become ranges', () => {
  const tempo = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, d: '', a: { Tempo: String(60 + (i % 140)) } }));
  const t = buildFacets(tempo).traits.find((x) => x.name === 'Tempo');
  assert.equal(t.values[0].value, '60–69');
  assert.ok(t.values.length <= 15);
  assert.equal(t.values.reduce((a, v) => a + v.total, 0), 200);
  const length = Array.from({ length: 100 }, (_, i) => ({ n: i + 1, d: '', a: { Length: `${1 + (i % 5)}:${String(i % 60).padStart(2, '0')}` } }));
  const l = buildFacets(length).traits.find((x) => x.name === 'Length');
  assert.deepEqual(l.values.map((v) => v.value), ['1:00–1:59', '2:00–2:59', '3:00–3:59', '4:00–4:59', '5:00–5:59']);
});
