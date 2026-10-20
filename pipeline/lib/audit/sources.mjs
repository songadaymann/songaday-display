// Local catalog and metadata sources. Everything here is a file already on this Mac; placeholders
// are skipped by the caller before anything is read.
import fs from 'node:fs';
import path from 'node:path';

// The newest cached sheet catalog the toolkit's description audit wrote
// (output/youtube-description-audit-<date>/catalog.json), unless one is named.
export function findCatalog(outputDir, named) {
  if (named) return fs.existsSync(named) ? named : null;
  if (!outputDir || !fs.existsSync(outputDir)) return null;
  const dirs = fs.readdirSync(outputDir).filter((d) => /^youtube-description-audit-\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const d of dirs.reverse()) {
    const f = path.join(outputDir, d, 'catalog.json');
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  }
  return null;
}

// → {file, asOfDate, songs: Map<n, row>, duplicates: [n], issues: {kind: count}}
export function loadCatalog(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const songs = new Map();
  const duplicates = [];
  for (const s of j.songs || []) {
    const n = Number(s.songNumber ?? s.number);
    if (!Number.isInteger(n) || n < 1) continue;
    if (songs.has(n)) duplicates.push(n);
    songs.set(n, {
      n,
      title: s.title || '',
      isoDate: s.isoDate || null,
      videoId: s.videoId || null,
      youtubeUrl: s.youtubeUrl ?? null,
      duration: s.duration || null,
      issues: s.issues || [],
    });
  }
  const issues = Object.fromEntries(Object.entries(j.issues || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
  return { file, asOfDate: j.asOfDate || null, generatedAt: j.generatedAt || null, songs, duplicates, issues };
}

// youtube-repair-candidates.json next to the catalog → Map<n, [{id, title}]>.
export function loadRepairCandidates(file) {
  const out = new Map();
  if (!file || !fs.existsSync(file)) return out;
  for (const r of JSON.parse(fs.readFileSync(file, 'utf8')).repairCandidates || []) {
    const c = (r.targetChannelCandidates || []).map((x) => ({ id: x.videoId, title: x.youtubeTitle || '' })).filter((x) => x.id);
    if (c.length) out.set(Number(r.songNumber), c);
  }
  return out;
}

// The old gallery's songaday_clean.jsonl → Map<n, json>, plus lines that didn't parse.
export function loadJsonl(file) {
  const out = new Map();
  const bad = [];
  if (!file || !fs.existsSync(file)) return { songs: out, bad };
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const j = JSON.parse(line);
      const n = Number(j.token_id);
      if (Number.isInteger(n) && n > 0) out.set(n, j);
      else bad.push(i + 1);
    } catch {
      bad.push(i + 1);
    }
  });
  return { songs: out, bad };
}

// {json} or {error} for one local JSON file.
export function readJson(file) {
  try {
    return { json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'missing' : 'does not parse' };
  }
}

export const trait = (json, name) => (json?.attributes || []).find((a) => a?.trait_type === name)?.value;

export const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
const IPFS_URI = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(\/[^\s'"]*)?$/;

// IPFS fields of a token metadata JSON → {field: uri}, plus the ones that aren't clean ipfs:// URIs.
export function ipfsFields(json) {
  const fields = {};
  const malformed = [];
  for (const k of ['image', 'animation_url', 'audio_url', 'gif_url']) {
    const v = json?.[k];
    if (v == null || v === '') continue;
    fields[k] = v;
    if (!IPFS_URI.test(v)) malformed.push(k);
  }
  return { fields, malformed };
}

export const normTitle = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
