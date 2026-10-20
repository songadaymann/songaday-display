// Screen-space math for one drawn frame. A frame is { ox, oy, s }: where the wall's top-left
// corner is on screen (CSS px, relative to the viewer element) and how many CSS px one wall
// pixel takes. Drawing and hit-testing both use the same frame, so the box is always on the
// cell the pointer is over.
import { WALL, CANVAS_W, cellOf, songAt, rowsFor } from '../../../shared/layout.mjs';

export const cellPx = (f) => WALL.cellW * f.s;

export function hitTest(f, p, songCount) {
  if (!p || !(f.s > 0)) return 0;
  const col = Math.floor((p.x - f.ox) / (WALL.cellW * f.s));
  const row = Math.floor((p.y - f.oy) / (WALL.cellH * f.s));
  if (col < 0 || col >= WALL.cols || row < 0) return 0;
  const n = songAt(col, row);
  return n <= songCount ? n : 0;
}

export function cellRect(n, f) {
  const { col, row } = cellOf(n);
  const w = WALL.cellW * f.s, h = WALL.cellH * f.s;
  return { x: f.ox + col * w, y: f.oy + row * h, w, h };
}

// Cells on screen: inclusive col/row ranges clipped to the filled rows, and how many songs that is.
export function visibleCells(f, width, height, songCount) {
  if (!(f.s > 0) || songCount < 1) return null;
  const w = WALL.cellW * f.s, h = WALL.cellH * f.s;
  const rows = rowsFor(songCount);
  // First cell whose right edge is past 0, last cell whose left edge is before the far side.
  const c0 = Math.max(0, Math.floor(-f.ox / w)), c1 = Math.min(WALL.cols - 1, Math.ceil((width - f.ox) / w) - 1);
  const r0 = Math.max(0, Math.floor(-f.oy / h)), r1 = Math.min(rows - 1, Math.ceil((height - f.oy) / h) - 1);
  if (c0 > c1 || r0 > r1) return null;
  return { c0, c1, r0, r1, count: countSongs(c0, c1, r0, r1, songCount) };
}

function countSongs(c0, c1, r0, r1, songCount) {
  const { col: cl, row: rl } = cellOf(songCount);
  const full = Math.max(0, Math.min(r1, rl - 1) - r0 + 1) * (c1 - c0 + 1);
  const last = rl >= r0 && rl <= r1 ? Math.max(0, Math.min(cl, c1) - c0 + 1) : 0;
  return full + last;
}

export function* songsIn(range, songCount) {
  if (!range) return;
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const n = songAt(c, r);
      if (n > songCount) return;
      yield n;
    }
  }
}

export function inRange(range, n) {
  if (!range) return false;
  const { col, row } = cellOf(n);
  return col >= range.c0 && col <= range.c1 && row >= range.r0 && row <= range.r1;
}

// Song n's cell in OpenSeadragon viewport units (the wall is 1 wide), grown by `pad` around its centre.
export function songViewportRect(n, pad = 1) {
  const { col, row } = cellOf(n);
  const w = WALL.cellW * pad, h = WALL.cellH * pad;
  const x = col * WALL.cellW - (w - WALL.cellW) / 2, y = row * WALL.cellH - (h - WALL.cellH) / 2;
  return { x: x / CANVAS_W, y: y / CANVAS_W, width: w / CANVAS_W, height: h / CANVAS_W };
}
