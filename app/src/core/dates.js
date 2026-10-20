// Song n came out on day n, counting 2009-01-01 as day 1. One song a day, no gaps.
const DAY = 86_400_000;
const EPOCH = Date.UTC(2009, 0, 1);

export const songDate = (n) => new Date(EPOCH + (n - 1) * DAY).toISOString().slice(0, 10);

// 'YYYY-MM-DD' -> song number, or null for anything that isn't a real date on or after 2009-01-01.
export function songForDate(iso) {
  const t = parseDay(iso);
  if (t === null) return null;
  const n = Math.round((t - EPOCH) / DAY) + 1;
  return n >= 1 ? n : null;
}

export function parseDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === iso ? t : null;
}

const long = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const short = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDate(iso, style = 'long') {
  const t = parseDay(iso);
  if (t === null) return String(iso ?? '');
  return (style === 'short' ? short : long).format(t);
}
