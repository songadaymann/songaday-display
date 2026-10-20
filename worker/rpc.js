// Raw JSON-RPC to MAINNET_RPC_URL. The URL usually carries the provider key, so it never goes
// into an error message or a log line.
import { UpstreamError } from './http.js';

export function rpcClient(url, { fetch, timeout = 15_000 }) {
  let id = 0;
  return async function call(method, params) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new UpstreamError(`rpc ${method}: ${err?.name || 'network error'}`);
    }
    if (!res.ok) throw new UpstreamError(`rpc ${method}: HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError(`rpc ${method}: not JSON`);
    }
    if (body?.error) throw new UpstreamError(`rpc ${method}: error ${Number(body.error.code) || 'unknown'}`);
    if (typeof body?.result !== 'string') throw new UpstreamError(`rpc ${method}: no result`);
    return body.result;
  };
}

// Runs fn over items, at most `limit` at a time, in order of start.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
