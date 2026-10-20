// Everything the page reads from its URL, and the URLs it writes back.
//
// Embed mode (same rules as the old gallery): the paths /embed, /embed/ and /embed.html, or an
// `embed` parameter with any value except 0/false/no (`?embed` and `?embed=` count as on).
// Viewport parameters, in OpenSeadragon viewport units (x 0..1 across the wall, y in the same
// unit): zoom, x, y, minZoom, maxZoom, and bounds=x,y,w,h, which wins over zoom/x/y.
// Song links: ?song=N, or ?date=YYYY-MM-DD.
import { songForDate } from './dates.js';

export function isEmbed(url) {
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (path === '/embed' || path === '/embed.html') return true;
  const v = url.searchParams.get('embed');
  return v !== null && !/^(0|false|no)$/i.test(v);
}

function num(params, name) {
  const v = params.get(name);
  if (v === null || v.trim() === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function bounds(params) {
  const v = params.get('bounds');
  if (!v) return null;
  const parts = v.split(',').map((p) => parseFloat(p.trim()));
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0 ? parts : null;
}

export function parseLocation(href) {
  const url = new URL(href);
  const p = url.searchParams;
  const songParam = (p.get('song') || '').trim().replace(/^#/, '');
  const date = (p.get('date') || '').trim();
  const dateSong = songForDate(date);
  const song = /^\d{1,6}$/.test(songParam) && +songParam >= 1 ? +songParam : dateSong;
  return {
    embed: isEmbed(url),
    song: song || null,
    date: dateSong ? date : null,
    view: {
      zoom: num(p, 'zoom'),
      x: num(p, 'x'),
      y: num(p, 'y'),
      minZoom: num(p, 'minZoom'),
      maxZoom: num(p, 'maxZoom'),
      bounds: bounds(p),
    },
  };
}

export const hasView = (v) => Boolean(v.bounds || v.zoom !== null || (v.x !== null && v.y !== null));

// The current URL with ?song=N (or without any song) and every other parameter kept.
export function withSong(href, n) {
  const url = new URL(href);
  url.searchParams.delete('date');
  if (n) url.searchParams.set('song', String(n));
  else url.searchParams.delete('song');
  return url.pathname + url.search + url.hash;
}

export const galleryLink = (origin, n) => `${origin}/?song=${n}`;
