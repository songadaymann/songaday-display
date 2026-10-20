// What the audit looks at, and the eras each source covers. Folder names are relative to
// SONGADAY_ARCHIVE_DIR; the eras come from docs/research/04-song-archive.md §2-3.

export const FOLDERS = {
  wav: 'Every Song A Day Song',
  mp3: 'Every Song A Day mp3s',
  video: 'Every Song A Day Video',
  gif: 'Every Song A Day Gif',
  still: 'EverySongADayPNG',
  thumb: 'Standardized_Thumnails',
  meta: 'Every Song A Day Metadata unclean',
};

// Column order in status.csv. `core` pieces count toward "songs with a missing piece".
export const PIECES = {
  catalog: { core: true, label: 'sheet row (cached catalog)' },
  meta: { core: true, label: 'token metadata JSON (local copy)' },
  youtube: { core: true, label: 'YouTube link' },
  wav: { core: true, label: 'WAV master', exts: ['wav'] },
  mp3: { core: true, label: 'MP3', exts: ['mp3'] },
  video: { core: true, label: 'video', exts: ['mp4', 'mov'] },
  gif: { core: true, label: 'GIF preview', exts: ['gif'] },
  still: { core: false, label: 'mid-video still (EverySongADayPNG)', exts: ['jpg', 'jpeg', 'png'] },
  thumb: { core: false, label: '4K standardized thumbnail', exts: ['jpg', 'jpeg'] },
  cell: { core: false, label: 'cell in the old gallery master' },
  art: { core: false, label: 'toolkit art (output/<n>/image_<n>.png, thumbnail.jpg)' },
  mosaic: { core: true, label: 'wall cell source (design A)' },
  ipfs: { core: false, online: true, label: 'IPFS pins through the songaday gateway (--online)' },
  r2: { core: false, online: true, label: 'R2 MP3 behind songaday.fan (--online)' },
  ytlive: { core: false, online: true, label: 'YouTube oEmbed (--online)' },
};

// Pieces a piece needs computed first.
export const DEPENDS = {
  youtube: ['catalog', 'meta'],
  mosaic: ['cell', 'still', 'thumb', 'art'],
  ipfs: ['meta'],
  r2: ['mp3'],
  ytlive: ['youtube'],
};

export const ERA = {
  stillFrom: 4996, // the toolkit's mid-video stills start here (3974 is a stray)
  thumbTo: 5831, // Standardized_Thumnails was a one-off 4K batch
  masterSongs: 5852, // the old master's cells, used only when the master itself can't be read
  azureGifTo: 5854, // the gallery takes GIFs 1-5854 from the Azure copy, so archive placeholders there don't block
};

export const LIMITS = {
  tinyWav: 2_000_000, // bytes; a few real songs are this short, so it's "suspect", not "bad"
  tinyThumb: 200_000,
  shortSeconds: 15,
  wavVsSheetSeconds: 20, // sheet lengths are hand-typed and often the video's; 10-20 s off is common
  neighbourSeconds: 2, // a WAV this close to another song's sheet length is probably that song
  mp3VsWavSeconds: 2,
  gifW: 320,
  gifH: 180,
};

export const SAMPLE = 0.02; // share of local media decoded or probed without --deep
export const RECENT = 7; // the newest songs are always decoded and probed
