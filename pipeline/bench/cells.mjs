import { createRequire } from 'node:module';
const require = createRequire(process.env.SHARP_FROM + '/'); const sharp = require('sharp'); sharp.concurrency(1);
const { data: M } = await sharp(process.env.MASTER, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
const W0 = 36960, CW = 480, CH = 270, COLS = 77;
const cell = (n) => { const c = (n - 1) % COLS, r = Math.floor((n - 1) / COLS), b = Buffer.alloc(CW * CH * 3);
  for (let y = 0; y < CH; y++) M.copy(b, y * CW * 3, ((r * CH + y) * W0 + c * CW) * 3, ((r * CH + y) * W0 + c * CW + CW) * 3); return b; };
const ns = Array.from({ length: 40 }, (_, i) => 1 + Math.floor(i * 5851 / 39));
let ll = 0, jq = 0, t0 = performance.now(); const luma = [];
await Promise.all(ns.map(async (n) => { const b = cell(n); const s = () => sharp(b, { raw: { width: CW, height: CH, channels: 3 } });
  ll += (await s().webp({ lossless: true, effort: 4 }).toBuffer()).length; jq += (await s().jpeg({ quality: 95 }).toBuffer()).length; }));
console.log(`40 cells: lossless webp avg ${(ll / 40 / 1024).toFixed(0)} KB, jpeg q95 avg ${(jq / 40 / 1024).toFixed(0)} KB, ${(performance.now() - t0).toFixed(0)} ms total`);
// black-cell scan over all 5852 cells (mean luma < 12)
const dark = []; for (let n = 1; n <= 5852; n++) { const c = (n - 1) % COLS, r = Math.floor((n - 1) / COLS); let s = 0, k = 0;
  for (let y = 0; y < CH; y += 6) for (let x = 0; x < CW; x += 6) { const i = ((r * CH + y) * W0 + c * CW + x) * 3; s += 0.2126 * M[i] + 0.7152 * M[i + 1] + 0.0722 * M[i + 2]; k++; }
  if (s / k < 12) dark.push(n); }
console.log('cells with mean luma < 12:', dark.length, dark.slice(0, 40).join(','));
