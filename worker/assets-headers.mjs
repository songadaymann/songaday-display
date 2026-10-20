// Wrangler's custom build step (wrangler.jsonc "build"): runs before `wrangler dev` and
// `wrangler deploy`. It checks the Vite build exists and writes dist/_headers, which the
// static-asset layer applies to files it serves. Vite puts content-hashed files under
// /assets/, so they can be cached for a year; index.html keeps the default revalidation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

export const HEADERS = `# Written by worker/assets-headers.mjs before each wrangler dev/deploy. Don't edit here.
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error('dist/index.html is missing. Run `npm run build` first.');
    process.exit(1);
  }
  fs.writeFileSync(path.join(dist, '_headers'), HEADERS);
  console.log('wrote dist/_headers');
}
