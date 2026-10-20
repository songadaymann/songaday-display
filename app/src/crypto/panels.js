// The three sidebar views: For Sale, Recent Sales and Collectors. Each fetches when it opens,
// outlines its songs on the wall and dims the rest, and clears that when the panel closes.
import { getApi, lookupNames, nameOf } from './api.js';
import { formatPrice, shortAddress, timeAgo, updatedAgo, plural, openSeaAccount } from './format.js';
import { el, panelRoot, note, list, addressLabel, refreshNames, songRow, scrollToTop } from './dom.js';

const MIN = 60_000;
const PAGE = 50; // collectors per page

// shared: { state, holders(), buttons, drop(name), setForSaleCount(n) } from index.js
export function createPanels(ctx, { state, holders, buttons, drop, setForSaleCount }) {
  let current = null; // { name, root }
  // Rows read titles from the catalog; give it a moment if it's still loading.
  const catalog = () => Promise.race([ctx.catalogReady, new Promise((r) => setTimeout(r, 4000))]);
  const highlight = (set) => {
    ctx.setMask(set);
    ctx.setOutlines(set);
  };

  function show(name, title) {
    const root = panelRoot(note('Loading…'));
    const button = buttons[name];
    const handle = ctx.openPanel(title, root, {
      onClose: () => {
        button?.classList.remove('active');
        button?.setAttribute('aria-expanded', 'false');
        highlight(null);
        if (current?.root === root) current = null;
      },
    });
    button?.classList.add('active');
    button?.setAttribute('aria-expanded', 'true');
    current = { name, root };
    return { root, handle, live: () => root.isConnected };
  }

  // No API here (404) or no key for it (503): the feature is off, so its button goes. Anything
  // else is probably passing; say so in the panel.
  function failed(v, name, r, what) {
    if (r.status === 404 || r.status === 503) {
      drop(name);
      v.handle.close();
      return;
    }
    v.root.replaceChildren(note(`${what} couldn’t be loaded. Try again in a minute.`));
  }

  async function forSale() {
    const v = show('forSale', 'Items For Sale');
    const [r] = await Promise.all([getApi('/api/market/listings'), catalog()]);
    if (!v.live()) return;
    if (!r.ok) return failed(v, 'forSale', r, 'Listings');
    const { listings, updatedAt, contract } = r.data;
    state.contract ||= contract;
    state.listings = new Map(listings.map((l) => [l.n, l]));
    state.listed = new Set(state.listings.keys());
    for (const n of state.listed) state.known.add(n);
    setForSaleCount(listings.length);
    v.handle.setTitle(`Items For Sale (${listings.length.toLocaleString('en-US')})`);
    const floor = listings[0]?.price;
    const head = listings.length
      ? [`${plural(listings.length, 'song')} listed`, floor && `from ${formatPrice(floor)}`, updatedAgo(updatedAt)].filter(Boolean).join(' · ')
      : 'Nothing is listed right now.';
    v.root.replaceChildren(note(head), list(listings.map((l) => songRow(ctx, l.n, { side: formatPrice(l.price) }))));
    highlight(state.listed);
  }

  async function sales() {
    const v = show('sales', 'Recent Sales');
    const [r] = await Promise.all([getApi('/api/market/sales?limit=50', 2 * MIN), catalog()]);
    if (!v.live()) return;
    if (!r.ok) return failed(v, 'sales', r, 'Recent sales');
    const items = r.data.sales;
    state.contract ||= r.data.contract;
    for (const s of items) state.known.add(s.n);
    const rows = items.map((s) =>
      songRow(ctx, s.n, {
        side: formatPrice(s.price),
        sub: [s.time ? timeAgo(s.time) : 'sold', ' · ', addressLabel(s.seller), ' → ', addressLabel(s.buyer)],
      }),
    );
    const head = items.length ? `Last ${plural(items.length, 'sale')} · ${updatedAgo(r.data.updatedAt)}` : 'No recent sales.';
    v.root.replaceChildren(note(head), list(rows));
    highlight(new Set(items.map((s) => s.n)));
    lookupNames(items.flatMap((s) => [s.seller, s.buyer])).then(() => v.live() && refreshNames(v.root));
  }

  // Collectors by song count, 50 a page. Hover a collector to see their songs on the wall;
  // click for the list. `address` opens straight on one collector.
  async function collectors(address) {
    const v = show('collectors', 'Top Collectors');
    const [r] = await Promise.all([holders(), catalog()]);
    if (!v.live()) return;
    if (!r.ok) return failed(v, 'collectors', r, 'Collectors');
    const h = r.index;
    let listView = null;

    function showList() {
      v.handle.setTitle('Top Collectors');
      highlight(null);
      if (listView) {
        v.root.replaceChildren(...listView);
        return;
      }
      const ul = list([]);
      const more = el('button', { type: 'button', className: 'crypto-more' });
      let shown = 0;
      const addPage = () => {
        const page = h.holders.slice(shown, shown + PAGE);
        for (const { address: a, tokens } of page) ul.append(el('li', {}, collectorRow(a, tokens)));
        shown += page.length;
        const left = h.holders.length - shown;
        more.hidden = left <= 0;
        more.textContent = `Show ${Math.min(PAGE, left)} more`;
        lookupNames(page.map((x) => x.address)).then(() => v.live() && refreshNames(ul));
      };
      more.addEventListener('click', addPage);
      addPage();
      const head = note([plural(h.holders.length, 'collector'), `${plural(h.minted, 'song')} minted`, updatedAgo(h.updatedAt)].filter(Boolean).join(' · '));
      listView = [head, ul, more];
      v.root.replaceChildren(...listView);
    }

    function collectorRow(a, tokens) {
      const b = el('button', { type: 'button', className: 'crypto-row collector-row' },
        el('span', { className: 'crypto-row-text' }, addressLabel(a)),
        el('span', { className: 'crypto-row-side', textContent: plural(tokens.length, 'song') }));
      const preview = () => highlight(new Set(tokens));
      const clear = () => b.isConnected && highlight(null);
      b.addEventListener('mouseenter', preview);
      b.addEventListener('focus', preview);
      b.addEventListener('mouseleave', clear);
      b.addEventListener('blur', clear);
      b.addEventListener('click', () => showOwner(a));
      return b;
    }

    function showOwner(a) {
      const tokens = h.tokensOf(a);
      const title = () => `Songs owned by ${nameOf(a) || shortAddress(a)}`;
      const back = el('button', { type: 'button', className: 'crypto-back', textContent: '← All collectors' });
      back.addEventListener('click', showList);
      const profile = el('a', { href: openSeaAccount(a), target: '_blank', rel: 'noopener', textContent: 'OpenSea profile ↗' });
      v.handle.setTitle(title());
      v.root.replaceChildren(back, note(addressLabel(a), ` · ${plural(tokens.length, 'song')} · `, profile), list(tokens.map((n) => songRow(ctx, n))));
      scrollToTop(v.root);
      highlight(new Set(tokens));
      lookupNames([a]).then(() => {
        if (!v.live() || !back.isConnected) return;
        refreshNames(v.root);
        v.handle.setTitle(title());
      });
    }

    if (address && h.count(address)) showOwner(address);
    else showList();
  }

  // A button opens its panel, or closes it if it's the one showing.
  const toggle = (name, open) => (current?.name === name ? ctx.closePanel() : open());
  return { forSale, sales, collectors, toggle };
}
