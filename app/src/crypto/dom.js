// DOM pieces for the crypto panels. Text goes in through textContent only.
import { songLabel } from '../ui/search.js';
import { shortAddress } from './format.js';
import { nameOf } from './api.js';

export function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}

// The element handed to ctx.openPanel. data-crypto on the root hides everything inside it.
export function panelRoot(...kids) {
  const root = el('div', { className: 'crypto-panel' }, ...kids);
  root.dataset.crypto = '';
  return root;
}

export const note = (...kids) => el('p', { className: 'crypto-note' }, ...kids);

export const list = (items) => el('ul', { className: 'crypto-list' }, ...items.map((item) => el('li', {}, item)));

// An address that shows its ENS name once lookupNames() has it; refreshNames() updates them.
export function addressLabel(address) {
  const s = el('span', { className: 'crypto-address', title: address || '' });
  s.dataset.address = address || '';
  s.textContent = nameOf(address) || shortAddress(address) || 'unknown';
  return s;
}

// Back to the top of whatever scrolls the panel, header included.
export function scrollToTop(el) {
  for (let e = el.parentElement; e; e = e.parentElement) if (e.scrollTop) e.scrollTop = 0;
}

export function refreshNames(root) {
  for (const s of root.querySelectorAll('[data-address]')) {
    const a = s.dataset.address;
    if (a) s.textContent = nameOf(a) || shortAddress(a);
  }
}

// A song: still, title and date, an optional second line, a value on the right. Hover or focus
// flies the wall there and click opens it (ctx.bindRow).
export function songRow(ctx, n, { side = '', sub = null } = {}) {
  const img = el('img', { className: 'crypto-thumb', alt: '', loading: 'lazy', decoding: 'async', width: 64, height: 36 });
  img.addEventListener('error', () => img.classList.add('missing'), { once: true });
  img.src = ctx.stillUrl(n);
  const text = el('span', { className: 'crypto-row-text' }, songLabel(ctx.getSong(n), n));
  if (sub) text.append(el('span', { className: 'crypto-row-sub' }, ...[].concat(sub)));
  const b = el('button', { type: 'button', className: 'crypto-row' }, img, text);
  if (side) b.append(el('span', { className: 'crypto-row-side', textContent: side }));
  return ctx.bindRow(b, n);
}
