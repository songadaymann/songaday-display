// Which songs get an animated preview this frame.
//   off     nothing
//   hover   the hovered song, once its cell is at least HOVER_MIN_PX wide
//   nearby  hover, plus every visible song when NEARBY_MAX or fewer are on screen
import { songsIn } from './frame.js';

export const MODES = ['off', 'hover', 'nearby'];
export const NEARBY_MAX = 48;
export const HOVER_MIN_PX = 60;

export function previewSongs(mode, { range, hover, cellPx, songCount, noGif }) {
  if (mode !== 'hover' && mode !== 'nearby') return [];
  const out = [];
  const ok = (n) => n >= 1 && n <= songCount && !noGif.has(n);
  if (hover && cellPx >= HOVER_MIN_PX && ok(hover)) out.push(hover);
  if (mode === 'nearby' && range && range.count <= NEARBY_MAX) {
    for (const n of songsIn(range, songCount)) if (n !== hover && ok(n)) out.push(n);
  }
  return out;
}

export const nextMode = (mode) => MODES[(MODES.indexOf(mode) + 1) % MODES.length];
