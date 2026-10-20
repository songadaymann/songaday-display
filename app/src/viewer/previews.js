// Animated previews: <img> GIFs laid out in wall pixels inside one container, which follows the
// wall with a single transform per frame. Which songs animate comes from core/previews.js.
// New GIFs wait until the visible tiles have loaded, at low fetch priority.
import { WALL, cellOf } from '../../../shared/layout.mjs';
import { previewSongs } from '../core/previews.js';

export function createPreviews(viewer, host, { gifUrl }) {
  const layer = document.createElement('div');
  layer.className = 'previews';
  layer.setAttribute('aria-hidden', 'true');
  host.append(layer);

  const imgs = new Map(); // n -> <img>
  const failed = new Set();
  let mode = 'off', noGif = new Set(), last = null;

  const tilesLoaded = () => {
    const item = viewer.world.getItemAt(0);
    return !item || item.getFullyLoaded();
  };

  function add(n) {
    const img = new Image();
    const { col, row } = cellOf(n);
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.alt = '';
    img.style.left = `${col * WALL.cellW}px`;
    img.style.top = `${row * WALL.cellH}px`;
    img.onerror = () => {
      failed.add(n);
      img.remove();
      imgs.delete(n);
    };
    img.src = gifUrl(n);
    layer.append(img);
    imgs.set(n, img);
  }

  function update(state) {
    last = state;
    const { frame: f, range, hover, cellPx, count } = state;
    const want = previewSongs(mode, { range, hover, cellPx, songCount: count, noGif }).filter((n) => !failed.has(n));
    const keep = new Set(want);
    for (const [n, img] of imgs) {
      if (!keep.has(n)) {
        img.removeAttribute('src');
        img.remove();
        imgs.delete(n);
      }
    }
    if (want.length && tilesLoaded()) for (const n of want) if (!imgs.has(n)) add(n);
    layer.hidden = imgs.size === 0;
    if (imgs.size) layer.style.transform = `translate(${f.ox}px, ${f.oy}px) scale(${f.s})`;
  }

  // When the tiles finish, start whatever GIFs were waiting.
  const watch = (item) => item.addHandler('fully-loaded-change', (e) => e.fullyLoaded && last && update(last));
  viewer.world.addHandler('add-item', (e) => watch(e.item));
  for (let i = 0; i < viewer.world.getItemCount(); i++) watch(viewer.world.getItemAt(i));

  return {
    update,
    setMode(m) {
      mode = m;
      if (last) update(last);
    },
    setNoGif(list) {
      noGif = new Set(list || []);
      if (last) update(last);
    },
  };
}
