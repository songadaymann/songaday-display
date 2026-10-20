// The song dialog. A native <dialog> opened with showModal(): role=dialog, focus trapped,
// the page behind inert, Escape closes. Closing removes the video so it stops playing.
import { songDate, formatDate } from '../core/dates.js';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const HIDDEN_TRAITS = new Set(['Song A Day', 'Date']);

export function createModal(dialog, { catalog, maxSong, stillUrl, songPageUrl, onShow, onHide }) {
  const $ = (sel) => dialog.querySelector(sel);
  const title = $('.song-title');
  const number = $('.song-number');
  const date = $('.song-date');
  const video = $('.video-container');
  const desc = $('.song-description');
  const traits = $('.attributes-grid');
  const link = $('.song-link');
  const slot = $('.modal-crypto');
  const prev = $('.song-prev');
  const next = $('.song-next');
  const openers = new Set();
  let current = 0, complete = false;

  function fillVideo(n, song) {
    const id = song?.yt;
    if (song && typeof id === 'string' && YT_ID.test(id)) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${id}?rel=0`;
      iframe.title = `Video: ${song.t || `Song #${n}`}`;
      iframe.allow = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      video.replaceChildren(iframe);
      return;
    }
    if (!song && !catalog.loaded) {
      video.replaceChildren(); // catalog still loading; filled again when it arrives
      return;
    }
    const box = document.createElement('div');
    box.className = 'video-unavailable';
    const img = new Image();
    img.alt = '';
    img.src = stillUrl(n);
    img.onerror = () => img.remove();
    const msg = document.createElement('p');
    msg.textContent = 'Video unavailable';
    const a = document.createElement('a');
    a.href = songPageUrl(n);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Watch on Song A Day';
    box.append(img, msg, a);
    video.replaceChildren(box);
  }

  function fillTraits(song) {
    const items = [];
    for (const [name, value] of Object.entries(song?.a || {})) {
      if (HIDDEN_TRAITS.has(name)) continue;
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v === null || v === undefined || v === '') continue;
        const item = document.createElement('div');
        item.className = 'attribute-item';
        const label = document.createElement('div');
        label.className = 'attribute-label';
        label.textContent = name;
        const val = document.createElement('div');
        val.className = 'attribute-value';
        val.textContent = String(v);
        item.append(label, val);
        items.push(item);
      }
    }
    traits.replaceChildren(...items);
  }

  function fill(n) {
    const song = catalog.getSong(n);
    complete = Boolean(song);
    title.textContent = song?.t || `Song #${n}`;
    number.textContent = `Song #${n}`;
    date.textContent = formatDate(song?.d || songDate(n));
    date.dateTime = song?.d || songDate(n);
    fillVideo(n, song);
    fillTraits(song);
    link.href = songPageUrl(n);
    prev.disabled = n <= 1;
    next.disabled = n >= maxSong();
  }

  async function fillDescription(n) {
    desc.textContent = '';
    desc.hidden = true;
    const text = await catalog.description(n);
    if (current !== n || !text) return;
    desc.textContent = text;
    desc.hidden = false;
  }

  function open(n) {
    if (!(n >= 1)) return;
    current = n;
    fill(n);
    fillDescription(n);
    slot.replaceChildren();
    for (const cb of openers) {
      try {
        cb(n, slot);
      } catch (err) {
        console.error('[gallery] onModalOpen handler failed:', err);
      }
    }
    if (!dialog.open) {
      dialog.showModal();
      dialog.querySelector('.close-button').focus();
    }
    dialog.scrollTop = 0;
    onShow?.(n);
  }

  const close = () => dialog.open && dialog.close();
  const step = (d) => current && current + d >= 1 && current + d <= maxSong() && open(current + d);

  // Whatever closed it (x, Escape, backdrop, code), stop the video and tidy up.
  dialog.addEventListener('close', () => {
    video.replaceChildren();
    slot.replaceChildren();
    const n = current;
    current = 0;
    onHide?.(n);
  });
  // A click on the backdrop lands on the <dialog> itself, outside its box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
  });
  $('.close-button').addEventListener('click', close);
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  // The catalog arrived while a song was open: fill in its title, video and traits (once, so a
  // later catalog update never reloads a playing video).
  catalog.onChange(() => {
    if (current && !complete && catalog.getSong(current)) fill(current);
  });

  return {
    open,
    close,
    get current() {
      return current;
    },
    // A listener added while a song is already open hears about it straight away.
    onOpen(cb) {
      openers.add(cb);
      if (current && dialog.open) cb(current, slot);
      return () => openers.delete(cb);
    },
  };
}
