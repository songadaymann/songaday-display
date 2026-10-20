// The top-bar search box: a debounced dropdown of the top 5 matches, arrow keys to move,
// Enter on a highlighted match opens it, Enter otherwise lists every match in the panel.
// Closes on blur and Escape.
import { buildIndex, search } from '../core/search.js';
import { formatDate, songDate } from '../core/dates.js';

const DEBOUNCE = 120;

export function songLabel(song, n) {
  const frag = document.createDocumentFragment();
  const t = document.createElement('span');
  t.className = 'row-title';
  t.textContent = song?.t || `Song #${n}`;
  const meta = document.createElement('span');
  meta.className = 'row-meta';
  meta.textContent = `#${n} · ${formatDate(song?.d || songDate(n), 'short')}`;
  frag.append(t, meta);
  return frag;
}

export function createSearch({ input, list, catalog, onPick, onResults }) {
  let index = null, items = [], active = -1, timer = 0;
  catalog.onChange(() => {
    index = null;
    if (input.value.trim() && !list.hidden) render();
  });

  const matches = (q, limit) => {
    if (!catalog.size) return catalog.loaded ? [] : null;
    index ??= buildIndex(catalog.allSongs());
    return search(index, q, { limit });
  };

  function setActive(i) {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    input.setAttribute('aria-activedescendant', i >= 0 ? `search-option-${i}` : '');
  }

  function close() {
    clearTimeout(timer);
    list.hidden = true;
    list.replaceChildren();
    items = [];
    setActive(-1);
    input.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const q = input.value.trim();
    if (!q) return close();
    const hits = matches(q, 5);
    items = hits || [];
    const lis = items.map((hit, i) => {
      const li = document.createElement('li');
      li.id = `search-option-${i}`;
      li.setAttribute('role', 'option');
      li.append(songLabel(hit.song, hit.n));
      li.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus so blur doesn't close first
      li.addEventListener('click', () => pick(hit.n));
      return li;
    });
    if (!lis.length) {
      const li = document.createElement('li');
      li.className = 'search-empty';
      li.textContent = hits ? 'No songs found. Press Enter for the full list.' : 'Loading songs…';
      lis.push(li);
    }
    list.replaceChildren(...lis);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }

  function pick(n) {
    close();
    input.blur();
    onPick(n);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, DEBOUNCE);
  });
  input.addEventListener('focus', () => input.value.trim() && render());
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) render();
      if (!items.length) return;
      e.preventDefault();
      // -1 is "nothing highlighted"; the arrows cycle through it.
      let i = active + (e.key === 'ArrowDown' ? 1 : -1);
      if (i >= items.length) i = -1;
      else if (i < -1) i = items.length - 1;
      setActive(i);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (active >= 0 && items[active]) return pick(items[active].n);
      if (!q) return;
      close();
      onResults(q, matches(q) || []);
    } else if (e.key === 'Escape') {
      if (!list.hidden) {
        e.stopPropagation();
        close();
      } else input.blur();
    }
  });

  return { close, focus: () => input.focus(), matches };
}
