// Display helpers for the crypto panels, and the holders index. Pure; tested in format.test.mjs.

const STABLE = /^(USDC|USDT|DAI)$/i;

// Integer string in base units -> decimal string, rounded to maxFrac places, '' if it rounds
// to zero. BigInt throughout, so 18-decimal values stay exact.
export function formatUnits(value, decimals, maxFrac) {
  const v = BigInt(value);
  const d = BigInt(decimals);
  const keep = BigInt(Math.min(maxFrac, decimals));
  const scale = 10n ** (d - keep);
  const rounded = (v + scale / 2n) / scale; // value in units of 10^-keep
  const unit = 10n ** keep;
  const whole = rounded / unit;
  const frac = keep ? (rounded % unit).toString().padStart(Number(keep), '0').replace(/0+$/, '') : '';
  return whole.toLocaleString('en-US') + (frac ? `.${frac}` : '');
}

// { value, decimals, currency } -> '0.05 ETH'. Tiny but non-zero amounts read '<0.0001 ETH'.
export function formatPrice(price) {
  if (!price || !/^\d+$/.test(String(price.value))) return '';
  const places = STABLE.test(price.currency) ? 2 : 4;
  const text = formatUnits(price.value, price.decimals ?? 18, places);
  const shown = text === '0' && BigInt(price.value) > 0n ? `<${(10 ** -places).toFixed(places)}` : text;
  return `${shown} ${price.currency || 'ETH'}`;
}

export const shortAddress = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ''));

// Seconds since the epoch -> '3d ago'.
export function timeAgo(sec, now = Date.now()) {
  const s = Math.max(0, Math.floor(now / 1000 - sec));
  if (s < 60) return 'just now';
  const units = [['y', 31_536_000], ['mo', 2_592_000], ['d', 86_400], ['h', 3600], ['m', 60]];
  for (const [unit, size] of units) if (s >= size) return `${Math.floor(s / size)}${unit} ago`;
  return 'just now';
}

export const updatedAgo = (iso, now = Date.now()) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `updated ${timeAgo(t / 1000, now)}` : '';
};

export const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export const openSeaItem = (contract, n) => `https://opensea.io/assets/ethereum/${contract}/${n}`;
export const openSeaAccount = (address) => `https://opensea.io/${address}`;

// /api/holders payload -> lookups. A token is minted when it was checked and didn't revert.
export function indexHolders(payload) {
  const owner = new Map();
  const count = new Map();
  for (const { address, tokens } of payload?.holders || []) {
    count.set(address, tokens.length);
    for (const n of tokens) owner.set(n, address);
  }
  const unminted = new Set(payload?.unminted || []);
  const { from = 1, to = 0 } = payload?.checked || {};
  return {
    contract: payload?.contract || null,
    updatedAt: payload?.updatedAt || null,
    holders: payload?.holders || [],
    minted: payload?.minted ?? owner.size,
    owner: (n) => owner.get(n) || null,
    count: (address) => count.get(address) || 0,
    tokensOf: (address) => payload?.holders?.find((h) => h.address === address)?.tokens || [],
    isMinted: (n) => n >= from && n <= to && !unminted.has(n),
  };
}
