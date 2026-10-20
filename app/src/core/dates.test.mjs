import test from 'node:test';
import assert from 'node:assert/strict';
import { songDate, songForDate, formatDate } from './dates.js';

test('song 1 is 2009-01-01 and the dates are contiguous', () => {
  assert.equal(songDate(1), '2009-01-01');
  assert.equal(songDate(365), '2009-12-31');
  assert.equal(songDate(366), '2010-01-01');
  assert.equal(songDate(6501), '2026-10-19');
  assert.equal(songDate(6502), '2026-10-20');
  assert.equal(songDate(6546), '2026-12-03');
  assert.equal(songDate(19712), '2062-12-20');
});

test('songForDate inverts songDate', () => {
  for (let n = 1; n <= 20000; n += 13) assert.equal(songForDate(songDate(n)), n);
  assert.equal(songForDate('2012-02-29'), 1155);
});

test('songForDate rejects bad input', () => {
  for (const bad of ['', null, undefined, '2008-12-31', '2026-02-30', '2026-13-01', '20261020', '2026-1-2', 'x']) {
    assert.equal(songForDate(bad), null, String(bad));
  }
});

test('formatDate', () => {
  assert.equal(formatDate('2026-10-20'), 'October 20, 2026');
  assert.equal(formatDate('2009-01-01', 'short'), 'Jan 1, 2009');
  assert.equal(formatDate('nope'), 'nope');
});
