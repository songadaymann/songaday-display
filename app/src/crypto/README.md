# Crypto module

The For Sale, Recent Sales and Collectors panels and the "View on OpenSea" link live here, and nowhere else in the app.

## When it loads

`app/src/main.js` calls `applyWalletGate()` at startup without waiting for it. When the result has `hasWallet: true` and the page isn't the embed (`/embed`, `?embed=1`), it runs `import('./crypto/index.js')` and calls `init(ctx)` once.

- Visitors without a wallet never download this code. Embed visitors don't either, and the embed doesn't even run wallet detection.
- `?crypto=1` forces it on, `?crypto=0` forces it off, and `?crypto=auto` goes back to detection (remembered in `localStorage`, see `app/src/lib/wallet-gate.js`).
- Anything this module adds to the page must carry `data-crypto`. The CSS hides `[data-crypto]` unless `<html data-wallet="yes">`, so nothing flashes.

## Rules

- Call only the Worker's `/api/*` routes (`/api/market/summary`, `/api/market/listings`, `/api/market/sales`, `/api/holders`, `/api/ens`). Never call OpenSea, Etherscan, an RPC or Algolia from the browser, and never put a key in a `VITE_` variable.
- Fetch nothing until `init` runs. Don't fetch on page load "just in case": fetch when a panel opens, apart from the one cached For Sale count.
- Without data (a 503 or an error), hide the button instead of showing "N/A".

## `init(ctx)`

`ctx` is a plain object. Every function in it works as soon as `init` is called; the catalog may still be loading, so wait for `ctx.catalogReady` before reading every song.

| Member | What it does |
| --- | --- |
| `viewer` | The OpenSeadragon 6.1.1 viewer. Read-only use; don't add handlers you don't remove. |
| `getSong(n)` | Catalog index entry `{ n, t, d, yt, a }` (see `shared/README.md`), or `null`. |
| `allSongs()` | Every loaded entry, sorted by `n`. Frozen; don't mutate it. |
| `catalogReady` | Promise that settles when the first catalog load is done. |
| `songCount()` | Songs on the wall right now (grows when a new manifest arrives). |
| `mediaUrl(path)`, `gifUrl(n)`, `stillUrl(n)` | URLs on the media host. `stillUrl` is the 480x270 cell image, good for list thumbnails. |
| `flyTo(n)` | Animate the wall to song `n` and put the highlight box on it. Returns `false` if `n` isn't on the wall. |
| `setFocus(n)` | Put the highlight box on `n` without moving (0 clears it). |
| `openSong(n)` | Fly to `n` and open its dialog. |
| `setMask(set \| null, style?)` | Dim every song **not** in `set` (a `Set` or array of song numbers). `style.color` is the dim colour, default `rgba(0,0,0,0.6)`. `null` removes it. It's one bitmap with a pixel per song, drawn once per frame, so any size is fine. It stacks with the Explore filter mask. |
| `setOutlines(set \| null, style?)` | Outline the visible songs in `set`. `style.color` defaults to `#4CAF50`. `null` removes them. |
| `addToolbarButton({ id, label, icon, onClick })` | Add a top-bar button (it gets `data-crypto`). `icon` is optional: a DOM node or a short string. Returns the `<button>`, so you can update its text, for example a For Sale count. |
| `openPanel(title, contentEl, { onClose }?)` | Show `contentEl` in the left sidebar. Returns `{ el, close(), setTitle(text) }`. `onClose` runs when it's closed or replaced (use it to clear your mask and outlines). |
| `closePanel()` | Close the left sidebar. |
| `bindRow(el, n)` | Make `el` (ideally a `<button>`) a song row: hover or focus flies to `n`, click opens it. Returns `el`. |
| `onModalOpen(cb)` | `cb(n, slotEl)` runs each time a song's dialog opens. `slotEl` is an empty `[data-crypto]` element under the traits; put the OpenSea link there. Returns an unsubscribe function. |

## What's here

| File | What |
| --- | --- |
| `index.js` | `init(ctx)`: the Sales, Collectors and For Sale (N) buttons, and the dialog's crypto row |
| `panels.js` | The three sidebar views. Each fetches when opened, outlines its songs and dims the rest, and clears that on close. |
| `dom.js` | Rows (still, title, date, value), notes, and addresses that switch to ENS names when known |
| `api.js` | `/api/*` calls, memoized per page; ENS lookups in batches of 50 |
| `format.js` | Prices (BigInt, no float rounding), short addresses, "3d ago", OpenSea URLs, the holders index. Tested in `format.test.mjs`. |
| `crypto.css` | Panel styles, loaded with this chunk only |

Behaviour:

- On `init` it fetches only `/api/market/summary`. If that works, **Sales** and **For Sale (N)** appear; if not, they're removed. **Collectors** shows at once and fetches `/api/holders` on click. A 404 or 503 there removes the button.
- **Dialog row:** "View on OpenSea" appears only for minted songs. Minted means `/api/holders` saw an owner, or the song was seen listed or sold. The row also shows the owner (ENS name when there is one, with "see all N" opening their songs) and the price if the song is listed. The contract address comes from the API responses, never from this bundle.
- **Deep links:** a `?song=` dialog can open before this chunk loads, and `onModalOpen` doesn't replay it. So `init` fills an already-open dialog itself, reading the song from the URL. That can go once the hook replays.
- **CSS:** the gate's `display: revert !important` would make the toolbar buttons plain inline-blocks and override `[hidden]`. `crypto.css` restores `inline-flex` and hiding for wallet visitors.
- **Response shapes:** see `worker/README.md`.
