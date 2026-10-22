# Song A Day Display

Ways of looking at Song A Day, the song Jonathan Mann has written and recorded every day since January 1, 2009.

The first display is a rebuilt deep-zoom gallery: every song's video still in one zoomable wall, built with OpenSeadragon. It replaces [song-a-day-gallery](https://github.com/songadaymann/song-a-day-gallery). It's served from Cloudflare, loads in a handful of large tiles instead of hundreds of small ones, and adds each day's new song by rewriting 8 tiles instead of rebuilding the wall.

**Status:** live. New songs are added with `npm run wall:add` and `npm run r2:sync` until the songaday-toolkit runs that step each day. The wallet-only panels (For Sale, Sales, Collectors) stay hidden until the Worker's OpenSea and RPC keys are set. Design notes and the full plan will be added under `docs/`.

**Live:** [gallery.songaday.world](https://gallery.songaday.world). Media is at [`tiles.songaday.world`](https://tiles.songaday.world/wall/current.json) (start from `wall/current.json`).

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
```

With nothing else set up, the page reads the published wall from `https://tiles.songaday.world` (once it exists). To build the wall yourself you need the Song A Day archive: copy `.env.example` to `.env`, fill in the paths, then:

```bash
npm run cells:import     # one 480x270 image per song, from the archive
npm run catalog:build    # titles, dates, traits and descriptions
npm run wall:build       # the tile pyramid (about 2,240 WebP tiles, 180 MB)
npm run wall:manifest
npm run wall:verify      # checks a one-song patch matches a full build, byte for byte
npm run wall:add -- --song-id 6503   # the daily step: adds one song, 8 tiles
npm run archive:audit    # what's missing or broken in the archive (reports in output/audit/)
```

Publishing to Cloudflare R2 (the buckets `songaday-display-media`, public as `tiles.songaday.world`, and `songaday-display-archive`, private):

```bash
npm run r2:sync          # upload what wall:add queued, wall/current.json last (--all: everything)
npm run r2:check         # HEAD every live object through tiles.songaday.world (--cors: the CORS test)
npm run wall:rollback -- --to 6501   # put an earlier manifest back live
```

Uploads use an R2 token from `~/.config/songaday-display/.env` if there is one (see `.env.example`), otherwise your `wrangler login`. `tiles.songaday.world` sits behind a small Worker that adds the CORS header to every response ([worker/README.md](worker/README.md)).

Generated files go in `~/Library/Caches/songaday-display` (override with `SONGADAY_DISPLAY_CACHE_DIR`), never in the repo.

The Worker (`worker/`) serves the built app and the crypto API. See [worker/README.md](worker/README.md) for `npm run dev:worker`, `.dev.vars`, and `wrangler secret put`.

## Daily step

`pipeline/daily.mjs` runs `wall:add` and then `r2:sync`, for the toolkit's hook and for cron:

```bash
npm run daily -- --song-id 6504 --json     # one song and any missing before it, then upload
npm run daily:catch-up -- --json           # the newest ready songs, late GIFs, leftover uploads
npm run daily:catch-up -- --dry-run --json # what it would do; runs and writes nothing
```

- Songs past the wall go up in order, each only when its inputs are ready. That means a real still in `EverySongADayPNG` (a 0-byte Dropbox placeholder doesn't count), an `initial-metadata.json` that parses and has the song's number and date, and a YouTube URL in it. Without a YouTube URL a song goes up once the still is 2 hours old. Until then the status is `waiting`, and catch-up retries later.
- `--song-id N` checks every song between the wall and N the same way. If one before N isn't ready, N is `waiting` too (`blockedBy` names it), and only the ready songs before that one go up.
- A song that still isn't ready a day after its first file turned up goes up anyway, so one song can't hold up the wall. That covers a manual add with no `initial-metadata.json`, and a still that's online-only or doesn't decode. wall-add then uses its fallbacks: a video frame, the art or a card, and `metadata.json` or just the title and date. A song with no files at all goes up the same way a day after its date ends, but only to fill a hole under a later song. The line lists these songs in `fallback`.
- Only one run at a time (`daily.lock` in the cache folder). A second run waits 15 s (`--wait`) and then reports `busy`.
- It prints one line, which is JSON with `--json`: `{status, songId, songCount, tilesWritten, uploaded, ms, error?}`, plus `reason`, `added`, `published`, `fallback` and `warnings` when they apply. Status is `added`, `already-current`, `waiting`, `busy` or `failed`. The result is also saved in the cache folder, in `state/daily/last.json` and `state/daily/<n>.json` for each song it's about, for the toolkit's Upload Song page. Once a song is published its file says so (`publishedAt`), and later runs only add `lastRun`. When a catch-up uploads what an earlier run left in the queue, that run's songs are marked published. Busy runs and dry runs write no file.
- Exit codes: 0 done; 1 failed; 3 uploaded, but the public check failed (see `npm run r2:check`). With `--song-id`, 4 means the song is waiting and 5 means busy: it isn't on the wall yet. Catch-up exits 0 for both.
- A GIF that's already in the publish folder while the manifest still lists the song in `noGif` (after `pipeline/gifs-index.mjs`, say) shows up in `warnings`: run `npm run wall:manifest`, then `npm run r2:sync -- --all`.
- From cron, use node's full path, because cron's PATH is minimal: `*/30 * * * * cd /path/to/songaday-display && /path/to/node pipeline/daily.mjs --catch-up >> ~/Library/Logs/songaday-display-daily.log 2>&1`. Each run logs one line.

## How it's built

- `shared/layout.mjs`: the wall's geometry and tile addresses, used by both the browser and the scripts. The JSON formats are in [shared/README.md](shared/README.md).
- `pipeline/`: Node scripts using sharp to import cells, build and patch the pyramid, build the catalog, and audit the archive.
- `app/`: the gallery, in plain JavaScript with Vite and OpenSeadragon 6.1.1. See [app/README.md](app/README.md).
- `worker/`: a Cloudflare Worker that serves the app and keeps the OpenSea and RPC keys on the server.

Crypto features (listings, sales, collectors, OpenSea links) appear only when the visitor's browser has a wallet installed. Everyone else gets the gallery without them.

## License

Code: [MIT](LICENSE). Art, music, and other media: see [ASSETS.md](ASSETS.md).

Made by [Jonathan Mann](https://jonathanmann.net) (Song A Day).
