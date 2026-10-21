// Song A Day gallery: boot and wiring. Load order (design §5.1): manifest, then the viewer;
// wall.json and the catalog index chunks in parallel; crypto code only behind the wallet gate.
import './styles.css';
import { mediaUrl, gifUrl, stillUrl, songPageUrl, mediaIsCrossOrigin } from './config.js';
import { parseLocation, withSong, galleryLink } from './core/deeplink.js';
import { fetchManifest, fetchWall, watchManifest } from './data/manifest.js';
import { createCatalog } from './data/catalog.js';
import { createGallery } from './viewer/gallery.js';
import { createModal } from './ui/modal.js';
import { createPanel } from './ui/panel.js';
import { createSearch, songLabel } from './ui/search.js';
import { createFilters } from './ui/filters.js';
import { rowBinder } from './ui/rows.js';
import { initialAnimateMode, animateToggle, toolbarAdder, fullscreenButton, mobileMenu } from './ui/toolbar.js';
import { applyWalletGate } from './lib/wallet-gate.js';
import { whenSized } from './lib/sized.js';

const $ = (sel) => document.querySelector(sel);
const loc = parseLocation(location.href);
const embed = loc.embed;
document.documentElement.classList.toggle('embed', embed);

// Wallet check runs alongside everything else and never delays the wall. Never in the embed.
const gate = embed ? null : applyWalletGate();

const status = $('#status');
function say(text, retry) {
  status.replaceChildren();
  status.hidden = !text;
  if (!text) return;
  status.append(Object.assign(document.createElement('span'), { textContent: text }));
  if (retry) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Try again' });
    b.addEventListener('click', () => location.reload());
    status.append(b);
  }
}

boot().catch((err) => {
  console.error('[gallery]', err);
  say(err.code === 'ENEWAPP' ? 'The wall has moved on since this page was loaded.' : 'The wall couldn’t be loaded.', true);
});

async function boot() {
  say('Loading the wall…');
  let modal = null; // created below (not in the embed); the viewer's click handler needs it later
  const manifest = await fetchManifest();
  // Stills and GIFs that changed live at <n>-r<rev> keys named by the current manifest.
  let live = manifest;
  const gifFor = (n) => gifUrl(n, live.gifRev?.[n]);
  const stillFor = (n) => stillUrl(n, live.stillRev?.[n]);
  // wall.json only cross-checks shared/layout.mjs (it warns on a mismatch), so the first tile needn't wait for it.
  fetchWall(manifest);
  // The embed has no search, filters or dialog, so it never needs the 2 MB of song data.
  const catalog = createCatalog();
  if (!embed) catalog.load(manifest);

  // OpenSeadragon fits the wall to #viewer when it starts. In a 0×0 window (an embed in a
  // display:none iframe, a hidden browser pane) that's a 1 px wall, and preserveImageSizeOnResize
  // keeps it 1 px when the window grows, so the wall stays black. Start it once there's a size.
  await whenSized($('#viewer'));
  const gallery = createGallery({
    element: $('#viewer'),
    manifest,
    mediaUrl,
    gifUrl: gifFor,
    // In dev, /media misses redirect to the public host, so tiles can be cross-origin there too.
    crossOrigin: mediaIsCrossOrigin() || import.meta.env.DEV,
    embed,
    onOpenSong: (n) => modal?.open(n),
    onPick: (n) => embed && showEmbedLink(n),
  });
  const { viewer, overlay, previews } = gallery;
  if (import.meta.env.DEV) window.__gallery = { gallery, catalog }; // for poking at in dev tools

  viewer.addOnceHandler('open', () => {
    say('');
    const viewed = gallery.applyView(loc.view); // minZoom/maxZoom apply even without a position
    const n = loc.song;
    if (!n) return;
    if (!viewed) gallery.flyTo(n);
    else overlay.setFocus(n);
    if (embed) return showEmbedLink(n);
    // A song past the wall's end may still be in the catalog (it's written first); otherwise ignore it.
    const openIfKnown = () => n <= Math.max(gallery.songCount(), catalog.maxSong()) && modal.open(n);
    if (n <= gallery.songCount()) openIfKnown();
    else catalog.ready.then(openIfKnown);
  });
  viewer.addHandler('open-failed', (e) => say(`The wall couldn’t be opened: ${e.message}`, true));

  // Previews and the Animate toggle.
  const mode = initialAnimateMode();
  previews.setMode(mode);
  if (!embed) animateToggle($('#animate-btn'), mode, (m) => previews.setMode(m));

  // Newer manifest: new tiles keep the view; new catalog chunks merge in.
  const refresh = watchManifest(manifest, (next) => {
    live = next;
    gallery.setManifest(next);
    if (!embed) catalog.load(next);
  });
  let lastFailRefresh = 0;
  viewer.addHandler('tile-load-failed', () => {
    if (Date.now() - lastFailRefresh < 60_000) return;
    lastFailRefresh = Date.now();
    refresh(); // an old manifest can point at a tile version that has since been cleaned up
  });

  // Zoom / fullscreen cluster (the only control left in the embed is fullscreen).
  $('#zoom-in').addEventListener('click', () => gallery.zoomBy(1.6));
  $('#zoom-out').addEventListener('click', () => gallery.zoomBy(1 / 1.6));
  fullscreenButton($('#fullscreen-btn'));

  if (embed) {
    // Hovering or clicking a song offers it in the full gallery; nothing opens in the frame.
    let shown = 0;
    overlay.onDraw(({ hover }) => hover && hover !== shown && showEmbedLink((shown = hover)));
    return;
  }

  const songCount = () => gallery.songCount();
  const maxSong = () => Math.max(songCount(), catalog.maxSong());

  modal = createModal($('#song-modal'), {
    catalog,
    maxSong,
    stillUrl: stillFor,
    songPageUrl,
    onShow: (n) => {
      gallery.reveal(n);
      history.replaceState(history.state, '', withSong(location.href, n));
    },
    onHide: () => history.replaceState(history.state, '', withSong(location.href, 0)),
  });

  // Fly there, then open. Used by search, lists, deep links and the crypto module.
  const openSong = (n) => {
    n = Number(n);
    if (!(n >= 1 && n <= maxSong())) return;
    gallery.flyTo(n);
    modal.open(n);
  };

  const panel = createPanel($('#panel'));
  // Open sidebars cover part of the wall: the left panel and the filter drawer on wide screens,
  // a bottom sheet on phones. Sizes ignore the slide-in transform.
  gallery.setInsets(() => {
    const out = { left: 0, right: 0, bottom: 0 };
    const stageW = $('#stage').clientWidth;
    for (const el of document.querySelectorAll('#stage > .sidebar.open')) {
      if (el.offsetWidth >= stageW - 1) out.bottom = Math.max(out.bottom, el.offsetHeight);
      else if (el.id === 'panel') out.left = el.offsetWidth;
      else out.right = el.offsetWidth;
    }
    return out;
  });
  // Leaving a row clears the box only if it's still on that row's song (an opened song keeps it).
  const clearFocus = (n) => overlay.focus === n && modal.current !== n && overlay.setFocus(0);
  const bindRow = rowBinder({ flyTo: (n) => gallery.flyTo(n), clearFocus, openSong });

  function showResults(query, hits) {
    const list = document.createElement('ul');
    list.className = 'song-list';
    const shown = hits.slice(0, 1000);
    for (const hit of shown) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'song-row';
      b.append(songLabel(hit.song, hit.n));
      li.append(bindRow(b, hit.n));
      list.append(li);
    }
    const wrap = document.createElement('div');
    const count = document.createElement('p');
    count.className = 'list-note';
    count.textContent = hits.length
      ? `${hits.length.toLocaleString('en-US')} song${hits.length === 1 ? '' : 's'}${hits.length > shown.length ? `, showing the first ${shown.length}` : ''}`
      : 'No songs found.';
    wrap.append(count, list);
    panel.open(`Results for “${query}”`, wrap);
  }

  const search = createSearch({ input: $('#search-input'), list: $('#search-results'), catalog, onPick: openSong, onResults: showResults });

  const filters = createFilters({
    drawer: $('#filters'),
    toggle: $('#explore-btn'),
    catalog,
    onChange: (matches) => {
      overlay.setMask('filter', matches, { color: 'rgba(0,0,0,0.6)' });
      overlay.setOutlines('filter', matches, { color: '#4CAF50' });
    },
  });

  $('#home-btn').addEventListener('click', () => gallery.home());
  const closeMenu = mobileMenu($('#menu-btn'), $('#top-nav'));

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || $('#song-modal').open) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      search.focus();
    } else if (e.key === 'Escape') {
      if (filters.isOpen) filters.close();
      else if (panel.isOpen) panel.close();
      else closeMenu();
    }
  });

  // Crypto parts load only when the gate finds a wallet (or ?crypto=1).
  const ctx = {
    viewer,
    getSong: (n) => catalog.getSong(n),
    allSongs: () => catalog.allSongs(),
    catalogReady: catalog.ready,
    songCount,
    mediaUrl,
    gifUrl: gifFor,
    stillUrl: stillFor,
    flyTo: (n) => gallery.flyTo(n),
    setFocus: (n) => overlay.setFocus(n),
    openSong,
    setMask: (set, style) => overlay.setMask('crypto', set, style),
    setOutlines: (set, style) => overlay.setOutlines('crypto', set, style),
    addToolbarButton: toolbarAdder($('#top-nav')),
    openPanel: (title, contentEl, opts) => panel.open(title, contentEl, opts),
    closePanel: () => panel.close(),
    bindRow,
    onModalOpen: (cb) => modal.onOpen(cb),
  };
  gate.then(({ hasWallet }) => {
    if (!hasWallet) return;
    import('./crypto/index.js')
      .then((m) => m.init(ctx))
      .catch((err) => console.error('[gallery] crypto module failed:', err));
  });
}

function showEmbedLink(n) {
  const a = $('#embed-link');
  a.href = galleryLink(location.origin, n);
  a.textContent = `Open #${n} in the gallery ↗`;
  a.hidden = false;
}
