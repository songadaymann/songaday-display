// Song data from the catalog chunks named in the manifest (shared/README.md). Index chunks load
// in parallel at start for search and filters; a detail chunk loads when a song's modal opens.
// Chunk names carry a content hash, so a chunk is fetched once and cached by the browser.
import { mediaUrl } from '../config.js';

export function createCatalog() {
  const songs = new Map();
  const fetched = new Map(); // chunk path -> Promise
  const applied = new Set(); // index chunk paths already merged into songs
  const listeners = new Set();
  let sorted = null, manifest = null, ready = null, loaded = false;

  const getJson = (path) => {
    if (!fetched.has(path)) {
      const p = fetch(mediaUrl(path)).then((res) => {
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return res.json();
      });
      p.catch(() => fetched.delete(path)); // let a later load retry
      fetched.set(path, p);
    }
    return fetched.get(path);
  };

  // Fetch any index chunks of manifest m not loaded yet. Resolves when they're in.
  function load(m) {
    manifest = m;
    const paths = (m.catalog?.index || []).filter((path) => !applied.has(path));
    const pending = paths.map((path) =>
      getJson(path).then(
        (chunk) => {
          if (applied.has(path)) return;
          applied.add(path);
          for (const s of chunk.songs || []) if (Number.isInteger(s.n)) songs.set(s.n, s);
          sorted = null;
        },
        (err) => console.warn('[gallery] catalog chunk failed:', err.message),
      ),
    );
    const before = applied.size;
    const done = Promise.all(pending).then(() => {
      const first = !loaded;
      loaded = true;
      if (first || applied.size !== before) listeners.forEach((cb) => cb());
    });
    ready ??= done;
    return done;
  }

  async function description(n) {
    const c = manifest?.catalog;
    if (!c?.detail?.length) return null;
    const path = c.detail[Math.floor((n - 1) / (c.chunkSize || 500))];
    if (!path) return null;
    try {
      const chunk = await getJson(path);
      return chunk.songs?.find((s) => s.n === n)?.description || null;
    } catch (err) {
      console.warn('[gallery] detail chunk failed:', err.message);
      return null;
    }
  }

  return {
    load,
    get ready() {
      return ready || Promise.resolve();
    },
    get size() {
      return songs.size;
    },
    // True once the first load has settled (even if it found no songs).
    get loaded() {
      return loaded;
    },
    getSong: (n) => songs.get(n) || null,
    allSongs: () => (sorted ??= Object.freeze([...songs.values()].sort((a, b) => a.n - b.n))),
    maxSong: () => (songs.size ? Math.max(...songs.keys()) : 0),
    description,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
