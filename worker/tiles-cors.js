// Worker "songaday-display-tiles" (wrangler.tiles.jsonc), on the route tiles.songaday.world/*.
// Passes every request on to the R2 bucket behind that custom domain, through Cloudflare's cache
// exactly as without it, and sets Access-Control-Allow-Origin: * on every response.
//
// Why: R2 sends the CORS header only when a request has an Origin. The edge cache can keep the copy
// fetched without one (a crawler, a direct link) and serve it to the gallery, whose WebGL drawer
// then can't use the tile. Measured on 2026-10-20: it happened for some URLs and not others. A zone
// Response Header Transform Rule would do the same job, but wrangler's login can't create one.
export default {
  async fetch(request) {
    const res = await fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('Access-Control-Allow-Origin', '*');
    return out;
  },
};
