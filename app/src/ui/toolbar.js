// Top-bar buttons, the zoom/fullscreen cluster, the Animate toggle and the mobile menu.
import { MODES, nextMode } from '../core/previews.js';
import { load, save } from '../lib/storage.js';

const ANIMATE_KEY = 'songaday-animate';
const LABELS = { off: 'Off', hover: 'Hover', nearby: 'Nearby' };

// Off for people who asked for less motion; Nearby otherwise. A saved choice wins.
export function initialAnimateMode() {
  const saved = load(ANIMATE_KEY);
  if (MODES.includes(saved)) return saved;
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'nearby';
}

export function animateToggle(button, mode, onChange) {
  const show = () => {
    button.querySelector('.state').textContent = LABELS[mode]; // accessible name: "Animate Nearby"
    button.classList.toggle('active', mode !== 'off');
  };
  button.addEventListener('click', () => {
    mode = nextMode(mode);
    save(ANIMATE_KEY, mode);
    show();
    onChange(mode);
  });
  show();
  return () => mode;
}

// Crypto buttons. They carry data-crypto, so they show only behind the wallet gate.
export function toolbarAdder(nav) {
  return function addToolbarButton({ id, label, icon, onClick }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-button';
    if (id) b.id = id;
    b.dataset.crypto = '';
    if (icon instanceof Node) b.append(icon);
    else if (icon) b.append(Object.assign(document.createElement('span'), { className: 'nav-icon', textContent: icon }));
    b.append(Object.assign(document.createElement('span'), { className: 'nav-label', textContent: label }));
    if (onClick) b.addEventListener('click', onClick);
    nav.append(b);
    return b;
  };
}

export const fullscreenSupported = () => Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

export function fullscreenButton(button, target = document.documentElement) {
  if (!fullscreenSupported()) {
    button.hidden = true; // e.g. an iframe without allow="fullscreen"
    return;
  }
  const sync = () => {
    const on = Boolean(fullscreenElement());
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    button.title = button.getAttribute('aria-label');
  };
  button.addEventListener('click', async () => {
    try {
      if (fullscreenElement()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (target.requestFullscreen || target.webkitRequestFullscreen).call(target);
    } catch (err) {
      console.warn('[gallery] full screen refused:', err.message);
    }
  });
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  sync();
}

// Under 640 px the nav folds into a menu.
export function mobileMenu(button, nav) {
  const set = (open) => {
    nav.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => set(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => e.target.closest('button') && set(false));
  document.addEventListener('pointerdown', (e) => {
    if (!nav.contains(e.target) && !button.contains(e.target)) set(false);
  });
  return () => set(false);
}
