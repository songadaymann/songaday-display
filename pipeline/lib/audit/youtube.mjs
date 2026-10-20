// YouTube links, checked offline: the id must parse (same rule the catalog uses), and the toolkit's
// cached YouTube Data API snapshot says whether it was public and embeddable when it was taken.
import fs from 'node:fs';
import { youtubeId } from '../catalog.mjs';

export { youtubeId };

// youtube-api-cache.json from the toolkit's description audit → Map<id, {state, embeddable, uploadStatus}>.
export function loadYouTubeCache(file) {
  if (!file || !fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = new Map();
  let latest = '';
  for (const [id, e] of Object.entries(j.videos || {})) {
    if (e?.fetchedAt > latest) latest = e.fetchedAt;
    const st = e?.result?.status;
    out.set(id, st
      ? { state: st.privacyStatus, embeddable: st.embeddable !== false, uploadStatus: st.uploadStatus }
      : { state: 'unavailable', embeddable: false, uploadStatus: null });
  }
  out.fetchedAt = latest || null;
  return out;
}

// sources: [{src, raw}] in priority order (the sheet first, then token metadata copies).
// idUse: Map<id, [n…]> across the whole catalog, to catch one video used for two songs.
// `flags` names each finding for the summary: malformed, malformedCopy, disagree, notPublic,
// notEmbeddable, sharedId, unknown.
export function classifyYouTube(n, sources, { cache, idUse } = {}) {
  const given = sources.filter((s) => s.raw != null && String(s.raw).trim() !== '');
  if (!given.length) return { status: 'missing', flags: [], detail: 'no YouTube link in the sheet or metadata' };
  const primary = given[0];
  const id = youtubeId(primary.raw);
  if (!id) return { status: 'bad', id: null, flags: ['malformed'], source: primary.src, detail: `malformed link in ${primary.src}: ${primary.raw}` };
  const notes = [];
  const flags = new Set();
  let status = 'ok';
  const flag = (s, name, note) => {
    if (s === 'bad' || status === 'ok') status = s;
    flags.add(name);
    notes.push(note);
  };
  for (const s of given.slice(1)) {
    const other = youtubeId(s.raw);
    if (!other) flag('suspect', 'malformedCopy', `malformed link in ${s.src}: ${s.raw}`);
    else if (other !== id) flag('suspect', 'disagree', `${s.src} has ${other}`);
  }
  const c = cache?.get(id);
  if (cache && !c) {
    flags.add('unknown');
    notes.push('not in the API snapshot');
  } else if (c && (c.state === 'unavailable' || c.state === 'private')) {
    flag('bad', 'notPublic', `${c.state === 'private' ? 'private' : 'not public or removed'} (API snapshot)`);
  } else if (c && !c.embeddable) {
    flag('suspect', 'notEmbeddable', 'embedding disabled (API snapshot)');
  } else if (c && c.state === 'unlisted') {
    notes.push('unlisted');
  }
  const shared = (idUse?.get(id) || []).filter((m) => m !== n);
  if (shared.length) flag('suspect', 'sharedId', `same video as #${shared.join(', #')}`);
  return { status, id, flags: [...flags], source: primary.src, detail: notes.join('; ') };
}
