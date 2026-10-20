// Quality sweep: lossless box pyramid from the real master, then encode sample tiles per level
// with several codecs/settings. Reports mean bytes/tile and PSNR vs the lossless tile.
import { createRequire } from 'node:module';
const require = createRequire(process.env.SHARP_FROM + '/');
const sharp = require('sharp'); sharp.concurrency(1);
const COLS = 77, CW = 480, CH = 270, TW = 960, TH = 540, N = 5852, W0 = 36960;
const { data: M } = await sharp(process.env.MASTER, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
const rows = Math.ceil(N / COLS), H0 = rows * CH;
// lossless level rasters via whole-level box shrink (equivalent to tile-wise, shown in pyramid-bench)
let lv = [{ w: W0, h: H0, raw: M }];
for (let k = 1; k <= 7; k++) { const p = lv[k - 1], w = Math.ceil(p.w / 2), h = Math.ceil(p.h / 2), o = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let b = 0; b < 3; b++) { let s = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const X = 2 * x + dx, Y = 2 * y + dy; if (X < p.w && Y < p.h) s += p.raw[(Y * p.w + X) * 3 + b]; }
    o[(y * w + x) * 3 + b] = (s + 2) >> 2; }
  lv.push({ w, h, raw: o }); }
function crop(L, tx, ty) { const w = Math.min(TW, L.w - tx * TW), h = Math.min(TH, L.h - ty * TH), o = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) L.raw.copy(o, y * w * 3, ((ty * TH + y) * L.w + tx * TW) * 3, ((ty * TH + y) * L.w + tx * TW + w) * 3); return { w, h, raw: o }; }
function psnr(a, b) { let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; } return 10 * Math.log10(65025 / (se / a.length)); }
const settings = {
  'webp q75': (s) => s.webp({ quality: 75, effort: 4 }),
  'webp q80': (s) => s.webp({ quality: 80, effort: 4 }),
  'webp q85': (s) => s.webp({ quality: 85, effort: 4 }),
  'webp q90': (s) => s.webp({ quality: 90, effort: 4 }),
  'webp q85 smart': (s) => s.webp({ quality: 85, effort: 4, smartSubsample: true }),
  'jpeg q85 mozjpeg': (s) => s.jpeg({ quality: 85, mozjpeg: true }),
  'jpeg q90 mozjpeg 444': (s) => s.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' }),
  'avif q60': (s) => s.avif({ quality: 60, effort: 4 }),
};
for (const k of [0, 1, 3, 5]) {
  const L = lv[k], ntx = Math.ceil(L.w / TW), nty = Math.ceil(L.h / TH);
  // sample interior tiles (full size), spread over the level
  const picks = []; for (let ty = 0; ty < nty; ty++) for (let tx = 0; tx < ntx; tx++) if ((tx + 1) * TW <= L.w && (ty + 1) * TH <= L.h) picks.push([tx, ty]);
  const step = Math.max(1, Math.floor(picks.length / 10)); const sample = picks.filter((_, i) => i % step === 0).slice(0, 10);
  const tiles = sample.map(([x, y]) => crop(L, x, y));
  for (const [name, fn] of Object.entries(settings)) { let bytes = 0, ps = 0, ms = 0;
    for (const tile of tiles) { const t0 = performance.now();
      const buf = await fn(sharp(tile.raw, { raw: { width: tile.w, height: tile.h, channels: 3 } })).toBuffer(); ms += performance.now() - t0;
      const d = await sharp(buf).raw().toBuffer(); bytes += buf.length; ps += psnr(d, tile.raw); }
    console.log(`k=${k} n=${tiles.length} ${name.padEnd(22)} ${(bytes / tiles.length / 1024).toFixed(0).padStart(5)} KB/tile  PSNR ${(ps / tiles.length).toFixed(2)} dB  enc ${(ms / tiles.length).toFixed(0)} ms`); }
}
