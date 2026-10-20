// JSON responses for /api/*. Same-origin only: no CORS headers at all, and CORP stops other
// sites from embedding the bodies. Error bodies are short fixed strings; upstream text never
// reaches them (an RPC error can echo its URL, and the URL holds a key).

export class HttpError extends Error {
  constructor(status, error, headers = {}) {
    super(error);
    this.status = status;
    this.headers = headers;
  }
}

// A failure at OpenSea or the RPC. Its message is for logs, and must not contain secrets.
export class UpstreamError extends Error {}

export function json(body, { status = 200, maxAge = 0, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...headers,
    },
  });
}

export const fail = (status, error, headers) => json({ error }, { status, headers });
