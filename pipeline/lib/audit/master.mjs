// The old gallery's full-resolution mosaic, the cell source for songs 1..count.
// One decode (shrink-on-load, about 3 s) gives every cell's mean brightness and its spread.
import sharp from 'sharp';
import { WALL, cellOf } from '../../../shared/layout.mjs';

// Samples per cell. 480/16 and 270/9 are both 30, so every sample is a whole 30x30 block.
const SX = 16, SY = 9;

export async function masterCells(file) {
  const meta = await sharp(file, { limitInputPixels: false }).metadata();
  const cols = meta.width / WALL.cellW;
  const rows = Math.floor(meta.height / WALL.cellH);
  if (cols !== WALL.cols || rows < 1) {
    throw new Error(`master is ${meta.width}x${meta.height}; expected ${WALL.cols * WALL.cellW} wide in ${WALL.cellW}x${WALL.cellH} cells`);
  }
  const w = cols * SX, h = rows * SY;
  // A partial last row is cropped off first; otherwise skip extract, which would turn off
  // JPEG shrink-on-load and quadruple the decode time.
  let img = sharp(file, { limitInputPixels: false });
  if (rows * WALL.cellH !== meta.height) img = img.extract({ left: 0, top: 0, width: meta.width, height: rows * WALL.cellH });
  const data = await img
    .resize(w, h, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  const count = cols * rows;
  const luma = new Float32Array(count + 1);
  const sd = new Float32Array(count + 1);
  const k = SX * SY;
  for (let n = 1; n <= count; n++) {
    const { col, row } = cellOf(n);
    let s = 0, s2 = 0;
    for (let y = 0; y < SY; y++) for (let x = 0; x < SX; x++) {
      const v = data[(row * SY + y) * w + col * SX + x];
      s += v;
      s2 += v * v;
    }
    luma[n] = s / k;
    sd[n] = Math.sqrt(Math.max(0, s2 / k - luma[n] * luma[n]));
  }
  return { width: meta.width, height: meta.height, count, luma, sd };
}
