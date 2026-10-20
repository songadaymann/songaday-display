// localStorage for small per-visitor preferences. Private windows and blocked storage throw;
// the page works the same without it.
export function load(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
