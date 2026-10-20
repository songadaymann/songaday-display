// Song catalog: merges the per-song sources into the chunked JSON the viewer reads.
// The output contract is in shared/README.md ("Catalog index chunk", "Catalog detail chunk").
//
// Sources, best first for every field:
//   d1        song-a-day-rating.songs, synced from the sheet (the editorial source) every day
//   initial   output/<n>/initial-metadata.json, what the toolkit form held (newest songs)
//   metadata  output/<n>/metadata.json, the token metadata pinned at publish (newest songs)
//   legacy    the old gallery's songaday_clean.jsonl, 1-5845, the only older descriptions
// The date is never taken from a source: song n is 2009-01-01 + (n-1) days. Sources that
// disagree are reported, not trusted. No lyrics and no crypto fields leave this module.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const SCHEMA = 1;
export const CHUNK_SIZE = 500;

const DAY = 86_400_000;
const FIRST = Date.UTC(2009, 0, 1);

export const dateOf = (n) => new Date(FIRST + (n - 1) * DAY).toISOString().slice(0, 10);
export const songOn = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - FIRST) / DAY) + 1;

// ---- YouTube ----

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'youtube-nocookie.com']);

// Video ID from a bare ID or any youtube.com / youtu.be URL form, or null if there isn't a valid one.
export function youtubeId(value) {
  const s = value == null ? '' : String(value).trim();
  if (!s) return null;
  if (YT_ID.test(s)) return s;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (YT_HOSTS.has(host)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v', 'e'].includes(parts[0])) id = parts[1];
    else if (parts[0] === 'attribution_link') return youtubeId(new URL(url.searchParams.get('u') || '/', url).href);
  }
  return id && YT_ID.test(id) ? id : null;
}

// ---- Traits ----

// Display order in the modal; anything else follows alphabetically.
export const TRAITS = ['Location', 'Topic', 'Instrument', 'Mood', 'Beard', 'Genre', 'Style', 'Length', 'Key', 'Tempo', 'Year', 'Noun', 'Proper Noun'];
// The sheet keeps these as comma lists ("NES, Zelda"), so each item is its own filter value.
export const MULTI = new Set(['Instrument', 'Style', 'Topic', 'Noun', 'Proper Noun']);

const ALIASES = {
  location: 'Location', topic: 'Topic', mood: 'Mood', beard: 'Beard', genre: 'Genre',
  instrument: 'Instrument', instruments: 'Instrument', maininstrument: 'Instrument', otherinstruments: 'Instrument', instrumentsjson: 'Instrument',
  style: 'Style', styles: 'Style', mainstyle: 'Style', otherstyles: 'Style', stylesjson: 'Style',
  length: 'Length', lengthlabel: 'Length', key: 'Key', inkey: 'Key', songkey: 'Key', tempo: 'Tempo', bpm: 'Tempo',
  year: 'Year', noun: 'Noun', propernoun: 'Proper Noun',
};
// Fields that are not traits here: the date and number have their own keys, lyrics stay out.
const NOT_TRAITS = new Set(['date', 'songaday', 'songnbr', 'lyrics', 'title', 'name', 'description']);
const CRYPTO = /contract|token|edition|address|opensea|wallet|owner|price|mint|chain|ipfs|hash|sound\.?xyz/i;
const BLANK = new Set(['', '-', '--', '?', 'null', 'undefined', 'n/a', 'na']);

export function cleanText(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '');
  return BLANK.has(s.toLowerCase()) ? null : s;
}

// Display name for a source's trait key, or null when it isn't a public trait.
export function traitName(raw) {
  const k = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ALIASES[k]) return ALIASES[k];
  if (!k || NOT_TRAITS.has(k) || /lyric/i.test(raw) || CRYPTO.test(raw)) return null;
  return cleanText(raw);
}

// An address or a content-hash URI anywhere in the value (a token page link carries the contract).
// Token data reaches only wallet visitors, through /api/*, never the public catalog.
export const isCryptoValue = (v) => /0x[0-9a-f]{40}/i.test(v) || /\b(ipfs|ar):\/\//i.test(v);

// Spreadsheet export artifacts: a linked cell exports its URL instead of its text, and a cell
// Excel read as a time exports a JavaScript date ("Sat Dec 30 1899 06:11:00 GMT-0500 ...").
export const isJunk = (v) => /^(https?:\/\/|www\.)/i.test(v) || /\b1899\b.*GMT[+-]\d{4}/.test(v);

const CYRILLIC = { 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E' };

function cleanTraitValue(name, value) {
  let v = cleanText(value);
  if (!v || isCryptoValue(v) || isJunk(v) || /https?:\/\//i.test(v)) return null; // a link is never a filter value
  if (name === 'Tempo' && /^\d+(\.\d+)?$/.test(v)) v = String(Math.round(Number(v)));
  if (name === 'Length') {
    const m = v.match(/^(?:0?0:)?0?(\d{0,2}):(\d{2})$/);
    if (m) v = `${Number(m[1])}:${m[2]}`;
  }
  if (name === 'Key') v = v.replace(/[АВСЕ]/g, (c) => CYRILLIC[c]);
  return v;
}

// Adds one source value to a trait map (name -> array). Multi-valued traits split on , ; |.
export function addTrait(traits, rawName, value) {
  const name = traitName(rawName);
  if (!name || value == null) return traits;
  const items = Array.isArray(value) ? value : MULTI.has(name) ? String(value).split(/[,;|]/) : [value];
  const list = traits.get(name) || [];
  for (const item of items) {
    const v = cleanTraitValue(name, item);
    if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
  }
  if (list.length) traits.set(name, list);
  return traits;
}

const traitRank = (name) => {
  const i = TRAITS.indexOf(name);
  return i < 0 ? TRAITS.length : i;
};

// The `a` object: known traits in display order, then the rest by name; multi-valued as arrays.
export function orderTraits(traits) {
  const names = [...traits.keys()].sort((x, y) => traitRank(x) - traitRank(y) || (x < y ? -1 : x > y ? 1 : 0));
  const a = {};
  for (const name of names) {
    const list = traits.get(name);
    if (list?.length) a[name] = MULTI.has(name) ? [...list] : list[0];
  }
  return a;
}

// ---- Sources -> source records {src, n, t, date, ytRaw, description, traits} ----

const record = (src, n) => ({ src, n, t: null, date: null, ytRaw: null, description: null, traits: new Map() });

// OpenSea-style token metadata: the legacy jsonl lines and output/<n>/metadata.json.
export function fromTokenMetadata(src, json, n = Number(json.token_id)) {
  const r = record(src, n);
  r.t = cleanText(json.name);
  r.ytRaw = json.youtube_url ?? null;
  r.description = json.description ?? null;
  for (const { trait_type: type, value } of json.attributes || []) {
    if (String(type).toLowerCase() === 'date') r.date = cleanText(value);
    else addTrait(r.traits, type, value);
  }
  return r;
}

// output/<n>/initial-metadata.json, written by the toolkit's upload form.
const INITIAL_TRAITS = ['location', 'topic', 'instrument', 'otherInstruments', 'mood', 'beard', 'genre', 'style', 'otherStyles', 'length', 'inKey', 'tempo', 'noun', 'properNoun'];

export function fromInitial(json, n = Number(json.songNbr)) {
  const r = record('initial', n);
  r.t = cleanText(json.title);
  r.date = cleanText(json.date);
  r.ytRaw = json.youtubeUrl || json.videoUrl || null;
  r.description = json.description ?? null;
  for (const k of INITIAL_TRAITS) addTrait(r.traits, k, json[k]);
  return r;
}

// One row of the D1 query below.
export const D1_DATABASE = 'song-a-day-rating';
export const D1_COLUMNS = ['id', 'date', 'title', 'location', 'topic', 'mood', 'genre', 'beard', 'length_label', 'song_key', 'tempo', 'video_url', 'youtube_id', 'proper_noun', 'noun', 'instruments_json', 'styles_json'];
export const d1SongsSql = (where = '') => `SELECT ${D1_COLUMNS.join(', ')} FROM songs${where ? ` WHERE ${where}` : ''} ORDER BY id`;

const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export function fromD1(row) {
  const r = record('d1', Number(row.id));
  r.t = cleanText(row.title);
  r.date = cleanText(row.date);
  r.ytRaw = youtubeId(row.youtube_id) ? row.youtube_id : row.video_url || row.youtube_id || null;
  for (const k of ['location', 'topic', 'mood', 'beard', 'genre', 'length_label', 'song_key', 'tempo', 'noun', 'proper_noun']) addTrait(r.traits, k, row[k]);
  addTrait(r.traits, 'instruments', parseList(row.instruments_json));
  addTrait(r.traits, 'styles', parseList(row.styles_json));
  return r;
}

export const SOURCE_ORDER = ['d1', 'initial', 'metadata', 'legacy'];

// ---- Merge ----

const sameTitle = (a, b) => !!a && !!b && a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

// A record whose own date and title both disagree with the D1 row for its number was saved
// under the wrong number (legacy 5172 holds 5173; initial 5854 holds 5855). It moves to the song
// its date and title point at when that song has no record from the same source; otherwise it's
// dropped. `sources` is {src: Map n -> record}, changed in place. Returns the moves made.
export function refile(sources, d1Titles) {
  const moves = [];
  for (const [src, m] of Object.entries(sources)) {
    if (src === 'd1') continue;
    for (const [n, r] of [...m]) {
      if (!r.date || r.date === dateOf(n) || !d1Titles.has(n) || sameTitle(r.t, d1Titles.get(n))) continue;
      const to = songOn(r.date);
      const ok = sameTitle(r.t, d1Titles.get(to)) && !m.has(to);
      m.delete(n);
      if (ok) m.set(to, { ...r, n: to });
      moves.push({ src, from: n, to: ok ? to : null, t: r.t, date: r.date });
    }
  }
  return moves;
}

// Descriptions: undo a CSV export's quoting, and restore the opening quote the jsonl lost
// on 1,355 story-style descriptions that start with the quoted title.
export function cleanDescription(text, title) {
  if (text == null) return null;
  let s = String(text).replace(/\r\n?/g, '\n').trim();
  if (/^"[\s\S]*"$/.test(s) && s.includes('""')) s = s.slice(1, -1).replace(/""/g, '"').trim();
  if (title && s.startsWith(`${title}"`)) s = `"${s}`;
  return s || null;
}

// The NFT collection's stock text, which the token metadata carries instead of a description for
// many early songs. It says nothing about the song, so the modal never shows it.
export const isBoilerplate = (text) =>
  /^\W*A new song,? every ?day,? forever\b/i.test(text) || /\bSong A Day is an ever-growing collection\b/i.test(text);

// A description more than `max` songs carry word for word isn't about any one of them.
export const SHARED_MAX = 3;
export function sharedDescriptions(sources, max = SHARED_MAX) {
  const songs = new Map();
  for (const m of Object.values(sources)) {
    for (const [n, r] of m) {
      const d = cleanText(r.description);
      if (d) (songs.get(d) || songs.set(d, new Set()).get(d)).add(n);
    }
  }
  return new Set([...songs].filter(([, ns]) => ns.size > max).map(([d]) => d));
}

// One song from its source records (any order; SOURCE_ORDER decides). A description that
// `skipDescription` rejects falls through to the next source; those sources are listed in
// droppedDescriptions.
export function mergeSong(n, sources, { skipDescription = isBoilerplate } = {}) {
  const ranked = [...sources].sort((x, y) => SOURCE_ORDER.indexOf(x.src) - SOURCE_ORDER.indexOf(y.src));
  const first = (f) => {
    for (const s of ranked) {
      const v = f(s);
      if (v != null && v !== '') return v;
    }
    return null;
  };
  // A linked or time-formatted title cell falls through to the next source.
  const t = first((s) => (s.t && !isJunk(s.t) ? s.t : null))
    || cleanText(first((s) => s.t)?.replace(/^(https?:\/\/)?(www\.)?/i, '').replace(/\/$/, ''));
  const yt = first((s) => youtubeId(s.ytRaw));
  const traits = new Map();
  for (const s of ranked) for (const [name, list] of s.traits) if (!traits.has(name) && name !== 'Year') traits.set(name, list);
  const d = dateOf(n);
  traits.set('Year', [d.slice(0, 4)]);
  const song = { n, t, d, yt, a: orderTraits(traits) };
  const written = ranked.filter((s) => cleanText(s.description));
  const from = written.find((s) => !skipDescription(cleanText(s.description)));
  const description = from ? cleanDescription(from.description, from.t) : null;
  const droppedDescriptions = written.filter((s) => skipDescription(cleanText(s.description))).map((s) => s.src);
  return { song, detail: { n, description }, descriptionSrc: description ? from.src : null, droppedDescriptions };
}

// Typos in casing: "LIfe", "INtense", all lower case, or a shouted word ("TUBA", but not "AI").
export const oddCase = (v) => /\b[A-Z]{2}[a-z]/.test(v) || v === v.toLowerCase() || /\b[A-Z]{4,}\b/.test(v);

// Spelling variants of a value that differ only in case or spacing become one: the most common
// well-cased spelling. Returns the merges made, e.g. {Instrument: {'djembe': 'Djembe'}}.
export function unifyCase(songs) {
  const counts = new Map();
  const keyOf = (v) => v.toLowerCase().replace(/\s+/g, ' ');
  for (const { a } of songs) for (const [name, v] of Object.entries(a)) {
    for (const x of [].concat(v)) {
      const m = counts.get(name) || counts.set(name, new Map()).get(name);
      const byKey = m.get(keyOf(x)) || m.set(keyOf(x), new Map()).get(keyOf(x));
      byKey.set(x, (byKey.get(x) || 0) + 1);
    }
  }
  const pick = new Map();
  const merged = {};
  for (const [name, m] of counts) for (const [k, spellings] of m) {
    if (spellings.size < 2) continue;
    const best = [...spellings].sort((x, y) => oddCase(x[0]) - oddCase(y[0]) || y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
    pick.set(`${name}\u0000${k}`, best);
    for (const [s] of spellings) if (s !== best) (merged[name] ||= {})[s] = best;
  }
  if (!pick.size) return merged;
  for (const song of songs) for (const [name, v] of Object.entries(song.a)) {
    const fix = (x) => pick.get(`${name}\u0000${keyOf(x)}`) || x;
    song.a[name] = Array.isArray(v) ? [...new Set(v.map(fix))] : fix(v);
  }
  return merged;
}

// ---- Chunks ----

export const chunkOf = (n, size = CHUNK_SIZE) => Math.floor((n - 1) / size);

// Splits a dense, sorted 1..N list into chunks; chunk i covers i*size+1 .. (i+1)*size.
export function chunkSongs(items, size = CHUNK_SIZE) {
  const chunks = [];
  for (const item of items) {
    const i = chunkOf(item.n, size);
    (chunks[i] ||= []).push(item);
  }
  return Array.from(chunks, (c = [], i) => ({ i, from: i * size + 1, to: c.length ? c.at(-1).n : i * size, songs: c }));
}

export const hash8 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);

// Serialized chunk and its content-addressed key, relative to the publish root.
export function chunkFile(kind, { i, from, to, songs }) {
  const text = JSON.stringify({ schema: SCHEMA, from, to, songs });
  return { key: `meta/${kind}-${i}-${hash8(text)}.json`, text };
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Writes the chunks that aren't already in `publish`. Unchanged chunks keep their key and file.
export function writeChunks(songs, details, publish, size = CHUNK_SIZE) {
  const out = { index: [], detail: [], written: [], bytes: {} };
  for (const [kind, items] of [['index', songs], ['detail', details]]) {
    for (const c of chunkSongs(items, size)) {
      const { key, text } = chunkFile(kind, c);
      const file = path.join(publish, key);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
        writeAtomic(file, text);
        out.written.push(key);
      }
      out[kind].push(key);
      out.bytes[key] = Buffer.byteLength(text);
    }
  }
  return out;
}

// The daily path (wall-add, no D1): appends items [{ song, detail }] for songs state.songCount+1..,
// in order, to the catalog in `state` (STATE/catalog.json's shape). Only the last chunk pair, and a
// new one at each i*chunkSize+1, get new keys. Returns the next state plus the keys written.
export function appendSongs(publish, state, items) {
  const size = state.chunkSize || CHUNK_SIZE;
  const index = [...state.index], detail = [...state.detail], written = [];
  const load = (key) => (key ? JSON.parse(fs.readFileSync(path.join(publish, key), 'utf8')).songs : [])
    .filter((s) => s.n <= state.songCount);
  const touched = new Map();
  let n = state.songCount;
  for (const item of items) {
    if (item.song.n !== ++n) throw new Error(`catalog append expected song ${n}, got ${item.song.n}`);
    const i = chunkOf(n, size);
    if (!touched.has(i)) touched.set(i, { index: load(index[i]), detail: load(detail[i]) });
    touched.get(i).index.push(item.song);
    touched.get(i).detail.push(item.detail);
  }
  for (const [i, chunk] of touched) {
    for (const [kind, keys] of [['index', index], ['detail', detail]]) {
      const songs = chunk[kind];
      const { key, text } = chunkFile(kind, { i, from: i * size + 1, to: songs.at(-1).n, songs });
      const file = path.join(publish, key);
      if (!fs.existsSync(file)) writeAtomic(file, text);
      keys[i] = key;
      written.push(key);
    }
  }
  return { index, detail, songCount: n, written };
}

// Deletes local chunk files that neither `keep` nor any manifest under publish/wall/ refers to.
export function pruneChunks(publish, keep) {
  const used = new Set(keep);
  const wall = path.join(publish, 'wall');
  const manifests = [path.join(wall, 'current.json')];
  if (fs.existsSync(path.join(wall, 'manifests'))) {
    for (const f of fs.readdirSync(path.join(wall, 'manifests'))) manifests.push(path.join(wall, 'manifests', f));
  }
  for (const f of manifests) {
    try {
      const { catalog } = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const k of [...(catalog?.index || []), ...(catalog?.detail || [])]) used.add(k);
    } catch {}
  }
  const dir = path.join(publish, 'meta');
  const removed = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^(index|detail)-\d+-[0-9a-f]{8}\.json$/.test(name) || used.has(`meta/${name}`)) continue;
    fs.rmSync(path.join(dir, name));
    removed.push(`meta/${name}`);
  }
  return removed;
}

// STATE/catalog.json. builtAt changes only when the chunk list or song count does.
export function writeCatalogState(file, { index, detail, songCount }, now = new Date()) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const same = prev && prev.songCount === songCount && prev.chunkSize === CHUNK_SIZE
    && JSON.stringify(prev.index) === JSON.stringify(index) && JSON.stringify(prev.detail) === JSON.stringify(detail);
  if (same) return { state: prev, changed: false };
  const state = { schema: SCHEMA, chunkSize: CHUNK_SIZE, index, detail, songCount, builtAt: now.toISOString() };
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  return { state, changed: true };
}

// ---- Readers ----

export function readLegacy(file) {
  const out = new Map();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = fromTokenMetadata('legacy', JSON.parse(line));
    if (Number.isInteger(r.n) && r.n > 0) out.set(r.n, r);
  }
  return out;
}

// output/<n>/ folders. Returns {initial: Map, metadata: Map, placeholders: [file]}.
// isPlaceholder decides which 0-byte Dropbox files to skip without opening them.
export function readOutputDirs(dirs, isPlaceholder) {
  const out = { initial: new Map(), metadata: new Map(), placeholders: [], unreadable: [] };
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+$/.test(name)) continue;
      const n = Number(name);
      for (const [kind, file, parse] of [
        ['initial', 'initial-metadata.json', (j) => fromInitial(j, n)],
        ['metadata', 'metadata.json', (j) => fromTokenMetadata('metadata', j, n)],
      ]) {
        if (out[kind].has(n)) continue;
        const f = path.join(dir, name, file);
        if (!fs.existsSync(f)) continue;
        if (isPlaceholder(f)) {
          out.placeholders.push(f);
          continue;
        }
        try {
          out[kind].set(n, parse(JSON.parse(fs.readFileSync(f, 'utf8'))));
        } catch {
          out.unreadable.push(f);
        }
      }
    }
  }
  return out;
}

const run = promisify(execFile);
const SECRET_ENV = /^(R2_|OPENSEA_|MAINNET_|ETHERSCAN_|ALCHEMY_)/;

// One read-only SELECT through the rating app's wrangler login. Returns the result rows.
export async function queryD1(sql, { cwd, database = D1_DATABASE }) {
  if (!/^\s*select\b/i.test(sql)) throw new Error('queryD1 only runs SELECT statements');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
  const { stdout } = await run('npx', ['--no', 'wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql], {
    cwd, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 1 << 29, timeout: 300_000,
  });
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error('wrangler printed no JSON');
  const [result] = JSON.parse(stdout.slice(start));
  if (!result?.success || !Array.isArray(result.results)) throw new Error('D1 query did not succeed');
  return result.results;
}
