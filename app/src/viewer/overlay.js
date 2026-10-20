// One canvas over the wall for everything drawn per song: dim masks, outlines and the hover box.
// It's redrawn in OpenSeadragon's 'update-viewport' (the same animation frame the tiles were
// drawn in) and on pointer moves while the view is still, always from the *current* viewport,
// so the box can't lag the picture. Hit-testing uses the same frame math as drawing.
import OpenSeadragon from 'openseadragon';
import { WALL, CANVAS_W, cellOf, rowsFor } from '../../../shared/layout.mjs';
import { hitTest, cellRect, visibleCells, songsIn, inRange } from '../core/frame.js';

const RING = 4;

export function createOverlay(viewer, host, { songCount }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'overlay';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const ctx = canvas.getContext('2d');

  let rect = host.getBoundingClientRect(), sized = false;
  let cssW = 0, cssH = 0, dpr = 1, raf = 0, drawn = false;
  let pointer = null, focus = 0, hover = 0;
  let box = null; // the box as last drawn: { n, x, y, w, h } in CSS px (for tests and dev tools)
  const masks = new Map(); // key -> { set, color, bitmap, dirty }
  const outlines = new Map(); // key -> { set, color }
  const listeners = new Set();

  function frame() {
    const vp = viewer.viewport;
    const o = vp.pixelFromPoint(new OpenSeadragon.Point(0, 0), true);
    const s = vp.deltaPixelsFromPoints(new OpenSeadragon.Point(1, 0), true).x / CANVAS_W;
    return { ox: o.x, oy: o.y, s };
  }

  // Size is cached and refreshed by a ResizeObserver, so drawing never forces a layout.
  function fit() {
    const d = window.devicePixelRatio || 1;
    if (sized && d === dpr) return;
    sized = true;
    cssW = rect.width;
    cssH = rect.height;
    dpr = d;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  // 1 px per song: songs outside the set get the dim colour. Rebuilt only when the set changes.
  function bitmapFor(m, count) {
    if (m.bitmap && !m.dirty) return m.bitmap;
    const rows = rowsFor(count);
    const b = m.bitmap || document.createElement('canvas');
    b.width = WALL.cols;
    b.height = rows;
    const g = b.getContext('2d');
    g.clearRect(0, 0, b.width, b.height);
    g.fillStyle = m.color;
    const last = cellOf(count);
    g.fillRect(0, 0, WALL.cols, last.row);
    g.fillRect(0, last.row, last.col + 1, 1);
    for (const n of m.set) {
      if (n < 1 || n > count) continue;
      const { col, row } = cellOf(n);
      g.clearRect(col, row, 1, 1);
    }
    m.bitmap = b;
    m.dirty = false;
    return b;
  }

  function draw() {
    fit();
    const count = songCount();
    const f = frame();
    const range = visibleCells(f, cssW, cssH, count);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (drawn) ctx.clearRect(0, 0, cssW, cssH);
    drawn = false;

    const cw = WALL.cellW * f.s, ch = WALL.cellH * f.s;
    if (range) {
      const { c0, c1, r0, r1 } = range;
      for (const m of masks.values()) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmapFor(m, count), c0, r0, c1 - c0 + 1, r1 - r0 + 1,
          f.ox + c0 * cw, f.oy + r0 * ch, (c1 - c0 + 1) * cw, (r1 - r0 + 1) * ch);
        drawn = true;
      }
      if (cw >= 6) {
        for (const o of outlines.values()) {
          const path = new Path2D();
          const lw = Math.min(2, Math.max(1, cw / 40));
          const add = (n) => {
            const r = cellRect(n, f);
            path.rect(r.x + lw / 2, r.y + lw / 2, r.w - lw, r.h - lw);
          };
          if (o.set.size < range.count) {
            for (const n of o.set) if (n <= count && inRange(range, n)) add(n);
          } else {
            for (const n of songsIn(range, count)) if (o.set.has(n)) add(n);
          }
          ctx.lineWidth = lw;
          ctx.strokeStyle = o.color;
          ctx.stroke(path);
          drawn = true;
        }
      }
    }

    hover = pointer ? hitTest(f, pointer, count) : focus <= count ? focus : 0;
    box = null;
    if (hover) {
      const r = cellRect(hover, f);
      box = { n: hover, ...r };
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = RING;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeRect(r.x - RING / 2, r.y - RING / 2, r.w + RING, r.h + RING);
      drawn = true;
    }

    for (const cb of listeners) cb({ frame: f, range, hover, count, cellPx: cw });
  }

  const schedule = () => {
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  };

  viewer.addHandler('update-viewport', draw);
  new ResizeObserver(() => {
    rect = host.getBoundingClientRect();
    sized = false;
    schedule();
  }).observe(host);

  // Hover follows mouse and pen, including while dragging. Touch has no hover: a tap sets focus.
  const local = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  viewer.element.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointer = local(e);
    schedule();
  }, { passive: true });
  viewer.element.addEventListener('pointerleave', () => {
    pointer = null;
    schedule();
  });
  viewer.element.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') pointer = null;
  }, { passive: true });

  return {
    canvas,
    frame,
    draw,
    schedule,
    get hover() {
      return hover;
    },
    get box() {
      return box;
    },
    hitAt: (p) => hitTest(frame(), p, songCount()),
    // Song shown with the box while the pointer is elsewhere (list hover, fly-to, tap). 0 clears.
    setFocus(n) {
      focus = n || 0;
      schedule();
    },
    get focus() {
      return focus;
    },
    // Dim every song NOT in set; null removes the mask. Several keyed masks stack.
    setMask(key, set, { color = 'rgba(0,0,0,0.6)' } = {}) {
      if (set) masks.set(key, { set: set instanceof Set ? set : new Set(set), color, bitmap: masks.get(key)?.bitmap, dirty: true });
      else masks.delete(key);
      schedule();
    },
    // Outline every visible song in set; null removes them.
    setOutlines(key, set, { color = '#4CAF50' } = {}) {
      if (set) outlines.set(key, { set: set instanceof Set ? set : new Set(set), color });
      else outlines.delete(key);
      schedule();
    },
    // The song count changed: rebuild the masks for the new rows.
    invalidate() {
      for (const m of masks.values()) m.dirty = true;
      schedule();
    },
    onDraw(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
