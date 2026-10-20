// Command-line options for pipeline/audit-archive.mjs.
import { parseArgs } from 'node:util';
import { ONLINE_DEFAULTS } from './online.mjs';

export const USAGE = `npm run archive:audit -- [options]

Read-only audit of every Song A Day piece: local files only unless --online.

  --from N           first song (default 1)
  --to N             last song (default: the highest WAV in the archive)
  --pieces a,b       catalog, meta, youtube, wav, mp3, video, gif, still, thumb, cell, art, mosaic
                     (default all; dependencies are added). With --online also ipfs, r2, ytlive.
  --deep             decode or probe every local file, not just a sample
  --sample F         share of local media to decode or probe without --deep (default 0.02)
  --out DIR          where the reports go (default output/audit)
  --catalog FILE     cached sheet catalog (default: the newest
                     $SONGADAY_TOOLKIT_DIR/output/youtube-description-audit-*/catalog.json)
  --concurrency N    parallel decodes and probes (default min(8, cores))
  --online           also run the online checks (Pinata gateway HEADs, R2 audio HEADs, YouTube oEmbed)
  --budget N         most HTTP requests --online may make, retries included (default ${ONLINE_DEFAULTS.budget})
  --strict           exit 2 when the wall has a gap (missing image, needed placeholder)
  --quiet            no progress lines
`;

const int = (name, v) => {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number, got ${v}`);
  return n;
};

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      pieces: { type: 'string' },
      deep: { type: 'boolean', default: false },
      sample: { type: 'string' },
      out: { type: 'string' },
      catalog: { type: 'string' },
      concurrency: { type: 'string' },
      online: { type: 'boolean', default: false },
      budget: { type: 'string' },
      strict: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  const sample = values.sample == null ? undefined : Number(values.sample);
  if (sample != null && !(sample > 0 && sample <= 1)) throw new Error(`--sample must be in (0, 1], got ${values.sample}`);
  const opts = {
    from: int('from', values.from),
    to: int('to', values.to),
    pieces: values.pieces ? values.pieces.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    deep: values.deep,
    sample,
    out: values.out,
    catalog: values.catalog,
    concurrency: int('concurrency', values.concurrency),
    online: values.online,
    budget: int('budget', values.budget) ?? ONLINE_DEFAULTS.budget,
    strict: values.strict,
    quiet: values.quiet,
    help: values.help,
  };
  if (opts.from != null && opts.to != null && opts.from > opts.to) throw new Error('--from is after --to');
  if (opts.pieces?.includes('all')) opts.pieces = undefined;
  return opts;
}
