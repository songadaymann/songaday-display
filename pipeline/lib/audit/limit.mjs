// Run fn over items with at most `concurrency` in flight. Results keep the input order.
export async function mapLimit(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
