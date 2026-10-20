// The wall as OpenSeadragon sees it, built from the manifest. All tile math is in shared/layout.mjs;
// this only maps OpenSeadragon levels onto it. OSD level L is our level k = levels-1-L.
import { WALL, declaredSize, tileKey, newestInTile, ourLevel } from '../../../shared/layout.mjs';

export function wallSource(manifest, mediaUrl) {
  const { songCount } = manifest;
  const overrides = manifest.overrides || {};
  return {
    ...declaredSize(songCount), // the filled rows only, so home isn't mostly black
    tileWidth: WALL.tileW,
    tileHeight: WALL.tileH,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: WALL.levels - 1,
    getTileUrl(level, x, y) {
      const key = tileKey(ourLevel(level), x, y, songCount, overrides);
      // OSD asks for a URL even for tiles it won't load; give empty ones a unique address it never fetches.
      return mediaUrl(key || `wall/none/${level}/${x}_${y}`);
    },
    hasTile: (level, x, y) =>
      level >= 0 && level < WALL.levels && x >= 0 && y >= 0 && newestInTile(ourLevel(level), x, y, songCount) > 0,
  };
}

const sameOverrides = (a = {}, b = {}) => JSON.stringify(a) === JSON.stringify(b);

// Does moving from manifest a to b change any tile address?
export const tilesChanged = (a, b) =>
  a.songCount !== b.songCount || a.pyramid !== b.pyramid || !sameOverrides(a.overrides, b.overrides);

export function manifestProblems(m) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['not an object'];
  if (m.schema !== 1) problems.push(`schema ${m.schema} (expected 1)`);
  if (!Number.isInteger(m.songCount) || m.songCount < 1) problems.push(`songCount ${m.songCount}`);
  if (m.pyramid !== WALL.pyramid) problems.push(`pyramid ${m.pyramid} (this page knows ${WALL.pyramid})`);
  return problems;
}

// A manifest for another pyramid (wall/p2/ after a layout change) or schema needs newer app code:
// this page's geometry and tile keys are p1's, so it must reload rather than apply it.
export const needsNewApp = (m) => Boolean(m && typeof m === 'object' && (m.schema !== 1 || m.pyramid !== WALL.pyramid));

// Keys of wall.json that disagree with shared/layout.mjs (empty when the page and the pyramid match).
export function wallMismatch(wall) {
  if (!wall || typeof wall !== 'object') return [];
  const src = wall.wall && typeof wall.wall === 'object' ? wall.wall : wall;
  return ['cols', 'cellW', 'cellH', 'tileW', 'tileH', 'levels', 'capacityRows'].filter(
    (k) => src[k] !== undefined && src[k] !== WALL[k],
  );
}
