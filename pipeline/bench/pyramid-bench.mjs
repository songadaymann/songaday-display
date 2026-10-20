// Benchmark: cell-aligned 960x540 WebP pyramid built tile-by-tile from the real
// 36960x20520 master (77 cols x 76 rows of 480x270 cells, songs 1..5852).
// Compares "parent from lossless children" (L) with "parent from published WebP
// children" (C), and checks that full build == build(N-1) + incremental patch(N).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(process.env.SHARP_FROM + '/');
const sharp = require('sharp');
sharp.concurrency(1); // one libvips thread per op; we parallelise across tiles
const MASTER = process.env.MASTER;
const OUT = process.env.OUT;
const Q = Number(process.env.Q || 80);
const COLS = 77, CW = 480, CH = 270, TW = 960, TH = 540, LEVELS = 8; // k = 0..7
const W0 = COLS * CW; // 36960

const t = () => performance.now();
async function pool(items, n, fn) { let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out; }

const t0 = t();
const { data: M, info } = await sharp(MASTER, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
console.log('decode master', info.width, info.height, ((t() - t0) / 1000).toFixed(1) + 's');

const enc = (raw, w, h) => sharp(raw, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: Q, effort: 4, smartSubsample: process.env.SMART === '1' }).toBuffer();
const dec = async (buf) => (await sharp(buf).raw().toBuffer({ resolveWithObject: true }));

// level widths in px for tile columns
const levelW = (k) => Math.ceil(W0 / 2 ** k);
const tileW = (k, tx) => Math.min(TW, levelW(k) - tx * TW);

function cellCopy(dst, dw, n, dx, dy) { // copy cell n (1-based) from master into dst at (dx,dy)
  const col = (n - 1) % COLS, row = Math.floor((n - 1) / COLS);
  for (let y = 0; y < CH; y++) {
    const s = ((row * CH + y) * W0 + col * CW) * 3;
    M.copy(dst, ((dy + y) * dw + dx) * 3, s, s + CW * 3);
  }
}
function level0Tile(tx, ty, N) { // tile covers cols 2tx..2tx+1, rows 2ty..2ty+1
  const w = tileW(0, tx), buf = Buffer.alloc(w * TH * 3);
  let any = false;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const col = 2 * tx + c, row = 2 * ty + r; if (col >= COLS) continue;
    const n = row * COLS + col + 1; if (n > N) continue; any = true;
    cellCopy(buf, w, n, c * CW, r * CH);
  }
  return any ? { w, raw: buf } : null;
}
function parentFrom(children, k, tx) { // children: [[c00,c10],[c01,c11]] raw {w,raw} or null, each TH tall
  const cw0 = children[0][0]?.w ?? children[1][0]?.w ?? 0;
  const cwTot = Math.min(2 * TW, levelW(k - 1) - 2 * tx * TW);
  const w = Math.ceil(cwTot / 2), h = TH, out = Buffer.alloc(w * h * 3);
  // 2x2 box filter; every parent pixel's 4 sources lie in one child (TW, TH even); missing = black
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const ch = children[r][c]; if (!ch) continue; const cwid = ch.w, src = ch.raw;
    const ox = c * (TW / 2), oy = r * (TH / 2), pw = Math.ceil(cwid / 2);
    for (let y = 0; y < TH / 2; y++) {
      const s0 = (2 * y) * cwid * 3, s1 = (2 * y + 1) * cwid * 3, d = ((oy + y) * w + ox) * 3;
      for (let x = 0; x < pw; x++) {
        const a = 2 * x * 3, two = 2 * x + 1 < cwid;
        for (let b = 0; b < 3; b++) {
          let s = src[s0 + a + b] + src[s1 + a + b];
          if (two) s += src[s0 + a + 3 + b] + src[s1 + a + 3 + b];
          out[d + x * 3 + b] = (s + 2) >> 2;
        }
      }
    }
  }
  return { w, raw: out };
}
const key = (tx, ty) => tx + ',' + ty;

async function build(N, { keepLossless = false, log = false } = {}) {
  const rows = Math.ceil(N / COLS);
  const lv = []; // per level: Map key -> {w, webp, rawL?}
  let tl = t();
  // level 0
  const nTX0 = Math.ceil(COLS / 2), nTY0 = Math.ceil(rows / 2);
  const jobs = []; for (let ty = 0; ty < nTY0; ty++) for (let tx = 0; tx < nTX0; tx++) jobs.push([tx, ty]);
  const L0 = new Map();
  await pool(jobs, 10, async ([tx, ty]) => { const tile = level0Tile(tx, ty, N); if (!tile) return;
    const webp = await enc(tile.raw, tile.w, TH); L0.set(key(tx, ty), { w: tile.w, webp, rawL: keepLossless ? tile.raw : null }); });
  lv.push(L0);
  if (log) console.log(`k=0 tiles=${L0.size} bytes=${sum(L0)} ${((t() - tl) / 1000).toFixed(1)}s`);
  for (let k = 1; k < LEVELS; k++) {
    tl = t(); const prev = lv[k - 1], cur = new Map();
    const keys = new Set(); for (const kk of prev.keys()) { const [x, y] = kk.split(',').map(Number); keys.add(key(x >> 1, y >> 1)); }
    await pool([...keys], 10, async (kk) => { const [tx, ty] = kk.split(',').map(Number);
      const getC = async (cx, cy, lossless) => { const c = prev.get(key(cx, cy)); if (!c) return null;
        if (lossless) return { w: c.w, raw: c.rawL }; const d = await dec(c.webp); return { w: d.info.width, raw: d.data }; };
      const kidsC = [[await getC(2 * tx, 2 * ty, false), await getC(2 * tx + 1, 2 * ty, false)], [await getC(2 * tx, 2 * ty + 1, false), await getC(2 * tx + 1, 2 * ty + 1, false)]];
      const pC = parentFrom(kidsC, k, tx);
      const entry = { w: pC.w, webp: await enc(pC.raw, pC.w, TH) };
      if (keepLossless) { const kidsL = [[await getC(2 * tx, 2 * ty, true), await getC(2 * tx + 1, 2 * ty, true)], [await getC(2 * tx, 2 * ty + 1, true), await getC(2 * tx + 1, 2 * ty + 1, true)]];
        const pL = parentFrom(kidsL, k, tx); entry.rawL = pL.raw; entry.webpL = await enc(pL.raw, pL.w, TH); }
      cur.set(kk, entry); });
    lv.push(cur);
    if (log) console.log(`k=${k} tiles=${cur.size} bytes=${sum(cur)} ${((t() - tl) / 1000).toFixed(1)}s`);
  }
  return lv;
}
function sum(m) { let s = 0; for (const v of m.values()) s += v.webp.length; return s; }

// incremental patch of song N onto a build of N-1 (strategy C: parents from published children)
async function patch(lv, N) {
  const col = (N - 1) % COLS, row = Math.floor((N - 1) / COLS);
  let tx = col >> 1, ty = row >> 1; const tile = level0Tile(tx, ty, N);
  lv[0].set(key(tx, ty), { w: tile.w, webp: await enc(tile.raw, tile.w, TH) });
  let written = 1;
  for (let k = 1; k < LEVELS; k++) { const ptx = tx >> 1, pty = ty >> 1, prev = lv[k - 1];
    const getC = async (cx, cy) => { const c = prev.get(key(cx, cy)); if (!c) return null; const d = await dec(c.webp); return { w: d.info.width, raw: d.data }; };
    const kids = [[await getC(2 * ptx, 2 * pty), await getC(2 * ptx + 1, 2 * pty)], [await getC(2 * ptx, 2 * pty + 1), await getC(2 * ptx + 1, 2 * pty + 1)]];
    const p = parentFrom(kids, k, ptx); lv[k].set(key(ptx, pty), { w: p.w, webp: await enc(p.raw, p.w, TH) }); written++; tx = ptx; ty = pty; }
  return written;
}
function psnr(a, b) { let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; } const mse = se / a.length; return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse); }

// 1) full build of N=5852, with lossless reference
let tb = t();
const full = await build(5852, { keepLossless: true, log: true });
console.log('full build (incl. lossless reference work)', ((t() - tb) / 1000).toFixed(1) + 's');
let total = 0, tiles = 0; for (const m of full) { total += sum(m); tiles += m.size; }
console.log('TOTAL tiles', tiles, 'bytes', total, (total / 1e6).toFixed(1) + ' MB', 'Q', Q);
// generation loss: decoded C vs lossless reference, decoded L-encoded vs lossless reference
for (let k = 1; k < LEVELS; k++) { let pc = [], pl = [];
  // sample up to 12 tiles per level
  const entries = [...full[k].values()].slice(0, 12);
  for (const e of entries) { const dc = await dec(e.webp), dl = await dec(e.webpL); pc.push(psnr(dc.data, e.rawL)); pl.push(psnr(dl.data, e.rawL)); }
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  console.log(`k=${k} PSNR vs lossless pyramid: chained=${avg(pc)}dB  direct=${avg(pl)}dB (n=${entries.length})`);
}
// level-0 PSNR (encode only)
{ const e = [...full[0].values()].slice(0, 12); const ps = []; for (const x of e) { const d = await dec(x.webp); ps.push(psnr(d.data, x.rawL)); }
  console.log('k=0 PSNR', (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2)); }
// write samples for eyeballing
fs.mkdirSync(OUT, { recursive: true });
for (const k of [0, 3, 6, 7]) { const [kk, v] = [...full[k].entries()][Math.floor(full[k].size / 2)]; fs.writeFileSync(path.join(OUT, `k${k}_${kk.replace(',', '_')}.webp`), v.webp); }

// 2) incremental equivalence: build(5851) + patch(5852) == build(5852)?  Also 5850 (mid tile) .
for (const N of [5852, 5800]) {
  const base = await build(N - 1);
  const tp = t(); const w = await patch(base, N); const dt = t() - tp;
  const ref = N === 5852 ? full : await build(N);
  let diff = 0, cmp = 0; for (let k = 0; k < LEVELS; k++) for (const [kk, v] of ref[k]) { cmp++; const o = base[k].get(kk); if (!o || Buffer.compare(o.webp, v.webp) !== 0) diff++; }
  console.log(`patch N=${N}: tiles written=${w}, ${dt.toFixed(0)}ms; compared ${cmp} tiles vs full build, mismatches=${diff}`);
}
