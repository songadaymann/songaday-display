// The to-do list: which gaps matter for what, and the suggested fix for each.
import { ERA } from './config.mjs';

export const PRIORITIES = ['gallery', 'catalog', 'archive', 'review'];

// gallery: the wall or its previews; catalog: what the song's modal shows; archive: the archive
// itself; review: usable, but a person should look.
export function priority(piece, status, n) {
  if (status === 'suspect') return 'review';
  if (piece === 'mosaic' || (piece === 'gif' && n > ERA.azureGifTo)) return 'gallery';
  if (piece === 'catalog' || piece === 'youtube' || piece === 'meta') return 'catalog';
  return 'archive';
}

// Placeholders are only to-dos where a build needs the bytes.
export function isGap(piece, status, n) {
  if (status === 'ok' || status === 'n/a') return false;
  if (status === 'placeholder') return piece === 'mosaic' || piece === 'meta' || (piece === 'gif' && n > ERA.azureGifTo);
  return true;
}

const offline = (folder) => `Make "${folder}" available offline in Dropbox (or just this file)`;

export function suggestFix(piece, r, n) {
  const s = r.status;
  const d = r.detail || '';
  switch (piece) {
    case 'mosaic':
      if (s === 'placeholder') return offline(r.source === 'still' ? 'EverySongADayPNG' : r.source);
      if (s === 'missing') return 'Publish a generated card (manifest missingArt); later grab a frame from the IPFS video (output/<n>/video_hash.txt) and fix it with wall-add --force';
      if (r.source === 'art') return 'Approve the generated art as the cell, or grab a frame from the video';
      if (r.source === 'master') return 'Look at the cell; if it is the wrong frame, replace it with wall-add --force';
      return 'Look at the image before it goes on the wall';
    case 'gif':
      if (s === 'placeholder') return offline('Every Song A Day Gif');
      if (s === 'missing' && n <= ERA.azureGifTo) return 'Gallery uses the Azure copy; regenerate from the video only if the archive should have it';
      if (s === 'missing') return 'Regenerate from the video (320x180, 1 s, 10 fps, as lib/video.ts does) or fetch gif_url from IPFS; else the viewer shows the still';
      return 'Regenerate the GIF from the video';
    case 'still':
      if (s === 'missing') return 'Grab the mid-video frame with ffmpeg (only needed for songs after the old master)';
      return 'Re-grab the mid-video frame';
    case 'thumb':
      return 'Not used by the wall (the old master covers 1-5852); regenerate only for the archive';
    case 'cell':
      return 'Look at the cell in the old master';
    case 'art':
      return 'Re-export the toolkit art';
    case 'video':
      if (/two versions/.test(d)) return 'Decide which file is the master and archive the other';
      if (s === 'missing') return 'Recover from IPFS animation_url (output/<n>/video_hash.txt or token metadata) or the YouTube upload';
      return 'Re-export or recover the video';
    case 'wav':
      if (s === 'missing') return 'Extract from the video (ffmpeg -vn) or recover IPFS audio_url';
      if (/sheet says/.test(d)) return 'Check the WAV and the sheet Length; one of them is wrong';
      return 'Listen to it; re-export from the session or the video if it is cut short';
    case 'mp3':
      if (s === 'missing') return 'Encode from the WAV (song-a-day-rating-app scripts/sync-audio-r2.mjs does this)';
      return 'Re-encode from the WAV';
    case 'meta':
      if (s === 'placeholder') return offline('Every Song A Day Metadata unclean');
      if (s === 'missing') return 'Fetch the tokenURI JSON through the songaday Pinata gateway (online check) and keep a copy';
      if (/Date trait/.test(d)) return 'Fix the Date trait in the token metadata (repairMetadata) and the local copy';
      if (/malformed|not a CID/.test(d)) return 'Fix the URI in the token metadata (repairMetadata)';
      if (/name/.test(d)) return 'Check the title in the sheet and the token metadata';
      return 'Re-save the local metadata copy';
    case 'youtube': {
      const f = new Set(r.flags || []);
      const c = r.candidate ? ` Candidate on the channel: ${r.candidate.id} "${r.candidate.title}".` : '';
      if (s === 'missing' || f.has('sheetBlank')) return `Add the YouTube link to the sheet (column T).${c}`;
      if (f.has('malformed')) return `Fix the id in the sheet (column T).${c}`;
      if (f.has('notPublic')) return `Make the video public or point the sheet at a public upload.${c}`;
      if (f.has('sharedId')) return `Point each song at its own upload.${c}`;
      if (f.has('disagree') || f.has('malformedCopy')) return `Check which id is right and fix the token metadata (repairMetadata) or the sheet.${c}`;
      if (f.has('notEmbeddable')) return 'Turn on "Allow embedding" for the video in YouTube Studio, or the modal can only link out';
      return `Check the link.${c}`;
    }
    case 'catalog':
      if (s === 'missing') return 'Add the row to the sheet, then re-run the toolkit catalog audit';
      return 'Fix the sheet row';
    default:
      return '';
  }
}
