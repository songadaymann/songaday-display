# Song A Day Display

Ways of looking at Song A Day, the song Jonathan Mann has written and recorded every day since January 1, 2009.

The first display is a rebuilt deep-zoom gallery: every song's video still in one zoomable wall, built with OpenSeadragon. It replaces [song-a-day-gallery](https://github.com/songadaymann/song-a-day-gallery). It's served from Cloudflare, loads in a handful of large tiles instead of hundreds of small ones, and adds each day's new song by rewriting 8 tiles instead of rebuilding the wall.

**Status:** the wall (all 6,502 songs), its stills, GIFs and catalog are published at `https://tiles.songaday.world`. The gallery app itself isn't deployed yet. Design notes and the full plan will be added under `docs/`.

**Live:** media at [`tiles.songaday.world`](https://tiles.songaday.world/wall/current.json) (start from `wall/current.json`). The gallery will move to `gallery.songaday.world`.

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

## How it's built

- `shared/layout.mjs`: the wall's geometry and tile addresses, used by both the browser and the scripts. The JSON formats are in [shared/README.md](shared/README.md).
- `pipeline/`: Node scripts using sharp to import cells, build and patch the pyramid, build the catalog, and audit the archive.
- `app/`: the gallery, in plain JavaScript with Vite and OpenSeadragon 6.1.1. See [app/README.md](app/README.md).
- `worker/`: a Cloudflare Worker that serves the app and keeps the OpenSea and RPC keys on the server.

Crypto features (listings, sales, collectors, OpenSea links) appear only when the visitor's browser has a wallet installed. Everyone else gets the gallery without them.

## License

Code: [MIT](LICENSE). Art, music, and other media: see [ASSETS.md](ASSETS.md).

Made by [Jonathan Mann](https://jonathanmann.net) (Song A Day).
