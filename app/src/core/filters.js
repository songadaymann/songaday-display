// Trait filters, worked out in the browser over the whole catalog (no 1,000-match cap).
// OR within a trait, AND across traits, and an optional date range. Counts are disjunctive:
// a value's count ignores its own trait's selection, so picking one Genre doesn't hide the others.

// Traits that aren't useful as filters. Year is recomputed from the date (the source data thins out).
const SKIP = new Set(['Song A Day', 'Date', 'Year', 'Token ID', 'Number']);
const ORDER = ['Topic', 'Genre', 'Mood', 'Location', 'Instrument', 'Style', 'Noun', 'Proper Noun', 'Year', 'Key', 'Tempo', 'Beard', 'Length'];

const listOf = (v) => (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== '').map(String);

// Long numeric traits (BPM, seconds, m:ss) become ranges so the list stays usable.
function bucketer(raw) {
  const distinct = [...new Set(raw)];
  if (distinct.length <= 24) return null;
  const clock = distinct.filter((v) => /^\d{1,2}:\d{2}$/.test(v));
  if (clock.length >= distinct.length * 0.9) {
    return (v) => {
      const m = /^(\d{1,2}):\d{2}$/.exec(v);
      return m ? { label: `${+m[1]}:00–${+m[1]}:59`, order: +m[1] } : { label: v, order: Infinity };
    };
  }
  const nums = distinct.filter((v) => /^\d+(\.\d+)?$/.test(v)).map(Number);
  if (nums.length < distinct.length * 0.9) return null;
  const span = Math.max(...nums) - Math.min(...nums);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => span / s <= 15) || 1000;
  return (v) => {
    if (!/^\d+(\.\d+)?$/.test(v)) return { label: v, order: Infinity };
    const lo = Math.floor(Number(v) / step) * step;
    return { label: step === 1 ? String(lo) : `${lo}–${lo + step - 1}`, order: lo };
  };
}

// Precompute each song's filter values. songs: catalog index entries { n, d, a }.
export function buildFacets(songs) {
  const raw = new Map();
  for (const s of songs) {
    for (const [name, v] of Object.entries(s.a || {})) {
      if (SKIP.has(name)) continue;
      if (!raw.has(name)) raw.set(name, []);
      raw.get(name).push(...listOf(v));
    }
  }
  const buckets = new Map([...raw].map(([name, vals]) => [name, bucketer(vals)]));
  const order = new Map(); // `${trait}\u0000${label}` -> sort key for bucketed traits

  const rows = songs.map((s) => {
    const values = new Map();
    for (const [name, v] of Object.entries(s.a || {})) {
      if (SKIP.has(name)) continue;
      const b = buckets.get(name);
      const labels = listOf(v).map((x) => {
        if (!b) return x;
        const { label, order: o } = b(x);
        order.set(`${name}\u0000${label}`, o);
        return label;
      });
      if (labels.length) values.set(name, [...new Set(labels)]);
    }
    if (s.d) values.set('Year', [s.d.slice(0, 4)]);
    return { n: s.n, d: s.d || '', values };
  });

  const totals = new Map();
  for (const r of rows) {
    for (const [name, vals] of r.values) {
      if (!totals.has(name)) totals.set(name, new Map());
      const t = totals.get(name);
      for (const v of vals) t.set(v, (t.get(v) || 0) + 1);
    }
  }

  const rank = (name) => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
  const traits = [...totals.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name) => {
      const t = totals.get(name);
      const values = [...t.keys()];
      if (name === 'Year') values.sort((a, b) => b.localeCompare(a));
      else if (buckets.get(name)) values.sort((a, b) => order.get(`${name}\u0000${a}`) - order.get(`${name}\u0000${b}`) || a.localeCompare(b));
      else values.sort((a, b) => t.get(b) - t.get(a) || a.localeCompare(b));
      return { name, values: values.map((value) => ({ value, total: t.get(value) })) };
    });

  const dates = rows.map((r) => r.d).filter(Boolean).sort();
  return { rows, traits, minDate: dates[0] || '', maxDate: dates.at(-1) || '' };
}

export const isActive = (selection, range = {}) =>
  [...selection.values()].some((set) => set.size > 0) || Boolean(range.from || range.to);

// selection: Map(trait -> Set(values)); range: { from, to } as 'YYYY-MM-DD' (either may be empty).
// Returns the matching song numbers (null when nothing is selected) and per-trait value counts.
export function evaluate(facets, selection, range = {}) {
  const active = [...selection].filter(([, set]) => set.size > 0);
  const counts = new Map(facets.traits.map((t) => [t.name, new Map()]));
  const matches = new Set();
  const bump = (name, vals) => {
    const c = counts.get(name);
    if (c) for (const v of vals) c.set(v, (c.get(v) || 0) + 1);
  };

  for (const r of facets.rows) {
    if (range.from && !(r.d >= range.from)) continue;
    if (range.to && !(r.d <= range.to)) continue;
    let failed = null, fails = 0;
    for (const [name, set] of active) {
      const vals = r.values.get(name);
      if (!vals || !vals.some((v) => set.has(v))) {
        failed = name;
        if (++fails > 1) break;
      }
    }
    if (fails === 0) {
      matches.add(r.n);
      for (const [name, vals] of r.values) bump(name, vals);
    } else if (fails === 1) {
      bump(failed, r.values.get(failed) || []);
    }
  }
  return { matches: isActive(selection, range) ? matches : null, counts };
}
