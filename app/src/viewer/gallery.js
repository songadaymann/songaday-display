// The wall viewer: OpenSeadragon 6.1.1 with the overlay canvas and the preview layer on top.
// Options follow docs/research/design-static-preallocated.md §5.2.
import OpenSeadragon from 'openseadragon';
import { wallSource, tilesChanged } from '../core/wall.js';
import { songViewportRect } from '../core/frame.js';
import { createOverlay } from './overlay.js';
import { createPreviews } from './previews.js';

const CLICK_DELAY = 300; // ms to wait for a second click before opening a song (OSD's double-click window)

// The page: a click opens the song after CLICK_DELAY and a double click zooms. The embed keeps
// OpenSeadragon's own defaults, as the old embed did: mouse and pen click to zoom, touch double-taps.
const PAGE_GESTURES = {
  gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
  gestureSettingsTouch: { clickToZoom: false, dblClickToZoom: true },
  gestureSettingsPen: { clickToZoom: false, dblClickToZoom: true },
};

function osdSource(manifest, mediaUrl) {
  const spec = wallSource(manifest, mediaUrl);
  const { hasTile, ...source } = spec;
  // Copied onto the TileSource instance by OSD; never requests an empty tile, so no 404s.
  source.tileExists = function (level, x, y) {
    return OpenSeadragon.TileSource.prototype.tileExists.call(this, level, x, y) && hasTile(level, x, y);
  };
  return source;
}

export function createGallery({ element, manifest, mediaUrl, gifUrl, crossOrigin, embed, onOpenSong, onPick }) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const hidpi = (window.devicePixelRatio || 1) >= 2;
  let current = manifest;

  const viewer = OpenSeadragon({
    element,
    tileSources: osdSource(manifest, mediaUrl),
    crossOriginPolicy: crossOrigin ? 'Anonymous' : false,
    showNavigationControl: false,
    showNavigator: false,
    visibilityRatio: 1,
    constrainDuringPan: true,
    minZoomImageRatio: 0.8,
    maxZoomPixelRatio: 2,
    animationTime: 0.45,
    springStiffness: 7,
    blendTime: 0.15,
    immediateRender: coarse,
    maxTilesPerFrame: coarse ? 2 : 4,
    minPixelRatio: hidpi ? 1 : 0.5,
    maxImageCacheCount: coarse ? 80 : 160,
    preserveImageSizeOnResize: true,
    ...(embed ? {} : PAGE_GESTURES),
  });

  // No rotate (r/R) or flip (f): the overlay assumes an upright wall. OpenSeadragon picks these by
  // keyCode (82, 70), which follows the keyboard layout, so the check does too.
  viewer.addHandler('canvas-key', (e) => {
    const k = e.originalEvent?.keyCode;
    if (k === 82 || k === 70) e.preventDefaultAction = true;
  });

  const songCount = () => current.songCount;
  const overlay = createOverlay(viewer, element, { songCount });
  const previews = createPreviews(viewer, element, { gifUrl });
  previews.setNoGif(manifest.noGif);
  overlay.onDraw((state) => previews.update(state));

  // A click opens its song after CLICK_DELAY. Each click restarts the wait for its own song; OSD
  // raises canvas-double-click after the second click (only when the two are within 20 px), which
  // cancels it and zooms. Anything that moves the view cancels it too.
  let timer = 0;
  const cancelOpen = () => {
    clearTimeout(timer);
    timer = 0;
  };
  viewer.addHandler('canvas-click', (e) => {
    if (!e.quick) return;
    cancelOpen();
    const n = overlay.hitAt(e.position);
    if (!n) return;
    overlay.setFocus(n);
    onPick?.(n);
    if (embed) return;
    timer = setTimeout(() => {
      timer = 0;
      onOpenSong?.(n);
    }, CLICK_DELAY);
  });
  viewer.addHandler('canvas-double-click', cancelOpen);
  viewer.addHandler('canvas-pinch', cancelOpen);
  viewer.addHandler('canvas-drag', () => {
    cancelOpen();
    if (overlay.focus) overlay.setFocus(0);
  });

  // Sidebars float over the wall; insets() reports how much of each side they cover (CSS px), so a
  // flight frames the song in the part of the wall you can still see.
  let insets = () => ({ left: 0, right: 0, bottom: 0 });

  function flyTo(n, { immediately = false, pad = 1.5 } = {}) {
    if (!(n >= 1 && n <= songCount())) return false;
    let { x, y, width, height } = songViewportRect(n, pad);
    const { left = 0, right = 0, bottom = 0 } = insets();
    const vw = viewer.container.clientWidth, vh = viewer.container.clientHeight;
    if (left + right > 0 && left + right < vw * 0.75) {
      const w = (width * vw) / (vw - left - right);
      x -= ((w - width) * left) / (left + right);
      width = w;
    }
    if (bottom > 0 && bottom < vh * 0.75) height = (height * vh) / (vh - bottom);
    viewer.viewport.fitBounds(new OpenSeadragon.Rect(x, y, width, height), immediately);
    overlay.setFocus(n);
    return true;
  }

  // Put the box on song n, panning (at the same zoom) only if it isn't inside where the view is headed.
  function reveal(n) {
    if (!(n >= 1 && n <= songCount())) return;
    const r = songViewportRect(n);
    const b = viewer.viewport.getBounds();
    const inside = r.x >= b.x && r.y >= b.y && r.x + r.width <= b.x + b.width && r.y + r.height <= b.y + b.height;
    if (!inside) viewer.viewport.panTo(new OpenSeadragon.Point(r.x + r.width / 2, r.y + r.height / 2));
    overlay.setFocus(n);
  }

  // Old embed links: minZoom and maxZoom always apply; then bounds wins; otherwise zoom about (x, y)
  // or the centre. Applied without animation. Returns whether the link set the view.
  function applyView(v) {
    const vp = viewer.viewport;
    if (v.minZoom !== null) vp.minZoomLevel = v.minZoom;
    if (v.maxZoom !== null) vp.maxZoomLevel = v.maxZoom;
    if (v.bounds) {
      const [x, y, w, h] = v.bounds;
      vp.fitBounds(new OpenSeadragon.Rect(x, y, w, h), true);
      return true;
    }
    const hasPos = v.x !== null && v.y !== null;
    if (v.zoom === null && !hasPos) {
      if (v.minZoom !== null || v.maxZoom !== null) vp.applyConstraints(true);
      return false;
    }
    const target = hasPos ? new OpenSeadragon.Point(v.x, v.y) : vp.getCenter(true);
    if (v.zoom !== null) vp.zoomTo(v.zoom, target, true);
    if (hasPos) vp.panTo(target, true);
    return true;
  }

  // A newer manifest: swap the tile source in place and keep the view. Unchanged tiles keep
  // their addresses, so they come back from the HTTP cache.
  function setManifest(next) {
    const swap = tilesChanged(current, next);
    current = next;
    previews.setNoGif(next.noGif);
    overlay.invalidate();
    if (!swap || !viewer.world.getItemCount()) return;
    const bounds = viewer.viewport.getBounds(true);
    viewer.addTiledImage({
      tileSource: osdSource(next, mediaUrl),
      index: 0,
      replace: true,
      success: () => viewer.viewport.fitBounds(bounds, true),
    });
  }

  return {
    viewer,
    overlay,
    previews,
    songCount,
    get manifest() {
      return current;
    },
    flyTo,
    setInsets: (fn) => (insets = fn),
    reveal,
    applyView,
    setManifest,
    home: () => viewer.viewport.goHome(),
    zoomBy(factor) {
      viewer.viewport.zoomBy(factor);
      viewer.viewport.applyConstraints();
    },
  };
}
