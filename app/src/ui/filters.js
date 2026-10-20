// The Explore drawer: one section per trait in the catalog (plus Year) and a date range.
// Sections stay open while you tick boxes; counts update in place. Matches go to onChange as a
// Set of song numbers (null when nothing is selected), which dims everything else on the wall.
import { buildFacets, evaluate, isActive } from '../core/filters.js';

const fmt = new Intl.NumberFormat('en-US');

export function createFilters({ drawer, toggle, catalog, onChange }) {
  const body = drawer.querySelector('.filter-content');
  const summary = drawer.querySelector('.filter-summary');
  const clearBtn = drawer.querySelector('.filter-clear');
  const from = drawer.querySelector('.date-from');
  const to = drawer.querySelector('.date-to');
  const selection = new Map();
  const sections = new Map(); // trait -> { el, count, rows: Map(value -> { input, count, row }) , rendered }
  let facets = null, result = null, built = false;

  const range = () => ({ from: from.value || '', to: to.value || '' });

  function apply() {
    if (!facets) return;
    result = evaluate(facets, selection, range());
    for (const [name, sec] of sections) updateSection(name, sec);
    const active = isActive(selection, range());
    summary.textContent = active ? `${fmt.format(result.matches.size)} of ${fmt.format(facets.rows.length)} songs match` : `${fmt.format(facets.rows.length)} songs`;
    clearBtn.disabled = !active;
    toggle.classList.toggle('has-filters', active);
    onChange(result.matches);
  }

  function updateSection(name, sec) {
    const picked = selection.get(name)?.size || 0;
    sec.badge.textContent = picked ? `${picked} selected` : '';
    if (!sec.rendered) return;
    const counts = result?.counts.get(name);
    for (const [value, r] of sec.rows) {
      const c = counts?.get(value) || 0;
      r.count.textContent = fmt.format(c);
      r.row.classList.toggle('is-empty', c === 0 && !r.input.checked);
    }
  }

  function renderOptions(name, sec, values) {
    const frag = document.createDocumentFragment();
    values.forEach(({ value }, i) => {
      const row = document.createElement('label');
      row.className = 'filter-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'filter-checkbox';
      input.checked = selection.get(name)?.has(value) || false;
      input.addEventListener('change', () => {
        if (!selection.has(name)) selection.set(name, new Set());
        const set = selection.get(name);
        if (input.checked) set.add(value);
        else set.delete(value);
        if (!set.size) selection.delete(name);
        apply();
      });
      const text = document.createElement('span');
      text.className = 'filter-value';
      text.textContent = value;
      const count = document.createElement('span');
      count.className = 'filter-value-count';
      row.append(input, text, count);
      frag.append(row);
      sec.rows.set(value, { input, count, row, i });
    });
    sec.options.append(frag);
    sec.rendered = true;
    updateSection(name, sec);
  }

  function build() {
    if (built) return;
    if (!catalog.size) {
      body.textContent = catalog.loaded ? 'Song data isn’t available yet.' : 'Loading songs…';
      return;
    }
    built = true;
    facets = buildFacets(catalog.allSongs());
    from.min = to.min = facets.minDate;
    from.max = to.max = facets.maxDate;
    const frag = document.createDocumentFragment();
    for (const { name, values } of facets.traits) {
      const el = document.createElement('section');
      el.className = 'filter-section';
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'filter-section-header';
      header.setAttribute('aria-expanded', 'false');
      const title = document.createElement('span');
      title.className = 'filter-section-title';
      title.textContent = name;
      const badge = document.createElement('span');
      badge.className = 'filter-selected';
      const count = document.createElement('span');
      count.className = 'filter-count';
      count.textContent = fmt.format(values.length);
      header.append(title, badge, count);
      const options = document.createElement('div');
      options.className = 'filter-options';
      options.hidden = true;
      options.id = `filter-${name.replace(/\W+/g, '-').toLowerCase()}`;
      header.setAttribute('aria-controls', options.id);
      const sec = { el, badge, options, rows: new Map(), rendered: false };
      header.addEventListener('click', () => {
        const open = options.hidden;
        options.hidden = !open;
        header.setAttribute('aria-expanded', String(open));
        if (open && !sec.rendered) renderOptions(name, sec, values); // big traits render on first open
      });
      el.append(header, options);
      frag.append(el);
      sections.set(name, sec);
    }
    body.replaceChildren(frag);
    apply();
  }

  function clear() {
    selection.clear();
    from.value = to.value = '';
    for (const sec of sections.values()) for (const r of sec.rows.values()) r.input.checked = false;
    apply();
  }

  function setOpen(open) {
    drawer.classList.toggle('open', open);
    drawer.inert = !open;
    drawer.toggleAttribute('aria-hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('active', open);
    if (open) build();
  }
  const isOpen = () => drawer.classList.contains('open');

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  drawer.querySelector('.filter-close-button').addEventListener('click', () => setOpen(false));
  clearBtn.addEventListener('click', clear);
  from.addEventListener('change', apply);
  to.addEventListener('change', apply);
  // Closes when you press anywhere outside it (filters stay applied).
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !drawer.contains(e.target) && !toggle.contains(e.target) && !e.target.closest?.('dialog')) setOpen(false);
  });
  // New songs (a manifest refresh): rebuild the sections, keeping the selection and open sections.
  catalog.onChange(() => {
    if (!built) return isOpen() && build();
    const open = [...sections].filter(([, s]) => !s.options.hidden).map(([name]) => name);
    built = false;
    sections.clear();
    build();
    for (const name of open) sections.get(name)?.el.querySelector('.filter-section-header').click();
  });
  drawer.inert = true;

  return { open: () => setOpen(true), close: () => setOpen(false), get isOpen() { return isOpen(); }, clear };
}
