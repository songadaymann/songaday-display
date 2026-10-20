// A list row that stands for one song: hovering or focusing it flies the wall to the song and
// frames it, clicking opens it. Used by search results and by the crypto lists.
const HOVER_DELAY = 120; // ms, so sweeping the mouse down a list doesn't fly to every row

export function rowBinder({ flyTo, clearFocus, openSong }) {
  let timer = 0;
  const later = (fn) => {
    clearTimeout(timer);
    timer = setTimeout(fn, HOVER_DELAY);
  };
  return function bindRow(el, n) {
    el.dataset.song = String(n);
    el.addEventListener('mouseenter', () => later(() => flyTo(n)));
    el.addEventListener('mouseleave', () => {
      clearTimeout(timer);
      clearFocus(n);
    });
    el.addEventListener('focus', () => later(() => flyTo(n)));
    el.addEventListener('click', () => {
      clearTimeout(timer);
      openSong(n);
    });
    return el;
  };
}
