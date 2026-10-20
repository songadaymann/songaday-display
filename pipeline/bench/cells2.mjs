import { createRequire } from 'node:module';
const require = createRequire(process.env.SHARP_FROM + '/'); const sharp = require('sharp');
const W0 = 36960, CW = 480, CH = 270, COLS = 77;
const sizes = { ll: [], jq: [] };
for (const n of [1000, 3000, 4500, 5800]) {
  const c = (n - 1) % COLS, r = Math.floor((n - 1) / COLS);
  const b = await sharp(process.env.MASTER, { limitInputPixels: false }).extract({ left: c * CW, top: r * CH, width: CW, height: CH }).raw().toBuffer();
  const s = () => sharp(b, { raw: { width: CW, height: CH, channels: 3 } });
  const ll = await s().webp({ lossless: true, effort: 4 }).toBuffer(), jq = await s().jpeg({ quality: 95 }).toBuffer();
  await s().png().toFile(`cell${n}.png`);
  console.log(n, 'lossless', ll.length, 'jpeg95', jq.length);
}
