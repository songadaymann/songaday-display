// Directory scans: one readdir and one stat per file, plus one `find` per folder to spot Dropbox
// placeholders by their marker. Nothing here opens a file, so a scan never triggers a download.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Legacy Smart Sync leaves online-only files at 0 bytes with a com.dropbox.placeholder xattr.
// File Provider marks them dataless instead (real size, no data). Both count.
// Returns null where BSD find isn't available; callers then treat every 0-byte file as one.
export async function placeholderSet(dir, depth = 1) {
  if (!fs.existsSync(dir)) return new Set();
  try {
    const { stdout } = await run('/usr/bin/find', [
      dir, '-maxdepth', String(depth), '-type', 'f',
      '(', '(', '-size', '0', '-xattrname', 'com.dropbox.placeholder', ')', '-o', '-flags', '+dataless', ')',
      '-print0',
    ], { maxBuffer: 1 << 28 });
    return new Set(stdout.split('\0').filter(Boolean).map((p) => path.resolve(p)));
  } catch {
    return null;
  }
}

const record = (file, st, n, ph) => ({
  n,
  name: path.basename(file),
  path: file,
  ext: path.extname(file).slice(1).toLowerCase(),
  size: st.size,
  mtimeMs: st.mtimeMs,
  placeholder: ph ? ph.has(file) : st.size === 0,
});

// Files named after a song number. `pattern`'s first group is the number.
// Returns {dir, exists, byN: Map<n, record[]>, other: [name]}.
export async function scanSongFiles(dir, { pattern = /^0*(\d+)\.[a-z0-9]+$/i } = {}) {
  const out = { dir, exists: fs.existsSync(dir), byN: new Map(), other: [] };
  if (!out.exists) return out;
  const ph = await placeholderSet(dir);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    const m = pattern.exec(ent.name);
    if (!m) {
      out.other.push(ent.name);
      continue;
    }
    const file = path.resolve(dir, ent.name);
    const rec = record(file, fs.statSync(file), Number(m[1]), ph);
    if (!out.byN.has(rec.n)) out.byN.set(rec.n, []);
    out.byN.get(rec.n).push(rec);
  }
  return out;
}

// The toolkit's output/<n>/ folders. Returns Map<n, Map<fileName, record>>.
export async function scanOutputDirs(root) {
  const out = new Map();
  if (!root || !fs.existsSync(root)) return out;
  const ph = await placeholderSet(root, 2);
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
    const n = Number(ent.name);
    const files = new Map();
    for (const f of fs.readdirSync(path.join(root, ent.name), { withFileTypes: true })) {
      if (!f.isFile() || f.name.startsWith('.')) continue;
      const file = path.resolve(root, ent.name, f.name);
      files.set(f.name, record(file, fs.statSync(file), n, ph));
    }
    out.set(n, files);
  }
  return out;
}

// Stat one file outside the per-song folders (the legacy master, a jsonl).
export async function statOne(file) {
  if (!file || !fs.existsSync(file)) return null;
  const ph = await placeholderSet(path.dirname(file));
  const abs = path.resolve(file);
  return record(abs, fs.statSync(abs), 0, ph);
}
