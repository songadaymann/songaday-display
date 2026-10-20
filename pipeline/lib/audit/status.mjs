// One status vocabulary for every piece of every song.
//
//   ok           present, local, and passed whatever checks ran
//   suspect      usable but worth a look (tiny, odd size, dark, two versions, sources disagree)
//   placeholder  a Dropbox online-only file: exists in the cloud, no bytes here, never opened
//   missing      no file and no copy anywhere we looked
//   empty        0 bytes with no placeholder marker: a real, broken file
//   bad          decode or ffprobe failure, black frame, duplicate of another song, malformed id
//   n/a          the piece didn't exist for this song's era, or wasn't checked

export const STATUSES = ['ok', 'suspect', 'placeholder', 'missing', 'empty', 'bad', 'n/a'];

const RANK = { 'n/a': 0, ok: 1, suspect: 2, placeholder: 3, missing: 4, empty: 5, bad: 6 };

export const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
export const isProblem = (s) => s === 'missing' || s === 'empty' || s === 'bad';

// State of one scanned file record ({size, placeholder}), or 'missing' for none.
export function fileStatus(rec) {
  if (!rec) return 'missing';
  if (rec.placeholder) return 'placeholder';
  if (rec.size === 0) return 'empty';
  return 'ok';
}

// The file to judge a piece by when a song has several: real bytes first, then a placeholder,
// then an empty file. Ties go to the earlier extension in `prefer`, then the bigger file.
export function pickBest(recs = [], prefer = []) {
  const score = (r) => (r.placeholder ? 1 : r.size > 0 ? 2 : 0);
  const order = (r) => {
    const i = prefer.indexOf(r.ext);
    return i < 0 ? prefer.length : i;
  };
  return [...recs].sort((a, b) => score(b) - score(a) || order(a) - order(b) || b.size - a.size)[0] || null;
}
