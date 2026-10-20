// Vite config for the gallery app in app/. The build goes to dist/ for the Worker to serve.
//
// In dev (and `vite preview`) /media/* is served from the local publish folder ($CACHE/publish),
// which has the same layout as tiles.songaday.world. Anything not there is redirected: GIFs
// 1-5854 to the old Azure copy, the rest to the public host, so a fresh clone with an empty cache
// shows the real wall. None of this ends up in the build, which reads the public host directly
// unless VITE_MEDIA_BASE says otherwise (app/src/config.js).
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { PUBLISH, REPO } from './pipeline/lib/env.mjs';

const LEGACY_GIFS = 'https://songadaygallery.blob.core.windows.net/dzi';
const LEGACY_GIF_MAX = 5854;
const PUBLIC_MEDIA = 'https://tiles.songaday.world'; // also in app/src/config.js

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function mediaMiddleware(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/^\/+/, '');
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) {
      res.statusCode = 403;
      return res.end();
    }

    let st = null;
    try {
      st = fs.statSync(file);
    } catch {}
    // A 0-byte file is a half-written or placeholder file, never a real image.
    if (!st?.isFile() || st.size === 0) {
      const gif = /^gifs\/(\d+)\.gif$/.exec(rel);
      const legacy = gif && +gif[1] >= 1 && +gif[1] <= LEGACY_GIF_MAX;
      res.statusCode = 302;
      res.setHeader('Location', legacy ? `${LEGACY_GIFS}/${+gif[1]}.gif` : `${PUBLIC_MEDIA}/${rel.split('/').map(encodeURIComponent).join('/')}`);
      res.setHeader('X-Local-Media', 'miss'); // not in the local publish folder
      return res.end();
    }

    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    // Always revalidate in dev: the pipeline may rebuild a key while we work. 304s keep it fast.
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', next).pipe(res);
  };
}

function localMedia() {
  // Returns nothing: a function returned from configureServer would run as a post hook.
  const use = (server) => {
    server.middlewares.use('/media', mediaMiddleware(PUBLISH));
  };
  return { name: 'songaday-local-media', configureServer: use, configurePreviewServer: use };
}

// Starts the manifest fetch from <head>, alongside the app code instead of after it, plus a
// <link rel=preconnect> to the media host when it isn't this origin. Both replace the marker
// comment in app/index.html, ahead of the font stylesheet (an inline script after a stylesheet
// waits for it). app/src/data/manifest.js takes the promise over. A <link rel=preload> can't ask
// for cache: 'no-cache', so this is a script.
const EARLY_MARK = '<!-- early manifest fetch (vite.config.mjs) -->';

function earlyManifest(base) {
  return {
    name: 'songaday-early-manifest',
    transformIndexHtml(html) {
      if (!html.includes(EARLY_MARK)) throw new Error(`app/index.html lost its marker: ${EARLY_MARK}`);
      const url = `${base.replace(/\/+$/, '')}/wall/current.json`;
      const tags = [`<script>window.__manifest = fetch(${JSON.stringify(url)}, { cache: 'no-cache' }).catch(function () { return null; });</script>`];
      if (/^https?:\/\//.test(base)) tags.unshift(`<link rel="preconnect" href="${new URL(base).origin}" crossorigin />`);
      return html.replace(EARLY_MARK, tags.join('\n    '));
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, REPO, 'VITE_');
  const app = path.join(REPO, 'app');
  // The same default as app/src/config.js: /media in dev, the public host in a build.
  const mediaBase = env.VITE_MEDIA_BASE || (command === 'build' ? PUBLIC_MEDIA : '/media');
  return {
    root: app,
    envDir: REPO,
    publicDir: path.join(app, 'public'),
    plugins: [localMedia(), earlyManifest(mediaBase)],
    server: {
      fs: { allow: [app, path.join(REPO, 'shared'), path.join(REPO, 'node_modules')] },
    },
    build: {
      outDir: path.join(REPO, 'dist'),
      emptyOutDir: true,
      sourcemap: true,
    },
  };
});
