// Paths and settings for pipeline scripts. Reads the repo's .env (paths only) and then
// ~/.config/songaday-display/.env (credentials, kept outside Dropbox). Real env vars win.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const file of [path.join(REPO, '.env'), path.join(os.homedir(), '.config/songaday-display/.env')]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const home = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const opt = (name, fallback) => home(process.env[name]) || fallback;

export function need(name) {
  const v = home(process.env[name]);
  if (!v) throw new Error(`${name} is not set. Add it to .env (see .env.example).`);
  return v;
}

export const CACHE = opt('SONGADAY_DISPLAY_CACHE_DIR', path.join(os.homedir(), 'Library/Caches/songaday-display'));
export const PUBLISH = path.join(CACHE, 'publish');
export const STATE = path.join(CACHE, 'state');
export const CELLS = path.join(CACHE, 'cells/480x270');

export const archiveDir = () => need('SONGADAY_ARCHIVE_DIR');
export const toolkitDir = () => need('SONGADAY_TOOLKIT_DIR');
// Two different folders. The toolkit checkout's output/<n>/ holds the art, videos, metadata.json and
// the description audit; the toolkit's own SONGADAY_OUTPUT_DIR is where it writes each day's
// initial-metadata.json, and may be somewhere else entirely.
export const toolkitOutputDir = () => opt('SONGADAY_TOOLKIT_OUTPUT_DIR', path.join(toolkitDir(), 'output'));
export const outputDir = () => opt('SONGADAY_OUTPUT_DIR', toolkitOutputDir());
export const legacyMaster = () => need('SONGADAY_LEGACY_MASTER');
export const legacyJsonl = () => need('SONGADAY_LEGACY_JSONL');

// Dropbox online-only files show up as 0-byte files; reading them yields nothing.
export function isPlaceholder(file) {
  try {
    return fs.statSync(file).size === 0;
  } catch {
    return false;
  }
}
