// How many bytes an online-only file will take once it's downloaded. Placeholders carry no size,
// so this guesses from the real files of the same piece: same year first, then the nearest year
// with any, then the piece's overall mean. Good to within the spread of a year's files.

export function sizeEstimator(real, yearOf) {
  const byYear = new Map();
  let total = 0;
  for (const { n, size } of real) {
    if (!(size > 0)) continue;
    const y = yearOf(n);
    const s = byYear.get(y) || { sum: 0, count: 0 };
    s.sum += size;
    s.count++;
    byYear.set(y, s);
    total += size;
  }
  const count = real.filter((r) => r.size > 0).length;
  const overall = count ? total / count : 0;
  const years = [...byYear.keys()].sort((a, b) => a - b);
  return (n) => {
    if (!years.length) return overall;
    const y = yearOf(n);
    const near = years.reduce((best, cand) => (Math.abs(cand - y) < Math.abs(best - y) ? cand : best), years[0]);
    const s = byYear.get(near);
    return s.sum / s.count;
  };
}

export function formatBytes(b) {
  if (!Number.isFinite(b)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) {
    b /= 1000;
    i++;
  }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${units[i]}`;
}
