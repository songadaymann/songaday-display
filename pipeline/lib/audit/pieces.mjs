// Per-song checks, one function per piece. Each returns {status, detail, …}; anything that
// needs a decode or a probe is finished later by applyImage / applyProbe.
import fs from 'node:fs';
import { dateOf } from '../catalog.mjs';
import { ERA, LIMITS, PIECES } from './config.mjs';
import { fileStatus, pickBest } from './status.mjs';
import { DARK, FLAT, is169, parseLength, fmtSeconds } from './media.mjs';
import { readJson, trait, ipfsFields, normTitle, CID } from './sources.mjs';
import { classifyYouTube } from './youtube.mjs';

const join = (...parts) => parts.filter(Boolean).join('; ');

// A file-backed piece from a folder scan. Outside [from, to] a song without a file is n/a.
export function filePiece(n, scan, piece, { from = 1, to = Infinity } = {}) {
  const recs = scan?.byN.get(n) || [];
  if (!recs.length) return { status: n >= from && n <= to ? 'missing' : 'n/a' };
  const exts = PIECES[piece].exts || [];
  const best = pickBest(recs, exts);
  const r = { status: fileStatus(best), file: best };
  const extra = recs.filter((x) => x !== best).map((x) => x.name);
  if (!exts.includes(best.ext)) {
    r.status = r.status === 'ok' ? 'suspect' : r.status;
    r.detail = `no .${exts[0]}, only ${best.name}`;
  } else if (extra.length) {
    const sameKind = recs.filter((x) => x !== best && exts.includes(x.ext));
    if (piece === 'video' && sameKind.length && r.status === 'ok') r.status = 'suspect';
    r.detail = `${sameKind.length ? 'two versions' : 'also'}: ${extra.join(', ')}`;
  }
  return r;
}

export function catalogPiece(n, cat) {
  if (!cat) return { status: 'n/a', detail: 'no cached catalog found' };
  const row = cat.songs.get(n);
  const expected = dateOf(n);
  if (!row) {
    return cat.asOfDate && expected > cat.asOfDate
      ? { status: 'n/a', detail: `newer than the ${cat.asOfDate} snapshot` }
      : { status: 'missing', detail: 'no row in the sheet snapshot' };
  }
  if (row.isoDate !== expected) return { status: 'bad', detail: `sheet date ${row.isoDate} is not ${expected}` };
  if (!row.title.trim()) return { status: 'bad', detail: 'blank title' };
  const notes = [];
  if (row.issues.includes('conflicting_source_titles')) notes.push('tabs disagree on the title');
  if (row.issues.includes('duplicate_combined_rows')) notes.push('two rows in ALL YEARS (json)');
  return { status: notes.length ? 'suspect' : 'ok', detail: join(...notes) };
}

// Token metadata: the toolkit's output/<n>/metadata.json, then all-metadata/<n>.json, then the
// archive's Metadata unclean copy (only if it's local), then the old gallery's jsonl line.
export function metaPiece(n, ctx) {
  const files = [
    ['toolkit output', ctx.output.get(n)?.get('metadata.json')],
    ['all-metadata', ctx.allMeta?.byN.get(n)?.[0]],
    ['archive metadata', ctx.archMeta?.byN.get(n)?.[0]],
  ].filter(([, f]) => f);
  const read = [];
  const notes = [];
  let status = null;
  const flag = (s, note) => {
    if (s === 'bad' || !status || status === 'ok') status = s;
    notes.push(note);
  };
  const placeholders = [];
  for (const [src, f] of files) {
    const st = fileStatus(f);
    if (st === 'placeholder') placeholders.push(src);
    else if (st === 'empty') flag('bad', `${src} copy is 0 bytes`);
    else {
      const { json, error } = readJson(f.path);
      if (json) read.push({ src, json, file: f });
      else flag('bad', `${src} copy ${error}`);
    }
  }
  const legacy = ctx.jsonl?.get(n);
  if (legacy) read.push({ src: 'legacy jsonl', json: legacy });

  if (!read.length) {
    if (status) return { status, detail: join(...notes) };
    if (placeholders.length) return { status: 'placeholder', detail: `only an online-only ${placeholders.join(', ')} copy`, file: files.find(([s]) => s === placeholders[0])[1] };
    return { status: 'missing', detail: 'no local token metadata' };
  }
  const expected = dateOf(n);
  for (const { src, json } of read) {
    if (json.token_id != null && Number(json.token_id) !== n) flag('bad', `${src} says token_id ${json.token_id}`);
    const d = trait(json, 'Date');
    if (d && d !== expected) flag('bad', `${src} Date trait ${d} is not ${expected}`);
    const { malformed } = ipfsFields(json);
    if (malformed.length) flag('bad', `${src} has a malformed ${malformed.join(', ')}: ${malformed.map((k) => json[k]).join(' ')}`);
  }
  for (const name of ['metadata_hash.txt', 'image_hash.txt', 'video_hash.txt', 'audio_hash.txt', 'gif_hash.txt']) {
    const f = ctx.output.get(n)?.get(name);
    if (!f || fileStatus(f) !== 'ok') continue;
    const cid = fs.readFileSync(f.path, 'utf8').trim();
    if (!CID.test(cid)) flag('bad', `output/${n}/${name} is not a CID: ${cid.slice(0, 80)}`);
  }
  const primary = read[0];
  const title = ctx.catalog?.songs.get(n)?.title;
  if (title && primary.json.name && normTitle(primary.json.name) !== normTitle(title)) {
    flag('suspect', `${primary.src} name "${primary.json.name}" vs sheet "${title}"`);
  }
  if (placeholders.length) notes.push(`${placeholders.join(', ')} copy online-only`);
  return {
    status: status || 'ok',
    detail: join(`from ${primary.src}`, ...notes),
    source: primary.src,
    file: primary.file,
    name: primary.json.name,
    ipfs: ipfsFields(primary.json).fields,
    youtube: read.map(({ src, json }) => ({ src: `${src} youtube_url`, raw: json.youtube_url })),
  };
}

export function youtubePiece(n, ctx, meta) {
  const row = ctx.catalog?.songs.get(n);
  const sources = [];
  if (row) sources.push({ src: 'sheet', raw: row.youtubeUrl || row.videoId || '' });
  for (const s of meta?.youtube || []) sources.push(s);
  const r = classifyYouTube(n, sources, { cache: ctx.ytCache, idUse: ctx.idUse });
  if (row && !(row.youtubeUrl || row.videoId) && r.id) {
    r.status = r.status === 'bad' ? 'bad' : 'suspect';
    r.flags.push('sheetBlank');
    r.detail = join(`sheet link is blank; ${r.source} has ${r.id}`, r.detail);
  }
  const cand = ctx.repair?.get(n);
  if (cand && r.status !== 'ok') r.candidate = cand[0];
  return r;
}

// Toolkit art for songs with no video still: generated image_<n>.png first, then the
// YouTube thumbnail the toolkit designed.
export function artPiece(n, ctx) {
  const dir = ctx.output.get(n);
  if (!dir) return { status: 'n/a' };
  const recs = [...dir.values()].filter((f) => new RegExp(`^image_${n}\\.(png|jpe?g)$`, 'i').test(f.name) || f.name === 'thumbnail.jpg');
  if (!recs.length) return { status: 'n/a' };
  const best = recs.sort((a, b) => (a.name === 'thumbnail.jpg') - (b.name === 'thumbnail.jpg'))[0];
  return { status: fileStatus(best), file: best, detail: best.name };
}

export function cellPiece(n, master) {
  if (!master) return { status: n <= ERA.masterSongs ? 'missing' : 'n/a', detail: 'no legacy master configured' };
  if (master.status !== 'ok') return { status: n <= ERA.masterSongs ? master.status : 'n/a', detail: master.detail };
  if (n > master.count) return { status: 'n/a' };
  const luma = master.luma[n];
  if (luma >= DARK) return { status: 'ok', luma };
  const flat = master.sd[n] < FLAT;
  return { status: 'suspect', luma, detail: `${flat ? 'black' : 'dark'} cell (mean luma ${luma.toFixed(1)}/255${flat ? ', flat' : ''})` };
}

// Fold a decode into an image piece.
export function applyImage(piece, r, stats, error) {
  r.checked = true;
  if (error) {
    r.status = 'bad';
    r.detail = join(r.detail, `does not decode: ${String(error.message || error).split('\n')[0]}`);
    return r;
  }
  Object.assign(r, { width: stats.width, height: stats.height, luma: Math.round(stats.luma * 10) / 10 });
  if (piece === 'gif') r.frames = stats.frames;
  const sus = (note) => {
    if (r.status === 'ok') r.status = 'suspect';
    r.detail = join(r.detail, note);
  };
  if (stats.luma < DARK && stats.sd < FLAT) {
    r.status = 'bad';
    r.detail = join(r.detail, `black frame (mean luma ${stats.luma.toFixed(1)}/255, flat)`);
  } else if (stats.luma < DARK) {
    sus(`very dark (mean luma ${stats.luma.toFixed(1)}/255)`);
  }
  if (!is169(stats.width, stats.height)) sus(`${stats.width}x${stats.height}, not 16:9`);
  else if (piece === 'gif' && (stats.width !== LIMITS.gifW || stats.height !== LIMITS.gifH)) sus(`${stats.width}x${stats.height}, not ${LIMITS.gifW}x${LIMITS.gifH}`);
  if (piece === 'gif' && stats.frames < 2) sus('a single frame');
  return r;
}

// Fold an ffprobe result into a media piece. sheetSeconds is the sheet's Length, if any.
export function applyProbe(piece, r, info, error, { sheetSeconds, wavSeconds } = {}) {
  r.checked = true;
  if (error) {
    r.status = 'bad';
    r.detail = join(r.detail, `ffprobe failed: ${String(error.stderr || error.message || error).trim().split('\n')[0]}`);
    return r;
  }
  r.duration = Math.round(info.duration * 10) / 10;
  const bad = (note) => {
    r.status = 'bad';
    r.detail = join(r.detail, note);
  };
  const sus = (note) => {
    if (r.status === 'ok') r.status = 'suspect';
    r.detail = join(r.detail, note);
  };
  if (!(info.duration > 0)) {
    bad('no duration');
    return r;
  }
  if (piece === 'video' && !info.video) bad('no video stream');
  if (piece !== 'video' && !info.audio) bad('no audio stream');
  if (info.video) r.dims = `${info.video.width}x${info.video.height}`;
  if (info.warnings.length) sus(`ffprobe: ${info.warnings[0]}`);
  if (info.duration < LIMITS.shortSeconds) sus(`only ${info.duration.toFixed(1)} s`);
  if (piece === 'wav' && sheetSeconds && Math.abs(info.duration - sheetSeconds) > LIMITS.wavVsSheetSeconds) {
    r.lengthMismatch = true;
    sus(`${fmtSeconds(info.duration)} long, sheet says ${fmtSeconds(sheetSeconds)}`);
  }
  if (piece === 'mp3' && wavSeconds && Math.abs(info.duration - wavSeconds) > LIMITS.mp3VsWavSeconds) {
    sus(`${fmtSeconds(info.duration)} long, the WAV is ${fmtSeconds(wavSeconds)}`);
  }
  return r;
}

export const sheetSeconds = (ctx, n) => parseLength(ctx.catalog?.songs.get(n)?.duration);

// After probing: a WAV whose length is another nearby song's sheet length is probably that song
// (swapped or shifted files). And a "probably the real one" duplicate whose WAV doesn't match its
// own sheet length isn't trusted either: every copy is then bad.
export function crossCheck(songs, ctx) {
  for (const s of songs) {
    const w = s.p.wav;
    if (!w?.lengthMismatch) continue;
    const near = [-2, -1, 1, 2].map((d) => s.n + d).filter((m) => {
      const len = sheetSeconds(ctx, m);
      return len && Math.abs(w.duration - len) <= LIMITS.neighbourSeconds;
    });
    if (near.length) w.detail = join(w.detail, `its length matches the sheet's #${near.join(', #')}`);
    for (const r of Object.values(s.p)) {
      if (!r?.dupOriginal) continue;
      r.status = 'bad';
      r.detail = join(r.detail, 'but this song\'s WAV does not match its sheet length either');
    }
  }
}

// Songs sharing bytes: the oldest file is probably the real one (a re-run copied it forward),
// so it stays usable for review; the copies are bad.
export function applyDuplicate(r, dup) {
  if (!dup || r.status === 'placeholder' || r.status === 'missing') return r;
  const list = `#${dup.others.slice(0, 8).join(', #')}${dup.others.length > 8 ? ` and ${dup.others.length - 8} more` : ''}`;
  r.sha1 = dup.sha1;
  if (dup.original) {
    r.dupOriginal = true;
    if (r.status === 'ok') r.status = 'suspect';
    r.detail = join(r.detail, `same bytes as ${list}; this is the oldest copy, probably the real one`);
  } else {
    r.status = 'bad';
    r.detail = join(r.detail, `same bytes as ${list}; a later copy of #${dup.originalN}`);
  }
  return r;
}

// Design A's cell source: the old master's cell, else the still, else the 4K thumbnail, else
// toolkit art (flagged for review, since it isn't a frame of the video), else a generated card.
export function mosaicPiece(p) {
  const cands = [['master', p.cell], ['still', p.still], ['thumb', p.thumb], ['art', p.art]].filter(([, r]) => r);
  const use = cands.find(([, r]) => r.status === 'ok' || r.status === 'suspect');
  if (use) {
    const [source, r] = use;
    const art = source === 'art';
    return {
      status: art ? 'suspect' : r.status,
      source,
      file: r.file,
      detail: join(art ? `generated art (${r.detail}), not a video frame` : source === 'master' ? 'old master cell' : null, art ? null : r.detail),
    };
  }
  const ph = cands.find(([, r]) => r.status === 'placeholder');
  if (ph) return { status: 'placeholder', source: ph[0], file: ph[1].file, detail: `${ph[0]} is online-only` };
  const why = cands.filter(([, r]) => r.status === 'bad' || r.status === 'empty').map(([s, r]) => `${s}: ${r.detail || r.status}`);
  return { status: 'missing', source: 'card', detail: join('no usable image, so a generated card', ...why) };
}
