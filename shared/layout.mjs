// Wall geometry, shared by the browser and the pipeline. Design A in docs/PLAN.md.
//
// Song n sits at col (n-1) % cols, row floor((n-1) / cols), row-major from the top left.
// The canvas is pre-allocated for capacityRows rows, so tile addresses never move.
// Our level k: 0 = full resolution, levels-1 = coarsest. OpenSeadragon level = levels-1-k.
// At level k a 960x540 tile covers 2^(k+1) x 2^(k+1) cells, so every song sits inside
// exactly one tile per level and adding a song changes exactly `levels` tiles.

export const WALL = Object.freeze({
  pyramid: 'p1',
  cols: 77,
  cellW: 480,
  cellH: 270,
  tileW: 960,
  tileH: 540,
  levels: 8,
  capacityRows: 256,
  ext: 'webp',
});

export const CANVAS_W = WALL.cols * WALL.cellW; // 36960
export const CAPACITY = WALL.cols * WALL.capacityRows; // 19712 songs

export const cellOf = (n) => ({ col: (n - 1) % WALL.cols, row: Math.floor((n - 1) / WALL.cols) });
export const songAt = (col, row) => row * WALL.cols + col + 1;
export const rowsFor = (songCount) => Math.ceil(songCount / WALL.cols);

export const osdLevel = (k) => WALL.levels - 1 - k;
export const ourLevel = (osd) => WALL.levels - 1 - osd;

// Cells per tile side at level k.
export const span = (k) => 2 ** (k + 1);

// Pixel width of the whole level (rounded up; OpenSeadragon crops to the exact width).
export const levelW = (k) => Math.ceil(CANVAS_W / 2 ** k);

// Tile grid at level k for the full pre-allocated canvas.
export const tileGrid = (k) => ({
  x: Math.ceil(WALL.cols / span(k)),
  y: Math.ceil(WALL.capacityRows / span(k)),
});

// Pixel size of tile (k, x, y). Height is always tileH; empty cells are black.
export const tileSize = (k, x) => ({ w: Math.min(WALL.tileW, levelW(k) - x * WALL.tileW), h: WALL.tileH });

export function tileCells(k, x, y) {
  const s = span(k);
  const c0 = x * s, r0 = y * s;
  return { c0, r0, c1: Math.min(c0 + s, WALL.cols) - 1, r1: Math.min(r0 + s, WALL.capacityRows) - 1 };
}

export function tileOfSong(k, n) {
  const { col, row } = cellOf(n);
  const s = span(k);
  return { x: Math.floor(col / s), y: Math.floor(row / s) };
}

// The `levels` tiles that contain song n, finest first.
export const tilesForSong = (n) => Array.from({ length: WALL.levels }, (_, k) => ({ k, ...tileOfSong(k, n) }));

// Newest song inside tile (k, x, y) when the wall holds songCount songs, or 0 if the tile is empty.
// Cells fill row-major, so this is computable from songCount alone. It versions the tile URL:
// a complete tile keeps one address forever; only the tiles holding the newest song change.
export function newestInTile(k, x, y, songCount) {
  if (songCount < 1) return 0;
  const { c0, c1, r0, r1 } = tileCells(k, x, y);
  if (c0 >= WALL.cols || r0 >= WALL.capacityRows) return 0;
  const { col: cl, row: rl } = cellOf(songCount);
  if (rl > r1) return songAt(c1, r1);
  if (rl >= r0 && cl >= c0) return songAt(Math.min(cl, c1), rl);
  if (rl > r0 && cl < c0) return songAt(c1, rl - 1);
  return 0;
}

// R2 key of tile (k, x, y). overrides["k/x_y"] = {v, rev} marks a tile rebuilt after an old cell was fixed;
// it applies only while the tile's newest song is still v.
export function tileKey(k, x, y, songCount, overrides = {}) {
  const v = newestInTile(k, x, y, songCount);
  if (!v) return null;
  const o = overrides[`${k}/${x}_${y}`];
  const rev = o && o.v === v && o.rev ? `-r${o.rev}` : '';
  return `wall/${WALL.pyramid}/${k}/${x}_${y}_${v}${rev}.${WALL.ext}`;
}

// Every non-empty tile at songCount, coarsest level last.
export function* existingTiles(songCount) {
  const rows = rowsFor(songCount);
  for (let k = 0; k < WALL.levels; k++) {
    const s = span(k);
    const nx = Math.ceil(WALL.cols / s), ny = Math.ceil(rows / s);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const v = newestInTile(k, x, y, songCount);
      if (v) yield { k, x, y, v };
    }
  }
}

// Declared image size for OpenSeadragon: the filled rows only, so home view isn't mostly black.
export const declaredSize = (songCount) => ({ width: CANVAS_W, height: rowsFor(songCount) * WALL.cellH });
