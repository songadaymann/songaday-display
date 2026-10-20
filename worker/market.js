// Turns OpenSea's listings and sale events into the small shapes /api/market/* serves:
// one cheapest listing per song, and sales of this contract only. Pure, so it's tested offline.

const TOKEN = /^\d{1,7}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export const tokenNumber = (id) => (TOKEN.test(String(id ?? '')) && Number(id) >= 1 ? Number(id) : null);
const address = (a) => (typeof a === 'string' && ADDR.test(a) ? a.toLowerCase() : null);

function price(value, decimals, currency) {
  if (!/^\d+$/.test(String(value ?? ''))) return null;
  const d = Number(decimals ?? 18);
  if (!Number.isInteger(d) || d < 0 || d > 36) return null;
  return { value: String(value), decimals: d, currency: String(currency || 'ETH').slice(0, 12) };
}

// ETH and WETH compare by value; anything else sorts after them.
const isEth = (p) => /^W?ETH$/i.test(p.currency) && p.decimals === 18;
export function comparePrices(a, b) {
  const ea = isEth(a) ? 0 : 1;
  const eb = isEth(b) ? 0 : 1;
  if (ea !== eb) return ea - eb;
  const va = BigInt(a.value);
  const vb = BigInt(b.value);
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export function normalizeListing(l, contract, nowSec) {
  const params = l?.protocol_data?.parameters;
  const item = params?.offer?.[0];
  const assetContract = String(l?.asset?.contract || item?.token || '').toLowerCase();
  if (assetContract && assetContract !== contract) return null;
  if (l?.status && l.status !== 'ACTIVE') return null;
  const n = tokenNumber(l?.asset?.identifier ?? item?.identifierOrCriteria);
  const p = l?.price?.current && price(l.price.current.value, l.price.current.decimals, l.price.current.currency);
  if (!n || !p) return null;
  const expires = Number(params?.endTime) || null;
  if (expires && expires <= nowSec) return null;
  return { n, price: p, maker: address(params?.offerer), expires };
}

// Cheapest listing per song, cheapest first.
export function bestListings(raw, contract, nowSec) {
  const best = new Map();
  for (const l of raw) {
    const x = normalizeListing(l, contract, nowSec);
    if (!x) continue;
    const have = best.get(x.n);
    if (!have || comparePrices(x.price, have.price) < 0) best.set(x.n, x);
  }
  return [...best.values()].sort((a, b) => comparePrices(a.price, b.price) || a.n - b.n);
}

export function marketSummary(listings) {
  const floor = listings.find((l) => isEth(l.price))?.price || null;
  return { listed: listings.length, tokens: listings.map((l) => l.n).sort((a, b) => a - b), floor };
}

export function normalizeSale(e, contract) {
  if (e?.event_type !== 'sale' || !e.nft) return null;
  const c = String(e.nft.contract || '').toLowerCase();
  if (c && c !== contract) return null;
  const n = tokenNumber(e.nft.identifier);
  const p = e.payment && price(e.payment.quantity, e.payment.decimals, e.payment.symbol);
  if (!n || !p) return null;
  const time = Number(e.closing_date || e.event_timestamp) || null;
  return {
    n,
    price: p,
    seller: address(e.seller),
    buyer: address(e.buyer),
    time,
    tx: TX.test(String(e.transaction || '')) ? e.transaction.toLowerCase() : null,
  };
}

export const recentSales = (events, contract) =>
  events.map((e) => normalizeSale(e, contract)).filter(Boolean).sort((a, b) => (b.time || 0) - (a.time || 0));
