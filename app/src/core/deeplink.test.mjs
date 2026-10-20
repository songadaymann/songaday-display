import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocation, hasView, withSong, galleryLink } from './deeplink.js';

const at = (path) => parseLocation(`https://gallery.songaday.world${path}`);

test('embed mode follows the old gallery rules', () => {
  const on = ['/embed', '/embed/', '/EMBED', '/embed.html', '/?embed', '/?embed=', '/?embed=1', '/?embed=true', '/?embed=yes', '/?embed=whatever', '/embed?embed=0'];
  const off = ['/', '/?embed=0', '/?embed=false', '/?embed=NO', '/embedded', '/gallery/embed'];
  for (const p of on) assert.equal(at(p).embed, true, p);
  for (const p of off) assert.equal(at(p).embed, false, p);
});

test('rating app embed URL', () => {
  const l = at('/embed?embed=1');
  assert.equal(l.embed, true);
  assert.equal(l.song, null);
  assert.equal(hasView(l.view), false);
});

test('song and date links', () => {
  assert.equal(at('/?song=6502').song, 6502);
  assert.equal(at('/?song=%236502').song, 6502);
  assert.equal(at('/?song=0').song, null);
  assert.equal(at('/?song=-3').song, null);
  assert.equal(at('/?song=12abc').song, null);
  assert.equal(at('/?date=2026-10-20').song, 6502);
  assert.equal(at('/?date=2026-10-20').date, '2026-10-20');
  assert.equal(at('/?date=2026-02-30').song, null);
  assert.equal(at('/?date=2008-12-31').song, null);
  assert.equal(at('/?song=5&date=2026-10-20').song, 5, 'song wins over date');
});

test('viewport parameters', () => {
  const v = at('/embed?zoom=2.5&x=0.25&y=0.1&minZoom=0.5&maxZoom=40').view;
  assert.deepEqual(v, { zoom: 2.5, x: 0.25, y: 0.1, minZoom: 0.5, maxZoom: 40, bounds: null });
  assert.equal(hasView(v), true);

  const b = at('/?bounds=0.1,%200.2,0.3,0.15&zoom=3').view;
  assert.deepEqual(b.bounds, [0.1, 0.2, 0.3, 0.15]);
  assert.equal(b.zoom, 3);

  assert.equal(at('/?bounds=1,2,3').view.bounds, null);
  assert.equal(at('/?bounds=1,2,x,4').view.bounds, null);
  assert.equal(at('/?bounds=0,0,0,1').view.bounds, null);
  assert.equal(at('/?zoom=').view.zoom, null);
  assert.equal(at('/?zoom=abc').view.zoom, null);
  assert.equal(hasView(at('/?x=0.5').view), false, 'x without y is not a position');
  assert.equal(hasView(at('/?x=0.5&y=0.2').view), true);
});

test('withSong keeps other parameters', () => {
  assert.equal(withSong('https://g.example/?embed=0&crypto=1', 12), '/?embed=0&crypto=1&song=12');
  assert.equal(withSong('https://g.example/?song=3&date=2009-01-03&zoom=2', 0), '/?zoom=2');
  assert.equal(withSong('https://g.example/?date=2009-01-03', 9), '/?song=9');
  assert.equal(galleryLink('https://gallery.songaday.world', 42), 'https://gallery.songaday.world/?song=42');
});
