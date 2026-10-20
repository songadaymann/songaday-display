// Decoding and probing for the files a run samples (every local file with --deep).
// Callers must never pass a placeholder: opening one makes Dropbox download it.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);

export const DARK = 12; // mean luma (0-255) below this is a dark frame
export const FLAT = 2; // and a luma spread below this makes it a black one (no picture at all)
export const ASPECT = 16 / 9;
export const ASPECT_TOLERANCE = 0.02;

export const is169 = (w, h) => w > 0 && h > 0 && Math.abs(w / h / ASPECT - 1) <= ASPECT_TOLERANCE;

// Mean and standard deviation of 8-bit samples.
export function lumaStats(buf) {
  let s = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    s += buf[i];
    s2 += buf[i] * buf[i];
  }
  const mean = buf.length ? s / buf.length : 0;
  return { mean, sd: buf.length ? Math.sqrt(Math.max(0, s2 / buf.length - mean * mean)) : 0 };
}

// {width, height, frames, luma, sd} for a still or an animated GIF (over every frame).
export async function imageStats(file) {
  const animated = /\.gif$/i.test(file);
  const opts = { limitInputPixels: false, pages: animated ? -1 : 1 };
  const meta = await sharp(file, opts).metadata();
  const frames = meta.pages || 1;
  const height = meta.pageHeight || meta.height;
  const img = sharp(file, opts).greyscale();
  const data = animated
    ? await img.raw().toBuffer()
    : await img.resize(64, 36, { fit: 'fill' }).raw().toBuffer();
  const { mean, sd } = lumaStats(data);
  return { width: meta.width, height, frames, format: meta.format, luma: mean, sd };
}

let ffprobe;
function ffprobePath() {
  if (ffprobe) return ffprobe;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  ffprobe = process.env.FFPROBE || dirs.map((d) => path.join(d, 'ffprobe')).find((p) => fs.existsSync(p)) || 'ffprobe';
  return ffprobe;
}

// {duration, format, video: {codec, width, height} | null, audio: {codec} | null, warnings}.
// Throws when ffprobe can't read the container.
export async function probe(file) {
  const { stdout, stderr } = await run(ffprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height',
    '-of', 'json', file,
  ], { timeout: 120_000, maxBuffer: 1 << 24 });
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration),
    format: j.format?.format_name,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height } : null,
    audio: a ? { codec: a.codec_name } : null,
    warnings: stderr.trim().split('\n').filter(Boolean).slice(0, 3),
  };
}

// "2:36" or "1:02:03" → seconds; null when it isn't a length.
export function parseLength(s) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ''));
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export const fmtSeconds = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '?');
