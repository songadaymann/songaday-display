// Where the wall, GIFs and catalog live: VITE_MEDIA_BASE when it is set. Otherwise /media in dev
// (served from $CACHE/publish by vite.config.mjs, which sends anything missing on to the public
// host) and the public host in a build, so a fresh clone and every deploy work with no setup.
export const PUBLIC_MEDIA = 'https://tiles.songaday.world'; // also in vite.config.mjs
export const MEDIA_BASE = (import.meta.env.VITE_MEDIA_BASE || (import.meta.env.DEV ? '/media' : PUBLIC_MEDIA)).replace(/\/+$/, '');

export const mediaUrl = (path) => `${MEDIA_BASE}/${String(path).replace(/^\/+/, '')}`;
// A changed still or GIF gets a new key, <n>-r<rev>; the manifest's stillRev and gifRev name it.
export const gifUrl = (n, rev = 0) => mediaUrl(`gifs/${n}${rev ? `-r${rev}` : ''}.gif`);
export const stillUrl = (n, rev = 0) => mediaUrl(`stills/${n}${rev ? `-r${rev}` : ''}.webp`);

export const mediaIsCrossOrigin = () => new URL(`${MEDIA_BASE}/`, location.href).origin !== location.origin;

export const songPageUrl = (n) => `https://songaday.world/song/${n}`;
