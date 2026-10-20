// In-browser search over the catalog: song numbers, dates, titles and trait values.
// No network per keystroke; 6,500 songs scan in well under a millisecond.

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const traitText = (a = {}) =>
  Object.values(a)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ');

export function buildIndex(songs) {
  return songs.map((song) => ({
    n: song.n,
    d: song.d || '',
    song,
    title: ` ${normalize(song.t)} `,
    traits: ` ${normalize(traitText(song.a))} `,
  }));
}

function score(e, q, tokens, number, year) {
  let best = 0;
  if (number && e.n === number) best = 1000;
  if (q.date && e.d === q.date) best = Math.max(best, 900);
  // Titles are stored as ' words ', so ' phrase ' only matches whole words and ' phrase' word starts.
  const whole = ` ${q.norm} `, start = ` ${q.norm}`;
  if (e.title === whole) best = Math.max(best, 500);
  else if (e.title.startsWith(whole)) best = Math.max(best, 450);
  else if (e.title.includes(whole)) best = Math.max(best, 350);
  else if (e.title.startsWith(start)) best = Math.max(best, 300);
  else if (e.title.includes(start)) best = Math.max(best, 250);
  if (best >= 250) return best;
  if (tokens.every((t) => e.title.includes(` ${t}`))) return Math.max(best, 200);
  if (tokens.every((t) => e.title.includes(t))) return Math.max(best, 100);
  if (tokens.every((t) => e.title.includes(` ${t}`) || e.traits.includes(` ${t}`))) return Math.max(best, 50);
  if (year && e.d.startsWith(year)) return Math.max(best, 40);
  return best;
}

// Ranked matches, best first; ties go to the newer song.
export function search(index, query, { limit = Infinity } = {}) {
  const raw = String(query ?? '').trim();
  const norm = normalize(raw);
  if (!norm) return [];
  const tokens = norm.split(' ');
  const numMatch = /^(?:#|no\.?\s*|song\s*#?\s*)?(\d{1,6})$/i.exec(raw);
  const number = numMatch ? +numMatch[1] : 0;
  const year = /^(19|20)\d{2}$/.test(raw) ? raw : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
  const q = { norm, date };
  const hits = [];
  for (const e of index) {
    const s = score(e, q, tokens, number, year);
    if (s > 0) hits.push({ n: e.n, song: e.song, score: s });
  }
  hits.sort((a, b) => b.score - a.score || b.n - a.n);
  return Number.isFinite(limit) ? hits.slice(0, limit) : hits;
}
