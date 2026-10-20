# Benchmarks

Throwaway scripts behind the numbers in `docs/research/design-static-preallocated.md` §0 and the calendar design (`design-calendar-layout.md`). They were written in a research session's scratchpad and copied here so the measurements can be repeated. They are not part of the pipeline: the real code is `pipeline/lib/tiles.mjs` and `pipeline/lib/cells.mjs`, and `npm run wall:verify` is the check that matters.

None of them upload anything or read Dropbox online-only files. Run them from a scratch directory (some write into the current directory), with paths from your `.env`:

```sh
set -a; . ./.env; set +a          # SONGADAY_* paths; the scripts don't read .env themselves
mkdir -p ~/Library/Caches/songaday-display/bench && cd ~/Library/Caches/songaday-display/bench
```

## Scripts

| Script | What it measures | Inputs (env) | Writes |
| --- | --- | --- | --- |
| `pyramid-bench.mjs` | Full 960x540 WebP pyramid from the real 36,960 x 20,520 master (songs 1-5852), tile by tile with the 2x2 box filter. Compares parents built from published (lossy) children with parents built from lossless children, and checks that building N-1 then patching N is byte-identical to building N (N = 5852 and 5800). Prints per-level tiles, bytes and seconds, PSNR per level, and the patch time. | `SHARP_FROM`, `MASTER`, `OUT`, `Q` (default 80), `SMART=1` for `smartSubsample` | 4 sample tiles in `OUT` |
| `quality-sweep.mjs` | Codec and quality per level: builds a lossless box pyramid of the whole master, then encodes 10 sample tiles at k0, k1, k3 and k5 with WebP q75-q90 (with and without smart subsampling), mozjpeg and AVIF. Prints KB per tile, PSNR and encode time. | `SHARP_FROM`, `MASTER` | nothing |
| `cells.mjs` | Lossless WebP vs JPEG q95 size for 40 cells cut from the master, and the scan for cells with mean luma under 12/255 (the "dark" list). | `SHARP_FROM`, `MASTER` | nothing |
| `cells2.mjs` | The same size comparison for songs 1000, 3000, 4500 and 5800, one crop each. | `SHARP_FROM`, `MASTER` | `cell<n>.png` in the current directory |
| `geom.py` | Pure arithmetic for the 77-column wall: capacity and its last date, tiles per level today and at capacity, a brute-force check of the tile-version formula and "one tile per level per day" for songs 6400-7299, and home-view tile counts. | none | nothing |
| `geom-calendar.py` | The same kind of arithmetic for the calendar layout (Design B): year-block sizes, tiles touched per daily add, world sizes. | none | nothing |
| `yearbench.py` | Design B's year pyramid: 12 x 31 cells for one year, joined and tiled with `vips dzsave`. Prints cell, join and tiling times and per-level sizes. | `SONGADAY_ARCHIVE_DIR`; optional `BENCH_DIR`, `SONGADAY_DISPLAY_CACHE_DIR`, `STANDARDIZED_THUMBS_DIR`. Needs `vips` on `PATH`. | `$BENCH_DIR` (default `$SONGADAY_DISPLAY_CACHE_DIR/bench`): `cells_<w>x<h>/`, `out/<name>/` |

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `SHARP_FROM` | the `.mjs` scripts | A directory whose `node_modules` holds sharp. The repo root works (`SHARP_FROM=$PWD` from the repo). The original numbers used sharp 0.33.5; the pipeline pins 0.35.5, so byte sizes can differ slightly. |
| `MASTER` | the `.mjs` scripts | The old mosaic master, the same file as `SONGADAY_LEGACY_MASTER` (`level_7_master.jpg`, 247 MB, must be a real local file). Decoding it takes about 4 s and 2.3 GB of RAM. |
| `OUT` | `pyramid-bench.mjs` | Directory for the sample tiles. Keep it outside the repo. |
| `Q`, `SMART` | `pyramid-bench.mjs` | WebP quality (default 80) and `SMART=1` for smart chroma subsampling. Production is q85 with smart subsampling. |
| `UV_THREADPOOL_SIZE` | the `.mjs` scripts | libuv's pool size caps how many sharp jobs run at once (default 4). Set it to the core count to match the pipeline, which re-runs itself with it set. |
| `SONGADAY_ARCHIVE_DIR` | `yearbench.py` | The "Every Single Song A Day Ever" folder; stills come from its `EverySongADayPNG/`. |
| `BENCH_DIR`, `SONGADAY_DISPLAY_CACHE_DIR` | `yearbench.py` | Where it writes. Defaults to `~/Library/Caches/songaday-display/bench`. |
| `STANDARDIZED_THUMBS_DIR` | `yearbench.py` | Optional fallback stills (`python_scripts/standardized_thumbnails`). Its 5984-6000 are one repeated stand-in image, so the pipeline never uses it. |

## Examples

```sh
# Full pyramid, production settings (about 40 s and 6 GB of RAM on a 10-core Mac)
UV_THREADPOOL_SIZE=10 SHARP_FROM="$OLDPWD" MASTER="$SONGADAY_LEGACY_MASTER" OUT=./pyramid Q=85 SMART=1 \
  node "$OLDPWD/pipeline/bench/pyramid-bench.mjs"

python3 "$OLDPWD/pipeline/bench/geom.py"
python3 "$OLDPWD/pipeline/bench/yearbench.py" 2025 6501 y2025
```

(`$OLDPWD` is the repo, after the `cd` above.)
