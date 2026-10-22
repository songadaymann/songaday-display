// wall/current.json is the only file that changes in place; everything it points at is immutable.
import { mediaUrl } from '../config.js';
import { manifestProblems, needsNewApp, wallMismatch } from '../core/wall.js';

const HOUR = 3_600_000;

// An inline script in <head> (vite.config.mjs) starts this fetch while the app code downloads; the
// first fetchManifest() takes it over. It resolves to null if that request failed.
let early = globalThis.window?.__manifest;

// The manifest, checked. One for another pyramid or schema is refused with code ENEWAPP: this page's
// geometry is p1's, so it can't show it.
export async function fetchManifest() {
  const pending = early;
  early = undefined;
  if (pending) delete window.__manifest;
  const res = (await pending) || (await fetch(mediaUrl('wall/current.json'), { cache: 'no-cache' }));
  if (!res.ok) throw new Error(`wall/current.json: HTTP ${res.status}`);
  const m = await res.json();
  const problems = manifestProblems(m);
  if (problems.length) {
    throw Object.assign(new Error(`wall/current.json: ${problems.join(', ')}`), { code: needsNewApp(m) ? 'ENEWAPP' : 'EMANIFEST' });
  }
  return m;
}

// The pyramid descriptor is informational for the viewer (tile math is in shared/layout.mjs),
// so a missing or odd wall.json only warns.
export async function fetchWall(m) {
  try {
    const res = await fetch(mediaUrl(`wall/${m.pyramid}/wall.json`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wall = await res.json();
    const bad = wallMismatch(wall);
    if (bad.length) console.warn('[gallery] wall.json disagrees with shared/layout.mjs on:', bad.join(', '));
    return wall;
  } catch (err) {
    console.warn('[gallery] wall.json unavailable:', err.message);
    return null;
  }
}

// Re-read the manifest when the tab comes back and once an hour; onChange gets the new one
// whenever it differs. Returns refresh() for on-demand checks (e.g. after a tile 404).
export function watchManifest(initial, onChange) {
  let current = initial, inflight = null, last = Date.now();
  const refresh = () => {
    inflight ??= fetchManifest()
      .then((m) => {
        last = Date.now();
        if (JSON.stringify(m) !== JSON.stringify(current)) {
          const prev = current;
          current = m;
          onChange(m, prev);
        }
      })
      .catch((err) => {
        // The wall moved to a new pyramid or schema: only newer app code can show it.
        if (err.code === 'ENEWAPP') location.reload();
        else console.warn('[gallery] manifest refresh failed:', err.message);
      })
      .finally(() => (inflight = null));
    return inflight;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - last > 30_000) refresh();
  });
  window.addEventListener('focus', () => Date.now() - last > 30_000 && refresh());
  setInterval(refresh, HOUR);
  return refresh;
}
