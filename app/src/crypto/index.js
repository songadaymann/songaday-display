// The gallery's crypto parts: For Sale, Recent Sales, Collectors, and the OpenSea link and owner
// in the song dialog. Loaded with import() only when the wallet gate finds a wallet (or
// ?crypto=1) and the page isn't the embed, so nobody else downloads or runs any of it. See
// README.md for ctx.
//
// Everything talks to the Worker's /api/* routes only (worker/api.js); keys stay server-side.
// On start it asks for one thing, the cached For Sale count. The rest waits for a click, and
// the minted/owner data waits for the first song dialog.
import './crypto.css';
import { getApi, lookupNames } from './api.js';
import { formatPrice, indexHolders, openSeaItem } from './format.js';
import { el, addressLabel, refreshNames } from './dom.js';
import { createPanels } from './panels.js';

let started = false;

export async function init(ctx) {
  if (started || document.documentElement.classList.contains('embed')) return;
  started = true;

  // contract: from any /api response. listed/listings: For Sale data once loaded. known: songs
  // seen listed or sold, so minted even when /api/holders isn't available.
  const state = { contract: null, listed: new Set(), listings: null, known: new Set() };

  const indexes = new WeakMap();
  async function holders() {
    const r = await getApi('/api/holders', 30 * 60_000);
    if (!r.ok) return r;
    if (!indexes.has(r.data)) indexes.set(r.data, indexHolders(r.data));
    return { ...r, index: indexes.get(r.data) };
  }

  // Buttons in the old order: Sales, Collectors, For Sale. Hidden until there's data.
  const buttons = {};
  const add = (name, label, open) => {
    const b = ctx.addToolbarButton({ id: `${name}-btn`, label, onClick: () => panels.toggle(name, open) });
    b.hidden = true;
    b.setAttribute('aria-controls', 'panel');
    b.setAttribute('aria-expanded', 'false');
    buttons[name] = b;
  };
  const drop = (name) => {
    buttons[name]?.remove();
    delete buttons[name];
  };
  const setForSaleCount = (n) => {
    const label = buttons.forSale?.querySelector('.nav-label');
    if (label) label.textContent = `For Sale (${n.toLocaleString('en-US')})`;
  };

  const panels = createPanels(ctx, { state, holders, buttons, drop, setForSaleCount });
  add('sales', 'Sales', () => panels.sales());
  add('collectors', 'Collectors', () => panels.collectors());
  add('forSale', 'For Sale', () => panels.forSale());
  buttons.forSale.classList.add('for-sale');
  // Collectors fetches on click; if the Worker has no RPC, that click removes it.
  buttons.collectors.hidden = false;

  const onOpen = modalSlot(ctx, { state, holders, openCollector: (a) => panels.collectors(a) });
  ctx.onModalOpen(onOpen);

  const summary = await getApi('/api/market/summary');
  if (!summary.ok) {
    drop('sales');
    drop('forSale');
    return;
  }
  state.contract ||= summary.data.contract;
  state.listed = new Set(summary.data.tokens);
  for (const n of state.listed) state.known.add(n);
  setForSaleCount(summary.data.listed);
  buttons.sales.hidden = false;
  buttons.forSale.hidden = false;
}

// The dialog's crypto row: "View on OpenSea" for minted songs only, the owner (ENS name when
// there is one) and the listing price if it's for sale.
function modalSlot(ctx, { state, holders, openCollector }) {
  let ticket = 0;
  return (n, slot) => {
    const t = ++ticket;
    fill(n, slot, t).catch((err) => console.warn('[gallery] crypto dialog row failed:', err));
  };

  async function fill(n, slot, t) {
    const r = await holders();
    if (t !== ticket) return; // another song (or none) is showing now
    const h = r.ok ? r.index : null;
    const contract = h?.contract || state.contract;
    if (!contract || !(h?.isMinted(n) || state.known.has(n))) return;

    const row = el('div', { className: 'crypto-modal' });
    row.append(el('a', { className: 'external-link', href: openSeaItem(contract, n), target: '_blank', rel: 'noopener', textContent: 'View on OpenSea' }));
    const owner = h?.owner(n);
    if (owner) {
      const who = el('span', { className: 'crypto-owner' }, 'Owned by ', addressLabel(owner));
      const count = h.count(owner);
      if (count > 1) {
        const all = el('button', { type: 'button', className: 'crypto-link-button', textContent: `see all ${count.toLocaleString('en-US')}` });
        all.addEventListener('click', () => {
          slot.closest('dialog')?.close();
          openCollector(owner);
        });
        who.append(' · ', all);
      }
      row.append(who);
      lookupNames([owner]).then(() => t === ticket && refreshNames(row));
    }
    const listing = state.listings?.get(n);
    if (listing) row.append(el('span', { className: 'crypto-listed', textContent: `Listed for ${formatPrice(listing.price)}` }));
    else if (state.listed.has(n)) row.append(el('span', { className: 'crypto-listed', textContent: 'Listed for sale' }));
    slot.replaceChildren(row);
  }
}
