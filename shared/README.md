# Shared contracts

Everything the pipeline writes and the viewer reads. `layout.mjs` holds the geometry and is imported by both sides; this file describes the JSON.

## Media layout

The public media root (`MEDIA_BASE`) has the same layout locally (`$SONGADAY_DISPLAY_CACHE_DIR/publish/`) and on R2 (`https://tiles.songaday.world`):

| Path | What | Cache |
| --- | --- | --- |
| `wall/current.json` | Manifest. The only file that changes in place. Fetch with `cache: 'no-cache'`. | `max-age=60` |
| `wall/manifests/<songCount>-<hash8>.json` | Immutable copy of each manifest version, for rollback. `hash8` is the first 8 hex digits of the SHA-256 of its bytes, so a manifest that changes at the same `songCount` (a fix, a catalog refresh) gets a new key. | immutable |
| `wall/p1/wall.json` | Pyramid descriptor: the `WALL` constants plus per-level codec settings and builder version | immutable |
| `wall/p1/<k>/<x>_<y>_<v>[-r<rev>].webp` | Tiles, keys from `tileKey()` | immutable |
| `stills/<n>[-r<rev>].webp` | The song's 480x270 cell image, public, for other displays. `rev` is the manifest's `stillRev[n]`; no suffix when it's 0. | immutable |
| `gifs/<n>[-r<rev>].gif` | Animated preview, 320x180. `rev` is the manifest's `gifRev[n]`; no suffix when it's 0. | immutable |
| `meta/index-<chunk>-<hash>.json` | Catalog index chunk (search and filters) | immutable |
| `meta/detail-<chunk>-<hash>.json` | Catalog detail chunk (modal text) | immutable |

No key ever gets new bytes once written: a changed tile, still or GIF gets the next `-r<rev>` key, and the manifest names it.

## Manifest (`wall/current.json`)

```json
{
  "schema": 1,
  "pyramid": "p1",
  "songCount": 6502,
  "updatedAt": "2026-10-20T21:35:00.000Z",
  "overrides": { "0/38_42": { "v": 6502, "rev": 1 } },
  "missingArt": [6000],
  "noGif": [940, 5832],
  "stillRev": { "143": 1 },
  "gifRev": { "1": 1 },
  "catalog": {
    "schema": 1,
    "chunkSize": 500,
    "index": ["meta/index-0-3f2a9c1b.json"],
    "detail": ["meta/detail-0-77e0b2aa.json"]
  }
}
```

- `songCount`: songs 1..songCount are on the wall. Rows fill row-major, so tile versions follow from it.
- `overrides`: tiles rebuilt after an old cell was fixed (see `tileKey`).
- `missingArt`: songs showing a generated card instead of a frame.
- `noGif`: songs without an animated preview. The viewer shows the still instead.
- `stillRev`, `gifRev`: songs whose still or GIF changed since it was first published, and its current revision. Missing means revision 0.
- `catalog.index[i]` and `catalog.detail[i]` cover songs `i*chunkSize+1 .. (i+1)*chunkSize`.

## Catalog index chunk

```json
{
  "schema": 1,
  "from": 1,
  "to": 500,
  "songs": [
    { "n": 1, "t": "In the Time of the Gods", "d": "2009-01-01", "yt": "v6Lk_OP4ZKc",
      "a": { "Location": "Los Angeles", "Topic": ["Poetic"], "Instrument": ["Baritone Ukulele"], "Mood": "Pensive" } }
  ]
}
```

- `n` song number, `t` title, `d` ISO date, `yt` YouTube video ID (or `null` when there's no public video).
- `a` traits: display name to a string, or to an array of strings for multi-valued traits (Instrument, Style, Topic, Noun, Proper Noun). The viewer builds its filter list from whatever traits appear, so new traits need no viewer change.
- No crypto fields here. Token, owner and market data come only from the Worker's `/api/*` for wallet visitors.

## Catalog detail chunk

```json
{ "schema": 1, "from": 1, "to": 500, "songs": [ { "n": 1, "description": "…" } ] }
```

`description` is `null` rather than the NFT collection's stock text, or any text more than 3 songs share.

Loaded only when a song's modal opens.
