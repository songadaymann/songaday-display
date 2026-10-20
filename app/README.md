# Gallery app

The zoomable wall of every Song A Day song: vanilla ES modules, Vite, OpenSeadragon 6.1.1. The design is `docs/research/design-static-preallocated.md` §5. The data it reads is described in `shared/README.md`.

## Run it

```sh
npm run dev       # http://localhost:5173, media from $SONGADAY_DISPLAY_CACHE_DIR/publish at /media
npm run build     # dist/, served by the Worker
npm test          # includes app/src/core/*.test.mjs
```

- `VITE_MEDIA_BASE` sets where the wall, GIFs and catalog come from. Unset, it is `/media` in dev and `https://tiles.songaday.world` in a build, so a fresh clone and every deploy work with no setup.
- In dev, `/media/*` is served from the local publish folder by `vite.config.mjs`. Anything not there redirects: GIFs 1–5854 to the old Azure copy, everything else to `https://tiles.songaday.world`. So `npm i && npm run dev` with an empty cache shows the public wall.
- An inline script in `<head>` (injected by `vite.config.mjs`) starts the `wall/current.json` fetch while the app code downloads; `src/data/manifest.js` reuses it.
- Changed stills and GIFs live at `-r<rev>` keys named by the manifest (`stillRev`, `gifRev`); `main.js` builds their URLs from the current manifest. A manifest for another pyramid or schema reloads the page instead of being applied.
- Open the page with `?crypto=1` to load the crypto module without a wallet, `?crypto=0` to hide it, and `?crypto=auto` to go back to detection.
- In dev, `window.__gallery` holds `{ gallery, catalog }` for poking at from the console.

## Layout

| Path | What |
| --- | --- |
| `src/main.js` | Boot and wiring: manifest, then the viewer. `wall.json` (a cross-check only) and the catalog chunks load in parallel; the embed skips the catalog. |
| `src/core/` | Pure modules with tests: frame math and hit-testing, tile source, search, filters, previews, dates, URL parsing |
| `src/viewer/` | OpenSeadragon setup, the overlay canvas (hover box, masks, outlines) and the GIF layer |
| `src/ui/` | Dialog, search box, Explore drawer, left panel, toolbar |
| `src/data/` | Manifest and catalog loading |
| `src/lib/` | Wallet gate (copied from the `crypto-wallet-gate` skill) and safe `localStorage` |
| `src/crypto/` | Wallet-only features, loaded with `import()`. Its `README.md` documents the `ctx` interface. |

## URLs

- `/`, plus `/embed`, `/embed/` and `?embed=1` for the chromeless embed. The embed keeps OpenSeadragon's default gestures, as the old one did (mouse and pen: click zooms 2×; touch: double-tap zooms), and a small link opens the hovered song in the full gallery. On the page, a click opens the song after 300 ms unless a second click (a double click, which zooms) or a drag comes first.
- `?song=N` or `?date=YYYY-MM-DD` flies to a song and opens it. The URL tracks the open song.
- The old viewport parameters `zoom`, `x`, `y`, `minZoom`, `maxZoom` and `bounds=x,y,w,h` work in every mode. They are in OpenSeadragon viewport units, and `bounds` wins. `minZoom` and `maxZoom` apply on their own too.
